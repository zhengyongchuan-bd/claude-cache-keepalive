// 缓存保活的纯逻辑：请求解析、心跳请求体、usage 解析、计价、护栏与收益核算。
// 这里不做任何 I/O，relay.js / store.js 负责网络、状态与持久化。

import { createHash } from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
  // 总开关：false 时不发任何心跳（自动 / 手动 / 长保活都停，也不能新开），中继照常转发；cache-keepalive off / on 切换
  enabled: true,
  upstream: 'http://127.0.0.1:8080',
  host: '127.0.0.1',
  port: 18110,
  // 各 TTL 的保活参数。interval 必须明显小于 TTL：TTL 从请求「开始」计时，留出网络与排队余量。
  ttl: {
    '1h': { ttlSec: 3600, intervalSec: 3000, minIntervalSec: 300, maxIntervalSec: 3300, defaultCount: 6, maxCount: 12, safetySec: 120 },
    '5m': { ttlSec: 300, intervalSec: 240, minIntervalSec: 60, maxIntervalSec: 270, defaultCount: 3, maxCount: 10, safetySec: 20 },
  },
  minContextTokens: 50000,   // 软护栏：上下文太小，省下的重写费不值得保活（--force 可越过）
  hitRatio: 0.9,             // 心跳 cache_read ≥ 预期前缀 × 该比例才算命中
  // 心跳写入超过 max(maxPingWriteTokens, 预期前缀 × maxPingWriteRatio) 视为前缀已部分失效。
  // 比例按 1%：600K 前缀允许 6K 重写（约 $0.05），5% 时 30K 重写（$0.24）也会被当成命中而静默多付
  maxPingWriteTokens: 4096,
  maxPingWriteRatio: 0.01,
  resumeHitRatio: 0.8,       // 回来的请求 cache_read ≥ 最后一次命中心跳读到的 × 该比例才算「保住」（低于它多半只读到共享系统前缀）
  // 全局安全刹车（按本地日期）：任务多时一天的心跳不止几百次（30 个会话 × 每天约 29 次），按金额兜底更实在；
  // cache-keepalive budget set --pings N --usd X 可改
  maxPingsPerDay: 1000,
  maxUsdPerDay: 50,
  planMaxAgeSec: 86400,
  // 实测 58 次心跳 p50 5.6s / p90 16.6s / p99 94s / max 108s（2026-10-25）：120s 会被长上下文撞到。
  // 超时的心跳上游多半已经处理（照常计费、照常刷新缓存），所以按预估成本记账并计入每日额度
  pingTimeoutMs: 300000,
  pingRetryDelaySec: 30,      // 心跳失败后的重试间隔；网关/上游瞬时故障按指数退避，封顶 pingRetryMaxDelaySec
  pingRetryTimeoutDelaySec: 120, // 超时后至少等这么久再重试：上游可能还在处理上一发
  pingRetryMaxDelaySec: 300,
  maxBodyBytes: 256 * 1024 * 1024,           // 请求体上限（中继要整段缓冲后再转发），超过直接 413
  maxCaptureBytes: 64 * 1024 * 1024,         // 超过此大小的请求体只透传、不留快照
  maxTotalSnapshotBytes: 768 * 1024 * 1024,  // 快照总内存上限，超出按最久未触达淘汰
  ledgerRetentionDays: 35,
  // 控制 API 的写操作（开启/停止/心跳/改设置）要带 x-cache-keepalive-token，值在 stateDir/control.token（0600）。
  // 防止同机其他用户或拿不到该文件的进程误触发计费心跳；设为 false 关闭
  controlToken: true,
  // 告警：未命中锁定、全局冷却、心跳超时、等凭证、额度用尽、上游持续失败、调度异常时 POST 到 webhook。
  // format: json（{kind,title,text,at,...}）/ feishu（飞书自定义机器人 text 消息）；同类告警 minIntervalSec 内只发一次
  alerts: { webhookUrl: '', format: 'json', minIntervalSec: 600, kinds: ['miss', 'cooldown', 'ping-timeout', 'waiting-auth', 'daily-budget', 'upstream-down', 'tick-error'] },
  // 长保活（pin）：给某个会话设一个到期时刻，期间每段空闲都按间隔发心跳直到到期，不受自动保活门槛与每段次数限制；
  // 仍受硬护栏约束：会话活跃时不发、缓存已过期不发、未命中即锁定并取消、每日额度、Paseo 归档即取消
  // skipClosedAgents：任务进程已退出 / 任务已关闭的空闲段不发（没人会回来，要回来得先 resume，那时接上）
  // idleMaxPings：长期保活每段空闲最多发多少次（默认 30 次 ≈ 25 小时没人回来就停这段，下一次请求后接上）；pin --forever --count N 可按会话改
  pin: { defaultSec: 12 * 3600, maxSec: 48 * 3600, skipClosedAgents: true, idleMaxPings: 30 },
  // 真实请求失败（如 529）后客户端会立刻重试：这段时间会话算活跃，不发心跳
  requestRetryGraceSec: 90,
  // 会话对应的任务还在不在（自动保活「任务已关闭」门槛）：process = 扫 /proc 里的 Claude Code 进程（按 --resume 会话 ID 或工作区匹配，
  // 只对见过进程的会话下结论）；paseo = 读 ~/.paseo/agents（有就优先）。两者都可关
  agentProbe: { process: true, paseo: true },
  // 回测的会话记录来源：默认 $CLAUDE_CONFIG_DIR / ~/.claude 的 projects，加上 Paseo 路由里标了 1h 的；这里可再加目录（projects 目录或其上级）
  backtest: { roots: [] },
  prices: {},     // 覆盖默认价格表，USD / 百万 token
  priceScale: 1,  // 网关折扣等整体系数
  // 自动保活：1h 缓存的主对话空闲到间隔时自动发心跳，每段空闲最多 count 次；用户手动 stop 后整个会话不再自动保活
  auto: {
    mode: 'on',               // on / off
    count: 3,                 // 每段空闲最多几次心跳（3 × 50m 约覆盖 3.5 小时的离开）
    minContextTokens: 100000, // 缓存前缀太小的会话不自动保活
    // 人工接入轮次太少（没有人参与的自动化任务）不自动保活。30 天回测（1007 个会话）：≥1 轮 815 次心跳 98% 白发、净 $22；
    // ≥2 轮 195 次心跳、少救 3 次（$2.4）、净 $35——「发完第一条提示就走」的会话绝大多数不会再回来
    minHumanTurns: 2,
    toolGapIgnoresTurns: true, // 工具（含子代理、后台任务）执行中的空闲一定会有下一次请求，不看人工轮次
    quietHours: [1, 8],       // 本地时间 [1 点, 8 点) 开始的空闲不自动保活（多半是去睡了，3.5 小时也保不住）；[0, 0] 关闭
    missCooldownSec: 7200,    // 任一自动心跳没命中后，全局暂停新的自动保活这么久
    // 任务进程已退出（进程探测 / Paseo 显示已关闭或出错）的空闲不保活：线上 7 天里「保活后没人回来」13 段对「生效」10 段，没回来是最大的成本来源
    skipClosedAgents: true,
  },
});

export const TTL_SEC = Object.freeze({ '1h': 3600, '5m': 300 });

// USD / 百万 token，Anthropic 官方价目（2026-10）。缓存写入按 input × 1.25（5m）/ × 2（1h）计。
export const DEFAULT_PRICES = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  // Haiku 5.5 超过 100K 提示词整单按高档计价。
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, above100k: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
});
const FALLBACK_PRICE_MODEL = 'claude-opus-5-5';

