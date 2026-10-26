import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeConfig } from './core.js';
import { discoverRoots, gatewayBudget, gatewayVariants, loadSessions, parseSpan, readTranscript, runBacktest, simulateSession } from './backtest.js';

const MIN = 60 * 1000;
const T0 = new Date(2026, 9, 21, 10, 0).getTime();
const cfg = mergeConfig(DEFAULT_CONFIG, { auto: { minContextTokens: 100000, minHumanTurns: 1 } });

function call(t, { read = 300000, write = 2000, stop = 'end_turn', model = 'claude-opus-5-5', w5m = 0 } = {}) {
  return { t, model, stop, usage: { input: 2, cacheRead: read, cacheWrite: write, cacheWrite5m: w5m, cacheWrite1h: w5m ? 0 : write, output: 100 } };
}

function session(calls, { humans = [T0 - MIN], compactions = [] } = {}) {
  return { sid: '11111111-aaaa', cwd: '/w', route: 'r', calls, humans, compactions };
}

test('simulateSession：离开 2 小时回来、真实数据里整段重写 → 保活救回，节省按线上冷启动口径', () => {
  const back = T0 + 120 * MIN;
  const gaps = simulateSession(session([call(T0), call(back, { read: 23000, write: 285000 })]), { cfg, now: back + 5 * MIN });
  assert.equal(gaps.length, 1);
  const gap = gaps[0];
  assert.equal(gap.outcome, 'kept');
  assert.equal(gap.pings, 2, '50m、100m 各一次，第三次之前就回来了');
  // 旧前缀 302000，回来时只读到 23000：重写 279000 × ($8 − $0.2)/M
  assert.ok(Math.abs(gap.benefitUsd - 279000 * 7.8 / 1e6) < 1e-9);
  assert.ok(Math.abs(gap.pingUsd - 2 * 302000 * 0.2 / 1e6) < 1e-9);
});

test('simulateSession：50–60 分钟回来是多余心跳；不回来白发 count 次；超出覆盖仍要重写', () => {
  const now = T0 + 24 * 60 * MIN;
  const redundant = simulateSession(session([call(T0), call(T0 + 55 * MIN, { read: 302000 })]), { cfg, now })[0];
  assert.equal(redundant.outcome, 'redundant');
  assert.equal(redundant.pings, 1);
  const gone = simulateSession(session([call(T0)]), { cfg, now })[0];
  assert.equal(gone.outcome, 'no-return');
  assert.equal(gone.pings, 3);
  const late = simulateSession(session([call(T0), call(T0 + 300 * MIN, { read: 0, write: 302000 })]), { cfg, now })[0];
  assert.equal(late.outcome, 'expired', '3 × 50m 之后 1 小时内没回来');
  assert.equal(late.benefitUsd, 0);
  assert.ok(late.coldUsd > 0);
});

test('simulateSession：门槛与线上一致——凌晨开始的空闲、前缀太小、5m 写入都不发；工具执行中不看人工轮次', () => {
  const now = T0 + 24 * 60 * MIN;
  const night = new Date(2026, 9, 22, 2, 0).getTime();
  assert.equal(simulateSession(session([call(night), call(night + 120 * MIN, { read: 0, write: 302000 })]), { cfg, now: night + 200 * MIN })[0].decision, 'quiet-hours');
  assert.equal(simulateSession(session([call(T0, { read: 50000 })]), { cfg, now })[0].decision, 'small-context');
  assert.equal(simulateSession(session([call(T0, { w5m: 2000 })]), { cfg, now })[0].decision, 'not-1h');
  const strict = mergeConfig(cfg, { auto: { minHumanTurns: 3 } });
  assert.equal(simulateSession(session([call(T0)]), { cfg: strict, now })[0].decision, 'few-human-turns');
  assert.equal(simulateSession(session([call(T0, { stop: 'tool_use' })]), { cfg: strict, now })[0].decision, 'tool-gap');
});

test('simulateSession：回来时先压缩——压缩请求按 5m 重写整段旧前缀，保活住了就省下这笔', () => {
  const back = T0 + 120 * MIN;
  const gaps = simulateSession(session([call(T0), call(back + 2 * MIN, { read: 0, write: 40000 })], { compactions: [back] }), { cfg, now: back + 10 * MIN });
  assert.equal(gaps[0].returnKind, 'compact');
  assert.equal(gaps[0].outcome, 'kept');
  assert.ok(Math.abs(gaps[0].benefitUsd - 302000 * (5 - 0.2) / 1e6) < 1e-9);
});

