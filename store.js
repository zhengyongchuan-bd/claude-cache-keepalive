// 保活中继的内存状态：会话 / 谱系(lineage) / 快照 / 保活计划（手动与自动）/ 收益账本。
// 请求体快照平时只在内存里（含鉴权头）；计划、谱系元数据和账本落在 stateDir。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AUTO_SKIP_LABELS,
  ESTIMATED_OUTCOMES,
  TTL_SEC,
  attributeResume,
  autoEligibility,
  buildEpisodes,
  classifyPing,
  coldStartOpportunity,
  evaluatePlanRequest,
  isTransientPingError,
  keepSavingUsd,
  localDay,
  parseDuration,
  pingCostEstimateUsd,
  planEconomics,
  promptTokens,
  summarizeEvents,
  ttlSettings,
  usageCostUsd,
  writtenTtl,
} from './core.js';

const STATE_VERSION = 1;
const DAY_MS = 86400 * 1000;
const STALE_SESSION_MS = 7 * DAY_MS;
const MAX_FINISHED_PLANS = 300;
const TERMINAL_PLAN_STATUSES = new Set(['completed', 'stopped', 'cancelled', 'expired', 'replaced']);
// 落盘快照里去掉的凭证头；重启后心跳借用之后经过中继的、同一把凭证（按指纹匹配，凭证本身只在内存）
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'proxy-authorization']);
const MAX_REMEMBERED_AUTH = 16;
// 重试时间离安全窗口截止不足这么久就不再排（调度 tick 是 5s）
const MIN_RETRY_LEAD_MS = 10 * 1000;
// max_tokens:0/1 的心跳理应没有输出；超过这个数说明上游没遵守 max_tokens（会按输出价和思考计费），停发
const MAX_PING_OUTPUT_TOKENS = 16;
const CONTROL_TOKEN_FILE = 'control.token';
const KEEPALIVE_OFF_MESSAGE = '保活已全局关闭（cache-keepalive on 打开）';

export class KeepaliveStore {
  // agentLookup(session) → { status, archived } | null：会话对应的 Paseo 任务状态（中继注入；测试可替换）
  // notify({ kind, title, text, ...meta })：告警出口（中继注入 webhook 发送；默认不做事）
  constructor({ cfg, stateDir, now = () => Date.now(), log = () => {}, agentLookup = () => null, notify = () => {} }) {
    this.cfg = cfg;
    this.stateDir = stateDir;
    this.now = now;
    this.log = log;
    this.agentLookup = agentLookup;
    this.notify = notify;
    // 控制 API 写操作的口令（stateDir/control.token，0600）；没有 stateDir 时为 null，不做校验
    this.controlToken = null;
    // 任一自动心跳没命中后，到这个时刻之前不再开始新的自动保活
    this.autoCooldownUntil = 0;
    this.authByFingerprint = new Map();
    this.sessions = new Map();
    this.lineages = new Map();
    this.plans = new Map();
    this.events = [];
    this.daily = { day: localDay(now()), pings: 0, usd: 0 };
    this.snapshotBytes = 0;
    this.saveTimer = null;
    this.statePath = stateDir ? path.join(stateDir, 'state.json') : null;
    this.ledgerPath = stateDir ? path.join(stateDir, 'ledger.jsonl') : null;
    this.snapshotDir = stateDir ? path.join(stateDir, 'snapshots') : null;
    this.lastAuth = null;
  }

  // ---------------------------------------------------------------- 持久化

