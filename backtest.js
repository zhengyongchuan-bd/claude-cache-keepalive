#!/usr/bin/env node
// 自动保活回测：重放本机 Claude Code 1h 路由的会话记录，回答「如果当时开着自动保活，会发多少心跳、救回多少重写」。
// 决策走线上同一个 autoEligibility，节省按线上同一套冷启动口径（coldStartOpportunity）计；只读会话记录，不发任何请求。
//
// 用法：node cache-keepalive/backtest.js [--days 7] [--count 3] [--min-context 100k] [--min-turns 2] [--quiet 1-8|off]
//                                        [--grid] [--session <ID 前缀>] [--json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  AUTO_SKIP_LABELS,
  DEFAULT_CONFIG,
  TTL_SEC,
  autoEligibility,
  classifyUserContent,
  coldStartOpportunity,
  inQuietHours,
  mergeConfig,
  pingCostEstimateUsd,
  priceFor,
  ttlSettings,
} from './core.js';
import { loadConfig } from './relay.js';

const __filename = fileURLToPath(import.meta.url);
const DAY_MS = 86400 * 1000;
export const ROUTER_ROOT = path.join(os.homedir(), '.cache', 'paseo', 'claude-router');

// Claude Code 自己的配置目录：$CLAUDE_CONFIG_DIR 或 ~/.claude（会话记录在其 projects/ 下）
export function defaultClaudeDirs() {
  const dirs = [];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(process.env.CLAUDE_CONFIG_DIR);
  dirs.push(path.join(os.homedir(), '.claude'));
  return dirs;
}

// 会话记录来源：Claude Code 配置目录的 projects（每次请求的 usage 自带 5m/1h 拆分，不用按 TTL 过滤）、
// Paseo 路由里 settings.json 标了 promptCacheTtl=1h 的、以及配置里额外指定的目录（projects 目录或它的上级）
export function discoverRoots(root = ROUTER_ROOT, { claudeDirs = defaultClaudeDirs(), extra = [] } = {}) {
  const out = [];
  const seen = new Set();
  const add = (route, dir) => {
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real) || !fs.statSync(real).isDirectory()) return;
    seen.add(real);
    out.push({ route, dir: real });
  };
  for (const dir of claudeDirs) {
    if (!dir) continue;
    add(path.basename(dir) || 'claude', path.join(dir, 'projects'));
  }
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch { /* 没有 Paseo 路由目录 */ }
  for (const name of names.sort()) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(root, name, 'settings.json'), 'utf8'));
      if (settings.promptCacheTtl === '1h') add(name, path.join(root, name, 'projects'));
    } catch { /* 不是路由目录 */ }
  }
  for (const dir of extra || []) {
    if (!dir) continue;
    const expanded = String(dir).replace(/^~(?=\/|$)/, os.homedir());
    add(path.basename(expanded), fs.existsSync(path.join(expanded, 'projects')) ? path.join(expanded, 'projects') : expanded);
  }
  return out;
}

