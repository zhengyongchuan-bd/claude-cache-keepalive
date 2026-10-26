#!/usr/bin/env node
// Claude Code ↔ 上游网关（任何兼容 Anthropic Messages API 的网关）之间的缓存保活中继：
//   1. 透明转发所有请求（SSE 原样流式回传）；
//   2. 旁路记下每个会话最近一次 /v1/messages 请求（内存快照）与 usage；
//   3. 按手动下发的保活计划，用快照发 max_tokens:0 的零输出心跳刷新缓存 TTL；
//   4. 在 /keepalive/ 提供控制 API 与 Web 页面。

import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { AUTO_SKIP_LABELS, DEFAULT_CONFIG, OUTCOME_LABELS, UsageTap, buildPingBody, mergeConfig, parseMessagesRequest } from './core.js';
import { KeepaliveStore } from './store.js';
import { createAgentLookup } from './agents.js';
import { findPaseoAgentByPrefix, lookupPaseoAgents } from './paseo.js';

const __filename = fileURLToPath(import.meta.url);
const PUBLIC_DIR = path.join(path.dirname(__filename), 'public');
const HOP_BY_HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
const STATIC_FILES = new Map([['', 'index.html'], ['index.html', 'index.html'], ['app.js', 'app.js'], ['styles.css', 'styles.css']]);
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_API_BODY = 64 * 1024;
const PING_BLOCKED = {
  'waiting-snapshot': '中继里没有该会话的请求快照（中继重启过），等会话再发一次请求后才能心跳',
  'daily-budget': '今日心跳额度已用完',
  busy: '会话正有请求在途，缓存正被真实请求刷新，不需要心跳',
  'waiting-after-compact': '会话刚压缩过，旧前缀不会再被读到；等压缩后的下一次请求',
  'waiting-auth': '中继重启后还没见过凭证，等任一请求经过中继',
};
const TICK_MS = 5000;
const BACKTEST_CACHE_MS = 10 * 60 * 1000;
// 重启时等在途的流式响应结束的上限；之后最多再等 FLUSH_MS 让在途心跳记完账；systemd 单元的 TimeoutStopSec 要比两者之和长
const DRAIN_MS = 120000;
const FLUSH_MS = 60000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const TOKEN_HEADER = 'x-cache-keepalive-token';
const TOKEN_META = '<meta name="cache-keepalive-token" content="">';

export function defaultPaths() {
  const configDir = process.env.CACHE_KEEPALIVE_CONFIG_DIR || path.join(os.homedir(), '.config', 'cache-keepalive');
  const stateDir = process.env.CACHE_KEEPALIVE_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'cache-keepalive');
  return { configDir, configFile: path.join(configDir, 'config.json'), stateDir };
}

// 优先级：默认值 < ~/.config/cache-keepalive/config.json < 环境变量 < 命令行参数
export function loadConfig(overrides = {}) {
  const { configFile } = defaultPaths();
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`配置文件解析失败 ${configFile}: ${error.message}`);
  }
  const env = {};
  if (process.env.CACHE_KEEPALIVE_UPSTREAM) env.upstream = process.env.CACHE_KEEPALIVE_UPSTREAM;
  if (process.env.CACHE_KEEPALIVE_HOST) env.host = process.env.CACHE_KEEPALIVE_HOST;
  if (process.env.CACHE_KEEPALIVE_PORT) env.port = Number(process.env.CACHE_KEEPALIVE_PORT);
  const cleaned = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  return mergeConfig(mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), env), cleaned);
}