export function mergeConfig(base, override = {}) {
  const out = { ...base, ...override };
  out.ttl = {};
  for (const key of Object.keys(TTL_SEC)) out.ttl[key] = { ...base.ttl[key], ...(override.ttl?.[key] || {}) };
  out.prices = { ...(base.prices || {}), ...(override.prices || {}) };
  out.auto = { ...(base.auto || {}), ...(override.auto || {}) };
  out.alerts = { ...(base.alerts || {}), ...(override.alerts || {}) };
  out.pin = { ...(base.pin || {}), ...(override.pin || {}) };
  out.agentProbe = { ...(base.agentProbe || {}), ...(override.agentProbe || {}) };
  out.backtest = { ...(base.backtest || {}), ...(override.backtest || {}) };
  return out;
}

export function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function nonNegInt(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

// "50m" / "1h30m" / "90s" / "3000"（秒）→ 秒；无法解析返回 NaN。
export function parseDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return NaN;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  let total = 0;
  let consumed = '';
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)) {
    total += Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2]];
    consumed += m[0];
  }
  return consumed && consumed === text ? total : NaN;
}

// ---------------------------------------------------------------------------
// 原始 JSON 文本的顶层字段改写
//
// 心跳必须与原请求渲染出相同的提示词前缀。整体 parse/stringify 可能改变数字格式或整数键顺序，
// 这里只替换顶层 max_tokens / stream 的值，其余字节原样保留。

export function patchTopLevelJson(text, patches) {
  const { members, closeAt } = scanTopLevelMembers(text);
  const edits = [];
  const seen = new Set();
  for (const member of members) {
    if (!Object.hasOwn(patches, member.key)) continue;
    edits.push({ start: member.valueStart, end: member.valueEnd, text: JSON.stringify(patches[member.key]) });
    seen.add(member.key);
  }
  const missing = Object.keys(patches).filter(key => !seen.has(key) && patches[key] !== undefined);
  if (missing.length) {
    const insert = missing.map(key => `${JSON.stringify(key)}:${JSON.stringify(patches[key])}`).join(',');
    edits.push({ start: closeAt, end: closeAt, text: (members.length ? ',' : '') + insert });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function scanTopLevelMembers(text) {
  let i = skipWs(text, 0);
  if (text[i] !== '{') throw new Error('请求体不是 JSON 对象');
  i = skipWs(text, i + 1);
  const members = [];
  if (text[i] === '}') return { members, closeAt: i };
  for (;;) {
    if (text[i] !== '"') throw new Error(`JSON 顶层键格式异常 @${i}`);
    const keyEnd = scanString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd));
    i = skipWs(text, keyEnd);
    if (text[i] !== ':') throw new Error(`JSON 缺少冒号 @${i}`);
    const valueStart = skipWs(text, i + 1);
    const valueEnd = scanValue(text, valueStart);
    members.push({ key, valueStart, valueEnd });
    i = skipWs(text, valueEnd);
    if (text[i] === ',') {
      i = skipWs(text, i + 1);
      continue;
    }
    if (text[i] === '}') return { members, closeAt: i };
    throw new Error(`JSON 顶层结构异常 @${i}`);
  }
}

function skipWs(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    i += 1;
  }
  return i;
}

function scanString(text, quoteAt) {
  const start = quoteAt + 1;
  let from = start;
  for (;;) {
    const q = text.indexOf('"', from);
    if (q < 0) throw new Error('JSON 字符串未闭合');
    let backslashes = 0;
    for (let b = q - 1; b >= start && text.charCodeAt(b) === 92; b -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return q + 1;
    from = q + 1;
  }
}

function scanValue(text, i) {
  const c = text[i];
  if (c === '"') return scanString(text, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i = scanString(text, i);
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    throw new Error('JSON 结构未闭合');
  }
  let j = i;
  while (j < text.length && !',}] \t\r\n'.includes(text[j])) j += 1;
  if (j === i) throw new Error(`JSON 值缺失 @${i}`);
  return j;
}

// 心跳 = 原请求体 + max_tokens:0 + stream:false。
// max_tokens:0 只跑 prefill：刷新缓存计时、只计缓存读取、不产生输出；它不能与 stream:true 同用，
// 而 stream 是传输层选项、不进缓存前缀，关掉不影响命中。
export function buildPingBody(rawText, { maxTokens = 0 } = {}) {
  const patched = patchTopLevelJson(rawText, { max_tokens: maxTokens, stream: false });
  const check = JSON.parse(patched);
  if (check.max_tokens !== maxTokens || check.stream !== false) throw new Error('心跳请求体改写校验失败');
  return patched;
}

// ---------------------------------------------------------------------------
// 请求解析

const CWD_RE = /(?:^|\n)[ \t]*(?:[-*][ \t]*)?(?:Primary working directory|Working directory)[ \t]*:[ \t]*([^\n]+)/;
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header';
// Claude Code 压缩（/compact、自动压缩，以及只总结较近消息的部分压缩）请求的最后一条 user 消息
const COMPACT_PROMPT_RE = /Your task is to create a detailed summary of the (?:conversation so far|RECENT portion of the conversation)/;

export function headerSessionId(headers = {}) {
  const header = headers['x-claude-code-session-id'];
  return typeof header === 'string' && /^[\w.:-]{6,128}$/.test(header.trim()) ? header.trim() : null;
}

export function extractSessionId(body, headers = {}) {
  const fromHeader = headerSessionId(headers);
  if (fromHeader) return fromHeader;
  const userId = body?.metadata?.user_id;
  if (typeof userId === 'string') {
    const composite = userId.match(/session_([0-9a-f]{8}-[0-9a-f-]{27,})/i);
    if (composite) return composite[1];
    try {
      const parsed = JSON.parse(userId);
      if (typeof parsed?.session_id === 'string' && parsed.session_id) return parsed.session_id;
    } catch { /* 非 JSON 形式的 user_id */ }
  }
  return null;
}

function blockTexts(content) {
  if (typeof content === 'string') return [content];
  return arr(content).filter(block => isPlainObject(block) && typeof block.text === 'string').map(block => block.text);
}

// 会话中途 cd 后，环境段会写成「/new/dir (was /old/dir)」；只要当前目录，否则 Paseo 任务映射与按目录匹配都会失效
function cleanCwd(text) {
  return String(text).trim().replace(/\s*\((?:was|previously|formerly)\b[^)]*\)\s*$/i, '').trim();
}

function cwdFromTexts(texts) {
  for (const text of texts) {
    const match = text.match(CWD_RE);
    if (match) return cleanCwd(match[1]);
  }
  return null;
}

// 环境段的位置随版本变化：顶层 system（旧版 CLI）→ messages 里的 role:system 消息（2.1.29x）
// → 首条 user 消息的 system-reminder；都没有时用 safeguards 里的 live_cwd。
export function extractCwd(body) {
  const direct = cwdFromTexts(blockTexts(body?.system));
  if (direct) return direct;
  const messages = arr(body?.messages);
  for (let i = 0; i < messages.length; i += 1) {
    if (i > 0 && messages[i]?.role !== 'system') continue;
    const found = cwdFromTexts(blockTexts(messages[i]?.content));
    if (found) return found;
  }
  for (const guard of arr(body?.safeguards)) {
    const live = guard?.classifier_context?.live_cwd;
    if (typeof live === 'string' && live) return live;
  }
  return null;
}