function listTranscripts(dir) {
  const files = [];
  const walk = current => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // 子代理的会话记录在 <会话>/subagents/ 下，不是保活目标
      if (entry.isDirectory()) {
        if (entry.name !== 'subagents') walk(full);
      } else if (entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  walk(dir);
  return files;
}

function stamp(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// 一个主对话会话记录 → { sid, cwd, calls: [{ t, model, usage, stop }], humans: [t], compactions: [t] }。
// 压缩请求本身不写进会话记录，只留一条压缩摘要（isCompactSummary）：用它的时间当作压缩发生的时刻。
export async function readTranscript(file) {
  const calls = new Map();
  const humans = [];
  const compactions = [];
  let sid = null;
  let cwd = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isSidechain) continue;
    const t = stamp(d.timestamp);
    if (t == null) continue;
    sid = sid || d.sessionId || null;
    cwd = cwd || d.cwd || null;
    if (d.type === 'assistant') {
      const m = d.message || {};
      const u = m.usage;
      if (!u || !m.id || m.model === '<synthetic>') continue;
      const cc = u.cache_creation || {};
      const prev = calls.get(m.id);
      if (!prev) {
        calls.set(m.id, {
          t,
          model: m.model || '',
          stop: m.stop_reason || null,
          usage: {
            input: u.input_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0,
            cacheWrite: u.cache_creation_input_tokens || 0,
            cacheWrite5m: cc.ephemeral_5m_input_tokens || 0,
            cacheWrite1h: cc.ephemeral_1h_input_tokens || 0,
            output: u.output_tokens || 0,
          },
        });
      } else {
        prev.usage.output = Math.max(prev.usage.output, u.output_tokens || 0);
        if (m.stop_reason) prev.stop = m.stop_reason;
      }
    } else if (d.type === 'user') {
      if (d.isCompactSummary) compactions.push(t);
      else if (!d.isMeta && classifyUserContent(d.message?.content) === 'human') humans.push(t);
    }
  }
  return {
    file,
    sid: sid || path.basename(file, '.jsonl'),
    cwd,
    calls: [...calls.values()].sort((a, b) => a.t - b.t),
    humans: humans.sort((a, b) => a - b),
    compactions: compactions.sort((a, b) => a - b),
  };
}

export async function loadSessions({ roots = null, cfg = null } = {}) {
  const list = roots || discoverRoots(ROUTER_ROOT, { extra: cfg?.backtest?.roots });
  const bySid = new Map();
  const seen = new Set();
  for (const { route, dir } of list) {
    for (const file of listTranscripts(dir)) {
      let real = file;
      try {
        real = fs.realpathSync(file);
      } catch { /* 读不到就按原路径 */ }
      if (seen.has(real)) continue;
      seen.add(real);
      const session = await readTranscript(real);
      if (!session.calls.length) continue;
      session.route = route;
      // 同一会话出现在多个文件（续接、链接）时取请求最多的那份
      const prev = bySid.get(session.sid);
      if (!prev || session.calls.length > prev.calls.length) bySid.set(session.sid, session);
    }
  }
  return [...bySid.values()];
}

function countUpTo(sorted, t) {
  let n = 0;
  for (const value of sorted) {
    if (value > t) break;
    n += 1;
  }
  return n;
}

// 一个会话按线上规则重放：每次主对话请求之后的空闲，到第一次心跳的时刻按 autoEligibility 决定是否保活，
// 之后每隔 interval 发一次，直到用户回来、次数用完或回测截止。
// 心跳一律按命中计（真实命中率见 stats）；回来时是否省钱看真实数据里那次请求有没有整段重写。
// 上游网关内置规则（live setting claude_prompt_cache_keepalive）：到期前 lead 秒重发一次，之后每隔「寿命−lead」一次；
// 停在工具调用的回合一律保活（上限 19 次），停在用户处的主线程回合只在 span > 0 时保活，且所有安排不晚于 span。
// 旧规则没有前缀大小、人工轮次、凌晨、进程状态等门槛；护栏版（policy.guards）加了提前量 5m、工具调用保活上限 2h、
// 停在用户处的回合要求人工 ≥ 2 轮、前缀 ≥ 100K、可选静默时段。锁定与冷却回测不建模（心跳按全部命中计）。
export const GATEWAY_BREAK_EVEN_1H = 19;
export const GATEWAY_LEAD_SEC = 30;
export const GATEWAY_GUARDS = { leadSec: 300, toolCallSpanSec: 2 * 3600, minHumanTurns: 2, minContextTokens: 100000, quietHours: [0, 0] };
// 经网关实测 79 次 170K–520K 前缀的保活读取：p50 6.0s、p90 16.5s、p95 26.4s、p99 108s、最大 108s。
// 提前量超过这个最大值时，落在过期之后的风险按 0 计；不超过时按 --late-rate 给的比例计。
export const GATEWAY_MEASURED_MAX_PING_SEC = 108;
export function gatewayBudget({ spanSec = 0, lifetimeSec = TTL_SEC['1h'], leadSec = GATEWAY_LEAD_SEC, budget = GATEWAY_BREAK_EVEN_1H, toolCallSpanSec = 0 } = {}) {
  const after = lifetimeSec - leadSec;
  const cap = span => (after > span ? 0 : 1 + Math.floor((span - after) / lifetimeSec));
  let n = budget;
  if (toolCallSpanSec > 0) n = Math.min(n, cap(toolCallSpanSec));
  if (spanSec > 0) n = Math.min(n, cap(spanSec));
  return n;
}