// watchConfig = { file, load }：配置文件变化时热加载（端口/上游除外），不必重启丢内存快照；页面改自动保活设置也写这个文件。
// agentLookup(session) → { status, archived } | null：会话对应的任务还在不在（默认 agents.js：进程探测 + 可选 Paseo；测试可替换）
export function createRelay({ cfg, stateDir = null, now = () => Date.now(), log = defaultLog, watchConfig = null, agentLookup = null, backtestRunner = null } = {}) {
  const target = new URL(cfg.upstream);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`不支持的上游协议: ${target.protocol}`);
  const transport = target.protocol === 'https:' ? https : http;
  const lookupAgent = agentLookup || createAgentLookup({ cfg, now, log });
  const stats = { requests: 0, messages: 0, captured: 0, upstreamErrors: 0, pings: 0, configReloads: 0, drainRejected: 0, tickErrors: 0, alertsSent: 0, alertsFailed: 0, tokenRejected: 0, rejectedTooLarge: 0 };
  const notifier = createNotifier({ cfg, now, log, stats, transportFor: url => (url.protocol === 'https:' ? https : http) });
  const notify = alert => notifier.send(alert);
  const store = new KeepaliveStore({ cfg, stateDir, now, log, agentLookup: lookupAgent, notify });
  store.load();
  if (stateDir && cfg.controlToken !== false && !store.controlToken) log('控制口令不可用，控制 API 写操作退化为不校验口令');
  const startedAt = now();
  let lastTickError = null;
  let backtestCache = null;
  const pingPromises = new Map();
  let listenPort = cfg.port;
  let tickTimer = null;
  let pruneTimer = null;
  let inflight = 0;
  let draining = false;
  const drainWaiters = new Set();
  let configMtime = watchConfig ? fileMtime(watchConfig.file) : null;

  // 在途的转发请求计数，供健康检查与优雅退出使用
  function trackInflight(res) {
    inflight += 1;
    res.once('close', () => {
      inflight -= 1;
      if (inflight === 0) for (const resolve of drainWaiters) resolve();
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://relay.local');
    if (url.pathname === '/keepalive' || url.pathname.startsWith('/keepalive/')) {
      handleControl(req, res, url).catch(error => sendJson(res, 500, { ok: false, error: error.message }));
      return;
    }
    stats.requests += 1;
    // 退出排空期间不接新请求：忙碌的会话会在已有的 keep-alive 连接上不断发新请求，在途数降不到 0，
    // 排空等满上限后会把正在流式输出的请求一起切断。新请求直接 503，Claude Code 退避重试到新进程。
    if (draining) {
      stats.drainRejected += 1;
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json', connection: 'close', 'x-should-retry': 'true' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'cache-keepalive relay is restarting, retry shortly' } }));
      return;
    }
    trackInflight(res);
    if (req.method === 'POST' && url.pathname === '/v1/messages') proxyMessages(req, res, url);
    else proxyPassthrough(req, res, url);
  });
  // 1M 上下文的请求体可能很大，客户端（Claude Code）自己管超时
  server.requestTimeout = 0;
  server.headersTimeout = 120000;

  // ------------------------------------------------------------------ 转发

  function upstreamOptions(method, url, headers, extra = {}) {
    const base = target.pathname.replace(/\/+$/, '');
    return {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method,
      path: `${base}${url.pathname}${url.search}`,
      headers,
      agent: false,
      ...extra,
    };
  }

  function forwardHeaders(headers, bodyLength) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!HOP_BY_HOP.has(name) && name !== 'host') out[name] = value;
    }
    out.host = target.host;
    if (bodyLength != null) out['content-length'] = String(bodyLength);
    return out;
  }

  function proxyPassthrough(req, res, url) {
    const upstreamReq = transport.request(upstreamOptions(req.method, url, forwardHeaders(req.headers)), upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, stripHopByHop(upstreamRes.headers));
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.pipe(res);
    });
    let clientClosed = false;
    upstreamReq.on('error', error => {
      if (clientClosed) return;
      stats.upstreamErrors += 1;
      log(`转发失败 ${req.method} ${url.pathname}: ${error.code || error.message}`);
      sendUpstreamError(res, error);
    });
    res.on('close', () => {
      if (res.writableFinished) return;
      clientClosed = true;
      upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  }

  function proxyMessages(req, res, url) {
    stats.messages += 1;
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      // 中继要整段缓冲后再转发：超过上限直接拒绝，不让一个异常请求把内存吃光
      if (size > cfg.maxBodyBytes) {
        tooLarge = true;
        stats.rejectedTooLarge = (stats.rejectedTooLarge || 0) + 1;
        log(`请求体超过 ${cfg.maxBodyBytes} 字节，拒绝转发`);
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `cache-keepalive relay: request body exceeds ${cfg.maxBodyBytes} bytes` } }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks);
      let ctx = null;
      if (!req.headers['content-encoding']) {
        // 记账失败不能影响转发：解析异常时这次请求只透传
        try {
          const meta = parseMessagesRequest(body.toString('utf8'), req.headers);
          if (meta.ok) ctx = store.beginRequest(meta);
        } catch (error) {
          log(`解析请求失败（仅透传）: ${error.message}`);
        }
      }
      // 记下凭证（只在内存）并关联到会话：重启后恢复的快照可以借同一会话后来的 token，哪怕已经轮换
      store.noteAuth(req.headers, ctx?.session || null);
      const headers = forwardHeaders(req.headers, body.length);
      // 旁路解析 usage 需要明文；本机回环不需要压缩
      headers['accept-encoding'] = 'identity';
      let finished = false;
      let responseStarted = false;
      const finish = async (status, tap) => {
        if (finished) return;
        finished = true;
        if (!ctx) return;
        try {
          const summary = tap ? await tap.finish() : null;
          const snapshot = body.length <= cfg.maxCaptureBytes
            ? { body, headers: replayHeaders(req.headers), path: `${url.pathname}${url.search}` }
            : null;
          if (snapshot && summary?.sawStart) stats.captured += 1;
          store.endRequest(ctx, { status, summary, snapshot });
        } catch (error) {
          ctx.session.inflight = Math.max(0, ctx.session.inflight - 1);
          ctx.lineage.inflight = Math.max(0, (ctx.lineage.inflight || 0) - 1);
          log(`记录请求失败: ${error.stack || error.message}`);
        }
      };
      const upstreamReq = transport.request(upstreamOptions('POST', url, headers), upstreamRes => {
        responseStarted = true;
        const status = upstreamRes.statusCode || 502;
        res.writeHead(status, stripHopByHop(upstreamRes.headers));
        const tap = ctx ? createTap(upstreamRes.headers) : null;
        upstreamRes.on('data', chunk => tap?.push(chunk));
        // 用户中途打断（ESC）时提示词已被处理、缓存已写入，仍按已收到的 usage 更新快照
        upstreamRes.on('error', error => {
          if (!clientClosed) log(`上游响应中断 session=${ctx?.session.id.slice(0, 8) || '-'}: ${error.code || error.message}`);
          res.destroy();
        });
        upstreamRes.on('close', () => finish(status, tap));
        upstreamRes.pipe(res);
      });
      let clientClosed = false;
      upstreamReq.on('error', error => {
        // 响应开始后的中断由 upstreamRes 的 close 收尾
        if (responseStarted) return;
        // 客户端先断开：这是我们自己销毁的上游请求，不算上游故障
        if (clientClosed) {
          finish(0, null);
          return;
        }
        stats.upstreamErrors += 1;
        log(`转发失败 POST ${url.pathname} session=${ctx?.session.id.slice(0, 8) || '-'}: ${error.code || error.message}`);
        sendUpstreamError(res, error);
        finish(502, null);
      });
      res.on('close', () => {
        if (res.writableFinished) return;
        clientClosed = true;
        upstreamReq.destroy(new Error('client closed'));
      });
      upstreamReq.end(body);
    });
  }

  // ------------------------------------------------------------------ 心跳

  function postPing(snapshot, maxTokens, session = null) {
    return new Promise(resolve => {
      const startedAt = now();
      let timedOut = false;
      const done = extra => resolve({ startedAt, endedAt: now(), maxTokens, timedOut, ...extra });
      let body;
      try {
        body = Buffer.from(buildPingBody(snapshot.body.toString('utf8'), { maxTokens }));
      } catch (error) {
        done({ status: 0, error: `构造心跳请求体失败: ${error.message}` });
        return;
      }
      const headers = { ...store.pingHeaders(snapshot, session), host: target.host, 'content-length': String(body.length), 'accept-encoding': 'identity', accept: 'application/json' };
      const pingUrl = new URL(snapshot.path, 'http://relay.local');
      const req = transport.request(upstreamOptions('POST', pingUrl, headers, { timeout: cfg.pingTimeoutMs }), res => {
        const status = res.statusCode || 0;
        const tap = createTap(res.headers);
        const errorParts = [];
        let errorBytes = 0;
        res.on('data', chunk => {
          tap?.push(chunk);
          if (status >= 400 && errorBytes < 4096) {
            errorParts.push(chunk);
            errorBytes += chunk.length;
          }
        });
        res.on('close', async () => {
          const summary = tap ? await tap.finish().catch(() => null) : null;
          const errorText = errorParts.length ? Buffer.concat(errorParts).toString('utf8').slice(0, 4096) : '';
          const error = status >= 200 && status < 300 ? summary?.error || null : (summary?.error || `HTTP ${status}`);
          done({ status, summary, error, errorText });
        });
      });
      req.on('timeout', () => {
        timedOut = true;
        req.destroy(new Error(`心跳超时 ${cfg.pingTimeoutMs}ms（上游可能仍在处理并计费）`));
      });
      req.on('error', error => done({ status: 0, error: error.message }));
      req.end(body);
    });
  }

  async function sendPing(plan, lineage) {
    plan.inflight = true;
    stats.pings += 1;
    try {
      const snapshot = lineage.snapshot;
      const session = store.sessions.get(lineage.sessionId) || null;
      let maxTokens = lineage.pingMaxTokens || 0;
      let result = await postPing(snapshot, maxTokens, session);
      // 个别网关/上游不接受 max_tokens:0，退回 1 个输出 token 再试一次
      if (result.status === 400 && maxTokens === 0 && /max_tokens/i.test(result.errorText || result.error || '')) {
        lineage.pingMaxTokens = maxTokens = 1;
        result = await postPing(snapshot, maxTokens, session);
      }
      const recorded = store.recordPing(plan, lineage, result);
      const usage = recorded.usage;
      log(`ping session=${lineage.sessionId.slice(0, 8)} plan=${plan.id} ${OUTCOME_LABELS[recorded.outcome] || recorded.outcome}`
        + ` status=${result.status} read=${usage?.cacheRead ?? '-'} write=${usage?.cacheWrite ?? '-'} out=${usage?.output ?? '-'}`
        + ` cost=$${recorded.costUsd.toFixed(4)}${recorded.estimated ? '(估)' : ''} ${result.error ? `error=${result.error}` : ''}`);
      return { ...recorded, status: result.status, error: result.error || null };
    } finally {
      plan.inflight = false;
    }
  }

  function reloadConfigIfChanged() {
    if (!watchConfig) return;
    const mtime = fileMtime(watchConfig.file);
    if (mtime === configMtime) return;
    configMtime = mtime;
    try {
      const next = watchConfig.load();
      for (const key of ['host', 'port', 'upstream']) {
        if (next[key] !== cfg[key]) log(`配置项 ${key} 变更需要重启中继才生效`);
      }
      for (const [key, value] of Object.entries(next)) if (!['host', 'port', 'upstream'].includes(key)) cfg[key] = value;
      stats.configReloads += 1;
      log(`已热加载配置 ${watchConfig.file}`);
    } catch (error) {
      log(`配置热加载失败，沿用旧配置: ${error.message}`);
    }
  }

  // 调度异常不能吞掉也不能让进程崩：计数、留最后一次错误，健康检查里能看到
  function tick() {
    if (draining) return;
    try {
      reloadConfigIfChanged();
      for (const { plan, lineage } of store.duePlans()) {
        const promise = sendPing(plan, lineage)
          .catch(error => {
            log(`ping 异常: ${error.stack || error.message}`);
            return { outcome: 'error', error: error.message };
          })
          .finally(() => pingPromises.delete(plan.id));
        pingPromises.set(plan.id, promise);
      }
    } catch (error) {
      stats.tickErrors += 1;
      lastTickError = { at: now(), message: error.message };
      log(`调度异常: ${error.stack || error.message}`);
      notify({ kind: 'tick-error', title: '保活调度出现异常', text: `第 ${stats.tickErrors} 次：${error.message}` });
    }
  }

  // ------------------------------------------------------------------ 控制 API

  async function handleControl(req, res, url) {
    const denied = checkAccess(req);
    if (denied) return sendJson(res, denied.status, { ok: false, error: denied.error });
    const sub = url.pathname.replace(/^\/keepalive\/?/, '');
    // 页面自己要发写操作：把口令注入 index.html（页面只能从回环 Host 读到，和 CLI 读文件是同一级别的信任）
    if (!sub.startsWith('api/')) return serveStatic(res, url, sub, tokenRequired() ? store.controlToken : '');
    const route = `${req.method} ${sub.slice(4)}`;
    const input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJsonBody(req);
    switch (route) {
      case 'GET health':
        return sendJson(res, 200, health());
      case 'GET sessions':
        return sendJson(res, 200, listSessions(input));
      case 'POST plans':
        return sendJson(res, 200, startPlans(input));
      case 'POST plans/stop':
        return sendJson(res, 200, stopPlans(input));
      case 'POST ping':
        return sendJson(res, 200, await pingNow(input));
      case 'GET auto':
        return sendJson(res, 200, { ok: true, auto: autoSettings(), labels: AUTO_SKIP_LABELS });
      case 'POST auto':
        return sendJson(res, 200, updateAuto(input));
      case 'POST sessions/auto':
        return sendJson(res, 200, setSessionAuto(input));
      case 'POST sessions/pin':
        return sendJson(res, 200, setSessionPin(input));
      case 'POST keepalive':
        return sendJson(res, 200, setEnabled(input));
      case 'GET backtest':
        return sendJson(res, 200, await backtest(input).catch(error => ({ ok: false, error: error.message })));
      case 'GET summary':
        return sendJson(res, 200, store.summary({ days: clampNumber(input.days, 1, 35, 7) }));
      case 'GET events':
        return sendJson(res, 200, { events: store.recentEvents(clampNumber(input.limit, 1, 1000, 100)) });
      case 'GET episodes': {
        let sessionId = input.session ? String(input.session) : null;
        if (!sessionId && input.agent) {
          const resolved = resolveTargets({ agent: input.agent, agentCwd: input.agentCwd, cwd: input.cwd });
          if (!resolved.matches.length) return sendJson(res, 200, { ok: false, error: describeMiss({ agent: input.agent }, resolved), episodes: [], totals: {} });
          sessionId = resolved.matches[0].id;
        }
        const result = store.episodes({ days: clampNumber(input.days, 1, 35, 7), sessionId, limit: clampNumber(input.limit, 1, 1000, 200) });
        // 带上任务标题，页面/CLI 显示更直观
        const titles = new Map(decorate([...new Set(result.episodes.map(e => e.sessionId))].map(id => ({ id, cwd: store.sessions.get(id)?.cwd || null }))).map(view => [view.id, view.paseo]));
        for (const episode of result.episodes) episode.paseo = titles.get(episode.sessionId) || null;
        return sendJson(res, 200, { ok: true, ...result });
      }
      default:
        return sendJson(res, 404, { ok: false, error: `未知接口 ${route}` });
    }
  }

  // 只认回环主机名（端口不限，SSH 隧道转发时本地端口常不同），防 DNS rebinding；其他域名需显式配置 allowedHosts。
  // 写操作还要带 x-cache-keepalive-token（stateDir/control.token）：同机其他用户、拿不到该文件的进程不能触发计费心跳或停掉保活。
  function checkAccess(req) {
    const host = String(req.headers.host || '').toLowerCase();
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    const allowed = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || (cfg.allowedHosts || []).includes(hostname);
    if (!allowed) return { status: 403, error: `Host ${host} 不在允许列表` };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // 写操作会触发计费心跳：要求 JSON（跨站表单无法不经预检发送），带 Origin 时必须同源
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return { status: 415, error: '写操作需要 Content-Type: application/json' };
      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch { /* 非法 Origin */ }
        if (originHost !== host) return { status: 403, error: `跨站请求被拒绝: ${origin}` };
      }
      if (tokenRequired()) {
        const given = String(req.headers[TOKEN_HEADER] || '');
        if (!given || !timingSafeEqualText(given, store.controlToken)) {
          stats.tokenRejected = (stats.tokenRejected || 0) + 1;
          return { status: 401, error: `写操作需要 ${TOKEN_HEADER} 请求头（值在 ${path.join(store.stateDir, 'control.token')}；CLI 会自动读取，或设 CACHE_KEEPALIVE_TOKEN）` };
        }
      }
    }
    return null;
  }

  const tokenRequired = () => cfg.controlToken !== false && Boolean(store.controlToken);

  function health() {
    const plans = store.activePlans();
    return {
      ok: true,
      service: 'cache-keepalive',
      enabled: cfg.enabled !== false,
      upstream: target.origin + target.pathname.replace(/\/+$/, ''),
      listen: `http://${cfg.host}:${listenPort}`,
      startedAt,
      uptimeSec: Math.round((now() - startedAt) / 1000),
      stats,
      inflight,
      sessions: store.sessions.size,
      snapshots: [...store.lineages.values()].filter(lineage => lineage.snapshot).length,
      snapshotBytes: store.snapshotBytes,
      activePlans: plans.length,
      autoPlans: plans.filter(plan => plan.source === 'auto').length,
      pinPlans: plans.filter(plan => plan.source === 'pin').length,
      pinnedSessions: [...store.sessions.values()].filter(session => session.pin).length,
      auto: autoSettings(),
      lastTickError,
      budget: { ...store.dailyUsage(), maxPings: cfg.maxPingsPerDay, maxUsd: cfg.maxUsdPerDay },
      defaults: { ttl: cfg.ttl, minContextTokens: cfg.minContextTokens, pingTimeoutMs: cfg.pingTimeoutMs, maxPingWriteRatio: cfg.maxPingWriteRatio, pin: cfg.pin },
      // 配置文件可能被删：这时全部走默认值，CLI/页面要能看出来
      config: { file: watchConfig?.file || null, exists: watchConfig ? fileMtime(watchConfig.file) != null : null },
      controlTokenRequired: tokenRequired(),
      alerts: { configured: Boolean(cfg.alerts?.webhookUrl), format: cfg.alerts?.format || 'json', sent: stats.alertsSent || 0, failed: stats.alertsFailed || 0, lastAt: notifier.lastAt || null },
    };
  }

  let agentCache = { key: '', at: 0, agents: new Map() };
  function decorate(views) {
    const cwds = [...new Set(views.map(view => view.cwd).filter(Boolean))].sort();
    const key = cwds.join('\n');
    if (key !== agentCache.key || now() - agentCache.at > 15000) agentCache = { key, at: now(), agents: lookupPaseoAgents(cwds) };
    const { agents } = agentCache;
    for (const view of views) {
      const agent = agents.get(view.id);
      view.paseo = agent ? { agentId: agent.agentId, title: agent.title, status: agent.status, model: agent.model } : null;
      // 没有 Paseo 时也给页面/CLI 一个「进程还在不在」的信号
      const session = store.sessions.get(view.id);
      const probe = session ? lookupAgent(session) : null;
      view.agent = probe ? { status: probe.status, archived: Boolean(probe.archived), source: probe.source, match: probe.match || null } : null;
    }
    return views;
  }

  function resolveTargets(input) {
    if (input.session) return { matches: store.resolveSessions({ sessionId: String(input.session) }), by: 'session' };
    if (input.agent) {
      // Paseo 任务 ID（可用 ≥6 位前缀）；多个候选时不猜，列出来让人选
      const { agent, candidates } = findPaseoAgentByPrefix(String(input.agent), input.agentCwd || input.cwd);
      if (!agent && candidates.length > 1) return { matches: [], by: 'paseo-agent', ambiguous: candidates };
      const session = agent?.sessionIds.map(id => store.sessions.get(id)).find(Boolean);
      if (session) return { matches: [session], by: 'paseo-agent', agent };
      // 认得这个任务、但它的会话没经过中继：不要退回按目录匹配到同目录下别的任务
      if (agent) return { matches: [], by: 'paseo-agent', agent };
      return { matches: [], by: 'paseo-agent', unknownAgent: String(input.agent) };
    }
    if (input.cwd) {
      const current = now();
      const matches = store.resolveSessions({ cwd: String(input.cwd) });
      // 同一工作区有多个会话时，缓存仍有效的排前面
      const warm = session => {
        const view = store.lineageView(store.primaryLineage(session), current);
        return view?.warm ? 1 : 0;
      };
      matches.sort((a, b) => warm(b) - warm(a) || b.lastSeenAt - a.lastSeenAt);
      return { matches, by: 'cwd' };
    }
    return { matches: [], by: null };
  }

  function listSessions(input) {
    const hours = clampNumber(input.hours, 1, 24 * 7, 24);
    let sessions;
    let hint = null;
    if (input.session || input.cwd || input.agent) {
      const resolved = resolveTargets(input);
      sessions = resolved.matches.map(session => store.sessionView(session));
      if (!resolved.matches.length) hint = describeMiss(input, resolved);
    } else {
      sessions = store.listSessions({ sinceMs: hours * 3600 * 1000 });
    }
    return { ok: true, now: now(), sessions: decorate(sessions), hint };
  }

  const planCount = input => (input.count === undefined || input.count === null || input.count === '' ? undefined : input.count === 'max' ? 'max' : Number(input.count));

  function startPlans(input) {
    if (truthy(input.global)) return startGlobalPlans(input);
    const resolved = resolveTargets(input);
    const { matches, by } = resolved;
    if (!matches.length) return { ok: false, error: describeMiss(input, resolved), results: [] };
    const chosen = truthy(input.all) ? matches : matches.slice(0, 1);
    const results = chosen.map(session => store.startPlan(session, {
      count: planCount(input),
      intervalSec: input.interval ?? input.intervalSec,
      force: truthy(input.force),
      source: input.source || 'api',
    }));
    for (const result of results) {
      if (result.ok) log(`plan start session=${result.sessionId.slice(0, 8)} count=${result.plan.count} interval=${result.plan.intervalSec}s`);
    }
    tick();
    return {
      ok: results.some(result => result.ok),
      by,
      results,
      alternatives: truthy(input.all) ? [] : decorate(matches.slice(1, 6).map(session => store.sessionView(session))),
    };
  }

  // 全局开始（cache-keepalive start --global）：遍历中继记得的全部会话，只给缓存仍有效、
  // 且没有进行中计划的主对话建手动计划。默认只看 1h；--ttl 5m / any 可放宽。
  // 显式全局开始会顺带恢复这些会话的「已关闭自动保活」标记（只清该标记，不动未命中锁定）。
  function startGlobalPlans(input) {
    if (input.session || input.agent || input.cwd) return { ok: false, error: '--global 不能和 --session / --cwd 一起使用' };
    const ttl = input.ttl === undefined || input.ttl === null || input.ttl === '' ? '1h' : String(input.ttl);
    if (!['1h', '5m', 'any'].includes(ttl)) return { ok: false, error: 'ttl 只能是 1h / 5m / any' };
    const results = [];
    const skippedBy = {};
    const summary = { sessions: store.sessions.size, started: 0, already: 0, skipped: 0, filtered: 0, restored: 0 };
    for (const session of store.sessions.values()) {
      const lineage = store.primaryLineage(session);
      if (!lineage || !lineage.ttl || !lineage.isMainThread || (ttl !== 'any' && lineage.ttl !== ttl)) {
        summary.filtered += 1;
        continue;
      }
      // 全局开始也是一次显式的「恢复保活」：先清掉会话级关闭标记（不动未命中锁定），
      // 这样即使这次因为缓存过期等原因没建成计划，下一次真实请求后的空闲也会重新参与自动判定。
      if (session.autoDisabled) {
        store.setSessionAuto(session, true, { source: input.source || 'api', reason: '全局开始保活', clearBlocked: false });
        summary.restored += 1;
      }
      const existing = store.activePlanFor(session.id);
      if (existing) {
        summary.already += 1;
        results.push({ ok: true, already: true, sessionId: session.id, plan: store.planView(existing) });
        continue;
      }
      const result = store.startPlan(session, {
        count: planCount(input),
        intervalSec: input.interval ?? input.intervalSec,
        force: truthy(input.force),
        source: input.source || 'api',
      });
      if (!result.ok) {
        summary.skipped += 1;
        // 只按第一个原因归类：一个会话可能同时命中多个软护栏，按会话计数才不会重复
        const code = result.errors?.[0]?.code || 'unknown';
        skippedBy[code] = (skippedBy[code] || 0) + 1;
        results.push(result);
        continue;
      }
      summary.started += 1;
      results.push(result);
    }
    tick();
    log(`global plan start ttl=${ttl} started=${summary.started} already=${summary.already} skipped=${summary.skipped} restored=${summary.restored}`);
    return { ok: summary.started > 0 || summary.already > 0, global: true, ttl, results, summary, skippedBy, autoMode: cfg.auto.mode, now: now() };
  }

  // 带 session/agent/cwd 时只停这些会话（cwd 下的全部会话）；什么都不带且 all=true 才停全部
  function stopPlans(input) {
    if (truthy(input.global)) {
      if (input.session || input.agent || input.cwd) return { ok: false, error: '--global 不能和 --session / --cwd 一起使用' };
      const { stopped, autoDisabled, unpinned } = store.stopPlans(null, input.reason || '全局停止', { source: input.source || 'api', allSessions: true });
      log(`global stop plans=${stopped.length} autoDisabled=${autoDisabled.map(id => id.slice(0, 8)).join(',') || '-'} unpinned=${unpinned.length}`);
      return { ok: true, global: true, stopped, autoDisabled, unpinned, sessions: store.sessions.size, autoMode: cfg.auto.mode };
    }
    let sessionIds = null;
    if (!(truthy(input.all) && !input.session && !input.agent && !input.cwd)) {
      const resolved = resolveTargets(input);
      const { matches } = resolved;
      if (!matches.length) return { ok: false, error: describeMiss(input, resolved), stopped: [] };
      sessionIds = matches.map(session => session.id);
    }
    const { stopped, autoDisabled, unpinned } = store.stopPlans(sessionIds, input.reason || '手动停止', { source: input.source || 'api' });
    if (stopped.length || autoDisabled.length || unpinned.length) log(`stop plans=${stopped.length} autoDisabled=${autoDisabled.map(id => id.slice(0, 8)).join(',') || '-'} unpinned=${unpinned.length}`);
    return { ok: true, stopped, autoDisabled, unpinned };
  }

  // ------------------------------------------------------------------ 自动保活

  function autoSettings() {
    return {
      ...cfg.auto,
      cooldownUntil: store.autoCooldownUntil > now() ? store.autoCooldownUntil : null,
      configFile: watchConfig?.file || null,
      configExists: watchConfig ? fileMtime(watchConfig.file) != null : null,
      intervalSec: cfg.ttl['1h'].intervalSec,
      // 会话级「已关闭自动保活」的数量，CLI/页面用来提示如何恢复
      disabledSessions: [...store.sessions.values()].filter(session => session.autoDisabled).length,
    };
  }

  // 改全局自动保活设置：校验后写进内存，并写回 config.json（保留其他配置项；热加载会读到同样的值）
  function updateAuto(input) {
    const patch = {};
    const errors = [];
    const intIn = (key, min, max) => {
      if (input[key] === undefined) return;
      const value = Number(input[key]);
      if (!Number.isInteger(value) || value < min || value > max) errors.push(`${key} 需要是 ${min}–${max} 的整数`);
      else patch[key] = value;
    };
    if (input.mode !== undefined) {
      if (!['on', 'off'].includes(input.mode)) errors.push('mode 只能是 on / off');
      else patch.mode = input.mode;
    }
    intIn('count', 1, cfg.ttl['1h'].maxCount);
    intIn('minContextTokens', 0, 2000000);
    intIn('minHumanTurns', 0, 1000);
    intIn('missCooldownSec', 0, 86400);
    if (input.skipClosedAgents !== undefined) patch.skipClosedAgents = truthy(input.skipClosedAgents);
    if (input.quietHours !== undefined) {
      const hours = Array.isArray(input.quietHours) ? input.quietHours.map(Number) : [];
      if (hours.length !== 2 || hours.some(h => !Number.isInteger(h) || h < 0 || h > 23)) errors.push('quietHours 需要是 [起, 止] 两个 0–23 的整数；[0, 0] 表示不设');
      else patch.quietHours = hours;
    }
    if (input.toolGapIgnoresTurns !== undefined) patch.toolGapIgnoresTurns = truthy(input.toolGapIgnoresTurns);
    if (truthy(input.clearCooldown)) store.autoCooldownUntil = 0;
    if (errors.length) return { ok: false, errors };
    cfg.auto = { ...cfg.auto, ...patch };
    // 全局关闭自动保活时，进行中的自动计划也要停掉；手动计划不受影响
    const cancelledAutoPlans = patch.mode === 'off' ? store.cancelAutoPlans('自动保活已全局关闭') : [];
    const persisted = Object.keys(patch).length ? persistConfig(current => { current.auto = { ...(current.auto || {}), ...patch }; }) : false;
    store.scheduleSave();
    log(`auto settings ${JSON.stringify(patch)}${persisted ? ' (已写入配置文件)' : ''}`);
    return { ok: true, auto: autoSettings(), persisted, cancelledAutoPlans };
  }

  // 把一个改动写回 config.json（保留其他配置项；热加载会读到同样的值）。返回是否写成功
  function persistConfig(mutate) {
    if (!watchConfig?.file) return false;
    try {
      let current = {};
      try {
        current = JSON.parse(fs.readFileSync(watchConfig.file, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      mutate(current);
      fs.mkdirSync(path.dirname(watchConfig.file), { recursive: true });
      const tmp = `${watchConfig.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, watchConfig.file);
      configMtime = fileMtime(watchConfig.file);
      return true;
    } catch (error) {
      log(`写配置失败（只在内存生效）: ${error.message}`);
      return false;
    }
  }

  // 总开关：off 停掉所有计划与长保活并写入配置（重启后仍关）；on 打开
  function setEnabled(input) {
    const enabled = input.enabled === undefined ? true : truthy(input.enabled);
    const result = store.setEnabled(enabled, { source: input.source || 'api', reason: input.reason || null });
    const persisted = persistConfig(current => { current.enabled = enabled; });
    return { ok: true, ...result, persisted, autoMode: cfg.auto.mode, disabledSessions: autoSettings().disabledSessions, pinnedSessions: [...store.sessions.values()].filter(session => session.pin).length };
  }

  // 会话级开关：off 等同于对这个会话 stop（同时停掉进行中的计划）；on 恢复自动保活并解除未命中锁定
  function setSessionAuto(input) {
    const enabled = truthy(input.enabled);
    if (truthy(input.global)) {
      if (input.session || input.agent || input.cwd) return { ok: false, error: 'global 不能和 session / agent / cwd 一起使用' };
      const all = [...store.sessions.values()];
      const changed = [];
      const source = input.source || 'api';
      const reason = input.reason || null;
      for (const session of all) {
        if (enabled) {
          store.setSessionAuto(session, true, { source, reason, clearBlocked: input.clearBlocked === undefined ? true : truthy(input.clearBlocked) });
        } else {
          store.stopPlans([session.id], reason || '手动关闭自动保活', { source });
        }
        changed.push(session.id);
      }
      log(`auto global ${enabled ? 'enable' : 'disable'} sessions=${changed.length}`);
      return { ok: true, global: true, enabled, changed, autoMode: cfg.auto.mode, sessions: decorate(all.map(session => store.sessionView(session))) };
    }
    const resolved = resolveTargets(input);
    const { matches } = resolved;
    if (!matches.length) return { ok: false, error: describeMiss(input, resolved) };
    const chosen = input.session || input.agent || truthy(input.all) ? matches : matches.slice(0, 1);
    const changed = [];
    for (const session of chosen) {
      if (enabled) store.setSessionAuto(session, true, { source: input.source || 'api', reason: input.reason || null, clearBlocked: input.clearBlocked === undefined ? true : truthy(input.clearBlocked) });
      else store.stopPlans([session.id], input.reason || '手动关闭自动保活', { source: input.source || 'api' });
      changed.push(session.id);
    }
    return { ok: true, enabled, sessions: decorate(chosen.map(session => store.sessionView(session))), changed };
  }

  // 长保活：给目标会话（工作区 / Paseo 任务 / 指定 ID）设到期时刻；enabled=false 取消。只作用于单个会话或 --all 的工作区会话，不提供全局版本
  function setSessionPin(input) {
    if (truthy(input.global)) return setGlobalPin(input);
    const resolved = resolveTargets(input);
    const { matches, by } = resolved;
    if (!matches.length) return { ok: false, error: describeMiss(input, resolved) };
    const enabled = input.enabled === undefined ? true : truthy(input.enabled);
    const chosen = input.session || input.agent || truthy(input.all) ? matches : matches.slice(0, 1);
    const results = chosen.map(session => (enabled
      ? store.pinSession(session, { forSec: truthy(input.forever) ? 'forever' : input.for ?? input.forSec, intervalSec: input.interval ?? input.intervalSec, idleMaxPings: input.idleMaxPings ?? input.count ?? null, source: input.source || 'api', reason: input.reason || null })
      : store.unpinSession(session, { source: input.source || 'api', reason: input.reason || '取消长保活' })));
    tick();
    for (const result of results) {
      if (result.ok && enabled) log(`pin set session=${result.sessionId.slice(0, 8)} until=${result.pin.untilAt == null ? 'forever' : new Date(result.pin.untilAt).toISOString()}`);
    }
    return {
      ok: results.some(result => result.ok),
      by,
      enabled,
      results,
      sessions: decorate(chosen.map(session => store.sessionView(session))),
      alternatives: input.session || input.agent || truthy(input.all) ? [] : decorate(matches.slice(1, 6).map(session => store.sessionView(session))),
    };
  }

  // 全局长保活（pin --global / unpin --global）：默认作用于缓存仍有效的 1h 主对话（--ttl 5m / any 放宽；--all-sessions 连缓存已过期的也设，
  // 等它们下一次请求后接上）。已有长保活的只延长到新的到期时刻。
  function setGlobalPin(input) {
    if (input.session || input.agent || input.cwd) return { ok: false, error: '--global 不能和 --session / --cwd 一起使用' };
    const enabled = input.enabled === undefined ? true : truthy(input.enabled);
    const ttl = input.ttl === undefined || input.ttl === null || input.ttl === '' ? '1h' : String(input.ttl);
    if (!['1h', '5m', 'any'].includes(ttl)) return { ok: false, error: 'ttl 只能是 1h / 5m / any' };
    const current = now();
    const results = [];
    const summary = { sessions: store.sessions.size, pinned: 0, extended: 0, unpinned: 0, skipped: 0, filtered: 0 };
    const skippedBy = {};
    for (const session of store.sessions.values()) {
      if (!enabled) {
        if (!session.pin) continue;
        const result = store.unpinSession(session, { source: input.source || 'api', reason: input.reason || '全局取消长保活' });
        summary.unpinned += 1;
        results.push(result);
        continue;
      }
      const lineage = store.primaryLineage(session);
      const view = store.lineageView(lineage, current);
      if (!lineage || !lineage.ttl || !lineage.isMainThread || (ttl !== 'any' && lineage.ttl !== ttl) || (!truthy(input.allSessions) && !view?.warm)) {
        summary.filtered += 1;
        continue;
      }
      const had = Boolean(session.pin);
      const result = store.pinSession(session, { forSec: truthy(input.forever) ? 'forever' : input.for ?? input.forSec, intervalSec: input.interval ?? input.intervalSec, idleMaxPings: input.idleMaxPings ?? input.count ?? null, source: input.source || 'api', reason: input.reason || null });
      if (!result.ok) {
        summary.skipped += 1;
        const code = result.errors?.[0]?.code || 'unknown';
        skippedBy[code] = (skippedBy[code] || 0) + 1;
      } else if (had) summary.extended += 1;
      else summary.pinned += 1;
      results.push(result);
    }
    tick();
    log(`global pin ${enabled ? 'set' : 'unset'} ttl=${ttl} pinned=${summary.pinned} extended=${summary.extended} unpinned=${summary.unpinned} skipped=${summary.skipped}`);
    return { ok: enabled ? summary.pinned + summary.extended > 0 : true, global: true, enabled, ttl, results, summary, skippedBy, now: current };
  }

  // 回测在子进程里跑（要读几百 MB 会话记录，不能卡住转发），结果缓存 10 分钟
  async function backtest(input) {
    const days = clampNumber(input.days, 1, 35, 7);
    const grid = truthy(input.grid);
    const key = JSON.stringify({ days, grid, auto: cfg.auto });
    if (!truthy(input.refresh) && backtestCache?.key === key && now() - backtestCache.at < BACKTEST_CACHE_MS) {
      return { ok: true, cached: true, at: backtestCache.at, result: backtestCache.result };
    }
    const runner = backtestRunner || runBacktestProcess;
    const result = await runner({ days, auto: cfg.auto, grid });
    backtestCache = { key, at: now(), result };
    return { ok: true, cached: false, at: backtestCache.at, result };
  }

  async function pingNow(input) {
    const resolved = resolveTargets(input);
    const { matches, by } = resolved;
    if (!matches.length) return { ok: false, error: describeMiss(input, resolved) };
    const session = matches[0];
    const started = store.pingNow(session, { force: truthy(input.force), source: input.source || 'api-ping' });
    if (!started.ok) return { ...started, by };
    tick();
    const promise = pingPromises.get(started.plan.id);
    const plan = store.plans.get(started.plan.id);
    if (!promise) {
      // 没能立即发出（快照缺失、额度用完、计划被护栏结束等），说明原因而不是返回空结果
      const message = PING_BLOCKED[plan?.state] || plan?.reason || `心跳未发出（${plan?.state || 'unknown'}）`;
      return { ok: false, by, sessionId: session.id, errors: [{ code: plan?.state || 'not-sent', message }], plan: plan && store.planView(plan) };
    }
    const result = await promise;
    return { ok: result?.outcome === 'hit', by, sessionId: session.id, result, plan: plan && store.planView(plan) };
  }

  function describeMiss(input, resolved = {}) {
    const agent = resolved.agent;
    if (resolved.ambiguous?.length) return `Paseo 任务 ID 前缀 ${input.agent} 匹配到 ${resolved.ambiguous.length} 个任务：${resolved.ambiguous.slice(0, 6).map(item => `${item.agentId.slice(0, 8)}（${item.title || '无标题'}）`).join('、')}；请多给几位`;
    if (agent) return `Paseo 任务（${agent.title || agent.agentId}）的会话没有经过保活中继，无法保活；确认它的模型路由已接入中继`;
    if (resolved.unknownAgent) return `没有找到 Paseo 任务 ${resolved.unknownAgent}（ID 需 ≥6 位前缀；cache-keepalive list 可看每个会话对应的任务 ID）`;
    if (input.session) return `没有找到会话 ${input.session}`;
    if (input.cwd) return `工作区 ${input.cwd} 下没有经过保活中继的会话（需要该会话的请求走中继）`;
    return '需要指定 session、agent 或 cwd';
  }

  // ------------------------------------------------------------------ 生命周期

  function listen(port = cfg.port, host = cfg.host) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        listenPort = server.address().port;
        tickTimer = setInterval(tick, TICK_MS);
        pruneTimer = setInterval(() => store.prune(), 10 * 60 * 1000);
        tickTimer.unref?.();
        pruneTimer.unref?.();
        resolve(listenPort);
      });
    });
  }

  // 优雅退出：先停止接新连接、新请求与新心跳，等退出前已在途的转发（流式响应）结束，最多 drainMs，再落盘退出。
  // 热快照与状态在排空之前就先落一次盘：排空 + 等在途心跳可能撞到外层兜底的 process.exit，不能把落盘放在最后才做
  async function close({ drainMs = 0, flushMs = FLUSH_MS } = {}) {
    draining = true;
    clearInterval(tickTimer);
    clearInterval(pruneTimer);
    const early = store.persistWarmSnapshots();
    store.saveNow();
    if (early) log(`退出前先落盘 ${early} 个缓存仍有效的主对话快照`);
    const closed = new Promise(resolve => server.close(() => resolve()));
    server.closeIdleConnections?.();
    if (inflight > 0 && drainMs > 0) {
      const drainStart = Date.now();
      log(`等待 ${inflight} 个在途请求结束（最多 ${Math.round(drainMs / 1000)}s）`);
      await new Promise(resolve => {
        const timer = setTimeout(resolve, drainMs);
        drainWaiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      log(`排空结束：用时 ${((Date.now() - drainStart) / 1000).toFixed(1)}s，期间拒绝新请求 ${stats.drainRejected} 个`
        + `${inflight > 0 ? `，${inflight} 个请求超过上限仍在途，将被切断` : ''}`);
    }
    // 在途心跳最多再等 flushMs（正常 p90 17s；超过就放弃等待，这一发的结果不记账，重启后计划按 inflight=false 恢复）
    const flushed = await Promise.race([flush().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), flushMs).unref?.())]);
    if (!flushed) log(`仍有 ${pingPromises.size} 个心跳在途，超过 ${Math.round(flushMs / 1000)}s 不再等待`);
    const persisted = store.persistWarmSnapshots();
    if (persisted) log(`已落盘 ${persisted} 个缓存仍有效的主对话快照，重启后自动保活接着发`);
    store.saveNow();
    server.closeAllConnections?.();
    await closed;
  }

  // 等待当前在途的心跳全部结束（测试与优雅退出用）
  async function flush() {
    await Promise.all([...pingPromises.values()]);
  }

  return { server, store, stats, listen, close, tick, flush, notifier, get token() { return store.controlToken; }, get port() { return listenPort; }, get inflight() { return inflight; } };
}

// 心跳重放时使用的请求头：保留鉴权、anthropic-beta、User-Agent、x-claude-code-session-id 等（网关按会话 ID 固定上游账号），
// 去掉逐跳头与长度/压缩协商。只存在内存里。
function replayHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || ['host', 'content-length', 'accept-encoding', 'expect'].includes(name)) continue;
    out[name] = value;
  }
  return out;
}

function stripHopByHop(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
  return out;
}

const DECODERS = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, br: zlib.createBrotliDecompress, deflate: zlib.createInflate };

// 返回 { push, finish(): Promise<summary> }；不认识的压缩编码返回 null（usage 未知）。
function createTap(headers) {
  const tap = new UsageTap(String(headers['content-type'] || ''));
  const encoding = String(headers['content-encoding'] || 'identity').toLowerCase().trim();
  if (encoding === 'identity' || encoding === '') {
    return { push: chunk => tap.push(chunk), finish: async () => tap.finish() };
  }
  const createDecoder = DECODERS[encoding];
  if (!createDecoder) return null;
  const decoder = createDecoder();
  let failed = false;
  decoder.on('data', chunk => tap.push(chunk));
  decoder.on('error', () => {
    failed = true;
  });
  return {
    push: chunk => {
      if (!failed) decoder.write(chunk);
    },
    finish: () => new Promise(resolve => {
      if (failed) return resolve(tap.finish());
      decoder.once('end', () => resolve(tap.finish()));
      decoder.once('error', () => resolve(tap.finish()));
      decoder.end();
      return undefined;
    }),
  };
}

function sendUpstreamError(res, error) {
  if (res.destroyed) return;
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `cache-keepalive relay: upstream unavailable (${error.code || error.message})` } }));
  } else if (!res.writableEnded) {
    res.destroy(error);
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function serveStatic(res, url, sub, token = '') {
  if (url.pathname === '/keepalive') {
    res.writeHead(301, { location: '/keepalive/' });
    res.end();
    return;
  }
  const name = STATIC_FILES.get(sub);
  if (!name) return sendJson(res, 404, { ok: false, error: 'not found' });
  fs.readFile(path.join(PUBLIC_DIR, name), (error, data) => {
    if (error) return sendJson(res, 500, { ok: false, error: error.message });
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(name)], 'cache-control': 'no-store' });
    if (name === 'index.html' && token) {
      res.end(data.toString('utf8').replace(TOKEN_META, `<meta name="cache-keepalive-token" content="${token}">`));
    } else res.end(data);
    return undefined;
  });
  return undefined;
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

// 告警出口：POST 到 cfg.alerts.webhookUrl；同类告警 minIntervalSec 内只发一次；发送失败只记数不抛。
// format=feishu 时按飞书自定义机器人的 text 消息格式发，其他按 { kind, title, text, at, ...meta } 的 JSON 发
export function createNotifier({ cfg, now = () => Date.now(), log = () => {}, stats = {}, transportFor = () => http, request = null } = {}) {
  const lastSentByKind = new Map();
  const notifier = { lastAt: null, pending: new Set() };
  notifier.send = alert => {
    const alerts = cfg.alerts || {};
    const url = String(alerts.webhookUrl || '').trim();
    if (!url || !alert?.kind) return false;
    if (Array.isArray(alerts.kinds) && alerts.kinds.length && !alerts.kinds.includes(alert.kind)) return false;
    const at = now();
    const minInterval = (Number(alerts.minIntervalSec) || 0) * 1000;
    const last = lastSentByKind.get(alert.kind) || 0;
    if (minInterval && at - last < minInterval) return false;
    lastSentByKind.set(alert.kind, at);
    const text = `[cache-keepalive] ${alert.title || alert.kind}\n${alert.text || ''}`.trim();
    const payload = alerts.format === 'feishu'
      ? { msg_type: 'text', content: { text } }
      : { source: 'cache-keepalive', at: new Date(at).toISOString(), ...alert };
    const body = Buffer.from(JSON.stringify(payload));
    const done = new Promise(resolve => {
      let target;
      try {
        target = new URL(url);
      } catch (error) {
        log(`告警 webhook 地址无效: ${error.message}`);
        stats.alertsFailed = (stats.alertsFailed || 0) + 1;
        resolve(false);
        return;
      }
      const send = request || ((options, onResponse) => transportFor(target).request(options, onResponse));
      const req = send({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) }, timeout: 10000 }, res => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            stats.alertsSent = (stats.alertsSent || 0) + 1;
            notifier.lastAt = at;
            resolve(true);
          } else {
            stats.alertsFailed = (stats.alertsFailed || 0) + 1;
            log(`告警发送失败 HTTP ${res.statusCode}: ${alert.kind}`);
            resolve(false);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', error => {
        stats.alertsFailed = (stats.alertsFailed || 0) + 1;
        log(`告警发送失败: ${error.message}`);
        resolve(false);
      });
      req.end(body);
    });
    notifier.pending.add(done);
    done.finally(() => notifier.pending.delete(done));
    return true;
  };
  notifier.flush = () => Promise.all([...notifier.pending]);
  return notifier;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_API_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
      return undefined;
    });
    req.on('error', reject);
  });
}

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// 子进程跑 backtest.js --json，按当前自动保活设置传参
function runBacktestProcess({ days, auto, grid = false }) {
  const script = path.join(path.dirname(__filename), 'backtest.js');
  const args = [script, '--json', '--days', String(days), '--auto', JSON.stringify(auto)];
  if (grid) args.push('--grid');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`回测失败: ${(stderr || error.message).slice(0, 500)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`回测输出不是 JSON: ${parseError.message}`));
      }
      return undefined;
    });
  });
}

