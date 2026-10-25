import test from 'node:test';
import assert from 'node:assert/strict';
import {
  headerSessionId,
  buildEpisodes,
  DEFAULT_CONFIG,
  UsageTap,
  attributeResume,
  autoEligibility,
  classifyUserContent,
  countHumanTurns,
  inQuietHours,
  mergeConfig,
  writtenTtl,
  buildPingBody,
  classifyPing,
  coldStartOpportunity,
  evaluatePlanRequest,
  extractCwd,
  isTransientPingError,
  extractSessionId,
  keepSavingUsd,
  normalizeModel,
  parseDuration,
  parseMessagesRequest,
  patchTopLevelJson,
  priceFor,
  summarizeEvents,
  usageCostUsd,
} from './core.js';

const cfg = DEFAULT_CONFIG;

test('parseDuration 支持秒数与 h/m/s 组合', () => {
  assert.equal(parseDuration('3000'), 3000);
  assert.equal(parseDuration('50m'), 3000);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('4m30s'), 270);
  assert.equal(parseDuration(90), 90);
  assert.ok(Number.isNaN(parseDuration('50x')));
  assert.ok(Number.isNaN(parseDuration('')));
});

test('patchTopLevelJson 只改顶层字段，嵌套同名键与字符串内容原样保留', () => {
  const raw = '{ "model" : "m", "max_tokens":32000 , "messages":[{"role":"user","content":"say \\"max_tokens\\": 1 \\\\"}],'
    + '"tools":[{"name":"t","input_schema":{"properties":{"2":{},"b":{},"max_tokens":{"type":"integer"}}}}], "stream" :true }';
  const patched = patchTopLevelJson(raw, { max_tokens: 0, stream: false });
  const parsed = JSON.parse(patched);
  assert.equal(parsed.max_tokens, 0);
  assert.equal(parsed.stream, false);
  assert.equal(parsed.messages[0].content, 'say "max_tokens": 1 \\');
  assert.deepEqual(parsed.tools[0].input_schema.properties.max_tokens, { type: 'integer' });
  // 未改动区域逐字节一致
  const messagesRaw = raw.slice(raw.indexOf('"messages"'), raw.indexOf(', "stream"'));
  assert.ok(patched.includes(messagesRaw));
});

test('patchTopLevelJson 缺失字段时追加', () => {
  assert.deepEqual(JSON.parse(patchTopLevelJson('{"a":1}', { stream: false })), { a: 1, stream: false });
  assert.deepEqual(JSON.parse(patchTopLevelJson('{}', { max_tokens: 0 })), { max_tokens: 0 });
  assert.throws(() => patchTopLevelJson('[1,2]', { a: 1 }));
});

test('buildPingBody 设为 max_tokens:0 + stream:false，其余不变', () => {
  const original = { model: 'passthrough/claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] }], max_tokens: 128000, thinking: { type: 'adaptive' }, stream: true };
  const ping = JSON.parse(buildPingBody(JSON.stringify(original)));
  assert.deepEqual(ping, { ...original, max_tokens: 0, stream: false });
  assert.equal(JSON.parse(buildPingBody(JSON.stringify(original), { maxTokens: 1 })).max_tokens, 1);
});

test('extractSessionId：请求头优先，其次 metadata.user_id 两种格式', () => {
  assert.equal(extractSessionId({}, { 'x-claude-code-session-id': 'abc-123-def' }), 'abc-123-def');
  const sid = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  assert.equal(extractSessionId({ metadata: { user_id: `user_ab12_account_x_session_${sid}` } }), sid);
  assert.equal(extractSessionId({ metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: sid }) } }), sid);
  assert.equal(extractSessionId({ metadata: { user_id: 'plain' } }), null);
});

test('extractCwd 识别 SDK 与 CLI 两种环境段', () => {
  assert.equal(extractCwd({ system: [{ type: 'text', text: '# Environment\n - Primary working directory: /home/u/project\n - Is a git repository: true' }] }), '/home/u/project');
  assert.equal(extractCwd({ system: '<env>\nWorking directory: /tmp/ws\nIs directory a git repo: No\n</env>' }), '/tmp/ws');
  assert.equal(extractCwd({ system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Working directory: /x/y' }] }] }), '/x/y');
  assert.equal(extractCwd({ system: 'nothing' }), null);
  // Claude Code 2.1.29x：环境段在 messages 里的 role:system 消息
  const v296 = {
    system: [{ type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>gitStatus</system-reminder>' }, { type: 'text', text: 'hi' }] },
      { role: 'system', content: [{ type: 'text', text: '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /tmp/ka-e2e-cc/ws\n - Is a git repository: false' }] },
    ],
    safeguards: [{ type: 'dangerous_tool_use', classifier_context: { live_cwd: '/tmp/live' } }],
  };
  assert.equal(extractCwd(v296), '/tmp/ka-e2e-cc/ws');
  assert.equal(extractCwd({ system: [], messages: [{ role: 'user', content: 'x' }], safeguards: v296.safeguards }), '/tmp/live');
  assert.equal(extractCwd({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'Working directory: /nope' }] }), null);
});

function claudeBody({ messages = 1, ttl = '1h', system = 'sys\nPrimary working directory: /w', model = 'passthrough/claude-opus-5-5', extra = {} } = {}) {
  const cc = ttl ? { type: 'ephemeral', ...(ttl === '1h' ? { ttl: '1h' } : {}) } : undefined;
  return {
    model,
    messages: Array.from({ length: messages }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `m${i}`, ...(i === messages - 1 && cc ? { cache_control: cc } : {}) }] })),
    system: [{ type: 'text', text: system, ...(cc ? { cache_control: cc } : {}) }],
    tools: [{ name: 'Bash' }, { name: 'Agent' }],
    metadata: { user_id: 'user_x_account_y_session_11111111-2222-3333-4444-555555555555' },
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    stream: true,
    ...extra,
  };
}