export function gatewayPolicy(policy) {
  if (policy?.kind !== 'gateway') return null;
  const base = policy.guards ? GATEWAY_GUARDS : { leadSec: GATEWAY_LEAD_SEC, toolCallSpanSec: 0, minHumanTurns: 0, minContextTokens: 0, quietHours: [0, 0] };
  return {
    guards: Boolean(policy.guards),
    spanSec: Number(policy.spanSec) || 0,
    leadSec: Number(policy.leadSec) || base.leadSec,
    toolCallSpanSec: policy.toolCallSpanSec != null ? Number(policy.toolCallSpanSec) : base.toolCallSpanSec,
    minHumanTurns: policy.minHumanTurns != null ? Number(policy.minHumanTurns) : base.minHumanTurns,
    minContextTokens: policy.minContextTokens != null ? Number(policy.minContextTokens) : base.minContextTokens,
    quietHours: policy.quietHours ?? base.quietHours,
  };
}

export const GATEWAY_SKIP_LABELS = {
  'gw-not-tool-call': '停在用户处的回合（span=0 不保活）',
  'gw-span-too-short': 'span 短于首次保活时刻，不安排',
  'gw-not-1h': '不是 1h 缓存',
  'gw-few-human-turns': '人工轮次不足（护栏版）',
  'gw-small-context': '前缀太小（护栏版）',
  'gw-quiet-hours': '静默时段开始的空闲（护栏版）',
};