// 按渲染顺序（tools → system → messages → 顶层自动缓存）收集断点 TTL。
function collectCacheTtls(body) {
  const ttls = [];
  const take = cacheControl => {
    if (isPlainObject(cacheControl) && cacheControl.type === 'ephemeral') ttls.push(cacheControl.ttl === '1h' ? '1h' : '5m');
  };
  for (const tool of arr(body.tools)) take(tool?.cache_control);
  if (Array.isArray(body.system)) for (const block of body.system) take(block?.cache_control);
  for (const message of arr(body.messages)) for (const block of arr(message?.content)) take(block?.cache_control);
  take(body.cache_control);
  return ttls;
}

function lastUserTexts(body) {
  const messages = arr(body.messages);
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'user') return blockTexts(messages[i].content);
  return [];
}

function stableSystemText(system) {
  // 计费 attribution 块每次请求都变，不参与会话谱系判定
  return blockTexts(system).filter(text => !text.startsWith(BILLING_HEADER_PREFIX)).join('\n\u001e');
}

export function parseMessagesRequest(text, headers = {}) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!isPlainObject(body)) return { ok: false, reason: 'not-object' };
  const model = typeof body.model === 'string' ? body.model : '';
  const sessionId = extractSessionId(body, headers);
  const toolNames = arr(body.tools).map(tool => (isPlainObject(tool) ? String(tool.name || tool.type || '?') : '?'));
  const ttls = collectCacheTtls(body);
  const thinkingType = isPlainObject(body.thinking) ? body.thinking.type ?? null : null;
  const systemHash = sha1(stableSystemText(body.system)).slice(0, 12);
  const outputFormat = isPlainObject(body.output_config) && body.output_config.format != null;
  const forcedTool = isPlainObject(body.tool_choice) && ['any', 'tool'].includes(body.tool_choice.type);
  // Claude Code 2.1.29x 的子代理请求带 x-claude-code-agent-id，主线程不带；子代理同样带 Agent 工具，不能只看工具
  const agentId = String(headers['x-claude-code-agent-id'] || '').trim();
  const hasAgentTool = toolNames.includes('Agent') || toolNames.includes('Task');
  // 主对话：不是子代理，并且（带 Agent/Task 工具）或（会发 x-claude-code-session-id 头的新版客户端里带任意工具的请求）。
  // 只认 Agent 工具会漏掉 --tools 限制、禁用 Agent、SDK 应用等场景；标题生成、权限分类等旁路请求没有工具，仍被排除。
  // 旧版客户端不发会话头也不发 agent-id 头，这时只能看 Agent 工具，否则会把子代理当成主对话
  const isMainThread = !agentId && (hasAgentTool || (Boolean(headerSessionId(headers)) && toolNames.length > 0));
  return {
    ok: true,
    model,
    sessionId,
    cwd: extractCwd(body),
    // 最后一个断点覆盖的前缀最长；API 要求长 TTL 在前，所以它也是最短的 TTL
    ttl: ttls.length ? ttls[ttls.length - 1] : null,
    breakpoints: ttls.length,
    stream: body.stream === true,
    thinkingType,
    toolCount: toolNames.length,
    isSubagent: Boolean(agentId),
    isMainThread,
    messageCount: arr(body.messages).length,
    humanTurns: countHumanTurns(body.messages),
    // 压缩请求读的是旧前缀；压缩后对话从摘要重新开始，旧前缀不会再被读到
    isCompaction: lastUserTexts(body).some(text => COMPACT_PROMPT_RE.test(text)),
    systemHash,
    lineageKey: sha1([sessionId || 'anon', model, systemHash, toolNames.join(',')].join('|')).slice(0, 16),
    // thinking.type=enabled 要求 max_tokens > budget_tokens，无法做零输出心跳
    unpingableReason: thinkingType === 'enabled' ? 'thinking-enabled' : null,
    // 结构化输出 / 强制工具时 max_tokens:0 会被拒，退回 max_tokens:1
    pingMaxTokens: outputFormat || forcedTool ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// usage 解析（SSE 与 JSON 两种响应）

export function normalizeUsage(raw) {
  if (!isPlainObject(raw)) return null;
  const creation = isPlainObject(raw.cache_creation) ? raw.cache_creation : null;
  return {
    input: nonNegInt(raw.input_tokens),
    cacheRead: nonNegInt(raw.cache_read_input_tokens),
    cacheWrite: nonNegInt(raw.cache_creation_input_tokens),
    cacheWrite5m: creation ? nonNegInt(creation.ephemeral_5m_input_tokens) : null,
    cacheWrite1h: creation ? nonNegInt(creation.ephemeral_1h_input_tokens) : null,
    output: nonNegInt(raw.output_tokens),
  };
}

export function promptTokens(usage) {
  return usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
}

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SSE_LINE = 4 * 1024 * 1024;
const SKIPPED_EVENTS = new Set(['content_block_start', 'content_block_delta', 'content_block_stop', 'ping']);

// 旁路观察响应：只解析 usage / stop_reason / 完整性，不影响透传给客户端的字节。
export class UsageTap {
  constructor(contentType = '') {
    this.mode = /event-stream/i.test(contentType) ? 'sse' : 'json';
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.eventName = '';
    this.eventData = [];
    this.jsonParts = [];
    this.jsonBytes = 0;
    this.rawUsage = null;
    this.stopReason = null;
    this.model = null;
    this.complete = false;
    this.sawStart = false;
    this.error = null;
    this.overflow = false;
  }

  push(chunk) {
    if (this.mode === 'json') {
      if (this.jsonBytes + chunk.length > MAX_JSON_BYTES) {
        this.overflow = true;
        return;
      }
      this.jsonParts.push(chunk);
      this.jsonBytes += chunk.length;
      return;
    }
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n', start)) {
      let line = this.buffer.slice(start, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.#line(line);
      start = nl + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > MAX_SSE_LINE) {
      this.overflow = true;
      this.buffer = '';
    }
  }

  finish() {
    if (this.mode === 'json') {
      if (!this.overflow && this.jsonBytes) {
        try {
          const body = JSON.parse(Buffer.concat(this.jsonParts).toString('utf8'));
          if (body?.type === 'error') this.error = body.error?.message || body.error?.type || 'error';
          else {
            this.rawUsage = isPlainObject(body?.usage) ? body.usage : null;
            this.stopReason = body?.stop_reason ?? null;
            this.model = body?.model ?? null;
            this.complete = Boolean(this.rawUsage);
            this.sawStart = this.complete;
          }
        } catch {
          this.error = 'invalid-json-response';
        }
      }
      this.jsonParts = [];
    } else {
      if (this.buffer) this.#line(this.buffer);
      this.#dispatch();
    }
    return {
      usage: normalizeUsage(this.rawUsage),
      stopReason: this.stopReason,
      model: this.model,
      complete: this.complete,
      sawStart: this.sawStart,
      error: this.error,
      overflow: this.overflow,
    };
  }

  #line(line) {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return undefined;
    if (line.startsWith('event:')) this.eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) this.eventData.push(line.slice(5).replace(/^ /, ''));
    return undefined;
  }

  #dispatch() {
    const name = this.eventName;
    const data = this.eventData.join('\n');
    this.eventName = '';
    this.eventData = [];
    if (!data || SKIPPED_EVENTS.has(name)) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event?.type === 'message_start') {
      this.sawStart = true;
      this.model = event.message?.model ?? null;
      this.rawUsage = isPlainObject(event.message?.usage) ? { ...event.message.usage } : null;
    } else if (event?.type === 'message_delta') {
      // message_delta 的 usage 是累计终值，覆盖 message_start 的同名字段
      if (isPlainObject(event.usage)) this.rawUsage = { ...(this.rawUsage || {}), ...event.usage };
      if (event.delta?.stop_reason) this.stopReason = event.delta.stop_reason;
    } else if (event?.type === 'message_stop') {
      this.complete = true;
    } else if (event?.type === 'error') {
      this.error = event.error?.message || event.error?.type || 'stream-error';
    }
  }
}

