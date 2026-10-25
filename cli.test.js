// CLI 端到端：用一个只回 JSON 的假中继验证命令解析、全局参数和输出；
// 真实中继的行为（建计划、停计划、自动开关）由 relay.test.js 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const MIN = 60 * 1000;
const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const TTL_DEFAULTS = {
  '1h': { ttlSec: 3600, intervalSec: 3000, minIntervalSec: 300, maxIntervalSec: 3300, defaultCount: 6, maxCount: 12, safetySec: 120 },
  '5m': { ttlSec: 300, intervalSec: 240, minIntervalSec: 60, maxIntervalSec: 270, defaultCount: 3, maxCount: 10, safetySec: 20 },
};

const autoSettings = (patch = {}) => ({
  mode: 'on',
  count: 3,
  minContextTokens: 100000,
  minHumanTurns: 1,
  toolGapIgnoresTurns: true,
  quietHours: [1, 8],
  missCooldownSec: 7200,
  cooldownUntil: null,
  configFile: '/tmp/config.json',
  intervalSec: 3000,
  disabledSessions: 0,
  ...patch,
});

function sessionView({ id, title, ttl = '1h', tokens = 120000, warm = true, remainingSec = 1800, auto = { state: 'armed', dueAt: Date.now() + 10 * MIN }, plan = null, cwd = '/tmp/ka-ws' }) {
  return {
    id,
    cwd,
    busy: false,
    primary: {
      ttl,
      model: 'passthrough/claude-opus-5-5',
      contextTokens: tokens,
      warm,
      remainingSec,
      expiresAt: Date.now() + remainingSec * 1000,
      lastTouchAt: Date.now() - 20 * MIN,
      lastUsage: null,
      lastPing: null,
      blocked: null,
    },
    plan,
    auto: { mode: 'on', humanTurns: 1, disabled: null, ...auto },
    paseo: title ? { title } : null,
  };
}

function startMock(t, state) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://relay.local');
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, path: url.pathname, search: url.searchParams, body, headers: req.headers });
      let payload;
      const route = `${req.method} ${url.pathname.replace(/^\/keepalive\/api\//, '')}`;
      if (route === 'GET health') payload = state.health || {
        ok: true, listen: 'http://127.0.0.1:18110', upstream: 'http://127.0.0.1:8080',
        auto: autoSettings(), budget: { pings: 2, maxPings: 200, usd: 0.02, maxUsd: 10 },
        defaults: { ttl: TTL_DEFAULTS },
      };
      else if (route === 'GET sessions') payload = { ok: true, now: Date.now(), sessions: state.sessions || [] };
      else if (route === 'GET auto') payload = { ok: true, auto: state.auto || autoSettings() };
      else if (route === 'POST auto') payload = state.autoResponse || { ok: true, auto: autoSettings({ ...(body || {}) }), persisted: true, cancelledAutoPlans: [] };
      else if (route === 'POST plans') payload = state.planResponse || { ok: true, global: true, ttl: '1h', summary: { sessions: 2, started: 1, already: 0, skipped: 1, filtered: 0, restored: 0 }, skippedBy: {}, results: [] };
      else if (route === 'POST plans/stop') payload = state.stopResponse || { ok: true, global: true, stopped: [], autoDisabled: [], sessions: 2, autoMode: 'on' };
      else if (route === 'POST sessions/auto') payload = state.sessionAutoResponse || { ok: true, enabled: true, changed: [SID_A, SID_B], sessions: [] };
      else if (route === 'GET events') payload = { events: [] };
      else if (route === 'POST keepalive') payload = state.keepaliveResponse || { ok: true, enabled: body?.enabled !== false, stopped: ['p1', 'p2'], unpinned: [SID_A], persisted: true, autoMode: 'on', disabledSessions: 1, pinnedSessions: 0 };
      else if (route === 'POST sessions/pin') payload = state.pinResponse || { ok: true, enabled: body?.enabled !== false, results: [] };
      else if (route === 'GET summary') payload = { days: 7, totals: {} };
      else if (route === 'GET episodes') payload = state.episodesResponse || { ok: true, days: 7, episodes: [], totals: { episodes: 0, auto: 0, manual: 0, pings: 0, pingCostUsd: 0, pingCostEstimatedUsd: 0, benefitUsd: 0, netUsd: 0, byOutcome: {} } };
      else payload = { ok: false, error: `unexpected ${route}` };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise(done => server.close(done)));
    resolve({ url, requests });
  }));
}