export function simulateSession(session, { cfg = DEFAULT_CONFIG, now = Date.now(), since = 0, policy = null } = {}) {
  const ttlMs = TTL_SEC['1h'] * 1000;
  const settings = ttlSettings('1h', cfg);
  const gateway = gatewayPolicy(policy);
  // 网关版的第一次心跳在「寿命−提前量」（旧规则 59.5 分钟、护栏版 55 分钟），之后每隔同样时长一次；中继是 50 分钟
  const stepMs = gateway ? (TTL_SEC['1h'] - gateway.leadSec) * 1000 : settings.intervalSec * 1000;
  const gaps = [];
  let ttl = '1h';
  for (let i = 0; i < session.calls.length; i += 1) {
    const prev = session.calls[i];
    const next = session.calls[i + 1] || null;
    const written = prev.usage.cacheWrite1h > 0 ? '1h' : prev.usage.cacheWrite5m > 0 ? '5m' : null;
    if (written) ttl = written;
    if (prev.t < since) continue;
    const prevCached = prev.usage.cacheRead + prev.usage.cacheWrite;
    const compactAt = session.compactions.find(t => t > prev.t && (!next || t <= next.t)) ?? null;
    const returnAt = compactAt ?? next?.t ?? null;
    const returnKind = compactAt ? 'compact' : next ? 'request' : 'none';
    const firstAt = prev.t + stepMs;
    // 第一次心跳之前用户就回来了（正常工作节奏）：不涉及保活
    if (returnAt != null && returnAt <= firstAt) continue;
    if (now < firstAt) continue;
    const features = {
      sessionId: session.sid,
      isMainThread: true,
      ttl,
      cacheable: prevCached > 0,
      contextTokens: prevCached,
      humanTurns: countUpTo(session.humans, prev.t),
      stopReason: prev.stop,
      idleStartAt: prev.t,
    };
    let decision;
    if (gateway) {
      const tool = prev.stop === 'tool_use';
      if (ttl !== '1h') decision = { ok: false, code: 'gw-not-1h' };
      else if (!tool && gateway.spanSec <= 0) decision = { ok: false, code: 'gw-not-tool-call' };
      else if (!tool && features.humanTurns < gateway.minHumanTurns) decision = { ok: false, code: 'gw-few-human-turns' };
      else if (!tool && prevCached > 0 && prevCached < gateway.minContextTokens) decision = { ok: false, code: 'gw-small-context' };
      else if (!tool && inQuietHours(prev.t, gateway.quietHours)) decision = { ok: false, code: 'gw-quiet-hours' };
      else {
        const count = gatewayBudget({ spanSec: gateway.spanSec, leadSec: gateway.leadSec, toolCallSpanSec: tool ? gateway.toolCallSpanSec : 0 });
        decision = count > 0 ? { ok: true, code: tool ? 'tool-gap' : 'idle', count } : { ok: false, code: 'gw-span-too-short' };
      }
    } else decision = autoEligibility(features, { now: firstAt, cfg });
    const pings = [];
    let end = 'count';
    if (decision.ok) {
      for (let k = 1; k <= decision.count; k += 1) {
        const at = prev.t + k * stepMs;
        if (returnAt != null && at >= returnAt) {
          end = 'returned';
          break;
        }
        if (at > now) {
          end = 'pending';
          break;
        }
        pings.push(at);
      }
    }
    const pingUsd = pings.length * pingCostEstimateUsd(prevCached, { model: prev.model, cfg });
    const gapSec = returnAt != null ? (returnAt - prev.t) / 1000 : null;
    // 真实发生的重写（不保活时的代价）：普通请求看它自己的 usage；压缩请求按 5m 断点重写整段旧前缀
    let cold = null;
    if (gapSec != null && gapSec > TTL_SEC['1h']) {
      if (returnKind === 'request') {
        cold = coldStartOpportunity({ ttl, gapSec, usage: next.usage, prevCached, model: next.model, cfg });
      } else {
        const price = priceFor(prev.model, cfg, prevCached);
        cold = { rewriteTokens: prevCached, rewriteUsd: prevCached * price.write5m / 1e6 };
      }
    }
    const lastPing = pings[pings.length - 1] ?? null;
    const kept = Boolean(lastPing && returnAt != null && gapSec > TTL_SEC['1h'] && returnAt - lastPing <= ttlMs);
    const prices = priceFor(prev.model, cfg, prevCached);
    const readPrice = prices.cacheRead;
    const benefitUsd = kept && cold ? Math.max(0, cold.rewriteUsd - cold.rewriteTokens * readPrice / 1e6) : 0;
    // 网关版心跳延迟超过提前量就落在过期之后，变成整段 1h 重写；提前量不超过实测最大延迟时按每次心跳记下这笔潜在代价
    const lateRewriteUsd = gateway && gateway.leadSec <= GATEWAY_MEASURED_MAX_PING_SEC ? prevCached * (prices.write1h ?? prices.write5m) / 1e6 : 0;
    let outcome;
    if (!decision.ok) outcome = cold ? 'missed' : 'skipped';
    else if (!pings.length) outcome = cold ? 'missed' : 'skipped';
    else if (kept) outcome = benefitUsd > 0 ? 'kept' : 'kept-no-rewrite';
    else if (returnAt == null) outcome = end === 'pending' ? 'pending' : 'no-return';
    else if (gapSec <= TTL_SEC['1h']) outcome = 'redundant';
    else outcome = 'expired';
    gaps.push({
      at: prev.t,
      returnAt,
      returnKind,
      gapSec,
      model: prev.model,
      contextTokens: prevCached,
      humanTurns: features.humanTurns,
      stopReason: prev.stop,
      decision: decision.ok ? decision.code : decision.code,
      pings: pings.length,
      pingUsd,
      lateRiskUsd: pings.length * lateRewriteUsd,
      coldUsd: cold?.rewriteUsd || 0,
      benefitUsd,
      outcome,
      end,
    });
  }
  return gaps;
}