// ---------------------------------------------------------------------------
// 计价

export function normalizeModel(model) {
  let id = String(model || '').toLowerCase().trim().replace(/\[[^\]]*\]$/, '');
  if (id.includes('/')) id = id.slice(id.lastIndexOf('/') + 1);
  return id.replace(/(\d)\.(\d)/g, '$1-$2').replace(/-\d{8}$/, '');
}

export function priceFor(model, cfg = DEFAULT_CONFIG, prompt = 0) {
  const table = { ...DEFAULT_PRICES, ...(cfg.prices || {}) };
  const id = normalizeModel(model);
  const key = table[id]
    ? id
    : Object.keys(table).filter(name => id.startsWith(name)).sort((a, b) => b.length - a.length)[0];
  const base = table[key] || table[FALLBACK_PRICE_MODEL];
  const tier = base.above100k && prompt > 100000 ? base.above100k : base;
  const scale = Number(cfg.priceScale) > 0 ? Number(cfg.priceScale) : 1;
  return {
    model: key || FALLBACK_PRICE_MODEL,
    assumed: !key,
    input: tier.input * scale,
    output: tier.output * scale,
    cacheRead: tier.cacheRead * scale,
    write5m: tier.input * 1.25 * scale,
    write1h: tier.input * 2 * scale,
  };
}

// 未给出 5m/1h 拆分时，按请求的断点 TTL 归类缓存写入。
export function usageCostUsd(usage, { model, ttl, cfg = DEFAULT_CONFIG } = {}) {
  if (!usage) return 0;
  const price = priceFor(model, cfg, promptTokens(usage));
  let write5m = usage.cacheWrite5m ?? 0;
  let write1h = usage.cacheWrite1h ?? 0;
  const rest = usage.cacheWrite - write5m - write1h;
  if (rest > 0) {
    if (ttl === '1h') write1h += rest;
    else write5m += rest;
  }
  return (usage.input * price.input
    + usage.cacheRead * price.cacheRead
    + write5m * price.write5m
    + write1h * price.write1h
    + usage.output * price.output) / 1e6;
}

// 保住缓存后，回来的那次请求把整段重写（write）变成读取（read）省下的钱。
// prompt：定价分档看的整条请求提示词（Haiku 5.5 超过 100K 整单按高档），默认就是 tokens
export function keepSavingUsd(tokens, { model, ttl, cfg = DEFAULT_CONFIG, prompt = tokens } = {}) {
  const price = priceFor(model, cfg, prompt);
  const write = ttl === '1h' ? price.write1h : price.write5m;
  return Math.max(0, tokens * (write - price.cacheRead) / 1e6);
}

// 这次请求每个写入 token 的实际单价：按响应里的 5m/1h 拆分加权（压缩请求自己标 5m），没有拆分时按 TTL
function writePrice(usage, ttl, price) {
  const split5m = usage.cacheWrite5m || 0;
  const split1h = usage.cacheWrite1h || 0;
  if (split5m + split1h > 0) return (split5m * price.write5m + split1h * price.write1h) / (split5m + split1h);
  return ttl === '1h' ? price.write1h : price.write5m;
}

export function pingCostEstimateUsd(tokens, { model, cfg = DEFAULT_CONFIG } = {}) {
  return tokens * priceFor(model, cfg, tokens).cacheRead / 1e6;
}

// ---------------------------------------------------------------------------
// 心跳结果判定

export function classifyPing(usage, expectedCached, cfg = DEFAULT_CONFIG) {
  if (!usage) return 'unknown';
  if (usage.cacheRead === 0) return 'miss';
  const writeLimit = Math.max(cfg.maxPingWriteTokens, expectedCached * cfg.maxPingWriteRatio);
  if (usage.cacheWrite > writeLimit) return 'rewrite';
  if (expectedCached > 0 && usage.cacheRead < expectedCached * cfg.hitRatio) return 'partial';
  return 'hit';
}