async function cli(url, ...args) {
  const env = { ...process.env, CACHE_KEEPALIVE_URL: '', PASEO_AGENT_ID: '', PASEO_AGENT_CWD: '' };
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args, '--relay', url], { env, timeout: 20000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

test('start --global：带上 global / ttl / count，按结果打印开始与跳过', async t => {
  const plan = { id: 'p1', source: 'manual', status: 'active', done: 0, count: 3, intervalSec: 3000, nextPingAt: Date.now() + 50 * MIN };
  const { url, requests } = await startMock(t, {
    planResponse: {
      ok: true,
      global: true,
      ttl: '1h',
      summary: { sessions: 4, started: 1, already: 0, skipped: 1, filtered: 2, restored: 1 },
      skippedBy: { expired: 1 },
      results: [
        { ok: true, sessionId: SID_A, plan, economics: { contextTokens: 180000 } },
        { ok: false, sessionId: SID_B, errors: [{ code: 'expired', message: '缓存已过期' }] },
      ],
    },
  });
  const result = await cli(url, 'start', '--global', '--count', '3', '--ttl', '1h');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /全局保活（1h）/);
  assert.match(result.stdout, /开始 1 个/);
  assert.match(result.stdout, /缓存已过期 1/);
  const body = requests.find(item => item.method === 'POST' && item.path === '/keepalive/api/plans').body;
  assert.equal(body.global, true);
  assert.equal(body.count, '3');
  assert.equal(body.ttl, '1h');
  assert.equal(body.source, 'cli');
});

test('stop --global：停全部计划 + 关全部会话自动保活，并提示全局开关', async t => {
  const { url, requests } = await startMock(t, {
    stopResponse: { ok: true, global: true, stopped: ['p1', 'p2'], autoDisabled: [SID_A, SID_B], sessions: 2, autoMode: 'on' },
  });
  const result = await cli(url, 'stop', '--global', '--reason', '下班');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已停止 2 个保活计划/);
  assert.match(result.stdout, /关闭 2 个会话的自动保活/);
  assert.match(result.stdout, /auto off --global/);
  const body = requests.find(item => item.path === '/keepalive/api/plans/stop').body;
  assert.equal(body.global, true);
  assert.equal(body.reason, '下班');
});

test('list / status --global：拉全部会话，支持 --active / --limit 过滤', async t => {
  const activePlan = { id: 'p1', source: 'manual', status: 'active', done: 1, count: 3, intervalSec: 3000, nextPingAt: Date.now() + 20 * MIN };
  const { url, requests } = await startMock(t, {
    sessions: [
      sessionView({ id: SID_A, title: '有计划的会话', plan: activePlan, cwd: '/tmp/ka-a' }),
      sessionView({ id: SID_B, title: '没有计划的会话', auto: { state: 'stopped', disabled: { at: Date.now(), reason: '手动停止' } }, cwd: '/tmp/ka-b' }),
    ],
  });
  const result = await cli(url, 'list', '--active', '--limit', '1');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /aaaaaaaa/);
  assert.doesNotMatch(result.stdout, /bbbbbbbb/);
  assert.match(result.stdout, /进行中计划 1/);
  assert.equal(requests.find(item => item.path === '/keepalive/api/sessions').search.get('hours'), '24');

  const globalStatus = await cli(url, 'status', '--global', '--days', '2');
  assert.equal(globalStatus.code, 0, globalStatus.stderr);
  assert.match(globalStatus.stdout, /近 2 天/);
  assert.equal(requests.filter(item => item.path === '/keepalive/api/sessions').at(-1).search.get('hours'), '48');
});