export function summarize(sessions, simulated) {
  const totals = {
    sessions: 0,
    idleGaps: 0,
    pings: 0,
    pingUsd: 0,
    usefulPings: 0,
    wastedPings: 0,
    wastedUsd: 0,
    kept: 0,
    benefitUsd: 0,
    coldStarts: 0,
    coldUsd: 0,
    missed: 0,
    missedUsd: 0,
    missedByReason: {},
    outcomes: {},
  };
  const rows = [];
  sessions.forEach((session, index) => {
    const gaps = simulated[index];
    if (!gaps.length) return;
    const row = { sid: session.sid, cwd: session.cwd, route: session.route, model: session.calls[0]?.model, idleGaps: gaps.length, pings: 0, pingUsd: 0, kept: 0, benefitUsd: 0, coldUsd: 0, missedUsd: 0, lastAt: session.calls.at(-1).t };
    for (const gap of gaps) {
      totals.idleGaps += 1;
      totals.outcomes[gap.outcome] = (totals.outcomes[gap.outcome] || 0) + 1;
      totals.pings += gap.pings;
      totals.pingUsd += gap.pingUsd;
      totals.lateRiskUsd = (totals.lateRiskUsd || 0) + (gap.lateRiskUsd || 0);
      row.pings += gap.pings;
      row.pingUsd += gap.pingUsd;
      if (gap.coldUsd) {
        totals.coldStarts += 1;
        totals.coldUsd += gap.coldUsd;
        row.coldUsd += gap.coldUsd;
      }
      if (gap.outcome === 'kept') {
        totals.kept += 1;
        totals.benefitUsd += gap.benefitUsd;
        totals.usefulPings += gap.pings;
        row.kept += 1;
        row.benefitUsd += gap.benefitUsd;
      } else if (gap.pings) {
        totals.wastedPings += gap.pings;
        totals.wastedUsd += gap.pingUsd;
      }
      if (gap.outcome === 'missed' || gap.outcome === 'expired') {
        totals.missed += 1;
        totals.missedUsd += gap.coldUsd;
        row.missedUsd += gap.coldUsd;
        const reason = gap.outcome === 'expired' ? 'coverage' : gap.decision;
        totals.missedByReason[reason] = (totals.missedByReason[reason] || { count: 0, usd: 0 });
        totals.missedByReason[reason].count += 1;
        totals.missedByReason[reason].usd += gap.coldUsd;
      }
    }
    row.netUsd = row.benefitUsd - row.pingUsd;
    rows.push(row);
  });
  totals.sessions = rows.length;
  totals.netUsd = totals.benefitUsd - totals.pingUsd;
  totals.roi = totals.pingUsd > 0 ? totals.benefitUsd / totals.pingUsd : null;
  rows.sort((a, b) => b.netUsd - a.netUsd || b.lastAt - a.lastAt);
  return { totals, sessions: rows };
}

export async function runBacktest({ cfg = DEFAULT_CONFIG, days = 7, now = Date.now(), roots, sessions = null, variants = null, policy = null } = {}) {
  const since = now - days * DAY_MS;
  const loaded = sessions || await loadSessions({ roots, cfg });
  const run = (variantCfg, variantPolicy = policy) => {
    const simulated = loaded.map(session => simulateSession(session, { cfg: variantCfg, now, since, policy: variantPolicy }));
    return { simulated, ...summarize(loaded, simulated) };
  };
  const main = run(cfg);
  const out = { days, since, now, auto: cfg.auto, policy, totals: main.totals, sessions: main.sessions };
  if (variants) {
    out.variants = variants.map(variant => {
      const variantCfg = variant.auto ? mergeConfig(cfg, { auto: variant.auto }) : cfg;
      const { totals } = run(variantCfg, variant.policy === undefined ? policy : variant.policy);
      return { label: variant.label, auto: variantCfg.auto, policy: variant.policy === undefined ? policy : variant.policy, totals };
    });
  }
  return { result: out, loaded, simulated: main.simulated };
}