// 网关/上游暂时不可用：连接失败或超时（status 0）、408/425/429、5xx（含 529 overloaded）。
// 这类失败时会话缓存多半还在，值得在安全窗口内重试；其他 4xx（请求被拒、认证失败）重试也没用。
export function isTransientPingError(status) {
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

export const OUTCOME_LABELS = Object.freeze({
  hit: '命中',
  miss: '未命中(cache_read=0)',
  partial: '部分命中',
  rewrite: '未命中(大量重写)',
  unknown: '用量未知',
  timeout: '超时(上游可能已处理)',
  error: '请求失败',
});

// 没拿到 usage 的心跳（超时、响应没有 usage）：上游多半已经做完 prefill 并计费，按读一遍前缀估算成本
export const ESTIMATED_OUTCOMES = new Set(['timeout', 'unknown']);

// ---------------------------------------------------------------------------
// 保活护栏与参数

export function ttlSettings(ttl, cfg = DEFAULT_CONFIG) {
  return cfg.ttl[ttl] || null;
}

// lineage 只需包含这些字段：ttl, model, expectedCached, lastTouchAt, blocked, hasSnapshot, unpingableReason, cacheable,
// compacted, ttlDowngraded, pingAnomaly
export function evaluatePlanRequest({ lineage, count, intervalSec, force = false, now = Date.now(), cfg = DEFAULT_CONFIG, daily = null }) {
  const errors = [];
  const warnings = [];
  const fail = (code, message, soft = false) => errors.push({ code, message, soft });

  if (!lineage) {
    fail('no-session', '没有找到经过保活中继的会话请求；需先让该会话通过中继发出至少一次请求');
    return { ok: false, errors, warnings };
  }
  const settings = ttlSettings(lineage.ttl, cfg);
  if (!settings) fail('no-cache-control', '该会话的请求没有 cache_control 断点，无缓存可保');
  // 缓存过期后快照会被清理，这时原因以「已过期」为准，不再报缺快照
  const idleSec = (now - lineage.lastTouchAt) / 1000;
  const expired = Boolean(settings) && idleSec > settings.ttlSec - settings.safetySec;
  if (!lineage.hasSnapshot && !expired) {
    fail('no-snapshot', lineage.compacted
      ? '会话刚压缩过，旧前缀不会再被读到；等它发出下一次请求（新前缀）后再保活'
      : '中继里没有该会话最近一次请求的快照（中继重启或请求体过大），等它再发一次请求后可保活');
  }
  if (lineage.unpingableReason === 'thinking-enabled') fail('thinking-enabled', 'thinking.type=enabled 需要 max_tokens > budget_tokens，无法发零输出心跳');
  if (!lineage.cacheable) fail('not-cacheable', '上一次请求既没读也没写缓存（cache_read+cache_write=0），保活没有意义');
  if (lineage.blocked) {
    fail('blocked', `上次保活心跳没命中会话缓存（${lineage.blocked.detail || 'cache_read=0'}），已锁定该会话；确认后可强制重试`, true);
  }
  if (lineage.expectedCached < cfg.minContextTokens) {
    fail('small-context', `缓存前缀仅 ${lineage.expectedCached} tokens（< ${cfg.minContextTokens}），省下的重写费很少`, true);
  }
  if (lineage.ttlDowngraded) fail('ttl-downgraded', '请求标了 1h，上游实际按 5m 写入缓存：按 1h 间隔发的心跳不会命中', true);
  if (lineage.pingAnomaly) {
    fail('ping-anomaly', `上次心跳产生了 ${lineage.pingAnomaly.output} 个输出 token（上游没遵守 max_tokens），每次心跳都会多付输出费`, true);
  }
  if (daily && (daily.pings >= cfg.maxPingsPerDay || daily.usd >= cfg.maxUsdPerDay)) {
    fail('daily-budget', `今日心跳已达上限（${daily.pings} 次 / $${daily.usd.toFixed(2)}）`);
  }
  if (!settings) return { ok: false, errors, warnings };

  // 缓存从最近一次触达（真实请求或命中心跳）的开始时刻起算 TTL；超过 TTL−安全边际就别再「保活」了，
  // 那会变成一次整段重写（1h 是 2× 输入价），正是保活要避免的成本。
  if (expired) {
    fail('expired', `距上次触达已 ${Math.round(idleSec / 60)} 分钟，超过 TTL(${lineage.ttl}) 安全窗口，缓存大概率已过期，心跳会变成整段重写`);
  }

  let resolvedCount = count == null || count === '' ? settings.defaultCount : count === 'max' ? settings.maxCount : Math.floor(Number(count));
  if (!Number.isFinite(resolvedCount) || resolvedCount < 1) {
    fail('bad-count', '保活次数必须是 ≥1 的整数');
    resolvedCount = settings.defaultCount;
  } else if (resolvedCount > settings.maxCount) {
    warnings.push(`保活次数 ${resolvedCount} 超过上限，按 ${settings.maxCount} 次执行`);
    resolvedCount = settings.maxCount;
  }

  let resolvedInterval = intervalSec == null || intervalSec === '' ? settings.intervalSec : parseDuration(intervalSec);
  if (!Number.isFinite(resolvedInterval)) {
    fail('bad-interval', `无法解析间隔：${intervalSec}`);
    resolvedInterval = settings.intervalSec;
  } else if (resolvedInterval < settings.minIntervalSec || resolvedInterval > settings.maxIntervalSec) {
    const clamped = Math.min(settings.maxIntervalSec, Math.max(settings.minIntervalSec, resolvedInterval));
    warnings.push(`间隔 ${Math.round(resolvedInterval)}s 超出 ${lineage.ttl} 允许范围 [${settings.minIntervalSec}, ${settings.maxIntervalSec}]s，按 ${clamped}s 执行`);
    resolvedInterval = clamped;
  }

  const blocking = errors.filter(error => !error.soft || !force);
  return {
    ok: blocking.length === 0,
    errors: blocking,
    warnings: [...warnings, ...errors.filter(error => error.soft && force).map(error => `已强制越过：${error.message}`)],
    count: resolvedCount,
    intervalSec: Math.round(resolvedInterval),
    settings,
  };
}

// 预估：每次心跳的花费、保住后回来能省多少、保活覆盖到什么时候。
export function planEconomics({ lineage, count, intervalSec, immediate = false, now = Date.now(), cfg = DEFAULT_CONFIG }) {
  const settings = ttlSettings(lineage.ttl, cfg);
  const tokens = lineage.expectedCached;
  const pingUsd = pingCostEstimateUsd(tokens, { model: lineage.model, cfg });
  const saveUsd = keepSavingUsd(tokens, { model: lineage.model, ttl: lineage.ttl, cfg });
  const firstPingAt = immediate ? now : Math.max(now, lineage.lastTouchAt + intervalSec * 1000);
  const lastPingAt = firstPingAt + (count - 1) * intervalSec * 1000;
  return {
    contextTokens: tokens,
    pingUsd,
    maxPingsUsd: pingUsd * count,
    saveUsd,
    breakEvenPings: pingUsd > 0 ? Math.floor(saveUsd / pingUsd) : null,
    firstPingAt,
    coveredUntil: settings ? lastPingAt + settings.ttlSec * 1000 : null,
  };
}

// ---------------------------------------------------------------------------
// 自动保活：人工轮次、上游实际写入的 TTL、资格判定（线上中继与回测共用同一套逻辑）

// 系统注入的用户消息（提醒、后台任务通知、本地命令输出、打断标记等），不算人工接入
const AUTO_TEXT_PREFIXES = ['<system-reminder>', '<task-notification', '[Request interrupted', '[SYSTEM NOTIFICATION',
  '<local-command-stdout', '<local-command-stderr', '<cross-session-message', 'Caveat: The messages below'];
const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation';

// 一条 user 消息是谁发的：human（人输入的提示、斜杠命令、粘贴的图片/文档）/ compact（压缩指令与压缩摘要）/
// tool（只有工具结果）/ auto（系统注入）/ empty。工具结果后面跟着的人工文字（执行中插话）也算 human。
export function classifyUserContent(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : arr(content);
  let tool = false;
  let auto = false;
  for (const block of blocks) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'tool_result') {
      tool = true;
      continue;
    }
    if (block.type === 'image' || block.type === 'document') return 'human';
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trimStart();
    if (!text) continue;
    if (COMPACT_PROMPT_RE.test(text) || text.startsWith(COMPACT_SUMMARY_PREFIX)) return 'compact';
    if (AUTO_TEXT_PREFIXES.some(prefix => text.startsWith(prefix))) {
      auto = true;
      continue;
    }
    return 'human';
  }
  return tool ? 'tool' : auto ? 'auto' : 'empty';
}

export function countHumanTurns(messages) {
  let turns = 0;
  for (const message of arr(messages)) if (message?.role === 'user' && classifyUserContent(message.content) === 'human') turns += 1;
  return turns;
}

// 上游实际按哪个 TTL 写的缓存（响应 usage 里的 5m/1h 拆分）；这次没有写入时返回 null
export function writtenTtl(usage) {
  const write1h = usage?.cacheWrite1h || 0;
  const write5m = usage?.cacheWrite5m || 0;
  if (write1h > 0 && write1h >= write5m) return '1h';
  if (write5m > 0) return '5m';
  return null;
}