test('sessions --hours：观察窗口传给中继', async t => {
  const { url, requests } = await startMock(t, { sessions: [] });
  const result = await cli(url, 'sessions', '--hours', '2');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.find(item => item.path === '/keepalive/api/sessions').search.get('hours'), '2');
});

test('auto reset --global / --clear-blocked：只改会话级标记，默认不动锁定', async t => {
  const { url, requests } = await startMock(t, { sessionAutoResponse: { ok: true, enabled: true, changed: [SID_A, SID_B], sessions: [] } });
  let result = await cli(url, 'auto', 'reset', '--global');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已恢复 2 个会话的自动保活/);
  let body = requests.filter(item => item.path === '/keepalive/api/sessions/auto').at(-1).body;
  assert.equal(body.global, true);
  assert.equal(body.enabled, true);
  assert.equal(body.clearBlocked, false);

  result = await cli(url, 'auto', 'reset', '--global', '--clear-blocked');
  assert.equal(result.code, 0, result.stderr);
  body = requests.filter(item => item.path === '/keepalive/api/sessions/auto').at(-1).body;
  assert.equal(body.clearBlocked, true);
});

test('auto off --global：显示被一起停掉的自动计划，并提示会话级关闭', async t => {
  const { url, requests } = await startMock(t, {
    autoResponse: { ok: true, auto: autoSettings({ mode: 'off', disabledSessions: 2 }), persisted: true, cancelledAutoPlans: ['p1'] },
  });
  const result = await cli(url, 'auto', 'off', '--global');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /自动保活（全局）：关/);
  assert.match(result.stdout, /已停止 1 个进行中的自动计划/);
  assert.match(result.stdout, /auto reset --global/);
  assert.equal(requests.find(item => item.path === '/keepalive/api/auto').body.mode, 'off');
});

test('auto status --global：汇总各会话的自动保活状态', async t => {
  const { url } = await startMock(t, {
    sessions: [
      sessionView({ id: SID_A, auto: { state: 'armed', dueAt: Date.now() + 10 * MIN } }),
      sessionView({ id: SID_B, auto: { state: 'stopped', disabled: { at: Date.now(), reason: '手动停止' } } }),
    ],
  });
  const result = await cli(url, 'auto', 'status', '--global');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已就绪 1/);
  assert.match(result.stdout, /已关闭 1/);
  assert.match(result.stdout, /bbbbbbbb/);
});

test('--global 和 --session / --cwd 互斥，直接报错且不发请求', async t => {
  const { url, requests } = await startMock(t, {});
  for (const args of [['start', '--global', '--cwd', '/tmp/x'], ['stop', '--global', '--session', SID_A], ['auto', 'reset', '--global', '--cwd', '/tmp/x'], ['auto', 'off', '--global', '--cwd', '/tmp/x']]) {
    const result = await cli(url, ...args);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.match(result.stderr, /不能和/);
  }
  assert.equal(requests.length, 0);
});

test('--ttl 只用于 start --global；ping 不支持 --global；都在发请求前拒绝', async t => {
  const { url, requests } = await startMock(t, {});
  for (const args of [['start', '--ttl', '5m'], ['ping', '--global']]) {
    const result = await cli(url, ...args);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.match(result.stderr, /--ttl 只用于|不支持 --global/);
  }
  assert.equal(requests.length, 0);
});

test('list 筛选后为空时提示筛选条件，不误导成接入问题', async t => {
  const { url } = await startMock(t, { sessions: [sessionView({ id: SID_A })] });
  const result = await cli(url, 'list', '--active');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /没有符合筛选条件的会话/);
  assert.doesNotMatch(result.stdout, /ANTHROPIC_BASE_URL/);
});