export function defaultVariants() {
  const variants = [];
  for (const minContextTokens of [0, 50000, 100000, 200000]) {
    for (const minHumanTurns of [1, 2, 3, 5]) variants.push({ label: `前缀≥${minContextTokens / 1000}K 人工≥${minHumanTurns}`, auto: { minContextTokens, minHumanTurns } });
  }
  for (const count of [1, 2, 4, 6, 12]) variants.push({ label: `次数 ${count}`, auto: { count } });
  variants.push({ label: '不设凌晨时段', auto: { quietHours: [0, 0] } });
  variants.push({ label: '凌晨 0–8 点', auto: { quietHours: [0, 8] } });
  variants.push({ label: '工具执行中也看人工轮次', auto: { toolGapIgnoresTurns: false } });
  return variants;
}

// 网关版旧规则与护栏版各 span 的对比，再放一行中继当前规则作参照
export function gatewayVariants() {
  const variants = [{ label: '中继：当前规则', policy: null }];
  for (const guards of [false, true]) {
    for (const hours of [0, 3, 6, 12, 24]) {
      const name = guards ? '网关护栏版' : '网关旧规则';
      variants.push({ label: hours ? `${name} span=${hours}h` : `${name} span=0`, policy: { kind: 'gateway', spanSec: hours * 3600, guards } });
    }
  }
  return variants;
}

// ------------------------------------------------------------------ 命令行

function parseArgs(argv) {
  const args = { days: 7, auto: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    const next = () => argv[++i];
    if (value === '--days') args.days = Number(next());
    else if (value === '--count') args.auto.count = Number(next());
    else if (value === '--min-context') args.auto.minContextTokens = parseTokens(next());
    else if (value === '--min-turns') args.auto.minHumanTurns = Number(next());
    else if (value === '--quiet') args.auto.quietHours = parseQuiet(next());
    else if (value === '--auto') Object.assign(args.auto, JSON.parse(next()));
    else if (value === '--grid') args.grid = true;
    else if (value === '--gateway') args.gateway = next();
    else if (value === '--gateway-grid') args.gatewayGrid = true;
    else if (value === '--gateway-guards') args.gatewayGuards = true;
    else if (value === '--late-rate') args.lateRate = Number(next());
    else if (value === '--json') args.json = true;
    else if (value === '--session') args.session = next();
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`未知参数: ${value}`);
  }
  return args;
}

export function parseSpan(value) {
  const text = String(value).trim().toLowerCase();
  if (text === '0' || text === 'off') return 0;
  const m = text.match(/^(\d+(?:\.\d+)?)(h|m)?$/);
  if (!m) throw new Error(`无法解析 span: ${value}（例如 0、3h、90m）`);
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 60 : 3600));
}

export function parseTokens(value) {
  const m = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) throw new Error(`无法解析 token 数: ${value}`);
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
}

export function parseQuiet(value) {
  if (['off', 'none', '0'].includes(String(value).toLowerCase())) return [0, 0];
  const m = String(value).match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error(`凌晨时段格式应为 起-止（小时），如 1-8；off 关闭: ${value}`);
  return [Number(m[1]), Number(m[2])];
}

const usd = value => `$${value.toFixed(2)}`;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const OUTCOME_TEXT = {
  kept: '保住并省下重写',
  'kept-no-rewrite': '保住了但回来时本来也没重写',
  redundant: '50–60 分钟就回来，心跳多余',
  expired: '心跳停了之后才回来，仍要重写',
  'no-return': '会话没再继续，心跳白发',
  pending: '空闲还在进行',
  missed: '没保活、回来时整段重写',
  skipped: '没保活（之后也没重写）',
};