function defaultLog(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

// 日志同时写 stateDir/relay.log（用户不一定读得到 journal）；启动时超过 5MB 轮转一份
function fileLogger(stateDir) {
  const file = path.join(stateDir, 'relay.log');
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* 写不了文件时只打到 stdout */ }
  return message => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch { /* 忽略 */ }
  };
}

export function parseServeArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--port') args.port = Number(argv[++index]);
    else if (value === '--host') args.host = argv[++index];
    else if (value === '--upstream') args.upstream = argv[++index];
    else if (value === '--state-dir') args.stateDir = argv[++index];
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`未知参数: ${value}`);
  }
  return args;
}

export async function serve(argv) {
  const args = parseServeArgs(argv);
  if (args.help) {
    console.log(`用法: node cache-keepalive/relay.js [--port 18110] [--host 127.0.0.1] [--upstream http://127.0.0.1:8080] [--state-dir DIR]`);
    return;
  }
  const overrides = { port: args.port, host: args.host, upstream: args.upstream };
  const cfg = loadConfig(overrides);
  const stateDir = args.stateDir || defaultPaths().stateDir;
  const log = fileLogger(stateDir);
  const relay = createRelay({
    cfg,
    stateDir,
    log,
    watchConfig: { file: defaultPaths().configFile, load: () => loadConfig(overrides) },
  });
  await relay.listen(cfg.port, cfg.host);
  log(`cache-keepalive relay listening on http://${cfg.host}:${relay.port} -> ${cfg.upstream}，页面 http://${cfg.host}:${relay.port}/keepalive/`);
  if (cfg.alerts?.webhookUrl) log(`告警 webhook 已配置（${cfg.alerts.format || 'json'}）`);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    relay.close({ drainMs: DRAIN_MS, flushMs: FLUSH_MS }).finally(() => process.exit(0));
    // 兜底必须晚于「排空 + 等在途心跳」之和，否则会抢在落盘之前退出
    setTimeout(() => process.exit(0), DRAIN_MS + FLUSH_MS + 10000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (path.resolve(process.argv[1] || '') === path.resolve(__filename)) {
  serve(process.argv.slice(2)).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