test('list / auto status --global 不接受 --session / --cwd，避免静默忽略目标', async t => {
  const { url, requests } = await startMock(t, {});
  for (const args of [['list', '--cwd', '/tmp/x'], ['status', '--global', '--session', SID_A], ['auto', 'status', '--global', '--cwd', '/tmp/x']]) {
    const result = await cli(url, ...args);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.match(result.stderr, /不支持|不能和/);
  }
  assert.equal(requests.length, 0);
});

test('全局自动关闭时 list 仍统计会话级关闭，并标明两者都关', async t => {
  const { url } = await startMock(t, {
    sessions: [sessionView({ id: SID_A, auto: { state: 'off', disabled: { at: Date.now(), reason: '手动停止' } } })],
  });
  const result = await cli(url, 'list');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已关闭自动 1/);
  assert.match(result.stdout, /全局已关 · 本会话已关/);
});

test('start --global 全部已有计划时显示成功标记，不让人误以为失败', async t => {
  const plan = { id: 'p1', source: 'manual', status: 'active', done: 0, count: 2, intervalSec: 3000, nextPingAt: Date.now() + 30 * MIN };
  const { url } = await startMock(t, {
    planResponse: {
      ok: true, global: true, ttl: '1h',
      summary: { sessions: 1, started: 0, already: 1, skipped: 0, filtered: 0, restored: 0 },
      skippedBy: {}, results: [{ ok: true, already: true, sessionId: SID_A, plan }],
    },
  });
  const result = await cli(url, 'start', '--global');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^✓ 全局保活/);
  assert.match(result.stdout, /已有计划 1 个/);
});

test('auto status --global 在全局关闭时仍列出被单独关闭的会话', async t => {
  const { url } = await startMock(t, {
    auto: autoSettings({ mode: 'off', disabledSessions: 1 }),
    sessions: [sessionView({ id: SID_A, auto: { state: 'off', disabled: { at: Date.now(), reason: '手动停止' } } })],
  });
  const result = await cli(url, 'auto', 'status', '--global');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已关闭自动保活的会话：aaaaaaaa/);
});

test('list 的计划列显示等待凭证等异常状态，而不只是「下一次」', async t => {
  const plan = { id: 'p1', source: 'manual', status: 'active', done: 0, count: 1, intervalSec: 300, nextPingAt: Date.now() + 5 * MIN, state: 'waiting-auth' };
  const { url } = await startMock(t, { sessions: [sessionView({ id: SID_A, plan })] });
  const result = await cli(url, 'list');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /手动 0\/1（等凭证）/);
});

test('start --global --for 2h 自动算次数，ttl/interval 走默认值', async t => {
  const plan = { id: 'p1', source: 'manual', status: 'active', done: 0, count: 2, intervalSec: 3000, nextPingAt: Date.now() + 50 * MIN };
  const { url, requests } = await startMock(t, {
    planResponse: {
      ok: true, global: true, ttl: '1h',
      summary: { sessions: 1, started: 1, already: 0, skipped: 0, filtered: 0, restored: 0 },
      skippedBy: {}, results: [{ ok: true, sessionId: SID_A, plan, economics: { contextTokens: 120000 } }],
    },
  });
  const result = await cli(url, 'start', '--global', '--for', '2h');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /按 2h 保护窗口自动计算：2 次 × 50m/);
  const body = requests.find(item => item.path === '/keepalive/api/plans').body;
  assert.equal(body.count, 2);
  assert.equal(body.interval, undefined);
  assert.equal(body.ttl, undefined);
});

test('start --global --ttl 5m --for 2h 按上限 10 次执行并提示覆盖不足', async t => {
  const plan = { id: 'p1', source: 'manual', status: 'active', done: 0, count: 10, intervalSec: 240, nextPingAt: Date.now() + 4 * MIN };
  const { url, requests } = await startMock(t, {
    planResponse: {
      ok: true, global: true, ttl: '5m',
      summary: { sessions: 1, started: 1, already: 0, skipped: 0, filtered: 0, restored: 0 },
      skippedBy: {}, results: [{ ok: true, sessionId: SID_A, plan }],
    },
  });
  const result = await cli(url, 'start', '--global', '--ttl', '5m', '--for', '2h');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /最多覆盖约 44m40s/);
  const body = requests.find(item => item.path === '/keepalive/api/plans').body;
  assert.equal(body.count, 10);
  assert.equal(body.ttl, '5m');
});