// quietHours = [起, 止)（本地小时，可跨零点，如 [23, 7]）；起止相同表示不设
export function inQuietHours(at, quietHours) {
  const [start, end] = Array.isArray(quietHours) ? quietHours.map(Number) : [0, 0];
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const d = new Date(at);
  const hour = d.getHours() + d.getMinutes() / 60;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export const AUTO_SKIP_LABELS = Object.freeze({
  'auto-off': '自动保活已全局关闭',
  'session-stopped': '该会话已手动停止保活',
  anonymous: '请求里没有会话 ID',
  archived: '任务已归档（Paseo）',
  'not-main-thread': '还没见过该会话主对话的请求',
  'not-1h': '不是 1h 缓存',
  'ttl-downgraded': '请求标了 1h，上游实际按 5m 写入缓存',
  blocked: '上次心跳没命中，会话已锁定',
  unpingable: '请求无法做零输出心跳',
  'not-cacheable': '上一次请求没有读写缓存',
  'small-context': '缓存前缀太小',
  'few-human-turns': '人工接入轮次太少',
  cooldown: '有自动心跳没命中，自动保活全局暂停中',
  'quiet-hours': '空闲开始于凌晨时段，不自动保活',
  'busy-plan': '已有手动保活计划',
  'no-snapshot': '中继里没有该会话的请求快照',
  'missed-window': '中继错过了判定窗口（空闲 50–58 分钟之间没运行）',
  'agent-closed': '任务进程已退出（或 Paseo 任务已关闭），没人会回来',
  pinned: '该会话设置了长保活，由长保活接管',
});

// 这段空闲能不能自动保活（在第一次心跳到点时判定一次）。features：{ sessionId, sessionStopped, archived, isMainThread, ttl,
// ttlDowngraded, blocked, unpingable, cacheable, contextTokens, humanTurns, stopReason, agentStatus, cooldownUntil, idleStartAt }
export function autoEligibility(features, { now = Date.now(), cfg = DEFAULT_CONFIG } = {}) {
  const auto = cfg.auto || {};
  const skip = (code, message = AUTO_SKIP_LABELS[code]) => ({ ok: false, code, message });
  if (auto.mode !== 'on') return skip('auto-off');
  if (features.sessionStopped) return skip('session-stopped');
  if (!features.sessionId || String(features.sessionId).startsWith('anon-')) return skip('anonymous');
  if (features.archived) return skip('archived');
  if (!features.isMainThread) return skip('not-main-thread');
  if (features.ttl !== '1h') return skip('not-1h');
  if (features.ttlDowngraded) return skip('ttl-downgraded');
  if (features.blocked) return skip('blocked');
  if (features.unpingable) return skip('unpingable');
  if (!features.cacheable) return skip('not-cacheable');
  const minContext = Number(auto.minContextTokens) || 0;
  if ((features.contextTokens || 0) < minContext) {
    return skip('small-context', `缓存前缀 ${fmtK(features.contextTokens || 0)} < ${fmtK(minContext)} tokens`);
  }
  // Paseo 显示任务已关闭/出错：进程已退出，这段空闲不会有人回来（要回来得先 resume，那时再判定）
  const agentGone = ['closed', 'error'].includes(features.agentStatus);
  if (agentGone && auto.skipClosedAgents !== false) return skip('agent-closed');
  // 上一轮停在 tool_use：工具（含子代理、后台任务）还在执行，执行完一定会有下一次请求，不看人工轮次
  const toolGap = features.stopReason === 'tool_use' && !agentGone;
  const minTurns = Number(auto.minHumanTurns) || 0;
  if (!(toolGap && auto.toolGapIgnoresTurns !== false) && (features.humanTurns || 0) < minTurns) {
    return skip('few-human-turns', `人工接入 ${features.humanTurns || 0} 轮 < ${minTurns} 轮`);
  }
  if (features.cooldownUntil && now < features.cooldownUntil) {
    return skip('cooldown', `有自动心跳没命中，自动保活暂停到 ${new Date(features.cooldownUntil).toLocaleTimeString('zh-CN', { hour12: false })}`);
  }
  // 看空闲从什么时候开始：熬夜到 1 点前离开的照常保活（回测里有 22:39 离开、01:35 回来的）
  if (inQuietHours(features.idleStartAt ?? now, auto.quietHours)) return skip('quiet-hours');
  const settings = ttlSettings('1h', cfg);
  const count = Math.min(settings.maxCount, Math.max(1, Math.floor(Number(auto.count) || 1)));
  return { ok: true, code: toolGap ? 'tool-gap' : 'idle', count, intervalSec: settings.intervalSec };
}

function fmtK(tokens) {
  return `${Math.round(tokens / 1000)}K`;
}

// ---------------------------------------------------------------------------
// 收益核算

// 心跳之后的第一次真实请求（「回来」）：判断缓存是否靠心跳保住、能折算多少收益。
// prev: 上一次真实请求开始时刻；pings: 期间的心跳 [{ at, outcome, cacheRead }]
export function attributeResume({ ttl, prevStartAt, startAt, usage, pings, model, cfg = DEFAULT_CONFIG }) {
  const ttlMs = (TTL_SEC[ttl] || 0) * 1000;
  const hits = pings.filter(ping => ping.outcome === 'hit');
  const result = { pings: pings.length, kept: false, savedTokens: 0, benefitUsd: 0, reason: 'no-pings' };
  if (!pings.length || !ttlMs) return result;
  if (startAt - prevStartAt <= ttlMs) return { ...result, reason: 'returned-within-ttl' };
  const lastHit = hits[hits.length - 1];
  if (!lastHit) return { ...result, reason: 'no-hit-ping' };
  if (startAt - lastHit.at > ttlMs) return { ...result, reason: 'expired-before-return' };
  // 只读到共享的系统提示/工具前缀（约 23K，常被别的会话保活）不算保住；默认要读到保住前缀的 80%
  const ratio = Number(cfg.resumeHitRatio) > 0 ? Number(cfg.resumeHitRatio) : 0.8;
  if (!usage || usage.cacheRead < lastHit.cacheRead * ratio) return { ...result, reason: 'resume-miss' };
  const savedTokens = Math.min(usage.cacheRead, lastHit.cacheRead);
  return {
    ...result,
    kept: true,
    savedTokens,
    benefitUsd: keepSavingUsd(savedTokens, { model, ttl, cfg, prompt: Math.max(savedTokens, promptTokens(usage)) }),
    reason: 'kept',
  };
}

// 冷启动（距上次请求超过 TTL、期间没有心跳）的整段重写：如果当时保活，大约能省多少。
// ttl：上一次请求写缓存时的 TTL；prevCached：上一次请求结束时缓存的前缀（read+write）。
// 只算旧前缀里没读到、被迫重写的部分（新追加的内容本来就要写）；大部分读到了就不是冷启动。
export function coldStartOpportunity({ ttl, gapSec, usage, prevCached = null, model, cfg = DEFAULT_CONFIG }) {
  const settings = ttlSettings(ttl, cfg);
  if (!settings || !usage || gapSec <= settings.ttlSec) return null;
  const lost = prevCached == null ? usage.cacheWrite : Math.max(0, prevCached - usage.cacheRead);
  const rewriteTokens = Math.min(usage.cacheWrite, lost);
  if (rewriteTokens <= Math.max(cfg.maxPingWriteTokens, (prevCached || 0) * cfg.maxPingWriteRatio)) return null;
  const pingsNeeded = Math.ceil((gapSec - settings.ttlSec) / settings.intervalSec);
  // 按整条请求的提示词定档：只看重写部分会把跨过 Haiku 100K 分档的请求低估 5 倍
  const price = priceFor(model, cfg, promptTokens(usage));
  const rewriteUsd = rewriteTokens * writePrice(usage, ttl, price) / 1e6;
  // 保活的代价：每次心跳读一遍整段缓存前缀，回来时这段改为读取
  const keepUsd = (pingsNeeded * (usage.cacheRead + rewriteTokens) + rewriteTokens) * price.cacheRead / 1e6;
  const autoCount = Math.min(settings.maxCount, Math.max(1, Math.floor(Number(cfg.auto?.count) || 1)));
  return {
    rewriteTokens,
    rewriteUsd,
    pingsNeeded,
    // coverable：手动保活按该 TTL 的次数上限能否覆盖；coverableByAuto：按当前自动策略的每段次数能否覆盖（两者分开报，别把自动策略救不到的算进「可挽救」）
    coverable: pingsNeeded <= settings.maxCount,
    coverableByAuto: pingsNeeded <= autoCount,
    autoCount,
    potentialSavingUsd: Math.max(0, rewriteUsd - keepUsd),
  };
}

export const RESUME_REASON_LABELS = Object.freeze({
  kept: '保活生效，回来时命中缓存',
  'returned-within-ttl': 'TTL 内就回来了，心跳是多余的',
  'expired-before-return': '心跳停止后缓存过期，回来时已失效',
  'no-hit-ping': '心跳都没命中',
  'resume-miss': '回来的请求没读到保住的前缀（前缀已变化）',
  'no-pings': '没有心跳',
});

export function summarizeEvents(events, { since = 0, pending = [] } = {}) {
  const totals = {
    pings: 0,
    pingHits: 0,
    pingMisses: 0,
    pingFailures: 0,
    pingTimeouts: 0,          // 超时 / 用量未知：上游多半已处理，成本按预估计入 pingCostUsd
    pingCostUsd: 0,
    pingCostEstimatedUsd: 0,  // pingCostUsd 里有多少是预估的（没拿到 usage）
    pingReadTokens: 0,
    resumes: 0,
    keptResumes: 0,
    savedTokens: 0,
    benefitUsd: 0,
    wastedResumes: 0,
    wastedPingCostUsd: 0,
    coldStarts: 0,
    coldRewriteUsd: 0,
    coldPotentialUsd: 0,      // 手动保活按次数上限能救回的
    coldPotentialAutoUsd: 0,  // 按当前自动策略的每段次数能救回的（自动保活真正能做到的上界）
    pendingSessions: 0,
    pendingPotentialUsd: 0,
    expiredUnusedSessions: 0,
    // 自动 / 手动分开看：心跳、花费、救回与白发
    bySource: {
      auto: { pings: 0, pingCostUsd: 0, keptResumes: 0, benefitUsd: 0, wastedResumes: 0, wastedPingCostUsd: 0 },
      manual: { pings: 0, pingCostUsd: 0, keptResumes: 0, benefitUsd: 0, wastedResumes: 0, wastedPingCostUsd: 0 },
      pin: { pings: 0, pingCostUsd: 0, keptResumes: 0, benefitUsd: 0, wastedResumes: 0, wastedPingCostUsd: 0 },
    },
    // 自动保活在每段空闲到点时的判定：开了几次、因为什么没开；冷启动按当时的判定归因
    autoStarted: 0,
    autoSkipped: {},
    coldByAuto: {},
  };
  const sessions = new Map();
  const daily = new Map();
  const touch = (sid, patch) => {
    const row = sessions.get(sid) || { sessionId: sid, pings: 0, pingCostUsd: 0, keptResumes: 0, benefitUsd: 0, coldStarts: 0, coldPotentialUsd: 0, lastAt: 0 };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'lastAt') row.lastAt = Math.max(row.lastAt, value);
      else row[key] = (row[key] || 0) + value;
    }
    sessions.set(sid, row);
  };
  const day = (at, patch) => {
    const key = localDay(at);
    const row = daily.get(key) || { day: key, pingCostUsd: 0, benefitUsd: 0, pings: 0 };
    for (const [field, value] of Object.entries(patch)) row[field] += value;
    daily.set(key, row);
  };
  const opportunities = [];
  for (const event of events) {
    if (!event || event.at < since) continue;
    if (event.t === 'ping') {
      totals.pings += 1;
      if (event.outcome === 'hit') totals.pingHits += 1;
      else if (['miss', 'rewrite', 'partial'].includes(event.outcome)) totals.pingMisses += 1;
      else if (ESTIMATED_OUTCOMES.has(event.outcome)) totals.pingTimeouts += 1;
      else totals.pingFailures += 1;
      totals.pingCostUsd += event.costUsd || 0;
      if (event.estimated) totals.pingCostEstimatedUsd += event.costUsd || 0;
      const bucket = totals.bySource[sourceKey(event.source)];
      bucket.pings += 1;
      bucket.pingCostUsd += event.costUsd || 0;
      totals.pingReadTokens += event.usage?.cacheRead || 0;
      touch(event.sid, { pings: 1, pingCostUsd: event.costUsd || 0, lastAt: event.at });
      day(event.at, { pings: 1, pingCostUsd: event.costUsd || 0 });
    } else if (event.t === 'auto') {
      if (event.ok === true) totals.autoStarted += 1;
      else if (event.ok === false) totals.autoSkipped[event.code] = (totals.autoSkipped[event.code] || 0) + 1;
    } else if (event.t === 'req' && event.resume) {
      totals.resumes += 1;
      const bucket = totals.bySource[sourceKey(event.resume.source)];
      if (event.resume.kept) {
        bucket.keptResumes += 1;
        bucket.benefitUsd += event.resume.benefitUsd;
      } else {
        bucket.wastedResumes += 1;
        bucket.wastedPingCostUsd += event.resume.pingCostUsd || 0;
      }
      if (event.resume.kept) {
        totals.keptResumes += 1;
        totals.savedTokens += event.resume.savedTokens;
        totals.benefitUsd += event.resume.benefitUsd;
        touch(event.sid, { keptResumes: 1, benefitUsd: event.resume.benefitUsd, lastAt: event.at });
        day(event.at, { benefitUsd: event.resume.benefitUsd });
      } else {
        totals.wastedResumes += 1;
        totals.wastedPingCostUsd += event.resume.pingCostUsd || 0;
        touch(event.sid, { lastAt: event.at });
      }
    } else if (event.t === 'req' && event.cold) {
      totals.coldStarts += 1;
      totals.coldRewriteUsd += event.cold.rewriteUsd;
      const code = event.auto ? (event.auto.ok ? 'started' : event.auto.code) : 'undecided';
      const cold = totals.coldByAuto[code] || { count: 0, rewriteUsd: 0 };
      cold.count += 1;
      cold.rewriteUsd += event.cold.rewriteUsd;
      totals.coldByAuto[code] = cold;
      if (event.cold.coverable) totals.coldPotentialUsd += event.cold.potentialSavingUsd;
      // 旧事件没有 coverableByAuto：按 3 次 × 50m 的默认策略回推
      const byAuto = event.cold.coverableByAuto ?? (event.cold.pingsNeeded <= (DEFAULT_CONFIG.auto.count || 3));
      if (byAuto) totals.coldPotentialAutoUsd += event.cold.potentialSavingUsd;
      touch(event.sid, { coldStarts: 1, coldPotentialUsd: event.cold.coverable ? event.cold.potentialSavingUsd : 0, lastAt: event.at });
      opportunities.push({ at: event.at, sessionId: event.sid, cwd: event.cwd, model: event.model, ttl: event.ttl, gapSec: event.gapSec, auto: event.auto || null, ...event.cold });
    }
  }
  for (const item of pending) {
    if (item.state === 'pending') {
      totals.pendingSessions += 1;
      totals.pendingPotentialUsd += item.potentialUsd;
    } else if (item.state === 'expired-unused') {
      totals.expiredUnusedSessions += 1;
    }
  }
  totals.netUsd = totals.benefitUsd - totals.pingCostUsd;
  totals.roi = totals.pingCostUsd > 0 ? totals.benefitUsd / totals.pingCostUsd : null;
  // 命中率只看拿到响应的心跳；网关/上游失败、超时单独计（退避重试会让失败次数偏多）
  const answered = totals.pingHits + totals.pingMisses;
  totals.pingHitRate = answered ? totals.pingHits / answered : null;
  opportunities.sort((a, b) => b.potentialSavingUsd - a.potentialSavingUsd);
  return {
    totals,
    sessions: [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt),
    series: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    opportunities: opportunities.slice(0, 30),
  };
}