  load() {
    if (!this.stateDir) return;
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.controlToken = this.loadControlToken();
    const state = readJson(this.statePath);
    if (state?.version === STATE_VERSION) {
      for (const session of state.sessions || []) this.sessions.set(session.id, { ...session, inflight: 0, lineageKeys: new Set(session.lineageKeys || []) });
      for (const lineage of state.lineages || []) this.lineages.set(lineage.key, { ...lineage, inflight: 0, snapshot: null });
      for (const plan of state.plans || []) this.plans.set(plan.id, { ...plan, inflight: false });
      if (state.daily?.day === this.daily.day) this.daily = state.daily;
      this.autoCooldownUntil = state.autoCooldownUntil || 0;
    }
    const since = this.now() - this.cfg.ledgerRetentionDays * DAY_MS;
    if (fs.existsSync(this.ledgerPath)) {
      const lines = fs.readFileSync(this.ledgerPath, 'utf8').split('\n');
      let dropped = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.at >= since) this.events.push(event);
          else dropped += 1;
        } catch {
          dropped += 1;
        }
      }
      // 过期记录多了就整理一次，避免账本无限增长
      if (dropped > 1000) writeTextAtomic(this.ledgerPath, this.events.map(event => JSON.stringify(event)).join('\n') + '\n');
    }
    this.restoreSnapshots();
  }

  // 口令文件不存在就生成一个（随机 32 字节 hex）；读写失败时返回 null，中继会退化为不校验并打日志
  loadControlToken() {
    const file = path.join(this.stateDir, CONTROL_TOKEN_FILE);
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing) return existing;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log(`读取控制口令失败: ${error.message}`);
        return null;
      }
    }
    try {
      const token = randomBytes(32).toString('hex');
      writeTextAtomic(file, `${token}\n`);
      return token;
    } catch (error) {
      this.log(`写控制口令失败: ${error.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- 快照落盘（只针对有进行中计划的会话）
  //
  // 平时快照只在内存；开启保活后才把该会话的快照写到 stateDir/snapshots（0600，不含凭证头），
  // 中继重启后计划可以继续。计划结束即删除。

  snapshotFiles(key) {
    return { body: path.join(this.snapshotDir, `${key}.body`), meta: path.join(this.snapshotDir, `${key}.json`) };
  }

  persistSnapshot(lineage) {
    if (!this.snapshotDir || !lineage?.snapshot) return;
    try {
      fs.mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 });
      const files = this.snapshotFiles(lineage.key);
      const { body, headers, path: requestPath, capturedAt } = lineage.snapshot;
      const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name)));
      const authFingerprint = lineage.snapshot.authFingerprint || authFingerprintOf(headers);
      writeTextAtomic(files.body, body);
      writeTextAtomic(files.meta, JSON.stringify({ sessionId: lineage.sessionId, path: requestPath, headers: safeHeaders, capturedAt, authFingerprint }));
    } catch (error) {
      this.log(`快照落盘失败: ${error.message}`);
    }
  }

  removePersistedSnapshots(session) {
    if (!session) return;
    for (const key of session.lineageKeys) this.removePersistedSnapshot(key);
  }

  removePersistedSnapshot(key) {
    if (!this.snapshotDir) return;
    const files = this.snapshotFiles(key);
    fs.rmSync(files.body, { force: true });
    fs.rmSync(files.meta, { force: true });
  }

  // 恢复有进行中计划的会话、以及缓存还没过期的主对话（退出时落盘，给自动保活用）的快照；其余删掉
  restoreSnapshots() {
    if (!this.snapshotDir || !fs.existsSync(this.snapshotDir)) return;
    const planned = new Set(this.activePlans().map(plan => plan.sessionId));
    const now = this.now();
    for (const name of fs.readdirSync(this.snapshotDir)) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -5);
      const files = this.snapshotFiles(key);
      const lineage = this.lineages.get(key);
      const meta = readJson(files.meta);
      const ttlMs = (TTL_SEC[lineage?.ttl] || 0) * 1000;
      const warm = Boolean(lineage) && now - lastTouchAt(lineage) < ttlMs;
      if (!lineage || !meta || !(planned.has(lineage.sessionId) || warm) || !fs.existsSync(files.body)) {
        fs.rmSync(files.body, { force: true });
        fs.rmSync(files.meta, { force: true });
        continue;
      }
      const body = fs.readFileSync(files.body);
      lineage.snapshot = { body, headers: meta.headers, path: meta.path, capturedAt: meta.capturedAt, restored: true, needsAuth: true, authFingerprint: meta.authFingerprint || null };
      this.snapshotBytes += body.length;
      // 没有计划的会话读回内存后就删掉文件（磁盘上尽量少留对话内容），下次优雅退出时再写
      if (!planned.has(lineage.sessionId)) {
        fs.rmSync(files.body, { force: true });
        fs.rmSync(files.meta, { force: true });
      }
    }
  }

  // 优雅退出前调用：缓存还没过期的主对话快照落盘，重启后自动保活还能接着发（崩溃退出的不保证）
  persistWarmSnapshots() {
    const now = this.now();
    let count = 0;
    for (const session of this.sessions.values()) {
      const lineage = this.primaryLineage(session);
      if (!lineage?.snapshot || !lineage.isMainThread) continue;
      const ttlMs = (TTL_SEC[lineage.ttl] || 0) * 1000;
      if (now - lastTouchAt(lineage) >= ttlMs) continue;
      this.persistSnapshot(lineage);
      count += 1;
    }
    return count;
  }

  // 记下经过中继的凭证（只在内存，按指纹索引），给重启后恢复的快照用；带 session 时同时记下该会话最近用的是哪把
  noteAuth(headers, session = null) {
    const auth = {};
    for (const name of SECRET_HEADERS) if (headers[name]) auth[name] = headers[name];
    if (!auth.authorization && !auth['x-api-key']) return;
    this.lastAuth = auth;
    const fingerprint = authFingerprintOf(headers);
    this.authByFingerprint.delete(fingerprint);
    this.authByFingerprint.set(fingerprint, auth);
    while (this.authByFingerprint.size > MAX_REMEMBERED_AUTH) this.authByFingerprint.delete(this.authByFingerprint.keys().next().value);
    if (session) session.authFingerprint = fingerprint;
  }

  // 恢复的快照没有凭证：优先借快照里记的同一把；token 轮换后同一会话再来的请求用的是新凭证，也可以借
  //（同一会话、同一账号，只是换了 token）；旧版快照没记指纹时退回最近一次的
  authFor(snapshot, session = null) {
    if (!snapshot.needsAuth) return {};
    if (snapshot.authFingerprint) {
      const same = this.authByFingerprint.get(snapshot.authFingerprint);
      if (same) return same;
      if (session?.authFingerprint) return this.authByFingerprint.get(session.authFingerprint) || null;
      return null;
    }
    return this.lastAuth;
  }

  pingHeaders(snapshot, session = null) {
    return snapshot.needsAuth ? { ...snapshot.headers, ...(this.authFor(snapshot, session) || {}) } : snapshot.headers;
  }

  scheduleSave() {
    if (!this.statePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (!this.statePath) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const state = {
      version: STATE_VERSION,
      savedAt: new Date(this.now()).toISOString(),
      daily: this.daily,
      autoCooldownUntil: this.autoCooldownUntil,
      sessions: [...this.sessions.values()].map(({ inflight, lineageKeys, ...rest }) => ({ ...rest, lineageKeys: [...lineageKeys] })),
      lineages: [...this.lineages.values()].map(({ snapshot, inflight, ...rest }) => rest),
      plans: [...this.plans.values()].map(({ inflight, ...rest }) => rest),
    };
    try {
      writeTextAtomic(this.statePath, JSON.stringify(state));
    } catch (error) {
      this.log(`保存状态失败: ${error.message}`);
    }
  }

  appendEvent(event) {
    this.events.push(event);
    if (!this.ledgerPath) return;
    try {
      fs.appendFileSync(this.ledgerPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    } catch (error) {
      this.log(`写账本失败: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------- 真实请求

  beginRequest(meta) {
    const now = this.now();
    const sessionId = meta.sessionId || `anon-${meta.lineageKey.slice(0, 8)}`;
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, cwd: null, cwdReal: null, firstSeenAt: now, lastSeenAt: now, inflight: 0, lineageKeys: new Set() };
      this.sessions.set(sessionId, session);
    }
    if (meta.cwd && meta.cwd !== session.cwd) {
      session.cwd = meta.cwd;
      session.cwdReal = realpathOr(meta.cwd);
    }
    session.lastSeenAt = now;
    session.inflight += 1;
    let lineage = this.lineages.get(meta.lineageKey);
    if (!lineage) {
      lineage = {
        key: meta.lineageKey,
        sessionId,
        model: meta.model,
        ttl: meta.ttl,
        isMainThread: meta.isMainThread,
        isSubagent: meta.isSubagent,
        toolCount: meta.toolCount,
        messageCount: meta.messageCount,
        firstSeenAt: now,
        lastRealStartAt: 0,
        lastRealEndAt: 0,
        lastUsage: null,
        lastStopReason: null,
        expectedCached: 0,
        lastHitPingAt: 0,
        lastPing: null,
        episode: { pings: [] },
        blocked: null,
        unpingableReason: meta.unpingableReason,
        pingMaxTokens: meta.pingMaxTokens,
        totals: { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 },
        inflight: 0,
        snapshot: null,
      };
      this.lineages.set(lineage.key, lineage);
    }
    // 按谱系计在途：子代理跑着的时候主对话的缓存并没有被刷新，仍需要心跳
    lineage.inflight = (lineage.inflight || 0) + 1;
    session.lineageKeys.add(lineage.key);
    return { session, lineage, meta, startedAt: now };
  }

  // summary 来自 UsageTap.finish()；snapshot = { body: Buffer, headers, path }
  endRequest(ctx, { status, summary, snapshot }) {
    const { session, lineage, meta, startedAt } = ctx;
    session.inflight = Math.max(0, session.inflight - 1);
    lineage.inflight = Math.max(0, (lineage.inflight || 0) - 1);
    const now = this.now();
    session.lastSeenAt = now;
    const usage = summary?.usage;
    // 只有上游真正处理了提示词（拿到 message_start 的 usage）才会读写缓存
    if (!(status >= 200 && status < 300 && usage && summary.sawStart)) {
      // 失败的真实请求（429/5xx/断开）客户端会马上重试：这段时间会话算活跃，心跳先让路
      if (meta.isMainThread) lineage.lastFailedAt = now;
      this.scheduleSave();
      return null;
    }
    const prevStartAt = lineage.lastRealStartAt;
    const gapSec = prevStartAt ? (startedAt - prevStartAt) / 1000 : null;
    const costUsd = usageCostUsd(usage, { model: meta.model, ttl: meta.ttl, cfg: this.cfg });
    let event = null;
    if (lineage.episode.pings.length && prevStartAt) {
      const resume = attributeResume({ ttl: lineage.ttl, prevStartAt, startAt: startedAt, usage, pings: lineage.episode.pings, model: lineage.model, cfg: this.cfg });
      resume.pingCostUsd = lineage.episode.pings.reduce((sum, ping) => sum + (ping.costUsd || 0), 0);
      resume.source = lineage.episode.pings.some(ping => ping.source === 'pin') ? 'pin' : lineage.episode.pings.some(ping => ping.source === 'auto') ? 'auto' : 'manual';
      event = { t: 'req', at: startedAt, sid: session.id, lk: lineage.key, model: meta.model, cwd: session.cwd, ttl: lineage.ttl, gapSec, usage, costUsd, resume };
    } else if (prevStartAt && meta.isMainThread && !lineage.compactedAt) {
      // 只记录「本可以靠保活避免」的大段重写：保活只针对主对话，子代理与旁路请求不算；
      // 压缩后的第一次请求本来就是新前缀。TTL 看上一次请求写缓存时的（压缩请求自己标 5m，读的却是之前 1h 的缓存）
      const cold = coldStartOpportunity({ ttl: lineage.ttl, gapSec, usage, prevCached: lineage.expectedCached, model: meta.model, cfg: this.cfg });
      // 记下这段空闲自动保活当时的判定，说明它为什么没被保住
      const decided = lineage.autoEpisode?.idleStartAt === prevStartAt ? lineage.autoEpisode : null;
      if (cold) event = { t: 'req', at: startedAt, sid: session.id, lk: lineage.key, model: meta.model, cwd: session.cwd, ttl: lineage.ttl, gapSec, usage, costUsd, cold, auto: decided && { ok: decided.ok, code: decided.code } };
    }
    if (event) this.appendEvent(event);

    // 人工接入轮次：主对话请求体里人发的消息数。压缩、回退后会变少，这时只重设基线、不累加
    if (meta.isMainThread && Number.isFinite(meta.humanTurns)) {
      const base = session.humanTurnsBaseline || 0;
      if (meta.humanTurns > base) session.humanTurns = (session.humanTurns || 0) + meta.humanTurns - base;
      session.humanTurnsBaseline = meta.humanTurns;
    }
    // 上游实际按哪个 TTL 写的：请求标了 1h、上游却按 5m 写时，缓存 5 分钟就没了，50 分钟一次的心跳必然不命中
    const written = writtenTtl(usage);
    if (written) {
      lineage.writtenTtl = written;
      lineage.ttlDowngraded = meta.ttl === '1h' && written === '5m';
    }

    Object.assign(lineage, {
      model: meta.model,
      ttl: meta.ttl,
      isMainThread: meta.isMainThread,
      isSubagent: meta.isSubagent,
      toolCount: meta.toolCount,
      messageCount: meta.messageCount,
      unpingableReason: meta.unpingableReason,
      // 网关一旦拒绝过 max_tokens:0（已退到 1），之后的请求不再重置回 0，免得每段空闲都先吃一次 400
      pingMaxTokens: Math.max(meta.pingMaxTokens, lineage.pingMaxTokens || 0),
      lastRealStartAt: startedAt,
      lastRealEndAt: now,
      lastUsage: usage,
      lastStopReason: summary.stopReason,
      expectedCached: usage.cacheRead + usage.cacheWrite,
      episode: { pings: [] },
    });
    lineage.totals.requests += 1;
    lineage.totals.input += usage.input;
    lineage.totals.cacheRead += usage.cacheRead;
    lineage.totals.cacheWrite += usage.cacheWrite;
    lineage.totals.output += usage.output;
    lineage.totals.costUsd += costUsd;
    if (meta.isCompaction) {
      // 压缩后旧前缀作废：不拿压缩请求当保活目标，计划等压缩后的第一次请求
      lineage.compactedAt = startedAt;
      this.dropSnapshot(lineage);
      this.removePersistedSnapshot(lineage.key);
    } else if (snapshot?.body) {
      lineage.compactedAt = null;
      this.setSnapshot(lineage, { ...snapshot, capturedAt: now });
    }
    // 主对话的真实请求已刷新缓存：挂着的「立即补一次」和失败重试都不需要了，计划按新的触达时间顺延
    const plan = this.activePlanFor(session.id);
    if (plan && this.primaryLineage(session) === lineage) {
      plan.pingNowAt = null;
      plan.retryAt = null;
      plan.errorStreak = 0;
      plan.lastError = null;
      // 自动保活 / 长保活只管一段空闲：会话继续了（人回来、工具执行完），这段的计划结束，下一段空闲重新判定 / 重新接上
      if (plan.source === 'auto') this.finishPlan(plan, 'completed', '会话继续了，本段空闲的自动保活结束');
      else if (plan.source === 'pin') this.finishPlan(plan, 'completed', '会话继续了，本段空闲的长保活结束，下一段空闲继续');
    }
    lineage.lastFailedAt = null;
    this.scheduleSave();
    return event;
  }

  setSnapshot(lineage, snapshot) {
    if (lineage.snapshot) this.snapshotBytes -= lineage.snapshot.body.length;
    lineage.snapshot = snapshot;
    this.snapshotBytes += snapshot.body.length;
    const session = this.sessions.get(lineage.sessionId);
    if (session && this.activePlanFor(session.id) && this.primaryLineage(session) === lineage) this.persistSnapshot(lineage);
    this.enforceSnapshotBudget();
  }

  dropSnapshot(lineage) {
    if (!lineage.snapshot) return;
    this.snapshotBytes -= lineage.snapshot.body.length;
    lineage.snapshot = null;
  }

  enforceSnapshotBudget() {
    if (this.snapshotBytes <= this.cfg.maxTotalSnapshotBytes) return;
    const planned = new Set([...this.activePlans()].map(plan => plan.sessionId));
    const victims = [...this.lineages.values()]
      .filter(lineage => lineage.snapshot)
      .sort((a, b) => Number(planned.has(a.sessionId)) - Number(planned.has(b.sessionId)) || lastTouchAt(a) - lastTouchAt(b));
    for (const lineage of victims) {
      if (this.snapshotBytes <= this.cfg.maxTotalSnapshotBytes) break;
      this.dropSnapshot(lineage);
    }
  }

  // ---------------------------------------------------------------- 会话视图

  sessionLineages(session) {
    return [...session.lineageKeys].map(key => this.lineages.get(key)).filter(Boolean);
  }

  // 主对话优先（不是子代理、带 Agent/Task 工具），其次非子代理、最近活跃；子代理、标题生成等旁路谱系不作为保活目标。
  primaryLineage(session) {
    const candidates = this.sessionLineages(session).filter(lineage => lineage.lastRealStartAt);
    candidates.sort((a, b) => Number(b.isMainThread) - Number(a.isMainThread)
      || Number(Boolean(a.isSubagent)) - Number(Boolean(b.isSubagent))
      || b.lastRealStartAt - a.lastRealStartAt);
    return candidates[0] || null;
  }

  guardView(lineage) {
    return lineage && {
      ttl: lineage.ttl,
      model: lineage.model,
      expectedCached: lineage.expectedCached,
      lastTouchAt: lastTouchAt(lineage),
      blocked: lineage.blocked,
      hasSnapshot: Boolean(lineage.snapshot),
      unpingableReason: lineage.unpingableReason,
      cacheable: lineage.expectedCached > 0,
      compacted: Boolean(lineage.compactedAt),
      ttlDowngraded: Boolean(lineage.ttlDowngraded),
      pingAnomaly: lineage.pingAnomaly || null,
    };
  }

  lineageView(lineage, now = this.now()) {
    if (!lineage) return null;
    const touch = lastTouchAt(lineage);
    const ttlSec = TTL_SEC[lineage.ttl] || 0;
    const expiresAt = ttlSec ? touch + ttlSec * 1000 : null;
    return {
      key: lineage.key,
      model: lineage.model,
      ttl: lineage.ttl,
      isMainThread: lineage.isMainThread,
      isSubagent: Boolean(lineage.isSubagent),
      messageCount: lineage.messageCount,
      contextTokens: lineage.expectedCached,
      promptTokens: promptTokens(lineage.lastUsage),
      lastUsage: lineage.lastUsage,
      lastStopReason: lineage.lastStopReason,
      lastRealStartAt: lineage.lastRealStartAt,
      lastRealEndAt: lineage.lastRealEndAt,
      lastHitPingAt: lineage.lastHitPingAt || null,
      lastTouchAt: touch,
      expiresAt,
      remainingSec: expiresAt ? Math.round((expiresAt - now) / 1000) : null,
      warm: expiresAt ? now < expiresAt : false,
      blocked: lineage.blocked,
      hasSnapshot: Boolean(lineage.snapshot),
      snapshotBytes: lineage.snapshot?.body.length || 0,
      snapshotRestored: Boolean(lineage.snapshot?.restored),
      compactedAt: lineage.compactedAt || null,
      unpingableReason: lineage.unpingableReason,
      writtenTtl: lineage.writtenTtl || null,
      ttlDowngraded: Boolean(lineage.ttlDowngraded),
      pingAnomaly: lineage.pingAnomaly || null,
      lastPing: lineage.lastPing,
      episodePings: lineage.episode.pings.length,
      totals: lineage.totals,
    };
  }

  sessionView(session, now = this.now()) {
    const primary = this.primaryLineage(session);
    const plan = this.latestPlan(session.id);
    const view = {
      id: session.id,
      cwd: session.cwd,
      firstSeenAt: session.firstSeenAt,
      lastSeenAt: session.lastSeenAt,
      // busy 只看主对话：子代理在跑时主对话缓存照样会过期
      busy: (primary?.inflight || 0) > 0,
      activeRequests: session.inflight,
      primary: this.lineageView(primary, now),
      lineages: this.sessionLineages(session).map(lineage => ({
        key: lineage.key,
        model: lineage.model,
        ttl: lineage.ttl,
        isMainThread: lineage.isMainThread,
        isSubagent: Boolean(lineage.isSubagent),
        contextTokens: lineage.expectedCached,
        lastRealStartAt: lineage.lastRealStartAt,
      })),
      plan: plan && this.planView(plan, now),
      pin: this.pinView(session, now),
      auto: this.autoView(session, primary, now),
      humanTurns: session.humanTurns || 0,
      check: null,
      economics: null,
    };
    if (primary) {
      // 用默认参数预演一次，给页面/CLI 展示「现在能否保活、为什么」
      const check = evaluatePlanRequest({ lineage: this.guardView(primary), now, cfg: this.cfg, daily: this.dailyUsage() });
      view.check = { ok: check.ok, errors: check.errors, warnings: check.warnings, count: check.count, intervalSec: check.intervalSec };
      if (ttlSettings(primary.ttl, this.cfg)) {
        view.economics = planEconomics({ lineage: this.guardView(primary), count: check.count, intervalSec: check.intervalSec, now, cfg: this.cfg });
      }
    }
    return view;
  }

  listSessions({ now = this.now(), sinceMs = DAY_MS } = {}) {
    return [...this.sessions.values()]
      .filter(session => now - session.lastSeenAt <= sinceMs || this.activePlanFor(session.id))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(session => this.sessionView(session, now));
  }

  // sessionId 支持前缀；cwd 先精确匹配，再找「当前目录位于会话工作区之下」的会话。
  resolveSessions({ sessionId, cwd } = {}) {
    const all = [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    if (sessionId) {
      const exact = all.filter(session => session.id === sessionId);
      if (exact.length) return exact;
      return sessionId.length >= 6 ? all.filter(session => session.id.startsWith(sessionId)) : [];
    }
    if (!cwd) return [];
    const target = realpathOr(cwd);
    const exact = all.filter(session => session.cwdReal === target || session.cwd === cwd);
    if (exact.length) return exact;
    return all
      .filter(session => session.cwdReal && target.startsWith(`${session.cwdReal}/`))
      .sort((a, b) => b.cwdReal.length - a.cwdReal.length || b.lastSeenAt - a.lastSeenAt);
  }

  // ---------------------------------------------------------------- 保活计划

  activePlans() {
    return [...this.plans.values()].filter(plan => plan.status === 'active');
  }

  activePlanFor(sessionId) {
    return this.activePlans().find(plan => plan.sessionId === sessionId) || null;
  }

  latestPlan(sessionId) {
    let latest = null;
    for (const plan of this.plans.values()) {
      if (plan.sessionId !== sessionId) continue;
      if (plan.status === 'active') return plan;
      if (!latest || plan.createdAt > latest.createdAt) latest = plan;
    }
    return latest;
  }

  dailyUsage() {
    const today = localDay(this.now());
    if (this.daily.day !== today) this.daily = { day: today, pings: 0, usd: 0 };
    return this.daily;
  }

  startPlan(session, { count, intervalSec, force = false, immediate = false, source = 'api' } = {}) {
    const now = this.now();
    if (this.cfg.enabled === false) return { ok: false, sessionId: session.id, errors: [{ code: 'keepalive-off', message: KEEPALIVE_OFF_MESSAGE }], warnings: [] };
    const lineage = this.primaryLineage(session);
    const check = evaluatePlanRequest({
      lineage: this.guardView(lineage),
      count: count ?? (immediate ? 1 : undefined),
      intervalSec,
      force,
      now,
      cfg: this.cfg,
      daily: this.dailyUsage(),
    });
    if (!check.ok) return { ok: false, sessionId: session.id, errors: check.errors, warnings: check.warnings };
    const previous = this.activePlanFor(session.id);
    if (previous) this.finishPlan(previous, 'replaced', previous.source === 'auto' ? '被手动保活计划替换' : '被新的保活计划替换');
    const plan = this.createPlan(session, lineage, { count: check.count, intervalSec: check.intervalSec, force, immediate, source, now });
    return {
      ok: true,
      sessionId: session.id,
      plan: this.planView(plan, now),
      warnings: check.warnings,
      economics: planEconomics({ lineage: this.guardView(lineage), count: plan.count, intervalSec: plan.intervalSec, immediate, now, cfg: this.cfg }),
    };
  }

  createPlan(session, lineage, { count, intervalSec, force = false, immediate = false, source, now, extra = {} }) {
    const plan = {
      id: randomUUID().slice(0, 8),
      sessionId: session.id,
      lineageKey: lineage.key,
      createdAt: now,
      count,
      done: 0,
      intervalSec,
      pingNowAt: immediate ? now : null,
      forced: force,
      source,
      status: 'active',
      reason: null,
      state: 'scheduled',
      lastPingAt: null,
      lastOutcome: null,
      errorStreak: 0,
      lastError: null,
      retryAt: null,
      endedAt: null,
      costUsd: 0,
      inflight: false,
      ...extra,
    };
    this.plans.set(plan.id, plan);
    this.persistSnapshot(lineage);
    this.appendEvent({
      t: 'plan', at: now, sid: session.id, plan: plan.id, action: 'start', count, intervalSec, immediate, forced: force, source,
      cwd: session.cwd, model: lineage.model, ttl: lineage.ttl, idleStartAt: lineage.lastRealStartAt || null, ...extra,
    });
    this.prunePlans();
    this.scheduleSave();
    return plan;
  }

  // ---------------------------------------------------------------- 自动保活
  //
  // 每段空闲（主对话最近一次真实请求之后）在第一次心跳到点时判定一次：符合条件就建一个 source=auto 的计划，
  // 之后和手动计划走同一套心跳、护栏与记账；会话继续了（真实请求）计划即结束，下一段空闲重新判定。
  // 用户手动 stop 后整个会话不再自动保活（auto on 才恢复）；手动计划优先，进行中时不另建自动计划。

  autoFeatures(session, lineage, now = this.now()) {
    const agent = this.agentLookup(session) || null;
    return {
      sessionId: session.id,
      sessionStopped: Boolean(session.autoDisabled),
      archived: Boolean(agent?.archived),
      agentStatus: agent?.status || null,
      isMainThread: Boolean(lineage?.isMainThread),
      ttl: lineage?.ttl || null,
      ttlDowngraded: Boolean(lineage?.ttlDowngraded),
      blocked: Boolean(lineage?.blocked),
      unpingable: Boolean(lineage?.unpingableReason || lineage?.pingAnomaly),
      cacheable: (lineage?.expectedCached || 0) > 0,
      contextTokens: lineage?.expectedCached || 0,
      humanTurns: session.humanTurns || 0,
      stopReason: lineage?.lastStopReason || null,
      cooldownUntil: this.autoCooldownUntil,
      idleStartAt: lineage?.lastRealEndAt || lineage?.lastRealStartAt || now,
    };
  }

  // 第一次自动心跳的时刻：从最近一次触达起算一个 1h 间隔
  autoDueAt(lineage) {
    const settings = ttlSettings('1h', this.cfg);
    return lastTouchAt(lineage) + settings.intervalSec * 1000;
  }

  maybeStartAutoPlans(now = this.now()) {
    if (this.cfg.auto?.mode !== 'on') return;
    for (const session of this.sessions.values()) {
      if (session.pin || this.activePlanFor(session.id)) continue;
      const lineage = this.primaryLineage(session);
      if (!lineage?.lastRealStartAt || lineage.inflight > 0 || lineage.ttl !== '1h' || this.inRetryGrace(lineage, now)) continue;
      // 这段空闲已经发过心跳（手动计划刚结束）或已经判定过，不再重复
      if (lineage.episode.pings.length || lineage.autoEpisode?.idleStartAt === lineage.lastRealStartAt) continue;
      if (now < this.autoDueAt(lineage)) continue;
      const settings = ttlSettings('1h', this.cfg);
      // 中继停着错过了窗口（空闲 50–58 分钟之间没 tick）：缓存多半已过期，不发心跳，但把原因记下来，
      // 页面/CLI 不再显示「已就绪」，冷启动也能归因；太久以前的空闲不补记，免得重启后刷一屏旧事件
      if (now - lastTouchAt(lineage) > (settings.ttlSec - settings.safetySec) * 1000) {
        if (now - lastTouchAt(lineage) <= this.cfg.planMaxAgeSec * 1000) {
          lineage.autoEpisode = { idleStartAt: lineage.lastRealStartAt, decidedAt: now, ok: false, code: 'missed-window', message: AUTO_SKIP_LABELS['missed-window'] };
          this.appendEvent({ t: 'auto', at: now, sid: session.id, lk: lineage.key, ok: false, code: 'missed-window', message: AUTO_SKIP_LABELS['missed-window'], contextTokens: lineage.expectedCached, humanTurns: session.humanTurns || 0, stopReason: lineage.lastStopReason || null });
          this.scheduleSave();
        }
        continue;
      }
      let decision = autoEligibility(this.autoFeatures(session, lineage, now), { now, cfg: this.cfg });
      if (decision.ok && !lineage.snapshot) decision = { ok: false, code: 'no-snapshot', message: '中继里没有该会话的请求快照（中继重启或请求体过大）' };
      lineage.autoEpisode = { idleStartAt: lineage.lastRealStartAt, decidedAt: now, ok: decision.ok, code: decision.code, message: decision.message || null };
      this.appendEvent({
        t: 'auto',
        at: now,
        sid: session.id,
        lk: lineage.key,
        ok: decision.ok,
        code: decision.code,
        message: decision.message || null,
        contextTokens: lineage.expectedCached,
        humanTurns: session.humanTurns || 0,
        stopReason: lineage.lastStopReason || null,
      });
      if (!decision.ok) {
        this.scheduleSave();
        continue;
      }
      const plan = this.createPlan(session, lineage, { count: decision.count, intervalSec: decision.intervalSec, source: 'auto', now, extra: { trigger: decision.code } });
      lineage.autoEpisode.planId = plan.id;
      this.log(`auto plan session=${session.id.slice(0, 8)} count=${plan.count} trigger=${decision.code} context=${lineage.expectedCached}`);
    }
  }

  // ---------------------------------------------------------------- 长保活（pin）
  //
  // 给某个会话设一个到期时刻：期间每段空闲（主对话最近一次真实请求之后）到间隔就发心跳，直到人回来或到期；
  // 会话一有真实请求，这段的计划结束，下一段空闲再接上。不受自动保活门槛（人工轮次、凌晨、前缀大小、任务已关闭）
  // 和每段次数上限约束，但硬护栏照常：活跃时不发、缓存已过期不发、未命中即锁定并取消长保活、每日额度、Paseo 归档即取消。

  pinView(session, now = this.now()) {
    const pin = session.pin;
    if (!pin) return null;
    const plan = this.activePlanFor(session.id);
    return { ...pin, remainingSec: Math.max(0, Math.round((pin.untilAt - now) / 1000)), active: plan?.source === 'pin', planId: plan?.source === 'pin' ? plan.id : null };
  }

  pinSession(session, { forSec = null, intervalSec = null, source = 'api', reason = null } = {}) {
    const now = this.now();
    const lineage = this.primaryLineage(session);
    const settings = lineage ? ttlSettings(lineage.ttl, this.cfg) : null;
    const fail = (code, message) => ({ ok: false, sessionId: session.id, errors: [{ code, message }], warnings: [] });
    if (this.cfg.enabled === false) return fail('keepalive-off', KEEPALIVE_OFF_MESSAGE);
    if (!lineage) return fail('no-session', '没有找到经过保活中继的会话请求；需先让该会话通过中继发出至少一次请求');
    if (!settings) return fail('no-cache-control', '该会话的请求没有 cache_control 断点，无缓存可保');
    if (lineage.unpingableReason === 'thinking-enabled') return fail('thinking-enabled', 'thinking.type=enabled 无法发零输出心跳');
    if (lineage.pingAnomaly) return fail('ping-anomaly', `上次心跳产生了 ${lineage.pingAnomaly.output} 个输出 token（上游没遵守 max_tokens），每次心跳都会多付输出费`);
    if (lineage.blocked) return fail('blocked', `上次心跳没命中会话缓存（${lineage.blocked.detail}），已锁定；先用 ping --force 确认能命中再设长保活`);
    const pinCfg = this.cfg.pin || {};
    const maxSec = Number(pinCfg.maxSec) || 48 * 3600;
    const wantSec = forSec == null || forSec === '' ? (Number(pinCfg.defaultSec) || 12 * 3600) : parseDuration(forSec);
    if (!Number.isFinite(wantSec) || wantSec <= 0) return fail('bad-duration', `无法解析长保活时长：${forSec}`);
    const warnings = [];
    const durationSec = Math.min(maxSec, wantSec);
    if (durationSec < wantSec) warnings.push(`长保活最长 ${Math.round(maxSec / 3600)} 小时，按上限执行`);
    let interval = intervalSec == null || intervalSec === '' ? settings.intervalSec : parseDuration(intervalSec);
    if (!Number.isFinite(interval)) return fail('bad-interval', `无法解析间隔：${intervalSec}`);
    const clamped = Math.min(settings.maxIntervalSec, Math.max(settings.minIntervalSec, Math.round(interval)));
    if (clamped !== Math.round(interval)) warnings.push(`间隔 ${Math.round(interval)}s 超出 ${lineage.ttl} 允许范围 [${settings.minIntervalSec}, ${settings.maxIntervalSec}]s，按 ${clamped}s 执行`);
    interval = clamped;
    const untilAt = now + durationSec * 1000;
    const previous = session.pin || null;
    session.pin = { at: now, untilAt, durationSec, intervalSec: interval, source, reason, ttl: lineage.ttl };
    // 长保活接管后，进行中的自动计划让位（次数更长）；手动计划保留，结束后由长保活接上
    const active = this.activePlanFor(session.id);
    if (active?.source === 'auto') this.finishPlan(active, 'replaced', '被长保活接管');
    this.appendEvent({ t: 'pin', at: now, sid: session.id, action: previous ? 'extend' : 'set', untilAt, durationSec, intervalSec: interval, source, reason, cwd: session.cwd });
    this.log(`pin session=${session.id.slice(0, 8)} until=${new Date(untilAt).toISOString()} interval=${interval}s`);
    // 已经空闲到点就立刻建计划（心跳由调度 tick 发）
    this.maybeStartPinPlan(session, now);
    this.scheduleSave();
    const pingUsd = pingCostEstimateUsd(lineage.expectedCached, { model: lineage.model, cfg: this.cfg });
    const maxPings = Math.ceil(durationSec / interval);
    return {
      ok: true,
      sessionId: session.id,
      pin: this.pinView(session, now),
      plan: this.activePlanFor(session.id) ? this.planView(this.activePlanFor(session.id), now) : null,
      warnings,
      // 上界：整段时间都空闲时的心跳次数与花费；人在工作的时段不发
      estimate: { maxPings, pingUsd, maxUsd: maxPings * pingUsd, saveUsd: keepSavingUsd(lineage.expectedCached, { model: lineage.model, ttl: lineage.ttl, cfg: this.cfg }), contextTokens: lineage.expectedCached },
    };
  }

  unpinSession(session, { source = 'api', reason = '取消长保活', action = 'unset' } = {}) {
    if (!session.pin) return { ok: true, sessionId: session.id, changed: false, stopped: [] };
    const pin = session.pin;
    session.pin = null;
    const stopped = [];
    const active = this.activePlanFor(session.id);
    if (active?.source === 'pin') {
      this.finishPlan(active, 'cancelled', reason);
      stopped.push(active.id);
    }
    this.appendEvent({ t: 'pin', at: this.now(), sid: session.id, action, untilAt: pin.untilAt, source, reason, cwd: session.cwd });
    this.log(`unpin session=${session.id.slice(0, 8)} ${action} ${reason}`);
    this.scheduleSave();
    return { ok: true, sessionId: session.id, changed: true, stopped };
  }

  // 真实请求失败后的宽限期：客户端在重试，会话算活跃
  inRetryGrace(lineage, now = this.now()) {
    const graceMs = (Number(this.cfg.requestRetryGraceSec) || 0) * 1000;
    return Boolean(lineage?.lastFailedAt) && now - lineage.lastFailedAt < graceMs;
  }

  maybeStartPinPlans(now = this.now()) {
    for (const session of this.sessions.values()) if (session.pin) this.maybeStartPinPlan(session, now);
  }

  maybeStartPinPlan(session, now = this.now()) {
    const pin = session.pin;
    if (!pin) return null;
    if (now >= pin.untilAt) {
      this.unpinSession(session, { source: 'scheduler', reason: '长保活到期', action: 'expired' });
      return null;
    }
    if (this.agentLookup(session)?.archived) {
      this.unpinSession(session, { source: 'scheduler', reason: 'Paseo 任务已归档，取消长保活', action: 'cancelled' });
      return null;
    }
    if (this.activePlanFor(session.id)) return null;
    const lineage = this.primaryLineage(session);
    if (!lineage?.lastRealStartAt || lineage.inflight > 0 || this.inRetryGrace(lineage, now)) return null;
    const settings = ttlSettings(lineage.ttl, this.cfg);
    if (!settings) return null;
    const interval = Math.min(settings.maxIntervalSec, Math.max(settings.minIntervalSec, pin.intervalSec || settings.intervalSec));
    const touch = lastTouchAt(lineage);
    if (now < touch + interval * 1000) return null;
    if (lineage.blocked) {
      this.unpinSession(session, { source: 'guard', reason: '上次心跳没命中已锁定，取消长保活', action: 'cancelled' });
      return null;
    }
    if (lineage.pingAnomaly) {
      this.unpinSession(session, { source: 'guard', reason: '心跳产生输出（上游没遵守 max_tokens），取消长保活', action: 'cancelled' });
      return null;
    }
    // 空闲 > TTL−安全边际：缓存多半已过期，这段不发（会变成整段重写）；等下一次真实请求后再接上。每段只记一次
    if (now - touch > (settings.ttlSec - settings.safetySec) * 1000) {
      if (lineage.pinMissedIdleAt !== lineage.lastRealStartAt) {
        lineage.pinMissedIdleAt = lineage.lastRealStartAt;
        this.appendEvent({ t: 'pin', at: now, sid: session.id, action: 'missed-window', untilAt: pin.untilAt, idleStartAt: lineage.lastRealStartAt, cwd: session.cwd });
        this.scheduleSave();
      }
      return null;
    }
    if (!lineage.snapshot || lineage.expectedCached <= 0) return null;
    if (lineage.ttlDowngraded) return null;
    const count = Math.max(1, Math.ceil((pin.untilAt - now) / (interval * 1000)));
    const plan = this.createPlan(session, lineage, { count, intervalSec: interval, source: 'pin', now, extra: { trigger: 'pin', pinUntilAt: pin.untilAt } });
    this.log(`pin plan session=${session.id.slice(0, 8)} count=${count} until=${new Date(pin.untilAt).toISOString()} context=${lineage.expectedCached}`);
    return plan;
  }

  // 页面/CLI 展示：自动保活对这个会话现在是什么状态、为什么
  autoView(session, lineage, now = this.now()) {
    const mode = this.cfg.auto?.mode === 'on' ? 'on' : 'off';
    const plan = this.activePlanFor(session.id);
    const view = { mode, disabled: session.autoDisabled || null, humanTurns: session.humanTurns || 0, cooldownUntil: this.autoCooldownUntil > now ? this.autoCooldownUntil : null };
    if (this.cfg.enabled === false) return { ...view, state: 'off', code: 'keepalive-off', message: KEEPALIVE_OFF_MESSAGE };
    if (plan?.source === 'auto') return { ...view, state: 'active', planId: plan.id, trigger: plan.trigger || null };
    if (session.pin) return { ...view, state: 'pinned', code: 'pinned', message: AUTO_SKIP_LABELS.pinned, untilAt: session.pin.untilAt };
    if (mode !== 'on') return { ...view, state: 'off' };
    if (session.autoDisabled) return { ...view, state: 'stopped' };
    if (!lineage) return { ...view, state: 'waiting' };
    const decided = lineage.autoEpisode?.idleStartAt === lineage.lastRealStartAt ? lineage.autoEpisode : null;
    if (decided && !decided.ok) return { ...view, state: 'skipped', code: decided.code, message: decided.message };
    if (decided?.ok) return { ...view, state: 'done', code: decided.code };
    if (plan) return { ...view, state: 'manual' };
    // 这段空闲已经发过心跳（手动计划刚结束）：调度器不会再开自动计划，别显示「已就绪」
    if (lineage.episode.pings.length) return { ...view, state: 'done', code: 'manual-pinged', message: '本段空闲已手动发过心跳，不再自动保活' };
    // 判定窗口（空闲 50–58 分钟）已过还没判定：调度器不会再发，如实显示而不是给一个过去的「已就绪」时间
    const settings = ttlSettings('1h', this.cfg);
    if (lineage.ttl === '1h' && settings && now - lastTouchAt(lineage) > (settings.ttlSec - settings.safetySec) * 1000) {
      return { ...view, state: 'skipped', code: 'missed-window', message: AUTO_SKIP_LABELS['missed-window'] };
    }
    // 还没到点：按现在的条件预判一次（真正判定在第一次心跳到点时）；没有快照时到点也发不了，如实显示
    let preview = autoEligibility(this.autoFeatures(session, lineage, now), { now: Math.max(now, this.autoDueAt(lineage)), cfg: this.cfg });
    if (preview.ok && !lineage.snapshot) preview = { ok: false, code: 'no-snapshot', message: '中继里没有该会话的请求快照（中继重启过），等它再发一次请求' };
    return { ...view, state: preview.ok ? 'armed' : 'ineligible', code: preview.code, message: preview.message || null, dueAt: this.autoDueAt(lineage) };
  }

  // 会话级开关：stop 时关闭，auto on 时恢复（默认同时解除未命中锁定，表示用户确认可以再试）。
  // clearBlocked=false 供「只恢复自动保活、不动锁定」的批量操作使用（如 auto reset --global）。
  setSessionAuto(session, enabled, { source = 'api', reason = null, clearBlocked = true } = {}) {
    if (enabled) {
      session.autoDisabled = null;
      const lineage = this.primaryLineage(session);
      if (clearBlocked && lineage) lineage.blocked = null;
    } else {
      session.autoDisabled = { at: this.now(), source, reason };
    }
    this.appendEvent({ t: 'auto', at: this.now(), sid: session.id, action: enabled ? 'enable' : 'disable', source, reason });
    this.scheduleSave();
  }

  // 「立即补一次」：已有计划时把它的下一次心跳提前到现在（计入次数）；没有计划时建一个 1 次的计划。
  pingNow(session, { force = false, source = 'api-ping' } = {}) {
    if (this.cfg.enabled === false) return { ok: false, sessionId: session.id, errors: [{ code: 'keepalive-off', message: KEEPALIVE_OFF_MESSAGE }], warnings: [] };
    if (this.primaryLineage(session)?.inflight > 0) {
      return { ok: false, sessionId: session.id, errors: [{ code: 'busy', message: '会话正有请求在途，缓存正被真实请求刷新，不需要心跳' }], warnings: [] };
    }
    const plan = this.activePlanFor(session.id);
    if (!plan) return this.startPlan(session, { count: 1, force, immediate: true, source });
    const lineage = this.primaryLineage(session);
    const check = evaluatePlanRequest({
      lineage: this.guardView(lineage),
      count: plan.count,
      intervalSec: plan.intervalSec,
      force: force || plan.forced,
      now: this.now(),
      cfg: this.cfg,
      daily: this.dailyUsage(),
    });
    if (!check.ok) return { ok: false, sessionId: session.id, errors: check.errors, warnings: check.warnings };
    plan.pingNowAt = this.now();
    plan.retryAt = null;
    plan.forced = plan.forced || force;
    return { ok: true, sessionId: session.id, plan: this.planView(plan), warnings: check.warnings };
  }

  finishPlan(plan, status, reason = null) {
    if (plan.status !== 'active') return;
    plan.status = status;
    plan.reason = reason;
    plan.endedAt = this.now();
    plan.state = status;
    if (status !== 'replaced') this.removePersistedSnapshots(this.sessions.get(plan.sessionId));
    this.appendEvent({ t: 'plan', at: plan.endedAt, sid: plan.sessionId, plan: plan.id, action: status, done: plan.done, count: plan.count, reason });
    this.scheduleSave();
  }

  // 手动 stop：停掉计划，并关闭这些会话的自动保活（整个会话不再继续保活）；不带目标时针对所有进行中的计划。
  // allSessions=true 时连没有进行中计划的会话也一并关闭（--global：取消所有当前会话的保活）。
  stopPlans(sessionIds, reason = '手动停止', { source = 'api', allSessions = false } = {}) {
    const stopped = [];
    const targets = new Set(sessionIds || []);
    for (const plan of this.activePlans()) {
      if (sessionIds && !targets.has(plan.sessionId)) continue;
      this.finishPlan(plan, 'cancelled', reason);
      stopped.push(plan.id);
      targets.add(plan.sessionId);
    }
    if (allSessions) for (const sessionId of this.sessions.keys()) targets.add(sessionId);
    const autoDisabled = [];
    const unpinned = [];
    for (const sessionId of targets) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      // stop 也取消长保活：用户说停就全停
      if (session.pin) {
        this.unpinSession(session, { source, reason, action: 'cancelled' });
        unpinned.push(sessionId);
      }
      if (session.autoDisabled) continue;
      this.setSessionAuto(session, false, { source, reason });
      autoDisabled.push(sessionId);
    }
    return { stopped, autoDisabled, unpinned };
  }

  // 总开关：off 停掉所有进行中的计划（自动/手动/长保活）并取消所有长保活；on 只打开开关，会话级关闭标记与锁定不动
  setEnabled(enabled, { source = 'api', reason = null } = {}) {
    const now = this.now();
    const stopped = [];
    const unpinned = [];
    if (!enabled) {
      for (const plan of this.activePlans()) {
        this.finishPlan(plan, 'cancelled', reason || '保活已全局关闭');
        stopped.push(plan.id);
      }
      for (const session of this.sessions.values()) {
        if (!session.pin) continue;
        this.unpinSession(session, { source, reason: reason || '保活已全局关闭', action: 'cancelled' });
        unpinned.push(session.id);
      }
    }
    this.cfg.enabled = enabled;
    this.appendEvent({ t: 'global', at: now, action: enabled ? 'on' : 'off', source, reason, stopped: stopped.length, unpinned: unpinned.length });
    this.log(`keepalive ${enabled ? 'ON' : 'OFF'} source=${source}${reason ? ` reason=${reason}` : ''} stopped=${stopped.length} unpinned=${unpinned.length}`);
    this.scheduleSave();
    return { enabled, stopped, unpinned };
  }

  // 全局关闭自动保活时，停掉进行中的自动计划（手动计划不动）。
  // 本段空闲不会再补发心跳（episode 已记过心跳）；等会话下一次真实请求之后，下一段空闲重新判定。
  cancelAutoPlans(reason = '自动保活已全局关闭') {
    const stopped = [];
    for (const plan of this.activePlans()) {
      if (plan.source !== 'auto') continue;
      this.finishPlan(plan, 'cancelled', reason);
      stopped.push(plan.id);
    }
    return stopped;
  }

  prunePlans() {
    const finished = [...this.plans.values()].filter(plan => TERMINAL_PLAN_STATUSES.has(plan.status)).sort((a, b) => b.createdAt - a.createdAt);
    for (const plan of finished.slice(MAX_FINISHED_PLANS)) this.plans.delete(plan.id);
  }

  planNextPingAt(plan, lineage) {
    if (!lineage) return null;
    if (plan.retryAt) return plan.retryAt;
    if (plan.pingNowAt) return plan.pingNowAt;
    const settings = ttlSettings(lineage.ttl, this.cfg);
    const interval = settings ? Math.min(plan.intervalSec, settings.maxIntervalSec) : plan.intervalSec;
    return lastTouchAt(lineage) + interval * 1000;
  }

  planView(plan, now = this.now()) {
    const session = this.sessions.get(plan.sessionId);
    const lineage = session ? this.primaryLineage(session) : null;
    // state 由调度 tick 推进（5s 一次）；请求刚结束时别再显示「暂缓」
    const state = plan.status === 'active' && plan.state === 'busy' && !(lineage?.inflight > 0) ? 'scheduled' : plan.state;
    return {
      id: plan.id,
      sessionId: plan.sessionId,
      source: plan.source === 'auto' || plan.source === 'pin' ? plan.source : 'manual',
      trigger: plan.trigger || null,
      pinUntilAt: plan.pinUntilAt || null,
      status: plan.status,
      state,
      reason: plan.reason,
      count: plan.count,
      done: plan.done,
      remaining: Math.max(0, plan.count - plan.done),
      intervalSec: plan.intervalSec,
      forced: plan.forced,
      createdAt: plan.createdAt,
      endedAt: plan.endedAt,
      lastPingAt: plan.lastPingAt,
      lastOutcome: plan.lastOutcome,
      errorStreak: plan.errorStreak || 0,
      lastError: plan.lastError || null,
      costUsd: plan.costUsd,
      nextPingAt: plan.status === 'active' ? this.planNextPingAt(plan, lineage) : null,
      inflight: plan.inflight,
      now,
    };
  }

  // 调度器每个 tick 调用：推进计划状态，返回此刻该发心跳的 [{ plan, lineage }]。
  duePlans() {
    const now = this.now();
    const due = [];
    const daily = this.dailyUsage();
    // 总开关关着：什么都不发（off 时已把计划和长保活取消；这里兜底，防止热加载配置后残留的计划继续发）
    if (this.cfg.enabled === false) {
      for (const plan of this.activePlans()) this.finishPlan(plan, 'cancelled', '保活已全局关闭');
      return due;
    }
    this.maybeStartPinPlans(now);
    this.maybeStartAutoPlans(now);
    // 预留：同一 tick 里多个会话一起到点、或心跳还在途时，按预估花费先占额度，避免一起越过每日上限
    let reservedPings = 0;
    let reservedUsd = 0;
    for (const plan of this.activePlans()) {
      if (!plan.inflight) continue;
      const lineage = this.lineages.get(plan.lineageKey);
      reservedPings += 1;
      reservedUsd += lineage ? pingCostEstimateUsd(lineage.expectedCached, { model: lineage.model, cfg: this.cfg }) : 0;
    }
    for (const plan of this.activePlans()) {
      if (plan.inflight) continue;
      if (now - plan.createdAt > this.cfg.planMaxAgeSec * 1000) {
        this.finishPlan(plan, 'expired', '计划超过最长有效期');
        continue;
      }
      const session = this.sessions.get(plan.sessionId);
      const lineage = session ? this.primaryLineage(session) : null;
      if (!lineage) {
        plan.state = 'waiting-snapshot';
        continue;
      }
      if (plan.source === 'auto' && this.agentLookup(session)?.archived) {
        this.finishPlan(plan, 'stopped', 'Paseo 任务已归档，停止自动保活');
        continue;
      }
      if (plan.source === 'pin' && this.agentLookup(session)?.archived) {
        this.unpinSession(session, { source: 'scheduler', reason: 'Paseo 任务已归档，取消长保活', action: 'cancelled' });
        continue;
      }
      // 主对话请求进行中时缓存由真实请求刷新（lastRealStartAt 在请求结束时才更新），不按时间判过期；
      // 真实请求刚失败、客户端在重试时同样算活跃
      if (lineage.inflight > 0 || this.inRetryGrace(lineage, now)) {
        plan.state = 'busy';
        continue;
      }
      const settings = ttlSettings(lineage.ttl, this.cfg);
      if (!settings) {
        this.finishPlan(plan, 'stopped', '当前请求没有 cache_control 断点');
        continue;
      }
      const touch = lastTouchAt(lineage);
      if (now - touch > (settings.ttlSec - settings.safetySec) * 1000) {
        if (plan.errorStreak) {
          this.finishPlan(plan, 'stopped', upstreamGaveUpReason(plan));
          this.notify({ kind: 'upstream-down', title: '心跳重试到缓存安全窗口截止仍失败', text: `会话 ${plan.sessionId.slice(0, 8)}：${upstreamGaveUpReason(plan)}`, sessionId: plan.sessionId, planId: plan.id });
        } else {
          this.finishPlan(plan, 'stopped', plan.state === 'waiting-auth'
            ? '中继重启后一直没等到该会话的凭证，缓存已过期，停止保活'
            : `距上次触达 ${Math.round((now - touch) / 60000)} 分钟，缓存可能已过期，不再发心跳`);
        }
        continue;
      }
      // 快照不在（中继重启且未落盘）：等会话再发一次请求；等不到就在上面的过期判断里结束
      if (!lineage.snapshot) {
        plan.state = lineage.compactedAt ? 'waiting-after-compact' : 'waiting-snapshot';
        continue;
      }
      if (lineage.snapshot.needsAuth && !this.authFor(lineage.snapshot, session)) {
        plan.state = 'waiting-auth';
        if (!plan.notifiedAuth) {
          plan.notifiedAuth = true;
          this.notify({ kind: 'waiting-auth', title: '中继重启后计划在等凭证', text: `会话 ${plan.sessionId.slice(0, 8)} 的保活计划 ${plan.id} 等该会话（或同一把 token）再发一次请求才能继续心跳；缓存 ${new Date(touch + settings.ttlSec * 1000).toLocaleTimeString('zh-CN', { hour12: false })} 过期`, sessionId: plan.sessionId, planId: plan.id });
        }
        continue;
      }
      if (lineage.blocked && !plan.forced) {
        this.finishPlan(plan, 'stopped', '上次心跳未命中缓存，已停止');
        continue;
      }
      const nextAt = this.planNextPingAt(plan, lineage);
      if (now < nextAt) {
        plan.state = plan.retryAt ? 'retrying' : 'scheduled';
        continue;
      }
      const estimateUsd = pingCostEstimateUsd(lineage.expectedCached, { model: lineage.model, cfg: this.cfg });
      if (daily.pings + reservedPings >= this.cfg.maxPingsPerDay || daily.usd + reservedUsd + estimateUsd > this.cfg.maxUsdPerDay) {
        if (plan.state !== 'daily-budget') {
          this.notify({ kind: 'daily-budget', title: '今日心跳额度已用完', text: `今日已发 ${daily.pings} 次 / $${daily.usd.toFixed(2)}（上限 ${this.cfg.maxPingsPerDay} 次 / $${this.cfg.maxUsdPerDay}），会话 ${plan.sessionId.slice(0, 8)} 的心跳暂停`, sessionId: plan.sessionId, planId: plan.id });
        }
        plan.state = 'daily-budget';
        continue;
      }
      reservedPings += 1;
      reservedUsd += estimateUsd;
      plan.state = 'pinging';
      due.push({ plan, lineage });
    }
    return due;
  }

  // result = { startedAt, endedAt, status, summary, error, maxTokens, timedOut }
  recordPing(plan, lineage, result) {
    const usage = result.summary?.usage || null;
    const ok = result.status >= 200 && result.status < 300 && !result.error;
    let outcome = ok ? classifyPing(usage, lineage.expectedCached, this.cfg) : 'error';
    if (result.timedOut) outcome = 'timeout';
    // 超时 / 没有 usage：上游多半已做完 prefill 并计费，按读一遍前缀估算成本，账本与每日额度都算进去（否则是下界）
    const estimated = ESTIMATED_OUTCOMES.has(outcome);
    const costUsd = estimated
      ? pingCostEstimateUsd(lineage.expectedCached, { model: lineage.model, cfg: this.cfg })
      : usageCostUsd(usage, { model: lineage.model, ttl: lineage.ttl, cfg: this.cfg });
    const daily = this.dailyUsage();
    daily.pings += 1;
    daily.usd += costUsd;
    const expected = lineage.expectedCached;
    const source = plan.source === 'auto' || plan.source === 'pin' ? plan.source : 'manual';
    this.appendEvent({
      t: 'ping',
      at: result.startedAt,
      sid: lineage.sessionId,
      lk: lineage.key,
      plan: plan.id,
      source,
      model: lineage.model,
      ttl: lineage.ttl,
      cwd: this.sessions.get(lineage.sessionId)?.cwd || null,
      idleStartAt: lineage.lastRealStartAt || null,
      status: result.status,
      ms: result.endedAt - result.startedAt,
      maxTokens: result.maxTokens,
      expected,
      usage,
      outcome,
      costUsd,
      estimated,
      error: result.error || null,
    });
    lineage.lastPing = { at: result.startedAt, outcome, costUsd, estimated, usage, status: result.status, error: result.error || null };
    // 心跳在途时真实请求先结束：这发心跳属于上一段空闲，不计入下一次「回来」的归因
    const superseded = result.startedAt < lineage.lastRealStartAt;
    if (!superseded) lineage.episode.pings.push({ at: result.startedAt, outcome, cacheRead: usage?.cacheRead || 0, costUsd, source });
    plan.lastPingAt = result.startedAt;
    plan.lastOutcome = outcome;
    plan.costUsd += costUsd;
    plan.retryAt = null;
    plan.pingNowAt = null;

    // 上游没遵守 max_tokens：每次心跳都会按输出价（和思考）计费。停发，并且不再自动保活这个会话
    const anomaly = outcome !== 'error' && outcome !== 'unknown' && (usage?.output || 0) > MAX_PING_OUTPUT_TOKENS;
    if (anomaly) lineage.pingAnomaly = { at: result.startedAt, output: usage.output, maxTokens: result.maxTokens };
    if (outcome === 'hit') {
      lineage.lastHitPingAt = Math.max(lineage.lastHitPingAt || 0, result.startedAt);
      if (!superseded) lineage.expectedCached = usage.cacheRead + usage.cacheWrite;
      lineage.blocked = null;
      plan.done += 1;
      plan.errorStreak = 0;
      plan.lastError = null;
      if (anomaly) {
        this.finishPlan(plan, 'stopped', `心跳产生了 ${usage.output} 个输出 token（max_tokens=${result.maxTokens}，上游没遵守），已停止`);
        const pinnedSession = this.sessions.get(lineage.sessionId);
        if (plan.source === 'pin' && pinnedSession?.pin) this.unpinSession(pinnedSession, { source: 'guard', reason: '心跳产生输出（上游没遵守 max_tokens），取消长保活', action: 'cancelled' });
      }
      else if (plan.done >= plan.count) this.finishPlan(plan, 'completed', `已完成 ${plan.done} 次心跳`);
    } else if (outcome === 'miss' || outcome === 'rewrite') {
      // 真实会话里 Claude Code 的系统与工具前缀常被其他会话保活，会话自己的缓存没了时
      // 表现为「读到共享前缀 + 大量重写」而不是 cache_read=0：两者同样锁定，再发只会反复重写。
      const detail = `只读到 ${usage.cacheRead}/${expected} tokens、重写 ${usage.cacheWrite}`;
      lineage.blocked = { at: result.startedAt, detail };
      this.finishPlan(plan, 'stopped', `心跳没命中会话缓存（${detail}），已停止并锁定该会话`);
      const pinnedSession = this.sessions.get(lineage.sessionId);
      if (plan.source === 'pin' && pinnedSession?.pin) this.unpinSession(pinnedSession, { source: 'guard', reason: `心跳没命中会话缓存（${detail}），已锁定并取消长保活`, action: 'cancelled' });
      this.notify({ kind: 'miss', title: `${source === 'auto' ? '自动' : '手动'}心跳没命中，会话已锁定`, text: `会话 ${lineage.sessionId.slice(0, 8)}（${lineage.model}）${detail}，这一发按整段重写计费 $${costUsd.toFixed(3)}；确认后用 auto on / ping --force 解锁`, sessionId: lineage.sessionId, planId: plan.id, costUsd });
      if (source === 'auto') {
        // 1h 缓存在 50 分钟时没命中不正常（上游换了账号、改了 TTL 等）：全局暂停新的自动保活，避免一连串整段重写
        this.autoCooldownUntil = this.now() + (Number(this.cfg.auto?.missCooldownSec) || 0) * 1000;
        this.appendEvent({ t: 'auto', at: this.now(), sid: lineage.sessionId, action: 'cooldown', until: this.autoCooldownUntil, detail });
        this.log(`auto keepalive paused until ${new Date(this.autoCooldownUntil).toISOString()} after miss session=${lineage.sessionId.slice(0, 8)}`);
        this.notify({ kind: 'cooldown', title: '自动保活已全局暂停', text: `自动心跳没命中，新的自动保活暂停到 ${new Date(this.autoCooldownUntil).toLocaleString('zh-CN', { hour12: false })}；排查上游账号粘性/TTL 后用 auto set --clear-cooldown 解除`, until: this.autoCooldownUntil });
      }
    } else if (outcome === 'partial') {
      this.finishPlan(plan, 'stopped', `心跳只读到 ${usage.cacheRead}/${expected} tokens，前缀已变化，停止保活`);
    } else if (outcome === 'unknown') {
      this.finishPlan(plan, 'stopped', '心跳响应没有 usage，无法确认命中，停止保活（成本按预估记）');
    } else {
      plan.errorStreak += 1;
      plan.lastError = result.error || `HTTP ${result.status}`;
      if (outcome === 'timeout' && plan.errorStreak >= 2) {
        this.notify({ kind: 'ping-timeout', title: '心跳连续超时', text: `会话 ${lineage.sessionId.slice(0, 8)}（前缀 ${expected} tokens）心跳连续 ${plan.errorStreak} 次超过 ${Math.round(this.cfg.pingTimeoutMs / 1000)}s，上游可能已处理并计费（每次约 $${costUsd.toFixed(3)}，已按预估记账）`, sessionId: lineage.sessionId, planId: plan.id });
      }
      if (outcome === 'timeout' || isTransientPingError(result.status)) {
        // 网关/上游暂时不可用：会话缓存多半还在（从上次触达起算），退避重试到 TTL 安全窗口截止。
        // 超时时上游可能还在处理上一发，至少等 pingRetryTimeoutDelaySec 再发
        const settings = ttlSettings(lineage.ttl, this.cfg);
        const deadline = lastTouchAt(lineage) + ((settings?.ttlSec || 0) - (settings?.safetySec || 0)) * 1000;
        let backoffSec = Math.min(this.cfg.pingRetryDelaySec * 2 ** (plan.errorStreak - 1), this.cfg.pingRetryMaxDelaySec);
        if (outcome === 'timeout') backoffSec = Math.max(backoffSec, this.cfg.pingRetryTimeoutDelaySec || 0);
        const retryAt = Math.min(this.now() + backoffSec * 1000, deadline - MIN_RETRY_LEAD_MS);
        if (retryAt - this.now() < MIN_RETRY_LEAD_MS) this.finishPlan(plan, 'stopped', upstreamGaveUpReason(plan));
        else {
          plan.retryAt = retryAt;
          plan.state = 'retrying';
        }
      } else if (plan.errorStreak >= 2) {
        this.finishPlan(plan, 'stopped', `心跳连续失败：${plan.lastError}`);
      } else {
        plan.retryAt = this.now() + this.cfg.pingRetryDelaySec * 1000;
        plan.state = 'retrying';
      }
    }
    this.scheduleSave();
    return { outcome, costUsd, usage };
  }

  // ---------------------------------------------------------------- 汇总

  pendingEpisodes(now = this.now()) {
    const out = [];
    for (const lineage of this.lineages.values()) {
      const hits = lineage.episode.pings.filter(ping => ping.outcome === 'hit');
      if (!hits.length) continue;
      const ttlMs = (TTL_SEC[lineage.ttl] || 0) * 1000;
      const alive = now - lineage.lastHitPingAt <= ttlMs;
      out.push({
        sessionId: lineage.sessionId,
        lineageKey: lineage.key,
        state: alive ? 'pending' : 'expired-unused',
        pings: lineage.episode.pings.length,
        pingCostUsd: lineage.episode.pings.reduce((sum, ping) => sum + (ping.costUsd || 0), 0),
        potentialUsd: alive ? keepSavingUsd(lineage.expectedCached, { model: lineage.model, ttl: lineage.ttl, cfg: this.cfg }) : 0,
        keptUntil: lineage.lastHitPingAt + ttlMs,
      });
    }
    return out;
  }

  summary({ days = 7 } = {}) {
    const now = this.now();
    const since = now - days * DAY_MS;
    const pending = this.pendingEpisodes(now);
    const result = summarizeEvents(this.events, { since, pending });
    const cwdBySession = new Map([...this.sessions.values()].map(session => [session.id, session.cwd]));
    for (const row of result.sessions) row.cwd = cwdBySession.get(row.sessionId) || null;
    return { days, since, now, ...result, pending, budget: { ...this.dailyUsage(), maxPings: this.cfg.maxPingsPerDay, maxUsd: this.cfg.maxUsdPerDay } };
  }

  recentEvents(limit = 100) {
    return this.events.slice(-limit).reverse();
  }

  // 保活执行记录：每个计划发了几次、每次结果、最后有没有保住
  episodes({ days = 7, sessionId = null, limit = 200 } = {}) {
    const now = this.now();
    const since = now - days * DAY_MS;
    const events = sessionId ? this.events.filter(event => event.sid && String(event.sid).startsWith(sessionId)) : this.events;
    const built = buildEpisodes(events, { now, since, limit });
    for (const episode of built.episodes) {
      const session = this.sessions.get(episode.sessionId);
      if (!episode.cwd && session?.cwd) episode.cwd = session.cwd;
      episode.active = this.plans.get(episode.planId)?.status === 'active';
    }
    return { days, since, now, ...built };
  }

  // 清理：长时间不活跃的会话、已确定过期的快照
  prune() {
    const now = this.now();
    const planned = new Set(this.activePlans().map(plan => plan.sessionId));
    for (const lineage of this.lineages.values()) {
      if (!lineage.snapshot || planned.has(lineage.sessionId)) continue;
      const ttlMs = (TTL_SEC[lineage.ttl] || 300) * 1000;
      if (now - lastTouchAt(lineage) > ttlMs + 15 * 60 * 1000) this.dropSnapshot(lineage);
    }
    for (const session of this.sessions.values()) {
      if (session.inflight || planned.has(session.id) || now - session.lastSeenAt < STALE_SESSION_MS) continue;
      for (const key of session.lineageKeys) {
        const lineage = this.lineages.get(key);
        if (lineage) this.dropSnapshot(lineage);
        this.lineages.delete(key);
      }
      this.sessions.delete(session.id);
    }
    const cutoff = now - this.cfg.ledgerRetentionDays * DAY_MS;
    if (this.events.length && this.events[0].at < cutoff) this.events = this.events.filter(event => event.at >= cutoff);
    this.scheduleSave();
  }
}

// 凭证指纹：只用来把恢复的快照和同一把凭证对上，不可逆、不落凭证本身
function authFingerprintOf(headers) {
  const secret = headers.authorization || headers['x-api-key'] || '';
  return secret ? createHash('sha256').update(String(secret)).digest('hex').slice(0, 16) : null;
}

function upstreamGaveUpReason(plan) {
  return `心跳连续失败 ${plan.errorStreak} 次（最后：${plan.lastError}），已到缓存安全窗口，停止保活`;
}

export function lastTouchAt(lineage) {
  return Math.max(lineage.lastRealStartAt || 0, lineage.lastHitPingAt || 0);
}

function realpathOr(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeTextAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