test('--for 和 --count / --ttl any 冲突时直接拒绝', async t => {
  const { url, requests } = await startMock(t, {});
  for (const args of [['start', '--global', '--for', '2h', '--count', '2'], ['start', '--global', '--for', '2h', '--ttl', 'any']]) {
    const result = await cli(url, ...args);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.match(result.stderr, /--for 不能/);
  }
  assert.equal(requests.length, 0);
});


// ---------------------------------------------------------------- 2026-10-25 review 修复

test('写操作带口令头：--token 优先，其次 CACHE_KEEPALIVE_TOKEN；读操作不带', async t => {
  const { url, requests } = await startMock(t, {});
  let result = await cli(url, 'stop', '--global', '--token', 'abc123');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.find(item => item.method === 'POST').headers['x-cache-keepalive-token'], 'abc123');
  requests.length = 0;
  const env = { ...process.env, CACHE_KEEPALIVE_URL: '', PASEO_AGENT_ID: '', PASEO_AGENT_CWD: '', CACHE_KEEPALIVE_TOKEN: 'from-env' };
  await exec(process.execPath, [CLI, 'stop', '--global', '--relay', url], { env, timeout: 20000 });
  assert.equal(requests.find(item => item.method === 'POST').headers['x-cache-keepalive-token'], 'from-env');
  requests.length = 0;
  result = await cli(url, 'list');
  assert.equal(result.code, 0, result.stderr);
  for (const item of requests) assert.equal(item.method, 'GET');
});

test('中继返回 401 时提示口令来源，退出码 1', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '写操作需要 x-cache-keepalive-token 请求头（值在 /tmp/x/control.token）' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await cli(`http://127.0.0.1:${server.address().port}`, 'stop', '--global');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /x-cache-keepalive-token/);
  assert.match(result.stderr, /CACHE_KEEPALIVE_TOKEN/);
});