function printResult(result, { lateRate = 0 } = {}) {
  const t = result.totals;
  const a = result.auto;
  const gw = result.policy?.kind === 'gateway' ? result.policy : null;
  console.log(`${gw ? '网关版保活规则' : '自动保活'}回测：最近 ${result.days} 天，${t.sessions} 个 1h 会话、${t.idleGaps} 段超过 ${gw ? '59.5' : Math.round(ttlSettings('1h').intervalSec / 60)} 分钟的空闲`);
  if (gw) {
    const g = gatewayPolicy(gw);
    const stepMin = (TTL_SEC['1h'] - g.leadSec) / 60;
    const budget = gatewayBudget({ spanSec: g.spanSec, leadSec: g.leadSec });
    const toolBudget = gatewayBudget({ spanSec: g.spanSec, leadSec: g.leadSec, toolCallSpanSec: g.toolCallSpanSec });
    console.log(`  规则${g.guards ? '（护栏版）' : '（旧规则）'}：到期前 ${g.leadSec}s 重发（第 ${stepMin} 分钟），之后每 ${stepMin} 分钟一次；工具调用回合保活最多 ${toolBudget} 次；停在用户处的主线程回合 ${g.spanSec > 0 ? `span=${g.spanSec / 3600}h → 每段最多 ${budget} 次` : '不保活（span=0）'}；${g.guards ? `人工 ≥ ${g.minHumanTurns} 轮、前缀 ≥ ${Math.round(g.minContextTokens / 1000)}K${g.quietHours[0] === g.quietHours[1] ? '' : `、${g.quietHours[0]}–${g.quietHours[1]} 点不保活`}` : '没有前缀 / 人工轮次 / 凌晨 / 进程门槛'}`);
    if (lateRate > 0) console.log(`  提前量风险：按实测 ${Math.round(lateRate * 1000) / 10}% 的心跳延迟超过 30s 计，提前量 ${g.leadSec}s ${g.leadSec > GATEWAY_MEASURED_MAX_PING_SEC ? `已超过实测最大延迟 ${GATEWAY_MEASURED_MAX_PING_SEC}s，按无风险计` : `下这些心跳会落在过期之后变成整段重写，期望额外成本 ${usd((t.lateRiskUsd || 0) * lateRate)}`}`);
  } else console.log(`  规则：每段空闲最多 ${a.count} 次；前缀 ≥ ${Math.round(a.minContextTokens / 1000)}K；人工接入 ≥ ${a.minHumanTurns} 轮${a.toolGapIgnoresTurns !== false ? '（工具执行中不看）' : ''}；${a.quietHours?.[0] === a.quietHours?.[1] ? '不设凌晨时段' : `${a.quietHours[0]}–${a.quietHours[1]} 点开始的空闲不保活`}`);
  console.log(`  心跳 ${t.pings} 次 ${usd(t.pingUsd)}：有用 ${t.usefulPings} 次，白发 ${t.wastedPings} 次（${pct(t.wastedPings, t.pings)}，${usd(t.wastedUsd)}）`);
  console.log(`  救回 ${t.kept} 次整段重写，省 ${usd(t.benefitUsd)}；净收益 ${usd(t.netUsd)}${t.roi ? `，ROI ${t.roi.toFixed(1)}×` : ''}`);
  console.log(`  不保活时这些空闲一共整段重写 ${t.coldStarts} 次 ${usd(t.coldUsd)}；开了之后仍要重写 ${t.missed} 次 ${usd(t.missedUsd)}`);
  const reasons = Object.entries(t.missedByReason).sort((x, y) => y[1].usd - x[1].usd);
  if (reasons.length) console.log(`  仍要重写的原因：${reasons.map(([code, v]) => `${code === 'coverage' ? '离开太久超出覆盖' : GATEWAY_SKIP_LABELS[code] || AUTO_SKIP_LABELS[code] || code} ${v.count} 次 ${usd(v.usd)}`).join('；')}`);
  console.log(`  空闲结局：${Object.entries(t.outcomes).map(([k, v]) => `${OUTCOME_TEXT[k] || k} ${v}`).join('，')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node cache-keepalive/backtest.js [--days 7] [--count 3] [--min-context 100k] [--min-turns 2] [--quiet 1-8|off] [--grid] [--session <ID 前缀>] [--json]');
    console.log('      --gateway <span，如 0|3h|12h>  按上游网关内置规则（live setting claude_prompt_cache_keepalive）回测；--gateway-guards 用护栏版规则（提前量 5m、工具调用 2h、人工 ≥2、前缀 ≥100K）；--gateway-grid 对比新旧各 span 与中继当前规则；--late-rate 0.04 心跳延迟超过 30s 的比例');
    return;
  }
  // 规则取 ~/.config/cache-keepalive/config.json（与中继一致），命令行参数覆盖
  const cfg = mergeConfig(loadConfig(), { auto: args.auto });
  const policy = args.gateway != null || args.gatewayGrid || args.gatewayGuards ? { kind: 'gateway', spanSec: args.gateway == null ? 0 : parseSpan(args.gateway), guards: Boolean(args.gatewayGuards) } : null;
  const variants = args.gatewayGrid ? gatewayVariants() : args.grid ? defaultVariants() : null;
  const { result, loaded, simulated } = await runBacktest({ cfg, days: args.days, variants, policy });
  if (args.json) {
    console.log(JSON.stringify({ ...result, labels: OUTCOME_TEXT }));
    return;
  }
  printResult(result, { lateRate: args.lateRate || 0 });
  if (args.session) {
    loaded.forEach((session, index) => {
      if (!session.sid.startsWith(args.session)) return;
      console.log(`\n会话 ${session.sid.slice(0, 8)} ${session.cwd || ''}`);
      for (const gap of simulated[index]) {
        const time = new Date(gap.at).toLocaleString('zh-CN', { hour12: false });
        console.log(`  ${time} 前缀 ${Math.round(gap.contextTokens / 1000)}K 人工 ${gap.humanTurns} 轮 ${gap.stopReason || '-'} → 空闲 ${gap.gapSec == null ? '未回来' : `${Math.round(gap.gapSec / 60)}m`}`
          + ` ${gap.decision} 心跳 ${gap.pings} 次 ${usd(gap.pingUsd)} · ${OUTCOME_TEXT[gap.outcome] || gap.outcome}${gap.benefitUsd ? ` 省 ${usd(gap.benefitUsd)}` : gap.coldUsd ? ` 重写 ${usd(gap.coldUsd)}` : ''}`);
      }
    });
  }
  if (result.variants) {
    const late = args.lateRate || 0;
    console.log(args.gatewayGrid ? '\n网关版旧规则 / 护栏版各 span 与中继当前规则对比（同一份数据；网关版心跳按全部命中计，最后一列按实测延迟分布扣掉落在过期后的心跳，提前量超过实测最大延迟的按无风险计）：' : '\n参数对比（同一份数据、同一套决策逻辑）：');
    console.log(`  规则                         心跳   白发   心跳花费   救回   节省      净收益${args.gatewayGrid ? '      提前量风险   扣风险后净' : ''}`);
    for (const variant of result.variants) {
      const v = variant.totals;
      const risk = variant.policy?.kind === 'gateway' ? (v.lateRiskUsd || 0) * late : 0;
      console.log(`  ${variant.label.padEnd(22)} ${String(v.pings).padStart(6)} ${pct(v.wastedPings, v.pings).padStart(6)} ${usd(v.pingUsd).padStart(9)} ${String(v.kept).padStart(6)} ${usd(v.benefitUsd).padStart(9)} ${usd(v.netUsd).padStart(9)}${args.gatewayGrid ? ` ${usd(-risk).padStart(14)} ${usd(v.netUsd - risk).padStart(11)}` : ''}`);
    }
  }
  if (!args.session) {
    console.log('\n按会话（净收益排序，前 15）：');
    for (const row of result.sessions.slice(0, 15)) {
      console.log(`  ${row.sid.slice(0, 8)} ${(row.model || '').replace(/^.*\//, '').padEnd(16)} 空闲 ${String(row.idleGaps).padStart(3)} 段 · 心跳 ${String(row.pings).padStart(3)} 次 ${usd(row.pingUsd)} · 救回 ${row.kept} 次 ${usd(row.benefitUsd)} · 净 ${usd(row.netUsd)}  ${row.cwd || ''}`);
    }
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(__filename)) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