export function sourceKey(source) {
  return source === 'auto' || source === 'pin' ? source : 'manual';
}

export const SOURCE_LABELS = Object.freeze({ auto: '自动', manual: '手动', pin: '长保活' });

export function localDay(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 保活执行记录：把账本里的计划 / 心跳 / 回来事件按「一次保活计划」聚成一段，回答每段保活发了几次、
// 每次命中没有、花了多少、最后人回来时有没有保住、省了多少。页面与 CLI 的「执行记录」都从这里出。

export const EPISODE_OUTCOME_LABELS = Object.freeze({
  kept: '保活生效，回来时命中',
  'returned-within-ttl': 'TTL 内就回来了，心跳多余',
  'expired-before-return': '心跳停止后缓存过期，回来时重写',
  'no-hit-ping': '心跳都没命中',
  'resume-miss': '回来时没读到保住的前缀',
  pending: '缓存保住中，还没回来',
  'expired-unused': '保活后没人回来，缓存已过期',
  'no-pings': '没发出心跳',
});

// events 按时间升序；返回 { episodes: [...最近的在前], totals }。since 按计划开始时间筛（心跳/回来事件全量参与聚合，
// 这样窗口边缘的计划也能拿到完整的心跳列表）
export function buildEpisodes(events, { now = Date.now(), since = 0, limit = 200, cfg = DEFAULT_CONFIG } = {}) {
  const byPlan = new Map();
  const list = [];
  const open = (planId, seed) => {
    let episode = byPlan.get(planId);
    if (!episode) {
      episode = {
        planId,
        sessionId: seed.sid,
        cwd: seed.cwd || null,
        model: seed.model || null,
        ttl: seed.ttl || null,
        source: sourceKey(seed.source),
        trigger: seed.trigger || null,
        pinUntilAt: seed.pinUntilAt || null,
        startedAt: seed.at,
        idleStartAt: seed.idleStartAt || null,
        count: seed.count ?? null,
        intervalSec: seed.intervalSec ?? null,
        forced: Boolean(seed.forced),
        contextTokens: seed.contextTokens ?? null,
        // 这段保活保住后、人按时回来能省多少（整段重写 − 读取）；实际收益见 benefitUsd
        expectedSaveUsd: seed.saveUsd ?? null,
        pings: [],
        hits: 0,
        misses: 0,
        failures: 0,
        timeouts: 0,
        pingCostUsd: 0,
        pingCostEstimatedUsd: 0,
        end: null,
        resume: null,
        outcome: null,
        benefitUsd: 0,
        netUsd: 0,
        lastHitAt: 0,
        lastPingAt: 0,
      };
      byPlan.set(planId, episode);
      list.push(episode);
    }
    return episode;
  };
  for (const event of events) {
    if (!event) continue;
    if (event.t === 'plan' && event.action === 'start') {
      open(event.plan, event);
    } else if (event.t === 'plan' && event.plan && event.action !== 'start') {
      const episode = open(event.plan, event);
      episode.end = { status: event.action, reason: event.reason || null, at: event.at, done: event.done ?? null, count: event.count ?? null };
      if (episode.count == null && event.count != null) episode.count = event.count;
    } else if (event.t === 'ping' && event.plan) {
      const episode = open(event.plan, event);
      if (!episode.model) episode.model = event.model || null;
      if (!episode.ttl) episode.ttl = event.ttl || null;
      episode.pings.push({
        at: event.at,
        outcome: event.outcome,
        status: event.status ?? null,
        ms: event.ms ?? null,
        cacheRead: event.usage?.cacheRead ?? null,
        cacheWrite: event.usage?.cacheWrite ?? null,
        output: event.usage?.output ?? null,
        expected: event.expected ?? null,
        costUsd: event.costUsd || 0,
        estimated: Boolean(event.estimated),
        error: event.error || null,
      });
      episode.pingCostUsd += event.costUsd || 0;
      if (event.estimated) episode.pingCostEstimatedUsd += event.costUsd || 0;
      if (event.expected) episode.contextTokens = Math.max(episode.contextTokens || 0, event.expected);
      episode.lastPingAt = Math.max(episode.lastPingAt, event.at);
      if (event.outcome === 'hit') {
        episode.hits += 1;
        episode.lastHitAt = Math.max(episode.lastHitAt, event.at);
      } else if (['miss', 'rewrite', 'partial'].includes(event.outcome)) episode.misses += 1;
      else if (ESTIMATED_OUTCOMES.has(event.outcome)) episode.timeouts += 1;
      else episode.failures += 1;
    } else if (event.t === 'req' && event.resume) {
      // 「回来」结束该会话这段空闲里的所有计划（手动被替换、自动接手动等都算同一段）
      for (const episode of list) {
        if (episode.sessionId !== event.sid || episode.resume || !episode.pings.length || episode.lastPingAt > event.at) continue;
        episode.resume = { at: event.at, reason: event.resume.reason, kept: Boolean(event.resume.kept), savedTokens: event.resume.savedTokens || 0, benefitUsd: event.resume.benefitUsd || 0, gapSec: event.gapSec ?? null };
      }
    }
  }
  const totals = { episodes: 0, auto: 0, manual: 0, pin: 0, pings: 0, pingCostUsd: 0, pingCostEstimatedUsd: 0, benefitUsd: 0, netUsd: 0, byOutcome: {} };
  const kept = [];
  for (const episode of list) {
    const ttlMs = (TTL_SEC[episode.ttl] || 0) * 1000;
    if (episode.expectedSaveUsd == null && episode.contextTokens && episode.ttl) {
      episode.expectedSaveUsd = keepSavingUsd(episode.contextTokens, { model: episode.model, ttl: episode.ttl, cfg });
    }
    if (episode.resume) {
      episode.outcome = episode.resume.kept ? 'kept' : episode.resume.reason;
      // 收益只记给最后一次命中心跳所在的计划，避免同一段空闲里多个计划重复计
      const lastKeeper = list.filter(other => other.sessionId === episode.sessionId && other.resume?.at === episode.resume.at && other.hits)
        .sort((a, b) => b.lastHitAt - a.lastHitAt)[0];
      episode.benefitUsd = episode.resume.kept && lastKeeper === episode ? episode.resume.benefitUsd : 0;
    } else if (!episode.pings.length) {
      episode.outcome = episode.end ? 'no-pings' : 'pending';
    } else if (episode.lastHitAt && ttlMs && now - episode.lastHitAt <= ttlMs) {
      episode.outcome = 'pending';
    } else if (episode.hits) {
      episode.outcome = 'expired-unused';
    } else {
      episode.outcome = episode.misses ? 'no-hit-ping' : 'expired-unused';
    }
    episode.netUsd = episode.benefitUsd - episode.pingCostUsd;
    if (episode.startedAt < since) continue;
    kept.push(episode);
    totals.episodes += 1;
    totals[episode.source] += 1;
    totals.pings += episode.pings.length;
    totals.pingCostUsd += episode.pingCostUsd;
    totals.pingCostEstimatedUsd += episode.pingCostEstimatedUsd;
    totals.benefitUsd += episode.benefitUsd;
    totals.byOutcome[episode.outcome] = (totals.byOutcome[episode.outcome] || 0) + 1;
  }
  totals.netUsd = totals.benefitUsd - totals.pingCostUsd;
  kept.sort((a, b) => b.startedAt - a.startedAt);
  return { episodes: kept.slice(0, limit), totals };
}