test('episodes：按段打印心跳标记、花费、结局与逐次心跳；--session / --days 传给中继', async t => {
  const now = Date.now();
  const { url, requests } = await startMock(t, {
    episodesResponse: {
      ok: true, days: 3,
      totals: { episodes: 2, auto: 1, manual: 1, pings: 3, pingCostUsd: 0.3, pingCostEstimatedUsd: 0.1, benefitUsd: 2, netUsd: 1.7, byOutcome: { kept: 1, 'expired-unused': 1 } },
      episodes: [
        {
          planId: 'p1', sessionId: SID_A, cwd: '/tmp/ka-ws', model: 'passthrough/claude-opus-5-5', ttl: '1h', source: 'auto', trigger: 'idle', startedAt: now - 3 * 3600e3, count: 3, intervalSec: 3000,
          pings: [
            { at: now - 3 * 3600e3, outcome: 'hit', cacheRead: 600000, cacheWrite: 0, output: 0, ms: 5000, costUsd: 0.12 },
            { at: now - 2.2 * 3600e3, outcome: 'timeout', cacheRead: null, cacheWrite: null, output: null, ms: 300000, costUsd: 0.1, estimated: true, error: '心跳超时 300000ms' },
          ],
          hits: 1, misses: 0, failures: 0, timeouts: 1, pingCostUsd: 0.22, pingCostEstimatedUsd: 0.1,
          end: { status: 'completed', reason: '会话继续了，本段空闲的自动保活结束', at: now - 2 * 3600e3, done: 1, count: 3 },
          resume: { at: now - 2 * 3600e3, reason: 'kept', kept: true, savedTokens: 600000, benefitUsd: 2, gapSec: 4700 },
          outcome: 'kept', benefitUsd: 2, netUsd: 1.78, active: false, paseo: { title: '重构 relay 模块' },
        },
        {
          planId: 'p2', sessionId: SID_B, cwd: '/tmp/ka-ws-b', model: 'passthrough/claude-opus-5-5', ttl: '1h', source: 'manual', startedAt: now - 5 * 3600e3, count: 1, intervalSec: 3000,
          pings: [{ at: now - 4 * 3600e3, outcome: 'hit', cacheRead: 100000, cacheWrite: 0, output: 0, ms: 3000, costUsd: 0.08 }],
          hits: 1, misses: 0, failures: 0, timeouts: 0, pingCostUsd: 0.08, pingCostEstimatedUsd: 0,
          end: { status: 'completed', reason: '已完成 1 次心跳', at: now - 4 * 3600e3, done: 1, count: 1 },
          resume: null, outcome: 'expired-unused', benefitUsd: 0, netUsd: -0.08, active: false, paseo: null,
        },
      ],
    },
  });
  const result = await cli(url, 'episodes', '--days', '3', '--session', SID_A.slice(0, 8), '--limit', '20');
  assert.equal(result.code, 0, result.stderr);
  const req = requests.find(item => item.path === '/keepalive/api/episodes');
  assert.equal(req.search.get('days'), '3');
  assert.equal(req.search.get('session'), SID_A.slice(0, 8));
  assert.equal(req.search.get('limit'), '20');
  assert.match(result.stdout, /近 3 天保活执行记录：2 段（自动 1、手动 1），心跳 3 次 \$0\.300（含预估 \$0\.100），收益 \$2\.00，净 \$1\.70/);
  assert.match(result.stdout, /保活生效，回来时命中 1/);
  assert.match(result.stdout, /保活后没人回来，缓存已过期 1/);
  assert.match(result.stdout, /自动 aaaaaaaa（重构 relay 模块）  心跳 2\/3 ✓⏱/);
  assert.match(result.stdout, /回来 .*（空闲 1h18m）/);
  assert.match(result.stdout, /超时\(上游可能已处理\) 心跳超时 300000ms 5m \$0\.100\(估\)/);
  assert.match(result.stdout, /手动 bbbbbbbb  心跳 1\/1 ✓/);
  const json = await cli(url, 'episodes', '--json');
  assert.equal(JSON.parse(json.stdout).totals.episodes, 2);
});

test('stats 显示超时次数、预估成本，以及自动策略 / 手动上限两个可挽救口径', async t => {
  const { url } = await startMock(t, {});
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      days: 7,
      totals: {
        pings: 10, pingHits: 7, pingMisses: 1, pingFailures: 1, pingTimeouts: 1, pingCostUsd: 1.5, pingCostEstimatedUsd: 0.2, pingReadTokens: 0,
        keptResumes: 2, savedTokens: 400000, benefitUsd: 6, netUsd: 4.5, roi: 4, wastedResumes: 0, wastedPingCostUsd: 0,
        coldStarts: 2, coldRewriteUsd: 8, coldPotentialUsd: 6, coldPotentialAutoUsd: 1.5, pendingSessions: 0, pendingPotentialUsd: 0, expiredUnusedSessions: 0,
        autoStarted: 3, autoSkipped: { 'missed-window': 1, 'agent-closed': 2 }, coldByAuto: {}, bySource: { auto: { pings: 0 }, manual: { pings: 0 } },
      },
      budget: { pings: 1, maxPings: 200, usd: 0.1, maxUsd: 10 },
      sessions: [],
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await cli(`http://127.0.0.1:${server.address().port}`, 'stats');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /失败 1、超时\/用量未知 1/);
  assert.match(result.stdout, /含预估 \$0\.200/);
  assert.match(result.stdout, /按当前自动策略能救回 \$1\.50，手动用满次数上限能救回 \$6\.00/);
  assert.match(result.stdout, /中继错过了判定窗口.* 1/);
  assert.match(result.stdout, /任务进程已退出.* 2/);
  assert.ok(url);
});