test('parseMessagesRequest：TTL、谱系、主对话与心跳可行性', () => {
  const a = parseMessagesRequest(JSON.stringify(claudeBody({ messages: 1 })), {});
  const b = parseMessagesRequest(JSON.stringify(claudeBody({ messages: 5 })), {});
  assert.equal(a.ok, true);
  assert.equal(a.ttl, '1h');
  assert.equal(a.cwd, '/w');
  assert.equal(a.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(a.isMainThread, true);
  assert.equal(a.lineageKey, b.lineageKey, '对话增长不改变谱系');
  assert.notEqual(parseMessagesRequest(JSON.stringify(claudeBody({ system: 'other' })), {}).lineageKey, a.lineageKey);
  assert.notEqual(parseMessagesRequest(JSON.stringify(claudeBody({ model: 'passthrough/claude-haiku-5-5' })), {}).lineageKey, a.lineageKey);
  assert.equal(parseMessagesRequest(JSON.stringify(claudeBody({ ttl: '5m' })), {}).ttl, '5m');
  assert.equal(parseMessagesRequest(JSON.stringify(claudeBody({ ttl: null })), {}).ttl, null);
  assert.equal(parseMessagesRequest(JSON.stringify(claudeBody({ extra: { thinking: { type: 'enabled', budget_tokens: 2048 } } })), {}).unpingableReason, 'thinking-enabled');
  assert.equal(parseMessagesRequest(JSON.stringify(claudeBody({ extra: { output_config: { format: { type: 'json_schema' } } } })), {}).pingMaxTokens, 1);
  assert.equal(parseMessagesRequest('not json', {}).ok, false);
});

test('parseMessagesRequest：带 x-claude-code-agent-id 的是子代理，即使也带 Agent 工具', () => {
  const text = JSON.stringify(claudeBody());
  const main = parseMessagesRequest(text, {});
  const sub = parseMessagesRequest(text, { 'x-claude-code-agent-id': 'a1b2c3d4' });
  assert.equal(main.isMainThread, true);
  assert.equal(main.isSubagent, false);
  assert.equal(sub.isMainThread, false);
  assert.equal(sub.isSubagent, true);
});

test('计费 attribution 块不影响谱系', () => {
  const withBilling = claudeBody();
  withBilling.system = [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1; cch=aaa;' }, ...withBilling.system];
  const other = claudeBody();
  other.system = [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1; cch=bbb;' }, ...other.system];
  assert.equal(parseMessagesRequest(JSON.stringify(withBilling), {}).lineageKey, parseMessagesRequest(JSON.stringify(other), {}).lineageKey);
});

function sse(events, { crlf = false } = {}) {
  const nl = crlf ? '\r\n' : '\n';
  return events.map(event => `event: ${event.type}${nl}data: ${JSON.stringify(event)}${nl}${nl}`).join('');
}

test('UsageTap 解析任意切块的 SSE，message_delta 覆盖终值', () => {
  const text = sse([
    { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 }, output_tokens: 1 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ], { crlf: true });
  const bytes = Buffer.from(text);
  for (const size of [1, 3, 7, 64, bytes.length]) {
    const tap = new UsageTap('text/event-stream; charset=utf-8');
    for (let i = 0; i < bytes.length; i += size) tap.push(bytes.subarray(i, i + size));
    const summary = tap.finish();
    assert.equal(summary.complete, true);
    assert.equal(summary.sawStart, true);
    assert.equal(summary.stopReason, 'end_turn');
    assert.deepEqual(summary.usage, { input: 3, cacheRead: 1000, cacheWrite: 50, cacheWrite5m: 0, cacheWrite1h: 50, output: 42 });
  }
});

test('UsageTap 处理 JSON 响应与错误', () => {
  const ok = new UsageTap('application/json');
  ok.push(Buffer.from(JSON.stringify({ type: 'message', stop_reason: 'max_tokens', usage: { input_tokens: 4, cache_read_input_tokens: 12074, cache_creation_input_tokens: 0, output_tokens: 0 } })));
  const summary = ok.finish();
  assert.equal(summary.complete, true);
  assert.equal(summary.usage.cacheRead, 12074);
  const bad = new UsageTap('application/json');
  bad.push(Buffer.from(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be >= 1' } })));
  assert.equal(bad.finish().error, 'max_tokens: must be >= 1');
  const streamErr = new UsageTap('text/event-stream');
  streamErr.push(Buffer.from(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])));
  assert.equal(streamErr.finish().error, 'Overloaded');
});

test('价格：模型名归一化、未知模型兜底、Haiku 分档', () => {
  assert.equal(normalizeModel('passthrough/claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(normalizeModel('my-gateway/claude-opus-5.5-1h[1m]'), 'claude-opus-5-5-1h');
  assert.equal(normalizeModel('claude-opus-4-6-20260101'), 'claude-opus-4-6');
  const opus = priceFor('passthrough/claude-opus-5-5');
  assert.equal(opus.input, 4);
  assert.equal(opus.cacheRead, 0.2);
  assert.equal(opus.write1h, 8);
  assert.equal(opus.assumed, false);
  assert.equal(priceFor('claude-opus-5').input, 5, '前缀匹配取最长');
  assert.equal(priceFor('mystery-model').assumed, true);
  assert.equal(priceFor('claude-haiku-5-5', cfg, 50000).input, 0.1);
  assert.equal(priceFor('claude-haiku-5-5', cfg, 200000).input, 0.5);
  assert.equal(priceFor('claude-opus-5-5', { ...cfg, priceScale: 0.5 }).input, 2);
});

test('usageCostUsd 按 5m/1h 拆分计价，缺拆分时按请求 TTL', () => {
  const usage = { input: 1000, cacheRead: 1_000_000, cacheWrite: 100_000, cacheWrite5m: null, cacheWrite1h: null, output: 1000 };
  // 1000×4 + 1e6×0.2 + 1e5×8 + 1000×20 = 4000 + 200000 + 800000 + 20000 = 1,024,000 → $1.024
  assert.ok(Math.abs(usageCostUsd(usage, { model: 'claude-opus-5-5', ttl: '1h' }) - 1.024) < 1e-9);
  // 5m 写入 1.25×：1e5×5 = 500000 → 4000+200000+500000+20000 = $0.724
  assert.ok(Math.abs(usageCostUsd(usage, { model: 'claude-opus-5-5', ttl: '5m' }) - 0.724) < 1e-9);
  const split = { ...usage, cacheWrite5m: 40_000, cacheWrite1h: 60_000 };
  // 40000×5 + 60000×8 = 680000 → 4000+200000+680000+20000 = $0.904
  assert.ok(Math.abs(usageCostUsd(split, { model: 'claude-opus-5-5', ttl: '1h' }) - 0.904) < 1e-9);
  // 保住 276K 前缀回来：276000 × (8 − 0.2) / 1e6
  assert.ok(Math.abs(keepSavingUsd(276000, { model: 'claude-opus-5-5', ttl: '1h' }) - 2.1528) < 1e-9);
});

test('classifyPing：命中 / 未命中 / 部分 / 大量重写', () => {
  const u = (cacheRead, cacheWrite) => ({ input: 4, cacheRead, cacheWrite, cacheWrite5m: null, cacheWrite1h: null, output: 0 });
  assert.equal(classifyPing(u(276000, 0), 276000), 'hit');
  assert.equal(classifyPing(u(0, 276000), 276000), 'miss');
  assert.equal(classifyPing(u(200000, 1000), 276000), 'partial');
  assert.equal(classifyPing(u(200000, 76000), 276000), 'rewrite');
  assert.equal(classifyPing(null, 1), 'unknown');
});

const NOW = Date.UTC(2026, 9, 21, 4, 0, 0);
function guardLineage(patch = {}) {
  return { ttl: '1h', model: 'passthrough/claude-opus-5-5', expectedCached: 276000, lastTouchAt: NOW - 10 * 60 * 1000, blocked: null, hasSnapshot: true, unpingableReason: null, cacheable: true, ...patch };
}

test('isTransientPingError：连接失败、超时、429、5xx 可重试，其他 4xx 不重试', () => {
  for (const status of [0, undefined, 408, 425, 429, 500, 502, 503, 504, 529]) assert.equal(isTransientPingError(status), true, String(status));
  for (const status of [400, 401, 403, 404, 413, 422]) assert.equal(isTransientPingError(status), false, String(status));
});

test('evaluatePlanRequest：默认值、上限与间隔校正', () => {
  const ok = evaluatePlanRequest({ lineage: guardLineage(), now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 6);
  assert.equal(ok.intervalSec, 3000);
  const clamped = evaluatePlanRequest({ lineage: guardLineage(), count: 40, intervalSec: '2h', now: NOW });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.count, 12);
  assert.equal(clamped.intervalSec, 3300);
  assert.equal(clamped.warnings.length, 2);
  assert.equal(evaluatePlanRequest({ lineage: guardLineage(), count: 'max', now: NOW }).count, 12);
  assert.equal(evaluatePlanRequest({ lineage: guardLineage({ ttl: '5m' }), now: NOW - 9 * 60 * 1000 }).intervalSec, 240);
  const bad = evaluatePlanRequest({ lineage: guardLineage(), count: 0, intervalSec: 'soon', now: NOW });
  assert.deepEqual(bad.errors.map(error => error.code).sort(), ['bad-count', 'bad-interval']);
});

test('evaluatePlanRequest：硬护栏', () => {
  const codes = patch => evaluatePlanRequest({ lineage: guardLineage(patch), now: NOW }).errors.map(error => error.code);
  assert.deepEqual(codes({ lastTouchAt: NOW - 59 * 60 * 1000 }), ['expired']);
  assert.deepEqual(codes({ hasSnapshot: false }), ['no-snapshot']);
  assert.deepEqual(codes({ lastTouchAt: NOW - 59 * 60 * 1000, hasSnapshot: false }), ['expired'], '过期后快照会被清理，只报过期');
  assert.deepEqual(codes({ cacheable: false, expectedCached: 0 }).sort(), ['not-cacheable', 'small-context']);
  assert.deepEqual(codes({ unpingableReason: 'thinking-enabled' }), ['thinking-enabled']);
  assert.deepEqual(codes({ ttl: null }), ['no-cache-control']);
  const budget = evaluatePlanRequest({ lineage: guardLineage(), now: NOW, daily: { pings: 200, usd: 1 } });
  assert.deepEqual(budget.errors.map(error => error.code), ['daily-budget']);
  // 强制也不能越过硬护栏
  assert.equal(evaluatePlanRequest({ lineage: guardLineage({ lastTouchAt: NOW - 2 * 3600 * 1000 }), force: true, now: NOW }).ok, false);
  assert.equal(evaluatePlanRequest({ lineage: null, now: NOW }).errors[0].code, 'no-session');
});

test('evaluatePlanRequest：上次心跳未命中 / 上下文过小可强制越过', () => {
  const blocked = guardLineage({ blocked: { at: NOW, detail: 'cache_read=0, cache_write=276000' } });
  const refused = evaluatePlanRequest({ lineage: blocked, now: NOW });
  assert.equal(refused.ok, false);
  assert.equal(refused.errors[0].code, 'blocked');
  assert.equal(refused.errors[0].soft, true);
  const forced = evaluatePlanRequest({ lineage: blocked, force: true, now: NOW });
  assert.equal(forced.ok, true);
  assert.match(forced.warnings[0], /已强制越过/);
  const small = evaluatePlanRequest({ lineage: guardLineage({ expectedCached: 30000 }), now: NOW });
  assert.equal(small.errors[0].code, 'small-context');
  assert.equal(evaluatePlanRequest({ lineage: guardLineage({ expectedCached: 30000 }), force: true, now: NOW }).ok, true);
});

test('attributeResume：保活生效与几类无效情形', () => {
  const base = { ttl: '1h', model: 'claude-opus-5-5', prevStartAt: NOW, cfg };
  const hit = at => ({ at, outcome: 'hit', cacheRead: 276000 });
  const usage = cacheRead => ({ input: 10, cacheRead, cacheWrite: 2000, cacheWrite5m: null, cacheWrite1h: null, output: 100 });
  const min = 60 * 1000;
  const kept = attributeResume({ ...base, startAt: NOW + 90 * min, usage: usage(276000), pings: [hit(NOW + 50 * min)] });
  assert.equal(kept.kept, true);
  assert.equal(kept.savedTokens, 276000);
  assert.ok(Math.abs(kept.benefitUsd - 2.1528) < 1e-9);
  assert.equal(attributeResume({ ...base, startAt: NOW + 55 * min, usage: usage(276000), pings: [hit(NOW + 50 * min)] }).reason, 'returned-within-ttl');
  assert.equal(attributeResume({ ...base, startAt: NOW + 200 * min, usage: usage(0), pings: [hit(NOW + 50 * min)] }).reason, 'expired-before-return');
  assert.equal(attributeResume({ ...base, startAt: NOW + 90 * min, usage: usage(1000), pings: [hit(NOW + 50 * min)] }).reason, 'resume-miss');
  assert.equal(attributeResume({ ...base, startAt: NOW + 90 * min, usage: usage(276000), pings: [{ at: NOW + 50 * min, outcome: 'miss', cacheRead: 0 }] }).reason, 'no-hit-ping');
});

test('coldStartOpportunity：按默认间隔估算需要的心跳与可省金额', () => {
  const usage = { input: 10, cacheRead: 0, cacheWrite: 276000, cacheWrite5m: null, cacheWrite1h: null, output: 100 };
  assert.equal(coldStartOpportunity({ ttl: '1h', gapSec: 1800, usage, model: 'claude-opus-5-5' }), null);
  const ninety = coldStartOpportunity({ ttl: '1h', gapSec: 5400, usage, model: 'claude-opus-5-5' });
  assert.equal(ninety.pingsNeeded, 1);
  assert.equal(ninety.coverable, true);
  // 重写 276000×8 = $2.208；保活 2 次读取 276000×0.2×2 = $0.1104
  assert.ok(Math.abs(ninety.potentialSavingUsd - (2.208 - 0.1104)) < 1e-9);
  const overnight = coldStartOpportunity({ ttl: '1h', gapSec: 14 * 3600, usage, model: 'claude-opus-5-5' });
  assert.equal(overnight.pingsNeeded, 16);
  assert.equal(overnight.coverable, false);
});

test('coldStartOpportunity：只算旧前缀里丢掉的部分，读到了旧前缀就不算；按实际 5m/1h 写入计价', () => {
  // 真实误报：压缩请求自己标 5m，14 分钟后读到了之前 1h 的缓存（681886 / 683764）
  const compact = { input: 2105, cacheRead: 681886, cacheWrite: 1878, cacheWrite5m: 1878, cacheWrite1h: 0, output: 15185 };
  assert.equal(coldStartOpportunity({ ttl: '1h', gapSec: 844, usage: compact, prevCached: 683764, model: 'claude-opus-5-5' }), null);
  assert.equal(coldStartOpportunity({ ttl: '1h', gapSec: 4000, usage: compact, prevCached: 683764, model: 'claude-opus-5-5' }), null, '超过 TTL 但旧前缀还在');
  // 96 分钟后回来：共享的系统/工具前缀还热，会话自己的部分重写；新追加的 3000 本来就要写，不算
  const back = { input: 2, cacheRead: 22102, cacheWrite: 600983, cacheWrite5m: 0, cacheWrite1h: 600983, output: 3990 };
  const cold = coldStartOpportunity({ ttl: '1h', gapSec: 5763, usage: back, prevCached: 620085, model: 'claude-opus-5-5' });
  assert.equal(cold.rewriteTokens, 620085 - 22102);
  assert.ok(Math.abs(cold.rewriteUsd - (620085 - 22102) * 8 / 1e6) < 1e-9);
  // 隔夜后先触发压缩：压缩请求按它实际写入的 5m 单价计
  const overnight = { input: 2027, cacheRead: 0, cacheWrite: 681973, cacheWrite5m: 681973, cacheWrite1h: 0, output: 9043 };
  const compactCold = coldStartOpportunity({ ttl: '1h', gapSec: 39248, usage: overnight, prevCached: 681000, model: 'claude-opus-5-5' });
  assert.equal(compactCold.rewriteTokens, 681000);
  assert.ok(Math.abs(compactCold.rewriteUsd - 681000 * 5 / 1e6) < 1e-9);
});

test('Haiku 5.5 分档：按整条请求的提示词定档，不只看重写或保住的部分', () => {
  // 真实对照组：共享前缀还热（读 23.0K），会话自己的部分重写 79.0K，整条 102.0K > 100K → 高档
  const cold = coldStartOpportunity({ ttl: '1h', gapSec: 3930, usage: { input: 2, cacheRead: 22998, cacheWrite: 79014, cacheWrite5m: null, cacheWrite1h: null, output: 16 }, model: 'claude-haiku-5-5' });
  assert.ok(Math.abs(cold.rewriteUsd - 79014 * 1.0 / 1e6) < 1e-12);
  // 1 次心跳读整段 102012 + 回来时读 79014，都按高档 $0.05/M
  assert.ok(Math.abs(cold.potentialSavingUsd - (79014 * 1.0 - (102012 + 79014) * 0.05) / 1e6) < 1e-12);
  // 保住 99K、整条 101K：同样按高档算节省
  const min = 60 * 1000;
  const kept = attributeResume({ ttl: '1h', model: 'claude-haiku-5-5', prevStartAt: NOW, startAt: NOW + 65 * min, usage: { input: 2, cacheRead: 99000, cacheWrite: 2000, cacheWrite5m: null, cacheWrite1h: null, output: 16 }, pings: [{ at: NOW + 50 * min, outcome: 'hit', cacheRead: 99000 }], cfg });
  assert.ok(Math.abs(kept.benefitUsd - 99000 * (1.0 - 0.05) / 1e6) < 1e-12);
});

test('summarizeEvents 汇总心跳成本、收益与机会', () => {
  const events = [
    { t: 'ping', at: NOW, sid: 's1', outcome: 'hit', costUsd: 0.05, usage: { cacheRead: 250000 } },
    { t: 'ping', at: NOW + 1, sid: 's1', outcome: 'miss', costUsd: 2, usage: { cacheRead: 0 } },
    { t: 'ping', at: NOW + 1, sid: 's1', outcome: 'error', costUsd: 0, usage: null },
    { t: 'req', at: NOW + 2, sid: 's1', resume: { kept: true, savedTokens: 250000, benefitUsd: 1.95, pingCostUsd: 0.05 } },
    { t: 'req', at: NOW + 3, sid: 's2', resume: { kept: false, reason: 'returned-within-ttl', pingCostUsd: 0.04 } },
    { t: 'req', at: NOW + 4, sid: 's3', gapSec: 7200, cold: { rewriteTokens: 100000, rewriteUsd: 0.8, pingsNeeded: 2, coverable: true, potentialSavingUsd: 0.74 } },
    { t: 'ping', at: NOW - 10 * 86400 * 1000, sid: 'old', outcome: 'hit', costUsd: 9 },
  ];
  const { totals, sessions, opportunities, series } = summarizeEvents(events, { since: NOW - 86400 * 1000, pending: [{ state: 'pending', potentialUsd: 1.5 }, { state: 'expired-unused', potentialUsd: 0 }] });
  assert.equal(totals.pings, 3);
  assert.equal(totals.pingHits, 1);
  assert.equal(totals.pingMisses, 1);
  assert.equal(totals.pingFailures, 1);
  assert.equal(totals.pingHitRate, 0.5, '上游失败不算进命中率的分母');
  assert.ok(Math.abs(totals.pingCostUsd - 2.05) < 1e-9);
  assert.equal(totals.keptResumes, 1);
  assert.ok(Math.abs(totals.netUsd - (1.95 - 2.05)) < 1e-9);
  assert.equal(totals.wastedResumes, 1);
  assert.equal(totals.coldStarts, 1);
  assert.ok(Math.abs(totals.coldPotentialUsd - 0.74) < 1e-9);
  assert.equal(totals.pendingSessions, 1);
  assert.equal(totals.expiredUnusedSessions, 1);
  assert.equal(sessions.length, 3);
  assert.equal(opportunities[0].sessionId, 's3');
  assert.equal(series.length, 1);
});

test('识别 Claude Code 的压缩请求', () => {
  const body = claudeBody({ messages: 3 });
  assert.equal(parseMessagesRequest(JSON.stringify(body), {}).isCompaction, false);
  body.messages.push({ role: 'user', content: [{ type: 'text', text: "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions." }] });
  assert.equal(parseMessagesRequest(JSON.stringify(body), {}).isCompaction, true);
  // 2.1.29x 的部分压缩：只总结较近的消息
  body.messages.at(-1).content[0].text = 'Your task is to create a detailed summary of the RECENT portion of the conversation \u2014 the messages that follow earlier retained context.';
  assert.equal(parseMessagesRequest(JSON.stringify(body), {}).isCompaction, true);
});

test('classifyUserContent / countHumanTurns：人发的提示、命令、图片算人工；工具结果、系统注入、压缩不算', () => {
  assert.equal(classifyUserContent('帮我看下'), 'human');
  assert.equal(classifyUserContent([{ type: 'text', text: '<system-reminder>gitStatus</system-reminder>' }, { type: 'text', text: 'hi' }]), 'human');
  assert.equal(classifyUserContent([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }, { type: 'text', text: '<system-reminder>todo</system-reminder>' }]), 'tool');
  assert.equal(classifyUserContent([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }, { type: 'text', text: '先别改这个文件' }]), 'human', '执行中插话');
  assert.equal(classifyUserContent([{ type: 'text', text: '<command-name>/compact</command-name>' }]), 'human');
  assert.equal(classifyUserContent([{ type: 'image', source: {} }]), 'human');
  assert.equal(classifyUserContent([{ type: 'text', text: '<task-notification><task-id>b1</task-id></task-notification>' }]), 'auto');
  assert.equal(classifyUserContent([{ type: 'text', text: '[Request interrupted by user]' }]), 'auto');
  assert.equal(classifyUserContent('This session is being continued from a previous conversation that ran out of context.'), 'compact');
  assert.equal(classifyUserContent([{ type: 'text', text: 'Your task is to create a detailed summary of the conversation so far, ...' }]), 'compact');
  assert.equal(classifyUserContent([]), 'empty');
  const messages = [
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>r</system-reminder>' }, { type: 'text', text: '继续' }] },
  ];
  assert.equal(countHumanTurns(messages), 2);
});

test('writtenTtl：按响应 usage 的 5m/1h 拆分判断上游实际写入的 TTL', () => {
  assert.equal(writtenTtl({ cacheWrite: 10, cacheWrite1h: 10, cacheWrite5m: 0 }), '1h');
  assert.equal(writtenTtl({ cacheWrite: 10, cacheWrite1h: 0, cacheWrite5m: 10 }), '5m');
  assert.equal(writtenTtl({ cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0 }), null);
  assert.equal(writtenTtl(null), null);
});

test('inQuietHours：本地小时区间，可跨零点；起止相同表示不设', () => {
  const at = (h, m = 0) => new Date(2026, 9, 21, h, m).getTime();
  assert.equal(inQuietHours(at(1), [1, 8]), true);
  assert.equal(inQuietHours(at(7, 59), [1, 8]), true);
  assert.equal(inQuietHours(at(8), [1, 8]), false);
  assert.equal(inQuietHours(at(0, 59), [1, 8]), false);
  assert.equal(inQuietHours(at(23, 30), [23, 7]), true);
  assert.equal(inQuietHours(at(6), [23, 7]), true);
  assert.equal(inQuietHours(at(12), [23, 7]), false);
  assert.equal(inQuietHours(at(3), [0, 0]), false);
});

test('autoEligibility：各个门槛按顺序判定并给出原因；工具执行中不看人工轮次', () => {
  const day = new Date(2026, 9, 21, 14, 0).getTime();
  const base = { sessionId: '11111111-2222', isMainThread: true, ttl: '1h', cacheable: true, contextTokens: 300000, humanTurns: 3, stopReason: 'end_turn', idleStartAt: day };
  const code = (patch, cfgPatch) => autoEligibility({ ...base, ...patch }, { now: day, cfg: mergeConfig(DEFAULT_CONFIG, { auto: cfgPatch || {} }) }).code;
  assert.equal(code({}), 'idle');
  assert.equal(code({}, { mode: 'off' }), 'auto-off');
  assert.equal(code({ sessionStopped: true }), 'session-stopped');
  assert.equal(code({ sessionId: 'anon-12345678' }), 'anonymous');
  assert.equal(code({ archived: true }), 'archived');
  assert.equal(code({ isMainThread: false }), 'not-main-thread');
  assert.equal(code({ ttl: '5m' }), 'not-1h');
  assert.equal(code({ ttlDowngraded: true }), 'ttl-downgraded');
  assert.equal(code({ blocked: true }), 'blocked');
  assert.equal(code({ unpingable: true }), 'unpingable');
  assert.equal(code({ cacheable: false }), 'not-cacheable');
  assert.equal(code({ contextTokens: 99999 }), 'small-context');
  assert.equal(code({ humanTurns: 0 }), 'few-human-turns');
  assert.equal(code({ humanTurns: 0, stopReason: 'tool_use' }), 'tool-gap');
  assert.equal(code({ humanTurns: 0, stopReason: 'tool_use', agentStatus: 'closed' }), 'agent-closed', '进程已不在：不算工具执行中，直接按任务已关闭跳过');
  assert.equal(code({ humanTurns: 5, stopReason: 'end_turn', agentStatus: 'closed' }), 'agent-closed', '人工轮次够也不保活：没人会回来');
  assert.equal(code({ humanTurns: 0, stopReason: 'tool_use', agentStatus: 'closed' }, { skipClosedAgents: false }), 'few-human-turns', '关掉 skipClosedAgents 后退回旧行为');
  assert.equal(code({ humanTurns: 0, stopReason: 'tool_use' }, { toolGapIgnoresTurns: false }), 'few-human-turns');
  assert.equal(code({ cooldownUntil: day + 1000 }), 'cooldown');
  assert.equal(code({ idleStartAt: new Date(2026, 9, 21, 2, 0).getTime() }), 'quiet-hours');
  assert.equal(code({ idleStartAt: new Date(2026, 9, 21, 0, 50).getTime() }), 'idle', '1 点前开始的空闲照常保活');
  const ok = autoEligibility(base, { now: day, cfg: mergeConfig(DEFAULT_CONFIG, { auto: { count: 99 } }) });
  assert.equal(ok.count, 12, '次数不超过 1h 的上限');
  assert.equal(ok.intervalSec, 3000);
  assert.match(autoEligibility({ ...base, contextTokens: 50000 }, { now: day }).message, /50K < 100K/);
});

test('summarizeEvents：自动与手动分开统计，记下自动保活的判定与冷启动归因', () => {
  const events = [
    { t: 'auto', at: NOW, sid: 'a', ok: true, code: 'idle' },
    { t: 'auto', at: NOW, sid: 'b', ok: false, code: 'quiet-hours' },
    { t: 'auto', at: NOW, sid: 'a', action: 'disable' },
    { t: 'ping', at: NOW, sid: 'a', source: 'auto', outcome: 'hit', costUsd: 0.1, usage: { cacheRead: 1 } },
    { t: 'ping', at: NOW, sid: 'c', outcome: 'hit', costUsd: 0.2, usage: { cacheRead: 1 } },
    { t: 'req', at: NOW, sid: 'a', resume: { kept: true, savedTokens: 10, benefitUsd: 3, pingCostUsd: 0.1, source: 'auto' } },
    { t: 'req', at: NOW, sid: 'c', resume: { kept: false, savedTokens: 0, benefitUsd: 0, pingCostUsd: 0.2, source: 'manual' } },
    { t: 'req', at: NOW, sid: 'b', cold: { rewriteTokens: 1, rewriteUsd: 5, coverable: false, potentialSavingUsd: 0 }, auto: { ok: false, code: 'quiet-hours' } },
    { t: 'req', at: NOW, sid: 'd', cold: { rewriteTokens: 1, rewriteUsd: 2, coverable: true, potentialSavingUsd: 1 } },
  ];
  const { totals } = summarizeEvents(events);
  assert.deepEqual(totals.bySource.auto, { pings: 1, pingCostUsd: 0.1, keptResumes: 1, benefitUsd: 3, wastedResumes: 0, wastedPingCostUsd: 0 });
  assert.deepEqual(totals.bySource.manual, { pings: 1, pingCostUsd: 0.2, keptResumes: 0, benefitUsd: 0, wastedResumes: 1, wastedPingCostUsd: 0.2 });
  assert.equal(totals.autoStarted, 1);
  assert.deepEqual(totals.autoSkipped, { 'quiet-hours': 1 });
  assert.deepEqual(totals.coldByAuto, { 'quiet-hours': { count: 1, rewriteUsd: 5 }, undecided: { count: 1, rewriteUsd: 2 } });
});


// ---------------------------------------------------------------- 2026-10-25 review 修复

test('classifyPing：大上下文下允许的「顺带写入」按 1% 算，600K 前缀重写 29K 不再当命中', () => {
  const u = (cacheRead, cacheWrite) => ({ input: 4, cacheRead, cacheWrite, cacheWrite5m: null, cacheWrite1h: null, output: 0 });
  assert.equal(classifyPing(u(571000, 29000), 600000), 'rewrite', '5% 阈值下会被当成 hit、静默多付约 $0.23');
  assert.equal(classifyPing(u(594000, 5000), 600000), 'hit', '1% 以内（6K）仍是命中');
  assert.equal(classifyPing(u(50000, 4000), 50000), 'hit', '小前缀仍以 4096 为底');
  assert.equal(classifyPing(u(50000, 4100), 50000), 'rewrite');
});

test('attributeResume：回来时只读到共享系统前缀（< 80%）不算保住', () => {
  const pings = [{ at: 3000e3, outcome: 'hit', cacheRead: 200000 }];
  const base = { ttl: '1h', prevStartAt: 0, startAt: 4000e3, pings, model: 'claude-opus-5-5' };
  assert.equal(attributeResume({ ...base, usage: { input: 0, cacheRead: 110000, cacheWrite: 150000, output: 0 } }).reason, 'resume-miss');
  assert.equal(attributeResume({ ...base, usage: { input: 0, cacheRead: 23000, cacheWrite: 180000, output: 0 } }).reason, 'resume-miss', '只读到 23K 共享前缀');
  const kept = attributeResume({ ...base, usage: { input: 0, cacheRead: 199000, cacheWrite: 2000, output: 0 } });
  assert.equal(kept.reason, 'kept');
  assert.equal(kept.savedTokens, 199000);
  assert.equal(attributeResume({ ...base, usage: { input: 0, cacheRead: 110000, cacheWrite: 150000, output: 0 }, cfg: mergeConfig(DEFAULT_CONFIG, { resumeHitRatio: 0.5 }) }).reason, 'kept', '阈值可配');
});

test('coldStartOpportunity：区分「手动用满上限能救」与「当前自动策略能救」', () => {
  const usage = { input: 10, cacheRead: 0, cacheWrite: 656440, cacheWrite5m: null, cacheWrite1h: null, output: 100 };
  const overnight = coldStartOpportunity({ ttl: '1h', gapSec: 30605, usage, model: 'claude-opus-5-5' });
  assert.equal(overnight.pingsNeeded, 10);
  assert.equal(overnight.coverable, true, '12 次上限能覆盖');
  assert.equal(overnight.coverableByAuto, false, '自动策略 3 次覆盖不到');
  assert.equal(overnight.autoCount, 3);
  const twoHours = coldStartOpportunity({ ttl: '1h', gapSec: 7200, usage, model: 'claude-opus-5-5' });
  assert.equal(twoHours.coverableByAuto, true);
  const wide = coldStartOpportunity({ ttl: '1h', gapSec: 30605, usage, model: 'claude-opus-5-5', cfg: mergeConfig(DEFAULT_CONFIG, { auto: { count: 12 } }) });
  assert.equal(wide.coverableByAuto, true);
  // summarizeEvents 两个口径分开
  const cold = (patch) => ({ t: 'req', at: 1, sid: 's', cold: { rewriteTokens: 1, rewriteUsd: 5, pingsNeeded: 9, coverable: true, potentialSavingUsd: 4, ...patch } });
  const { totals } = summarizeEvents([cold({ coverableByAuto: false }), cold({ coverableByAuto: true, potentialSavingUsd: 1 }), cold({ pingsNeeded: 2, coverableByAuto: undefined, potentialSavingUsd: 2 })]);
  assert.equal(totals.coldPotentialUsd, 7);
  assert.equal(totals.coldPotentialAutoUsd, 3, '旧事件按默认 3 次回推');
});

test('summarizeEvents：超时/用量未知的心跳单独计，预估成本计入总成本并单列', () => {
  const ping = (outcome, costUsd, estimated = false) => ({ t: 'ping', at: 1, sid: 's', outcome, costUsd, estimated, source: 'auto' });
  const { totals } = summarizeEvents([ping('hit', 0.1), ping('timeout', 0.1, true), ping('unknown', 0.1, true), ping('error', 0), ping('miss', 0.5)]);
  assert.equal(totals.pings, 5);
  assert.equal(totals.pingHits, 1);
  assert.equal(totals.pingMisses, 1);
  assert.equal(totals.pingTimeouts, 2);
  assert.equal(totals.pingFailures, 1);
  assert.ok(Math.abs(totals.pingCostUsd - 0.8) < 1e-9);
  assert.ok(Math.abs(totals.pingCostEstimatedUsd - 0.2) < 1e-9);
  assert.equal(totals.pingHitRate, 0.5, '命中率只看拿到响应的');
});

test('parseMessagesRequest：带会话头的新版客户端里，没有 Agent 工具但带其他工具也是主对话；没工具 / 旧客户端不是', () => {
  const body = tools => JSON.stringify({ model: 'claude-opus-5-5', system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }], ...(tools ? { tools } : {}), messages: [{ role: 'user', content: 'hi' }], metadata: { user_id: 'user_a_account_b_session_11111111-2222-3333-4444-555555555555' } });
  const withHeader = { 'x-claude-code-session-id': '11111111-2222-3333-4444-555555555555' };
  assert.equal(headerSessionId(withHeader), '11111111-2222-3333-4444-555555555555');
  assert.equal(headerSessionId({}), null);
  assert.equal(parseMessagesRequest(body([{ name: 'Bash' }, { name: 'Read' }]), withHeader).isMainThread, true, '--tools 限制 / 禁用 Agent 的 Claude Code');
  assert.equal(parseMessagesRequest(body(null), withHeader).isMainThread, false, '标题生成等旁路请求没有工具');
  assert.equal(parseMessagesRequest(body([{ name: 'Bash' }]), { ...withHeader, 'x-claude-code-agent-id': 'sub' }).isMainThread, false, '子代理');
  assert.equal(parseMessagesRequest(body([{ name: 'Bash' }]), {}).isMainThread, false, '旧客户端不发会话头：只能看 Agent 工具');
  assert.equal(parseMessagesRequest(body([{ name: 'Bash' }, { name: 'Agent' }]), {}).isMainThread, true);
});

test('autoEligibility：Paseo 任务已关闭优先于其他门槛被跳过；skipClosedAgents=false 退回', () => {
  const day = new Date(2026, 9, 21, 14, 0).getTime();
  const base = { sessionId: '11111111-2222', isMainThread: true, ttl: '1h', cacheable: true, contextTokens: 300000, humanTurns: 3, stopReason: 'end_turn', idleStartAt: day };
  assert.equal(autoEligibility({ ...base, agentStatus: 'closed' }, { now: day }).code, 'agent-closed');
  assert.equal(autoEligibility({ ...base, agentStatus: 'error' }, { now: day }).code, 'agent-closed');
  assert.equal(autoEligibility({ ...base, agentStatus: 'idle' }, { now: day }).code, 'idle');
  assert.equal(autoEligibility({ ...base, agentStatus: 'running', stopReason: 'tool_use' }, { now: day }).code, 'tool-gap');
  assert.equal(autoEligibility({ ...base, agentStatus: null }, { now: day }).code, 'idle', '非 Paseo 会话不受影响');
  assert.equal(autoEligibility({ ...base, agentStatus: 'closed' }, { now: day, cfg: mergeConfig(DEFAULT_CONFIG, { auto: { skipClosedAgents: false } }) }).code, 'idle');
});

test('buildEpisodes：按计划聚合心跳与回来；同一段空闲多个计划只给最后命中的记收益；没回来按缓存是否仍有效分 pending / expired-unused', () => {
  const H = 3600e3;
  const ping = (plan, at, outcome, extra = {}) => ({ t: 'ping', at, sid: 'A', plan, source: 'manual', model: 'm', ttl: '1h', outcome, costUsd: 0.1, usage: { cacheRead: 1000, cacheWrite: 0, output: 0 }, expected: 1000, ms: 500, ...extra });
  const events = [
    { t: 'plan', at: 0, sid: 'A', plan: 'p1', action: 'start', count: 2, intervalSec: 3000, source: 'manual', cwd: '/w', model: 'm', ttl: '1h', idleStartAt: -1000 },
    ping('p1', 50 * 60e3, 'hit'),
    { t: 'plan', at: 51 * 60e3, sid: 'A', plan: 'p1', action: 'replaced', done: 1, count: 2 },
    { t: 'plan', at: 51 * 60e3, sid: 'A', plan: 'p2', action: 'start', count: 1, intervalSec: 3000, source: 'manual' },
    ping('p2', 100 * 60e3, 'timeout', { usage: null, costUsd: 0.2, estimated: true, error: '心跳超时' }),
    ping('p2', 102 * 60e3, 'hit'),
    { t: 'plan', at: 102 * 60e3, sid: 'A', plan: 'p2', action: 'completed', done: 1, count: 1 },
    { t: 'req', at: 130 * 60e3, sid: 'A', gapSec: 7800, resume: { kept: true, reason: 'kept', savedTokens: 1000, benefitUsd: 2 } },
    // B：命中后没人回来，缓存已过期
    { t: 'plan', at: 0, sid: 'B', plan: 'p3', action: 'start', count: 1, intervalSec: 3000, source: 'auto', trigger: 'idle', ttl: '1h' },
    { ...ping('p3', 50 * 60e3, 'hit'), sid: 'B', source: 'auto' },
    { t: 'plan', at: 50 * 60e3, sid: 'B', plan: 'p3', action: 'completed', done: 1, count: 1 },
    // C：刚命中，缓存仍有效
    { t: 'plan', at: 0, sid: 'C', plan: 'p4', action: 'start', count: 3, intervalSec: 3000, source: 'auto', ttl: '1h' },
    { ...ping('p4', 170 * 60e3, 'hit'), sid: 'C', source: 'auto' },
    // D：未命中锁定
    { t: 'plan', at: 0, sid: 'D', plan: 'p5', action: 'start', count: 3, intervalSec: 3000, source: 'auto', ttl: '1h' },
    { ...ping('p5', 50 * 60e3, 'rewrite'), sid: 'D', source: 'auto', usage: { cacheRead: 100, cacheWrite: 900, output: 0 } },
    { t: 'plan', at: 50 * 60e3, sid: 'D', plan: 'p5', action: 'stopped', done: 0, count: 3, reason: '未命中锁定' },
  ];
  const { episodes, totals } = buildEpisodes(events, { now: 3 * H });
  const by = Object.fromEntries(episodes.map(episode => [episode.planId, episode]));
  assert.equal(by.p1.outcome, 'kept');
  assert.equal(by.p1.benefitUsd, 0, '被替换的计划不记收益');
  assert.equal(by.p1.end.status, 'replaced');
  assert.equal(by.p1.idleStartAt, -1000);
  assert.equal(by.p2.outcome, 'kept');
  assert.equal(by.p2.benefitUsd, 2);
  assert.equal(by.p2.pings.length, 2);
  assert.equal(by.p2.timeouts, 1);
  assert.equal(by.p2.hits, 1);
  assert.ok(Math.abs(by.p2.pingCostUsd - 0.3) < 1e-9);
  assert.ok(Math.abs(by.p2.pingCostEstimatedUsd - 0.2) < 1e-9);
  assert.ok(Math.abs(by.p2.netUsd - 1.7) < 1e-9);
  assert.equal(by.p2.resume.gapSec, 7800);
  assert.equal(by.p3.outcome, 'expired-unused');
  assert.equal(by.p3.source, 'auto');
  assert.equal(by.p4.outcome, 'pending');
  assert.equal(by.p5.outcome, 'no-hit-ping');
  assert.equal(by.p5.misses, 1);
  assert.equal(totals.episodes, 5);
  assert.equal(totals.auto, 3);
  assert.equal(totals.manual, 2);
  assert.equal(totals.pings, 6);
  assert.equal(totals.benefitUsd, 2);
  assert.deepEqual(totals.byOutcome, { kept: 2, 'expired-unused': 1, pending: 1, 'no-hit-ping': 1 });
  assert.equal(episodes[0].planId, 'p2', '最近开始的在前');
  // since 过滤 + limit
  assert.equal(buildEpisodes(events, { now: 3 * H, since: 10 * 60e3 }).episodes.map(e => e.planId).join(), 'p2');
  assert.equal(buildEpisodes(events, { now: 3 * H, limit: 2 }).episodes.length, 2);
});