test('readTranscript / loadSessions：只读主对话（跳过子代理目录与 sidechain），按 message id 合并，识别人工消息与压缩', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-bt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const route = path.join(root, 'local-opus-5-5-1h');
  const projects = path.join(route, 'projects', '-w');
  fs.mkdirSync(path.join(projects, 'sid1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(route, 'settings.json'), JSON.stringify({ promptCacheTtl: '1h' }));
  fs.mkdirSync(path.join(root, 'local-opus-5-5', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local-opus-5-5', 'settings.json'), JSON.stringify({}));
  const line = obj => JSON.stringify({ sessionId: 'sid1', cwd: '/w', isSidechain: false, ...obj });
  const usage = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 5 }, output_tokens: 3 };
  fs.writeFileSync(path.join(projects, 'sid1.jsonl'), [
    line({ type: 'user', timestamp: '2026-10-21T02:00:00Z', message: { role: 'user', content: '你好' } }),
    line({ type: 'user', timestamp: '2026-10-21T02:00:01Z', isMeta: true, message: { role: 'user', content: 'meta' } }),
    line({ type: 'assistant', timestamp: '2026-10-21T02:00:05Z', message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: null, usage } }),
    line({ type: 'assistant', timestamp: '2026-10-21T02:00:06Z', message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { ...usage, output_tokens: 9 } } }),
    line({ type: 'assistant', timestamp: '2026-10-21T02:00:07Z', isSidechain: true, message: { id: 'side', model: 'claude-haiku-5-5', usage } }),
    line({ type: 'user', timestamp: '2026-10-21T02:01:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }),
    line({ type: 'user', timestamp: '2026-10-21T03:00:00Z', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' } }),
    'not json',
  ].join('\n'));
  fs.writeFileSync(path.join(projects, 'sid1', 'subagents', 'agent-x.jsonl'), line({ type: 'assistant', timestamp: '2026-10-21T02:00:09Z', message: { id: 'sub', model: 'claude-haiku-5-5', usage } }));
  const roots = discoverRoots(root, { claudeDirs: [] });
  assert.deepEqual(roots.map(r => r.route), ['local-opus-5-5-1h'], '只扫 1h 路由');
  const one = await readTranscript(path.join(projects, 'sid1.jsonl'));
  assert.equal(one.calls.length, 1);
  assert.equal(one.calls[0].stop, 'tool_use');
  assert.equal(one.calls[0].usage.output, 9);
  assert.equal(one.humans.length, 1);
  assert.equal(one.compactions.length, 1);
  const sessions = await loadSessions({ roots });
  assert.equal(sessions.length, 1);
  const { result, simulated } = await runBacktest({ cfg, days: 7, now: Date.parse('2026-10-21T12:00:00Z'), sessions });
  assert.equal(result.totals.pings, 0, '前缀太小，不发心跳');
  assert.equal(simulated[0][0].decision, 'small-context');
  assert.equal(simulated[0][0].returnKind, 'compact');
});


test('网关版规则回测：span 决定每段次数（3h→3、12h→12、24h→封顶 19）；工具调用回合不回来发满 19 次；停在用户处 span=0 不保活；59.5 分钟一次', () => {
  assert.equal(gatewayBudget({ spanSec: 0 }), 19);
  assert.equal(gatewayBudget({ spanSec: 3 * 3600 }), 3);
  assert.equal(gatewayBudget({ spanSec: 12 * 3600 }), 12);
  assert.equal(gatewayBudget({ spanSec: 24 * 3600 }), 19);
  assert.equal(gatewayBudget({ spanSec: 30 * 60 }), 0, 'span 短于 59.5 分钟不安排');
  assert.equal(parseSpan('3h'), 10800);
  assert.equal(parseSpan('90m'), 5400);
  assert.equal(parseSpan('0'), 0);
  const now = T0 + 48 * 60 * MIN;
  const gone = simulateSession(session([call(T0, { stop: 'tool_use' })]), { cfg, now, policy: { kind: 'gateway', spanSec: 0 } })[0];
  assert.equal(gone.decision, 'tool-gap');
  assert.equal(gone.pings, 19, '工具调用回合没人回来：发满回本上限');
  assert.ok(gone.lateRiskUsd > 0);
  const idle0 = simulateSession(session([call(T0)]), { cfg, now, policy: { kind: 'gateway', spanSec: 0 } })[0];
  assert.equal(idle0.decision, 'gw-not-tool-call');
  assert.equal(idle0.pings, 0);
  const idle3h = simulateSession(session([call(T0)]), { cfg, now, policy: { kind: 'gateway', spanSec: 3 * 3600 } })[0];
  assert.equal(idle3h.decision, 'idle');
  assert.equal(idle3h.pings, 3);
  // 第一次在 59.5 分钟：58 分钟就回来的不算空闲段；2 小时回来 → 发了 2 次（59.5m、119m），保住
  assert.ok(simulateSession(session([call(T0), call(T0 + 58 * MIN, { read: 302000 })]), { cfg, now, policy: { kind: 'gateway', spanSec: 3 * 3600 } }).every(gap => gap.at !== T0), '58 分钟就回来：第一段不算空闲段');
  const back = simulateSession(session([call(T0), call(T0 + 120 * MIN, { read: 23000, write: 285000 })]), { cfg, now, policy: { kind: 'gateway', spanSec: 3 * 3600 } })[0];
  assert.equal(back.pings, 2);
  assert.equal(back.outcome, 'kept');
  // 没有前缀 / 人工轮次 / 凌晨门槛
  const night = new Date(2026, 9, 22, 2, 0).getTime();
  assert.equal(simulateSession(session([call(night, { read: 50000 })], { humans: [] }), { cfg, now: night + 10 * 3600 * 1000, policy: { kind: 'gateway', spanSec: 3 * 3600 } })[0].pings, 3);
  assert.equal(gatewayVariants()[0].policy, null);
  assert.equal(gatewayVariants().length, 6);
});

test('runBacktest：variants 可各带 policy，中继规则与网关规则同一份数据对比', async () => {
  const sessions = [session([call(T0, { stop: 'tool_use' })])];
  const { result } = await runBacktest({ cfg, days: 7, now: T0 + 48 * 60 * MIN, sessions, variants: gatewayVariants(), policy: { kind: 'gateway', spanSec: 0 } });
  assert.equal(result.policy.kind, 'gateway');
  assert.equal(result.totals.pings, 19);
  const relay = result.variants.find(v => v.label === '中继：当前规则');
  assert.equal(relay.totals.pings, cfg.auto.count, '中继按每段次数');
  assert.equal(result.variants.find(v => v.label.startsWith('网关 span=3h')).totals.pings, 3, 'span 也封顶工具调用回合的安排');
});