test('auto set --skip-closed on|off 传 skipClosedAgents；auto 显示配置文件不存在的提示', async t => {
  const { url, requests } = await startMock(t, { auto: autoSettings({ configExists: false, skipClosedAgents: false }) });
  let result = await cli(url, 'auto', 'set', '--skip-closed', 'off');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.find(item => item.method === 'POST').body.skipClosedAgents, false);
  result = await cli(url, 'auto', 'set', '--skip-closed', 'maybe');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--skip-closed 只能是 on \/ off/);
  result = await cli(url, 'auto');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /配置文件 \/tmp\/config.json（不存在：当前全部为默认值/);
  assert.match(result.stdout, /任务进程已退出的空闲照常保活/);
});


test('pin / unpin：按工作区目标发 sessions/pin，默认不传时长由中继取 12h；打印到期、估算；--global / --count 被拒', async t => {
  const now = Date.now();
  const { url, requests } = await startMock(t, {
    pinResponse: {
      ok: true, enabled: true, by: 'cwd',
      results: [{ ok: true, sessionId: SID_A, pin: { at: now, untilAt: now + 12 * 3600e3, durationSec: 12 * 3600, intervalSec: 3000, active: false }, plan: null, warnings: [], estimate: { maxPings: 15, pingUsd: 0.12, maxUsd: 1.8, saveUsd: 4.7, contextTokens: 600000 } }],
      alternatives: [],
    },
  });
  let result = await cli(url, 'pin');
  assert.equal(result.code, 0, result.stderr);
  const body = requests.find(item => item.path === '/keepalive/api/sessions/pin').body;
  assert.equal(body.enabled, true);
  assert.equal(body.for, undefined, '不传时长，由中继默认 12h');
  assert.ok(body.cwd);
  assert.match(result.stdout, /长保活到 .*（12h，每 50m 一次，只在空闲时发/);
  assert.match(result.stdout, /每次心跳约 \$0\.120，整段都空闲时最多 15 次 \$1\.80/);
  requests.length = 0;
  result = await cli(url, 'pin', '--for', '24h', '--session', SID_A.slice(0, 8), '--interval', '45m');
  assert.equal(result.code, 0, result.stderr);
  const body2 = requests.find(item => item.path === '/keepalive/api/sessions/pin').body;
  assert.equal(body2.for, '24h');
  assert.equal(body2.interval, '45m');
  assert.equal(body2.session, SID_A.slice(0, 8));
  for (const args of [['pin', '--count', '3'], ['pin', '--global', '--session', 'abcdef'], ['unpin', '--global', '--cwd', '/x']]) {
    const bad = await cli(url, ...args);
    assert.notEqual(bad.code, 0, args.join(' '));
  }
});

test('unpin：发 enabled=false 并打印结果；pin 失败时打印原因并退出码 2', async t => {
  const { url, requests } = await startMock(t, { pinResponse: { ok: true, enabled: false, results: [{ ok: true, sessionId: SID_A, changed: true, stopped: ['p1'] }] } });
  let result = await cli(url, 'unpin');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.find(item => item.path === '/keepalive/api/sessions/pin').body.enabled, false);
  assert.match(result.stdout, /已取消会话 aaaaaaaa 的长保活，并停止了进行中的心跳计划/);
  const { url: url2 } = await startMock(t, { pinResponse: { ok: false, enabled: true, results: [{ ok: false, sessionId: SID_A, errors: [{ code: 'blocked', message: '上次心跳没命中已锁定' }] }] } });
  result = await cli(url2, 'pin');
  assert.equal(result.code, 2);
  assert.match(result.stdout, /无法设长保活/);
  assert.match(result.stdout, /上次心跳没命中已锁定/);
});


test('off / on：总开关，打印停掉与取消的数量、配置是否写入、如何恢复', async t => {
  const { url, requests } = await startMock(t, {});
  let result = await cli(url, 'off', '--reason', '下班');
  assert.equal(result.code, 0, result.stderr);
  const body = requests.find(item => item.path === '/keepalive/api/keepalive').body;
  assert.equal(body.enabled, false);
  assert.equal(body.reason, '下班');
  assert.match(result.stdout, /保活已全局关闭：停止 2 个计划，取消 1 个长保活/);
  assert.match(result.stdout, /已写入配置文件，重启后仍关/);
  assert.match(result.stdout, /cache-keepalive on/);
  requests.length = 0;
  result = await cli(url, 'on');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.find(item => item.path === '/keepalive/api/keepalive').body.enabled, true);
  assert.match(result.stdout, /保活已全局打开/);
  assert.match(result.stdout, /仍有 1 个会话被单独关闭自动保活/);
  assert.match(result.stdout, /长保活不会自动恢复/);
});

test('list 在总开关关闭时打横幅；help 按场景分组', async t => {
  const { url } = await startMock(t, { health: { ok: true, enabled: false, listen: 'http://127.0.0.1:18110', upstream: 'http://127.0.0.1:8080', auto: autoSettings(), budget: { pings: 0, maxPings: 200, usd: 0, maxUsd: 10 }, defaults: { ttl: TTL_DEFAULTS } }, sessions: [sessionView({ id: SID_A, auto: { state: 'off', code: 'keepalive-off' } })] });
  const result = await cli(url, 'list');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /⚠ 保活已全局关闭/);
  assert.match(result.stdout, /保活总开关已关/);
  const help = await cli(url, 'help');
  assert.match(help.stdout, /日常只需要这几条/);
  for (const name of ['pin', 'unpin', 'off \/ on', 'episodes', 'stop --global', 'auto set']) assert.match(help.stdout, new RegExp(name), name);
});


test('pin --global / unpin --global：打印新设、延长、跳过与每个会话的估算', async t => {
  const now = Date.now();
  const { url, requests } = await startMock(t, {
    pinResponse: {
      ok: true, global: true, enabled: true, ttl: '1h',
      summary: { sessions: 5, pinned: 2, extended: 1, unpinned: 0, skipped: 1, filtered: 1 }, skippedBy: { blocked: 1 },
      results: [
        { ok: true, sessionId: SID_A, pin: { untilAt: now + 12 * 3600e3, durationSec: 43200, intervalSec: 3000 }, estimate: { maxPings: 15, pingUsd: 0.12, maxUsd: 1.8, saveUsd: 4.7, contextTokens: 600000 } },
        { ok: false, sessionId: SID_B, errors: [{ code: 'blocked', message: '上次心跳没命中已锁定' }] },
      ],
    },
  });
  let result = await cli(url, 'pin', '--global', '--for', '12h');
  assert.equal(result.code, 0, result.stderr);
  const body = requests.find(item => item.path === '/keepalive/api/sessions/pin').body;
  assert.equal(body.global, true);
  assert.equal(body.enabled, true);
  assert.equal(body.for, '12h');
  assert.match(result.stdout, /全局长保活（1h）：新设 2 个，延长 1 个，跳过 1 个（.*1）/);
  assert.match(result.stdout, /另有 1 个会话不在范围/);
  assert.match(result.stdout, /aaaaaaaa 到 .*前缀 600\.0K，每次约 \$0\.120，整段空闲最多 15 次 \$1\.80，保住回来省 \$4\.70/);
  assert.match(result.stdout, /✗ bbbbbbbb 上次心跳没命中已锁定/);
  const { url: url2, requests: r2 } = await startMock(t, { pinResponse: { ok: true, global: true, enabled: false, summary: { unpinned: 3 }, results: [] } });
  result = await cli(url2, 'unpin', '--global');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(r2.find(item => item.path === '/keepalive/api/sessions/pin').body.enabled, false);
  assert.match(result.stdout, /已取消 3 个会话的长保活/);
});
