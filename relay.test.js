import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeConfig } from './core.js';
import { createRelay } from './relay.js';

const MIN = 60 * 1000;
const SID = '11111111-2222-3333-4444-555555555555';

// 假上游：按「model+system+tools+消息前缀」模拟 Anthropic 前缀缓存与 TTL，记录收到的每个请求。
function startFakeUpstream(clock, { ttlMs = 60 * MIN } = {}) {
  const cache = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, raw });
      if (!req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
        return;
      }
      const body = JSON.parse(raw);
      if (upstream.failNext) {
        upstream.failNext = false;
        res.writeHead(529, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
        return;
      }
      if (upstream.fail?.count > 0) {
        upstream.fail.count -= 1;
        res.writeHead(upstream.fail.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: upstream.fail.message } }));
        return;
      }
      // hangPing：心跳请求不回响应，模拟上游处理很慢 / 挂住（中继那边会超时）
      if (upstream.hangPing && body.max_tokens === 0) {
        upstream.hungPings.push(res);
        return;
      }
      // 与真实 API 一样，cache_control 标记的位置不影响前缀匹配
      const plain = value => JSON.parse(JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v)));
      const prefixKey = n => JSON.stringify([req.headers['x-claude-code-session-id'], body.model, plain(body.system), body.tools, plain(body.messages.slice(0, n))]);
      const tokens = n => prefixKey(n).length;
      let cached = 0;
      for (let n = body.messages.length; n > 0; n -= 1) {
        if ((cache.get(prefixKey(n)) || 0) > clock.t) {
          cached = n;
          break;
        }
      }
      const read = cached ? tokens(cached) : 0;
      const total = tokens(body.messages.length);
      if (cached) cache.set(prefixKey(cached), clock.t + ttlMs);
      cache.set(prefixKey(body.messages.length), clock.t + ttlMs);
      // writeTtl='5m' 模拟上游把请求里的 1h 降成 5m；pingOutput 模拟上游不遵守 max_tokens
      const split = upstream.writeTtl === '5m'
        ? { ephemeral_5m_input_tokens: total - read, ephemeral_1h_input_tokens: 0 }
        : { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: total - read };
      const usage = {
        input_tokens: 3,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: total - read,
        cache_creation: split,
        output_tokens: body.max_tokens === 0 ? (upstream.pingOutput ?? 0) : 7,
      };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        send({ type: 'message_start', message: { model: body.model, usage: { ...usage, output_tokens: 1 } } });
        send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } });
        const finishStream = () => {
          send({ type: 'message_delta', delta: { stop_reason: upstream.stopReason || 'end_turn' }, usage: { output_tokens: usage.output_tokens } });
          send({ type: 'message_stop' });
          res.end();
        };
        if (upstream.hangAfterStart) {
          upstream.hanging.push(finishStream);
          return;
        }
        finishStream();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', model: body.model, content: [], stop_reason: 'max_tokens', usage }));
      }
    });
  });
  const upstream = { server, requests, cache, failNext: false, fail: null, hangAfterStart: false, hanging: [], hangPing: false, hungPings: [], stopReason: null, pingOutput: null, writeTtl: '1h' };
  upstream.finishHanging = () => upstream.hanging.splice(0).forEach(finish => finish());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    upstream.url = `http://127.0.0.1:${server.address().port}`;
    resolve(upstream);
  }));
}

function claudeRequest(messages, { sessionId = SID, cwd = '/tmp/ka-ws' } = {}) {
  return {
    model: 'passthrough/claude-opus-5-5',
    messages: messages.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text, ...(i === messages.length - 1 ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}) }] })),
    system: [{ type: 'text', text: `You are Claude Code.\n - Primary working directory: ${cwd}\n${'stable system prompt. '.repeat(50)}`, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }, { name: 'Agent', input_schema: { type: 'object' } }],
    metadata: { user_id: `user_a_account_b_session_${sessionId}` },
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    stream: true,
  };
}

function request(port, { method = 'GET', path: urlPath, body, headers = {} }) {
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(payload ? { 'content-length': payload.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch { /* SSE 或文本 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const claudeHeaders = sessionId => ({
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,extended-cache-ttl-2025-04-11',
  'user-agent': 'claude-cli/2.1.296 (external, sdk-cli)',
  'x-app': 'cli',
  'x-claude-code-session-id': sessionId,
  authorization: 'Bearer test-key',
});

async function sendMessages(relay, messages, opts = {}) {
  const sessionId = opts.sessionId || SID;
  return request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: claudeRequest(messages, opts), headers: claudeHeaders(sessionId) });
}

// 写操作带上中继生成的口令（stateDir/control.token），和 CLI / 页面一样
const control = (relay, method, route, body, extraHeaders = {}) => request(relay.port, {
  method,
  path: `/keepalive/api/${route}`,
  body,
  headers: body ? { 'content-type': 'application/json', 'x-cache-keepalive-token': relay.token, ...extraHeaders } : extraHeaders,
});

async function setup(t, cfgPatch = {}, relayOpts = {}) {
  const clock = { t: Date.UTC(2026, 9, 21, 2, 0, 0) };
  const upstream = await startFakeUpstream(clock);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-test-'));
  const cfg = mergeConfig(DEFAULT_CONFIG, { upstream: upstream.url, minContextTokens: 100, ...cfgPatch });
  const relay = createRelay({ cfg, stateDir, now: () => clock.t, log: () => {}, agentLookup: () => null, ...relayOpts });
  await relay.listen(0, '127.0.0.1');
  t.after(async () => {
    await relay.close();
    upstream.server.closeAllConnections?.();
    await new Promise(resolve => upstream.server.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  return { clock, upstream, relay, stateDir };
}

test('透明转发 SSE 并记录会话快照', async t => {
  const { upstream, relay } = await setup(t);
  const res = await sendMessages(relay, ['hello']);
  assert.equal(res.status, 200);
  assert.match(res.text, /event: message_stop/);
  const forwarded = upstream.requests.at(-1);
  assert.equal(forwarded.url, '/v1/messages?beta=true');
  assert.equal(forwarded.headers['x-claude-code-session-id'], SID);
  assert.equal(forwarded.headers.authorization, 'Bearer test-key');
  assert.equal(forwarded.headers['accept-encoding'], 'identity');

  const models = await request(relay.port, { path: '/v1/models?limit=10' });
  assert.equal(models.status, 200);
  assert.equal(upstream.requests.at(-1).url, '/v1/models?limit=10');

  const list = await control(relay, 'GET', `sessions?cwd=${encodeURIComponent('/tmp/ka-ws')}`);
  assert.equal(list.json.sessions.length, 1);
  const view = list.json.sessions[0];
  assert.equal(view.id, SID);
  assert.equal(view.primary.ttl, '1h');
  assert.equal(view.primary.hasSnapshot, true);
  assert.ok(view.primary.contextTokens > 0);
  assert.equal(view.check.ok, true);
});

test('手动保活：按间隔发零输出心跳，原样重放请求头，命中后计入收益', async t => {
  const { clock, upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const started = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2, interval: '50m' });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  const plan = started.json.results[0].plan;
  assert.equal(plan.count, 2);
  assert.equal(plan.intervalSec, 3000);

  relay.tick();
  await relay.flush();
  const before = upstream.requests.length;
  assert.equal(relay.store.plans.get(plan.id).done, 0, '未到间隔不发');

  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(upstream.requests.length, before + 1);
  const ping = upstream.requests.at(-1);
  const pingBody = JSON.parse(ping.raw);
  assert.equal(pingBody.max_tokens, 0);
  assert.equal(pingBody.stream, false);
  assert.deepEqual({ ...pingBody, max_tokens: 32000, stream: true }, claudeRequest(['hello']));
  for (const name of ['x-claude-code-session-id', 'authorization', 'anthropic-beta', 'user-agent', 'x-app']) {
    assert.equal(ping.headers[name], claudeHeaders(SID)[name], name);
  }
  assert.equal(relay.store.plans.get(plan.id).done, 1);
  assert.equal(relay.store.plans.get(plan.id).lastOutcome, 'hit');

  // 第二次心跳从上一次命中心跳起算
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.plans.get(plan.id).status, 'completed');

  // 距最初请求 2h、距最后一次心跳 30m 回来：没有心跳早就过期了，现在命中 → 记收益
  clock.t += 30 * MIN;
  const resumed = await sendMessages(relay, ['hello', 'ok', 'next question']);
  assert.equal(resumed.status, 200);
  const summary = await control(relay, 'GET', 'summary?days=7');
  const totals = summary.json.totals;
  assert.equal(totals.pings, 2);
  assert.equal(totals.pingHits, 2);
  assert.equal(totals.keptResumes, 1);
  assert.ok(totals.benefitUsd > totals.pingCostUsd);
  assert.ok(totals.roi > 1);
});

test('心跳未命中（cache_read=0）即停止并锁定；不强制不能再保活', async t => {
  const { clock, upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const started = await control(relay, 'POST', 'plans', { session: SID.slice(0, 8), count: 3 });
  assert.equal(started.json.ok, true);
  upstream.cache.clear();
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  const plan = relay.store.plans.get(started.json.results[0].plan.id);
  assert.equal(plan.status, 'stopped');
  assert.equal(plan.lastOutcome, 'miss');

  const again = await control(relay, 'POST', 'plans', { session: SID });
  assert.equal(again.json.ok, false);
  assert.equal(again.json.results[0].errors[0].code, 'blocked');
  const forced = await control(relay, 'POST', 'plans', { session: SID, force: true });
  assert.equal(forced.json.ok, true);
});

test('缓存可能已过期时拒绝保活；会话请求进行中时暂缓心跳', async t => {
  const { clock, upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  clock.t += 59 * MIN;
  const late = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws' });
  assert.equal(late.json.ok, false);
  assert.equal(late.json.results[0].errors[0].code, 'expired');

  clock.t -= 59 * MIN;
  const started = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  assert.equal(started.json.ok, true);
  const lineage = relay.store.primaryLineage(relay.store.sessions.get(SID));
  lineage.inflight = 1;
  clock.t += 50 * MIN;
  const before = upstream.requests.length;
  relay.tick();
  await relay.flush();
  assert.equal(upstream.requests.length, before, '主对话请求进行中不发心跳');
  assert.equal(relay.store.plans.get(started.json.results[0].plan.id).state, 'busy');
  lineage.inflight = 0;
});

test('子代理请求在途不阻塞主对话的心跳', async t => {
  const { clock, upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const started = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  assert.equal(started.json.ok, true);
  // 同一会话、不同 system 与工具集的子代理谱系；2.1.29x 的子代理请求带 x-claude-code-agent-id
  const sub = claudeRequest(['subtask']);
  sub.system = [{ type: 'text', text: 'You are a subagent.', cache_control: { type: 'ephemeral' } }];
  sub.tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: sub, headers: { ...claudeHeaders(SID), 'x-claude-code-agent-id': 'agent-sub-1' } });
  const session = relay.store.sessions.get(SID);
  assert.equal(session.lineageKeys.size, 2);
  const subLineage = relay.store.sessionLineages(session).find(lineage => !lineage.isMainThread);
  assert.notEqual(relay.store.primaryLineage(session), subLineage, '主对话仍是保活目标');
  subLineage.inflight = 1;
  clock.t += 50 * MIN;
  const before = upstream.requests.length;
  relay.tick();
  await relay.flush();
  assert.equal(upstream.requests.length, before + 1, '子代理在途时主对话照常心跳');
  assert.equal(JSON.parse(upstream.requests.at(-1).raw).system[0].text.startsWith('You are Claude Code.'), true);
});

test('立即补一次：已有计划时计入计划；上游失败安排重试', async t => {
  const { upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const started = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 3 });
  const planId = started.json.results[0].plan.id;
  const pinged = await control(relay, 'POST', 'ping', { cwd: '/tmp/ka-ws' });
  assert.equal(pinged.json.ok, true, JSON.stringify(pinged.json));
  assert.equal(pinged.json.result.outcome, 'hit');
  assert.equal(relay.store.plans.get(planId).done, 1);
  assert.equal(relay.store.plans.get(planId).status, 'active');

  upstream.failNext = true;
  const failed = await control(relay, 'POST', 'ping', { cwd: '/tmp/ka-ws' });
  assert.equal(failed.json.result.outcome, 'error');
  assert.equal(relay.store.plans.get(planId).status, 'active', '一次失败只安排重试');
  assert.ok(relay.store.plans.get(planId).retryAt);
});

test('用户中途打断（流未结束）也按 message_start 的 usage 更新快照', async t => {
  const { upstream, relay } = await setup(t);
  upstream.hangAfterStart = true;
  const req = http.request({ host: '127.0.0.1', port: relay.port, method: 'POST', path: '/v1/messages?beta=true', headers: claudeHeaders(SID) });
  req.on('error', () => {});
  const firstChunk = new Promise(resolve => req.on('response', res => res.once('data', resolve)));
  req.end(JSON.stringify(claudeRequest(['interrupt me'])));
  await firstChunk;
  req.destroy();
  for (let i = 0; i < 50 && !relay.store.sessions.get(SID)?.lineageKeys.size; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  for (let i = 0; i < 50 && relay.store.sessions.get(SID)?.inflight; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  const session = relay.store.sessions.get(SID);
  assert.equal(session.inflight, 0);
  const lineage = relay.store.primaryLineage(session);
  assert.equal(lineage.inflight, 0);
  assert.ok(lineage.snapshot, '打断的请求也留下快照');
  assert.ok(lineage.expectedCached > 0);
});

test('控制接口的访问保护', async t => {
  const { relay } = await setup(t);
  const noJson = await request(relay.port, { method: 'POST', path: '/keepalive/api/plans', body: 'x', headers: { 'content-type': 'text/plain' } });
  assert.equal(noJson.status, 415);
  const evilHost = await request(relay.port, { path: '/keepalive/api/health', headers: { host: 'evil.example:18110' } });
  assert.equal(evilHost.status, 403);
  const crossSite = await request(relay.port, { method: 'POST', path: '/keepalive/api/plans', body: {}, headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
  assert.equal(crossSite.status, 403);
  const tunneled = await request(relay.port, { path: '/keepalive/api/health', headers: { host: 'localhost:28110' } });
  assert.equal(tunneled.status, 200);
  const page = await request(relay.port, { path: '/keepalive/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  // 页面只提供白名单里的三个静态文件
  for (const name of ['relay.js', 'core.js', '..%2Frelay.js']) {
    const missing = await request(relay.port, { path: `/keepalive/${name}` });
    assert.equal(missing.status, 404, name);
  }
});

test('中继重启：计划与账本保留，有计划的会话快照落盘恢复，借用后来请求的凭证继续心跳', async t => {
  const { clock, relay, stateDir, upstream } = await setup(t);
  await sendMessages(relay, ['hello']);
  await sendMessages(relay, ['other session'], { sessionId: '99999999-8888-7777-6666-555555555555', cwd: '/tmp/ka-other' });
  await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  // 只有有计划的会话落盘，且不含凭证
  const snapDir = path.join(stateDir, 'snapshots');
  const metas = fs.readdirSync(snapDir).filter(name => name.endsWith('.json'));
  assert.equal(metas.length, 1);
  const meta = JSON.parse(fs.readFileSync(path.join(snapDir, metas[0]), 'utf8'));
  assert.equal(meta.sessionId, SID);
  assert.equal(meta.headers.authorization, undefined);
  assert.equal(meta.headers['x-claude-code-session-id'], SID);
  assert.ok(meta.authFingerprint && !JSON.stringify(meta).includes('test-key'), '只记凭证指纹');
  await relay.close();
  // 优雅退出时缓存仍有效的主对话（没有计划的那个）也落盘，给重启后的自动保活用
  assert.equal(fs.readdirSync(snapDir).filter(name => name.endsWith('.json')).length, 2);

  const cfg = mergeConfig(DEFAULT_CONFIG, { upstream: upstream.url, minContextTokens: 100 });
  const reborn = createRelay({ cfg, stateDir, now: () => clock.t, log: () => {} });
  await reborn.listen(0, '127.0.0.1');
  t.after(() => reborn.close());
  const plan = reborn.store.activePlans()[0];
  assert.equal(plan.done, 1);
  assert.equal(reborn.store.events.filter(event => event.t === 'ping').length, 1);
  const lineage = reborn.store.primaryLineage(reborn.store.sessions.get(SID));
  assert.equal(lineage.snapshot.restored, true);
  const other = reborn.store.primaryLineage(reborn.store.sessions.get('99999999-8888-7777-6666-555555555555'));
  assert.equal(other.snapshot.restored, true);
  assert.equal(fs.readdirSync(snapDir).filter(name => name.endsWith('.json')).length, 1, '没有计划的读回内存后删掉文件');

  clock.t += 50 * MIN;
  reborn.tick();
  await reborn.flush();
  assert.equal(plan.state, 'waiting-auth', '重启后还没见过凭证，先等');
  assert.equal(plan.done, 1);

  // 任意会话的请求经过中继后，借用它的凭证发心跳
  const before = upstream.requests.length;
  await sendMessages(reborn, ['other session', 'ok', 'more'], { sessionId: '99999999-8888-7777-6666-555555555555', cwd: '/tmp/ka-other' });
  reborn.tick();
  await reborn.flush();
  const ping = upstream.requests.at(-1);
  assert.equal(upstream.requests.length, before + 2);
  assert.equal(ping.headers.authorization, 'Bearer test-key');
  assert.equal(ping.headers['x-claude-code-session-id'], SID);
  assert.equal(JSON.parse(ping.raw).max_tokens, 0);
  assert.equal(plan.status, 'completed');
  assert.equal(plan.lastOutcome, 'hit');
  assert.deepEqual(fs.readdirSync(snapDir), [], '计划结束后删除落盘快照');
});

test('快照文件缺失时等会话下一次请求，等不到就在缓存过期时结束计划', async t => {
  const { clock, relay, stateDir, upstream } = await setup(t);
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  await relay.close();
  fs.rmSync(path.join(stateDir, 'snapshots'), { recursive: true, force: true });
  const cfg = mergeConfig(DEFAULT_CONFIG, { upstream: upstream.url, minContextTokens: 100 });
  const reborn = createRelay({ cfg, stateDir, now: () => clock.t, log: () => {} });
  await reborn.listen(0, '127.0.0.1');
  t.after(() => reborn.close());
  const plan = reborn.store.activePlans()[0];
  clock.t += 50 * MIN;
  reborn.tick();
  assert.equal(plan.state, 'waiting-snapshot');
  clock.t += 10 * MIN;
  reborn.tick();
  assert.equal(plan.status, 'stopped');
  assert.match(plan.reason, /缓存可能已过期/);
});

test('配置文件热加载：改额度与护栏不必重启', async t => {
  const { relay, stateDir, upstream, clock } = await setup(t);
  await relay.close();
  const configFile = path.join(stateDir, 'config.json');
  const load = () => mergeConfig(mergeConfig(DEFAULT_CONFIG, { upstream: upstream.url, minContextTokens: 100 }), JSON.parse(fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '{}'));
  const hot = createRelay({ cfg: load(), stateDir, now: () => clock.t, log: () => {}, watchConfig: { file: configFile, load } });
  await hot.listen(0, '127.0.0.1');
  t.after(() => hot.close());
  await sendMessages(hot, ['hello']);
  fs.writeFileSync(configFile, JSON.stringify({ maxPingsPerDay: 0 }));
  hot.tick();
  const refused = await control(hot, 'POST', 'plans', { session: SID });
  assert.equal(refused.json.results[0].errors[0].code, 'daily-budget');
  fs.writeFileSync(configFile, JSON.stringify({ maxPingsPerDay: 50, ttl: { '1h': { defaultCount: 4 } } }));
  fs.utimesSync(configFile, new Date(), new Date(Date.now() + 2000));
  hot.tick();
  const ok = await control(hot, 'POST', 'plans', { session: SID });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.results[0].plan.count, 4);
  assert.equal(hot.stats.configReloads, 2);
});

test('优雅退出：等在途的流式响应结束再关', async t => {
  const { relay, upstream } = await setup(t);
  upstream.hangAfterStart = true;
  const finished = new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: relay.port, method: 'POST', path: '/v1/messages?beta=true', headers: claudeHeaders(SID) }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve(text));
    });
    req.end(JSON.stringify(claudeRequest(['long answer please'])));
  });
  for (let i = 0; i < 100 && relay.inflight === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(relay.inflight, 1);
  let closed = false;
  const closing = relay.close({ drainMs: 5000 }).then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(closed, false, '流还没结束时不退出');
  // 退出过程中不再接新连接
  await assert.rejects(request(relay.port, { path: '/keepalive/api/health' }));
  upstream.finishHanging();
  await closing;
  const text = await finished;
  assert.match(text, /message_stop/, '在途的流完整送达');
});

test('退出排空期间，已有 keep-alive 连接上的新请求直接 503（可重试），排空只等退出前已在途的请求', { timeout: 10000 }, async t => {
  const { relay, upstream } = await setup(t);
  upstream.hangAfterStart = true;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const post = (text, viaAgent) => new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: relay.port, method: 'POST', path: '/v1/messages?beta=true', headers: claudeHeaders(SID), ...(viaAgent ? { agent } : {}) }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', error => resolve({ error: error.code }));
    req.end(JSON.stringify(claudeRequest([text])));
  });
  const waitInflight = async n => {
    for (let i = 0; i < 200 && relay.inflight !== n; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(relay.inflight, n);
  };
  const first = post('first', true);
  await waitInflight(1);
  const long = post('long answer', false);
  await waitInflight(2);
  const closing = relay.close({ drainMs: 5000 });
  upstream.hanging.shift()();
  assert.equal((await first).status, 200);
  // 和生产里忙碌的会话一样：在刚结束的 keep-alive 连接上马上发下一个请求
  const forwarded = upstream.requests.length;
  const next = await post('next turn', true);
  assert.equal(next.status, 503);
  assert.equal(next.headers['x-should-retry'], 'true');
  assert.equal(next.headers.connection, 'close');
  assert.equal(upstream.requests.length, forwarded, '不转发上游');
  assert.equal(relay.inflight, 1, '只剩退出前就在途的那条流');
  assert.equal(relay.stats.drainRejected, 1);
  upstream.finishHanging();
  await closing;
  assert.match((await long).body, /message_stop/, '退出前已在途的流完整送达');
});

test('请求在途时「立即补一次」被拒；真实请求会作废挂着的重试', async t => {
  const { upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const lineage = relay.store.primaryLineage(relay.store.sessions.get(SID));
  lineage.inflight = 1;
  const busy = await control(relay, 'POST', 'ping', { session: SID });
  assert.equal(busy.json.ok, false);
  assert.equal(busy.json.errors[0].code, 'busy');
  lineage.inflight = 0;

  const started = await control(relay, 'POST', 'plans', { session: SID, count: 3 });
  const plan = relay.store.plans.get(started.json.results[0].plan.id);
  upstream.failNext = true;
  await control(relay, 'POST', 'ping', { session: SID });
  assert.ok(plan.retryAt, '失败后安排了重试');
  await sendMessages(relay, ['hello', 'ok', 'again']);
  assert.equal(plan.retryAt, null, '真实请求刷新了缓存，重试作废');
  assert.equal(plan.pingNowAt, null);
  assert.equal(plan.errorStreak, 0, '退避从头算');
});

test('网关/上游暂时不可用：退避重试，恢复后命中继续；一直不恢复就在缓存安全窗口截止时停', async t => {
  const { clock, upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const started = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2, interval: '50m' });
  const plan = relay.store.plans.get(started.json.results[0].plan.id);
  const advanceTo = async at => {
    clock.t = at;
    relay.tick();
    await relay.flush();
  };
  const SEC = 1000;
  upstream.fail = { count: 3, status: 503, message: 'no eligible upstream account is currently available' };
  await advanceTo(clock.t + 50 * MIN);
  assert.equal(plan.status, 'active');
  assert.equal(plan.state, 'retrying');
  assert.equal(plan.retryAt - clock.t, 30 * SEC);
  await advanceTo(plan.retryAt);
  assert.equal(plan.retryAt - clock.t, 60 * SEC, '指数退避');
  await advanceTo(plan.retryAt);
  assert.equal(plan.retryAt - clock.t, 120 * SEC);
  const view = (await control(relay, 'GET', 'sessions?cwd=/tmp/ka-ws')).json.sessions[0].plan;
  assert.equal(view.state, 'retrying');
  assert.equal(view.errorStreak, 3);
  assert.match(view.lastError, /no eligible upstream account/);

  await advanceTo(plan.retryAt);
  assert.equal(plan.lastOutcome, 'hit', '上游恢复后命中：这期间会话缓存还在');
  assert.equal(plan.done, 1);
  assert.equal(plan.errorStreak, 0);
  assert.equal(plan.retryAt, null);

  // 第二次心跳从命中的那次重试起算；这次上游一直不可用：30s、60s、120s、240s，最后一次贴着截止（58 分钟 − 10s）
  const hitAt = clock.t;
  upstream.fail = { count: 1000, status: 503, message: 'no eligible upstream account is currently available' };
  await advanceTo(hitAt + 50 * MIN);
  const attempts = [clock.t];
  while (plan.status === 'active') {
    await advanceTo(plan.retryAt);
    attempts.push(clock.t);
  }
  assert.deepEqual(attempts.map(at => (at - hitAt) / SEC), [3000, 3030, 3090, 3210, 3450, 3470]);
  assert.equal(plan.status, 'stopped');
  assert.match(plan.reason, /心跳连续失败 6 次（最后：no eligible upstream account is currently available），已到缓存安全窗口/);
  assert.equal(plan.done, 1);
});

test('请求被拒（非瞬时错误）连续两次就停，不退避重试', async t => {
  const { clock, upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const started = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  const plan = relay.store.plans.get(started.json.results[0].plan.id);
  upstream.fail = { count: 2, status: 401, message: 'invalid api key' };
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(plan.state, 'retrying');
  clock.t = plan.retryAt;
  relay.tick();
  await relay.flush();
  assert.equal(plan.status, 'stopped');
  assert.match(plan.reason, /心跳连续失败：invalid api key/);
});

test('Paseo 任务内运行：认得任务但会话没经过中继时，不退回同目录的其他会话', async t => {
  const { relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-agents-'));
  const dir = path.join(agentsDir, 'tmp-ka-ws');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'agent-1.json'), JSON.stringify({ id: 'agent-1', title: '另一个任务', cwd: '/tmp/ka-ws', persistence: { sessionId: 'not-through-relay' } }));
  fs.writeFileSync(path.join(dir, 'agent-2.json'), JSON.stringify({ id: 'agent-2', title: '保活中的任务', cwd: '/tmp/ka-ws', persistence: { sessionId: SID } }));
  const previous = process.env.PASEO_AGENTS_DIR;
  process.env.PASEO_AGENTS_DIR = agentsDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_AGENTS_DIR;
    else process.env.PASEO_AGENTS_DIR = previous;
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });
  const other = await control(relay, 'POST', 'plans', { agent: 'agent-1', agentCwd: '/tmp/ka-ws', cwd: '/tmp/ka-ws' });
  assert.equal(other.json.ok, false);
  assert.match(other.json.error, /另一个任务/);
  const mine = await control(relay, 'POST', 'plans', { agent: 'agent-2', agentCwd: '/tmp/ka-ws', cwd: '/tmp/ka-ws' });
  assert.equal(mine.json.ok, true);
  assert.equal(mine.json.by, 'paseo-agent');
  const listed = await control(relay, 'GET', `sessions?cwd=${encodeURIComponent('/tmp/ka-ws')}`);
  assert.equal(listed.json.sessions[0].paseo.title, '保活中的任务');
});

test('stop 只停目标工作区；不带目标的 --all 才停全部', async t => {
  const { relay } = await setup(t);
  const other = '99999999-8888-7777-6666-555555555555';
  await sendMessages(relay, ['hello']);
  await sendMessages(relay, ['hi there'], { sessionId: other, cwd: '/tmp/ka-other' });
  await control(relay, 'POST', 'plans', { session: SID });
  await control(relay, 'POST', 'plans', { session: other });
  const scoped = await control(relay, 'POST', 'plans/stop', { cwd: '/tmp/ka-ws', all: true });
  assert.equal(scoped.json.stopped.length, 1);
  assert.equal(relay.store.activePlanFor(other)?.status, 'active');
  const everything = await control(relay, 'POST', 'plans/stop', { all: true });
  assert.equal(everything.json.stopped.length, 1);
  assert.equal(relay.store.activePlans().length, 0);
});

test('立即补一次发不出去时说明原因', async t => {
  const { relay } = await setup(t, { maxPingsPerDay: 1 });
  await sendMessages(relay, ['hello']);
  const first = await control(relay, 'POST', 'ping', { session: SID });
  assert.equal(first.json.ok, true);
  const second = await control(relay, 'POST', 'ping', { session: SID });
  assert.equal(second.json.ok, false);
  assert.equal(second.json.errors[0].code, 'daily-budget');
});

test('会话缓存过期但共享前缀还在：心跳表现为「读到一部分 + 大量重写」，同样停止并锁定', async t => {
  const { clock, upstream, relay } = await setup(t);
  // 先缓存一个短前缀（相当于跨会话共享的系统/工具前缀），再让会话长出自己的长尾
  await sendMessages(relay, ['hello']);
  await sendMessages(relay, ['hello', 'ok', `session tail ${'x'.repeat(20000)}`]);
  const started = await control(relay, 'POST', 'plans', { session: SID, count: 2 });
  // 只让会话自己的尾部过期：保留 1 条消息前缀的条目
  for (const key of [...upstream.cache.keys()]) if (JSON.parse(key)[4].length > 1) upstream.cache.delete(key);
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  const plan = relay.store.plans.get(started.json.results[0].plan.id);
  assert.equal(plan.lastOutcome, 'rewrite');
  assert.equal(plan.status, 'stopped');
  const again = await control(relay, 'POST', 'plans', { session: SID });
  assert.equal(again.json.results[0].errors[0].code, 'blocked');
  const summary = await control(relay, 'GET', 'summary?days=1');
  assert.equal(summary.json.totals.pingMisses, 1);
});

test('会话压缩：压缩请求照常记收益，但不作为保活目标；计划等压缩后的新前缀', async t => {
  const { clock, upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const started = await control(relay, 'POST', 'plans', { session: SID, count: 3 });
  const plan = relay.store.plans.get(started.json.results[0].plan.id);
  const compactBody = claudeRequest(['hello', 'ok', "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions."]);
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: compactBody, headers: claudeHeaders(SID) });
  const lineage = relay.store.primaryLineage(relay.store.sessions.get(SID));
  assert.equal(lineage.snapshot, null, '压缩请求不留作快照');
  assert.ok(lineage.compactedAt);
  clock.t += 50 * MIN;
  const before = upstream.requests.length;
  relay.tick();
  await relay.flush();
  assert.equal(upstream.requests.length, before, '没有新前缀时不发心跳');
  assert.equal(plan.state, 'waiting-after-compact');
  const view = await control(relay, 'GET', `sessions?session=${SID}`);
  assert.match(view.json.sessions[0].check.errors.map(error => error.message).join(), /压缩/);
  // 压缩后第一次请求带来新前缀，计划继续
  clock.t += 1 * MIN;
  await sendMessages(relay, ['summary of earlier work', 'next question']);
  assert.ok(lineage.snapshot);
  assert.equal(lineage.compactedAt, null);
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(plan.lastOutcome, 'hit');
});

test('子代理也带 Agent 工具：按 x-claude-code-agent-id 识别，比主对话晚结束也不会成为保活目标', async t => {
  const { clock, upstream, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  const started = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  assert.equal(started.json.ok, true);
  // general-purpose 子代理：system 不同、同样带 Agent 工具，在主对话之后才结束
  clock.t += 1 * MIN;
  const sub = claudeRequest(['subtask']);
  sub.system = [{ type: 'text', text: 'You are a general-purpose subagent.', cache_control: { type: 'ephemeral' } }];
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: sub, headers: { ...claudeHeaders(SID), 'x-claude-code-agent-id': 'a1b2c3d4' } });
  const session = relay.store.sessions.get(SID);
  const subLineage = relay.store.sessionLineages(session).find(lineage => lineage.isSubagent);
  assert.ok(subLineage);
  assert.equal(subLineage.isMainThread, false);
  assert.notEqual(relay.store.primaryLineage(session), subLineage, '主对话仍是保活目标');
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.match(JSON.parse(upstream.requests.at(-1).raw).system[0].text, /^You are Claude Code\./, '心跳打在主对话上');
  assert.equal(relay.store.plans.get(started.json.results[0].plan.id).lastOutcome, 'hit');
});

test('冷启动只记主对话真正丢了缓存的重写：子代理不算，压缩请求标 5m 但读到之前 1h 的缓存也不算', async t => {
  const { clock, relay } = await setup(t);
  const sub = claudeRequest(['subtask']);
  sub.system = [{ type: 'text', text: 'You are a subagent.', cache_control: { type: 'ephemeral', ttl: '1h' } }];
  const sendSub = () => request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: sub, headers: { ...claudeHeaders(SID), 'x-claude-code-agent-id': 'a1b2c3d4' } });
  const history = ['hello', 'ok', `long ${'x'.repeat(20000)}`];
  await sendMessages(relay, history);
  await sendSub();
  // 2 小时后：缓存都过期了，子代理和主对话都要重写，只有主对话算冷启动
  clock.t += 120 * MIN;
  await sendSub();
  await sendMessages(relay, history);
  // 14 分钟后自动压缩：压缩请求自己标 5m，读的是 14 分钟前写下的 1h 缓存
  clock.t += 14 * MIN;
  const compact = claudeRequest([...history, `reply ${'y'.repeat(6000)}`, 'Your task is to create a detailed summary of the conversation so far, paying close attention to everything.']);
  compact.messages.at(-1).content[0].cache_control = { type: 'ephemeral' };
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: compact, headers: claudeHeaders(SID) });
  const summary = await control(relay, 'GET', 'summary?days=1');
  assert.equal(summary.json.totals.coldStarts, 1, JSON.stringify(summary.json.opportunities));
  assert.equal(summary.json.opportunities[0].ttl, '1h');
  assert.ok(summary.json.opportunities[0].gapSec >= 7200);
});

// ---------------------------------------------------------------- 自动保活

const AUTO = { auto: { minContextTokens: 100, minHumanTurns: 1 } };
const OTHER_SID = '99999999-8888-7777-6666-555555555555';

async function idle(relay, clock, minutes) {
  clock.t += minutes * MIN;
  relay.tick();
  await relay.flush();
}

function autoPlans(relay, sessionId = SID) {
  return [...relay.store.plans.values()].filter(plan => plan.sessionId === sessionId && plan.source === 'auto');
}

test('自动保活：空闲到间隔时自动发心跳，每段空闲最多 count 次；会话继续即结束本段，回来时按自动来源记收益', async t => {
  const { clock, upstream, relay } = await setup(t, AUTO);
  await sendMessages(relay, ['hello']);
  await idle(relay, clock, 49);
  assert.equal(autoPlans(relay).length, 0, '没到间隔不判定');
  await idle(relay, clock, 1);
  const [plan] = autoPlans(relay);
  assert.ok(plan, '到点自动建计划');
  assert.equal(plan.count, 3);
  assert.equal(plan.trigger, 'idle');
  assert.equal(plan.done, 1);
  assert.equal(JSON.parse(upstream.requests.at(-1).raw).max_tokens, 0);
  await idle(relay, clock, 50);
  await idle(relay, clock, 50);
  assert.equal(plan.status, 'completed');
  assert.equal(plan.done, 3);
  const before = upstream.requests.length;
  await idle(relay, clock, 50);
  assert.equal(upstream.requests.length, before, '这段空闲次数用完就不再发');
  // 第三次心跳后 40 分钟回来（离开约 3h20m）：缓存还在
  clock.t -= 10 * MIN;
  await sendMessages(relay, ['hello', 'ok', 'back']);
  const summary = (await control(relay, 'GET', 'summary?days=1')).json.totals;
  assert.equal(summary.bySource.auto.pings, 3);
  assert.equal(summary.bySource.auto.keptResumes, 1);
  assert.ok(summary.bySource.auto.benefitUsd > summary.bySource.auto.pingCostUsd);
  assert.equal(summary.autoStarted, 1);
  // 新的一段空闲重新判定
  await idle(relay, clock, 50);
  assert.equal(autoPlans(relay).length, 2);
  // 进行中的自动计划遇到真实请求就结束
  await sendMessages(relay, ['hello', 'ok', 'back', 'ok', 'again']);
  assert.equal(autoPlans(relay)[1].status, 'completed');
  assert.match(autoPlans(relay)[1].reason, /会话继续/);
});

test('自动保活：手动 stop 后整个会话不再自动保活，auto on 才恢复；关闭时同时停掉进行中的计划', async t => {
  const { clock, relay } = await setup(t, AUTO);
  await sendMessages(relay, ['hello']);
  await idle(relay, clock, 50);
  assert.equal(autoPlans(relay)[0].status, 'active');
  const stop = await control(relay, 'POST', 'plans/stop', { session: SID });
  assert.deepEqual(stop.json.autoDisabled, [SID]);
  assert.equal(autoPlans(relay)[0].status, 'cancelled');
  await sendMessages(relay, ['hello', 'ok', 'more']);
  await idle(relay, clock, 50);
  assert.equal(autoPlans(relay).length, 1, 'stop 之后的空闲不再自动保活');
  let view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.auto.state, 'stopped');
  // 没有计划时 stop 也会关掉自动保活
  const on = await control(relay, 'POST', 'sessions/auto', { session: SID, enabled: true });
  assert.equal(on.json.ok, true);
  await sendMessages(relay, ['hello', 'ok', 'more', 'ok', 'again']);
  await idle(relay, clock, 50);
  assert.equal(autoPlans(relay).length, 2, 'auto on 后恢复');
  const off = await control(relay, 'POST', 'sessions/auto', { session: SID, enabled: false });
  assert.equal(off.json.ok, true);
  assert.equal(autoPlans(relay)[1].status, 'cancelled');
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.auto.state, 'stopped');
});

test('自动保活门槛：前缀太小、人工轮次不够、凌晨开始的空闲、5m 缓存、上游把 1h 降成 5m 都不发，并记下原因', async t => {
  const cases = [
    { name: 'small-context', cfg: { auto: { minContextTokens: 10 ** 7, minHumanTurns: 1 } } },
    { name: 'few-human-turns', cfg: { auto: { minContextTokens: 100, minHumanTurns: 3 } } },
    { name: 'quiet-hours', cfg: AUTO, startAt: new Date(2026, 9, 21, 2, 30).getTime() },
    { name: 'not-1h', cfg: AUTO, ttl5m: true },
    { name: 'ttl-downgraded', cfg: AUTO, writeTtl: '5m' },
  ];
  for (const item of cases) {
    const { clock, upstream, relay } = await setup(t, item.cfg);
    if (item.startAt) clock.t = item.startAt;
    if (item.writeTtl) upstream.writeTtl = item.writeTtl;
    if (item.ttl5m) {
      const body = claudeRequest(['hello']);
      body.messages[0].content[0].cache_control = { type: 'ephemeral' };
      body.system[0].cache_control = { type: 'ephemeral' };
      await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body, headers: claudeHeaders(SID) });
    } else {
      await sendMessages(relay, ['hello']);
    }
    const before = upstream.requests.length;
    await idle(relay, clock, 50);
    assert.equal(upstream.requests.length, before, `${item.name}: 不发心跳`);
    const lineage = relay.store.primaryLineage(relay.store.sessions.get(SID));
    if (item.name === 'not-1h') {
      assert.equal(lineage.autoEpisode, undefined, '5m 缓存不参与自动保活判定');
      assert.equal((await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0].auto.code, 'not-1h');
      continue;
    }
    assert.equal(lineage.autoEpisode.code, item.name);
    const event = relay.store.events.find(e => e.t === 'auto' && e.ok === false);
    assert.equal(event.code, item.name);
    const view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
    assert.equal(view.auto.state, 'skipped');
    assert.equal(view.auto.code, item.name);
  }
});

test('自动保活：停在 tool_use（工具、子代理执行中）的空闲不看人工轮次；Paseo 显示任务已关闭则不算', async t => {
  const status = { value: 'running' };
  const { clock, upstream, relay } = await setup(t, { auto: { minContextTokens: 100, minHumanTurns: 5 } }, { agentLookup: () => ({ status: status.value, archived: false }) });
  upstream.stopReason = 'tool_use';
  await sendMessages(relay, ['hello']);
  await idle(relay, clock, 50);
  assert.equal(autoPlans(relay)[0]?.trigger, 'tool-gap');
  status.value = 'closed';
  await sendMessages(relay, ['hello', 'ok', 'more']);
  await idle(relay, clock, 50);
  assert.equal(autoPlans(relay).length, 1);
  // Paseo 显示任务已关闭：进程已退出，这段空闲没人会回来，直接按「任务已关闭」跳过（优先于人工轮次）
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(SID)).autoEpisode.code, 'agent-closed');
});

test('自动保活：心跳没命中即锁定该会话，并全局暂停新的自动保活；冷却期间其他会话也不发', async t => {
  const { clock, upstream, relay } = await setup(t, { auto: { minContextTokens: 100, minHumanTurns: 1, missCooldownSec: 7200 } });
  await sendMessages(relay, ['hello']);
  clock.t += 10 * MIN;
  await sendMessages(relay, ['other session'], { sessionId: OTHER_SID, cwd: '/tmp/ka-other' });
  clock.t -= 10 * MIN;
  for (const key of [...upstream.cache.keys()]) if (JSON.parse(key)[0] === SID) upstream.cache.delete(key);
  await idle(relay, clock, 50);
  const [plan] = autoPlans(relay);
  assert.equal(plan.lastOutcome, 'miss');
  assert.equal(plan.status, 'stopped');
  assert.ok(relay.store.autoCooldownUntil > clock.t);
  const before = upstream.requests.length;
  await idle(relay, clock, 10);
  assert.equal(upstream.requests.length, before, '冷却期间另一个会话到点也不发');
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(OTHER_SID)).autoEpisode.code, 'cooldown');
  // 锁定的会话：下一段空闲也不自动保活（blocked），直到 auto on 解锁
  await sendMessages(relay, ['hello', 'ok', 'more']);
  clock.t += 3 * 60 * MIN;
  await sendMessages(relay, ['hello', 'ok', 'more', 'ok', 'again']);
  await idle(relay, clock, 50);
  // 未命中后整个会话的保活都停：新谱系也不自动（会话级关闭优先于谱系锁定）
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(SID)).autoEpisode.code, 'session-stopped');
  assert.match(relay.store.sessions.get(SID).autoDisabled.reason, /auto on 恢复/);
  const health = (await control(relay, 'GET', 'health')).json;
  assert.equal(health.auto.cooldownUntil, null, '冷却到期');
});

test('自动保活：手动计划优先；这段空闲手动发过心跳后不再另建自动计划；手动 start 会替换进行中的自动计划', async t => {
  const { clock, relay } = await setup(t, AUTO);
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'plans', { session: SID, count: 1, interval: '20m' });
  await idle(relay, clock, 20);
  assert.equal([...relay.store.plans.values()].find(plan => plan.source !== 'auto').status, 'completed');
  await idle(relay, clock, 50);
  assert.equal(autoPlans(relay).length, 0, '手动心跳过的空闲不再自动保活');
  await sendMessages(relay, ['hello', 'ok', 'more']);
  await idle(relay, clock, 50);
  const [auto] = autoPlans(relay);
  assert.equal(auto.status, 'active');
  const manual = await control(relay, 'POST', 'plans', { session: SID, count: 'max' });
  assert.equal(manual.json.ok, true);
  assert.equal(auto.status, 'replaced');
  assert.equal(relay.store.activePlanFor(SID).source, 'api');
});

test('自动保活：Paseo 任务归档后停掉进行中的自动计划，之后也不再开始', async t => {
  const agent = { status: 'idle', archived: false };
  const { clock, relay } = await setup(t, AUTO, { agentLookup: () => agent });
  await sendMessages(relay, ['hello']);
  await idle(relay, clock, 50);
  const [plan] = autoPlans(relay);
  assert.equal(plan.done, 1);
  agent.archived = true;
  await idle(relay, clock, 50);
  assert.equal(plan.status, 'stopped');
  assert.match(plan.reason, /归档/);
  await sendMessages(relay, ['hello', 'ok', 'more']);
  await idle(relay, clock, 50);
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(SID)).autoEpisode.code, 'archived');
});

test('重启：缓存仍有效的主对话快照在优雅退出时落盘，重启后自动保活接着发；凭证按指纹借，不借别的凭证', async t => {
  const { clock, upstream, relay, stateDir } = await setup(t, AUTO);
  await sendMessages(relay, ['hello']);
  clock.t += 20 * MIN;
  await relay.close();
  const cfg = mergeConfig(DEFAULT_CONFIG, { upstream: upstream.url, minContextTokens: 100, ...AUTO });
  const reborn = createRelay({ cfg, stateDir, now: () => clock.t, log: () => {}, agentLookup: () => null });
  await reborn.listen(0, '127.0.0.1');
  t.after(() => reborn.close());
  const lineage = reborn.store.primaryLineage(reborn.store.sessions.get(SID));
  assert.equal(lineage.snapshot.restored, true);
  await idle(reborn, clock, 30);
  const [plan] = autoPlans(reborn);
  assert.equal(plan.state, 'waiting-auth');
  // 另一把凭证的请求经过：不借
  await request(reborn.port, { method: 'POST', path: '/v1/messages?beta=true', body: claudeRequest(['x'], { sessionId: OTHER_SID }), headers: { ...claudeHeaders(OTHER_SID), authorization: 'Bearer other-key' } });
  await idle(reborn, clock, 0);
  assert.equal(plan.state, 'waiting-auth');
  await request(reborn.port, { method: 'POST', path: '/v1/messages?beta=true', body: claudeRequest(['y'], { sessionId: OTHER_SID }), headers: claudeHeaders(OTHER_SID) });
  await idle(reborn, clock, 0);
  const ping = upstream.requests.at(-1);
  assert.equal(ping.headers['x-claude-code-session-id'], SID);
  assert.equal(ping.headers.authorization, 'Bearer test-key');
  assert.equal(plan.lastOutcome, 'hit');
});

test('心跳产生输出（上游没遵守 max_tokens）：停发，这个会话不再自动保活，手动需要强制', async t => {
  const { clock, upstream, relay } = await setup(t, AUTO);
  upstream.pingOutput = 223;
  await sendMessages(relay, ['hello']);
  await idle(relay, clock, 50);
  const [plan] = autoPlans(relay);
  assert.equal(plan.status, 'stopped');
  assert.match(plan.reason, /223 个输出 token/);
  await sendMessages(relay, ['hello', 'ok', 'more']);
  await idle(relay, clock, 50);
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(SID)).autoEpisode.code, 'unpingable');
  const manual = await control(relay, 'POST', 'plans', { session: SID });
  assert.equal(manual.json.results[0].errors[0].code, 'ping-anomaly');
});

test('每日额度按预估预留：多个会话同一时刻到点，不会一起越过上限', async t => {
  const { clock, upstream, relay } = await setup(t, { ...AUTO, maxPingsPerDay: 1 });
  await sendMessages(relay, ['hello']);
  await sendMessages(relay, ['other session'], { sessionId: OTHER_SID, cwd: '/tmp/ka-other' });
  const before = upstream.requests.length;
  await idle(relay, clock, 50);
  assert.equal(upstream.requests.length, before + 1, '额度只剩 1 次时只发 1 个');
  const plans = [...relay.store.plans.values()];
  assert.equal(plans.length, 2);
  assert.equal(plans.filter(plan => plan.done === 1).length, 1);
  assert.equal(plans.filter(plan => plan.state === 'daily-budget').length, 1);
});

test('调度异常被计数并暴露在健康检查里，不会让进程崩溃', async t => {
  const { relay } = await setup(t, AUTO);
  const original = relay.store.duePlans.bind(relay.store);
  relay.store.duePlans = () => {
    throw new Error('boom');
  };
  assert.doesNotThrow(() => relay.tick());
  relay.store.duePlans = original;
  const health = (await control(relay, 'GET', 'health')).json;
  assert.equal(health.stats.tickErrors, 1);
  assert.equal(health.lastTickError.message, 'boom');
});

test('人工接入轮次：只数主对话里人发的消息；子代理的任务提示不算；压缩后基线重置、不重复累加', async t => {
  const { relay } = await setup(t, AUTO);
  await sendMessages(relay, ['hello']);
  await sendMessages(relay, ['hello', 'ok', 'second']);
  const sub = claudeRequest(['do the subtask', 'ok', 'more detail']);
  sub.system = [{ type: 'text', text: 'You are a subagent.', cache_control: { type: 'ephemeral' } }];
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: sub, headers: { ...claudeHeaders(SID), 'x-claude-code-agent-id': 'a1b2c3d4' } });
  const session = relay.store.sessions.get(SID);
  assert.equal(session.humanTurns, 2);
  // 压缩后从摘要重新开始（摘要不算人工），之后的新消息才累加
  const compacted = claudeRequest(['This session is being continued from a previous conversation that ran out of context.', 'ok', 'third']);
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: compacted, headers: claudeHeaders(SID) });
  assert.equal(session.humanTurns, 2, '压缩后的请求体变短：只重设基线');
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: claudeRequest(['This session is being continued from a previous conversation that ran out of context.', 'ok', 'third', 'ok', 'fourth']), headers: claudeHeaders(SID) });
  assert.equal(session.humanTurns, 3);
});

test('自动保活设置：页面改的值校验后生效并写回配置文件，保留其他配置项', async t => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-cfg-'));
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ maxUsdPerDay: 7 }));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const { relay } = await setup(t, AUTO, { watchConfig: { file: configFile, load: () => mergeConfig(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(configFile, 'utf8'))) } });
  const bad = await control(relay, 'POST', 'auto', { count: 99, quietHours: [1] });
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.errors.length, 2);
  const good = await control(relay, 'POST', 'auto', { mode: 'off', count: 4, quietHours: [0, 7], minHumanTurns: 2 });
  assert.equal(good.json.ok, true);
  assert.equal(good.json.persisted, true);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.maxUsdPerDay, 7);
  assert.deepEqual(saved.auto, { mode: 'off', count: 4, quietHours: [0, 7], minHumanTurns: 2 });
  assert.equal(relay.store.cfg.auto.mode, 'off');
  assert.equal((await control(relay, 'GET', 'auto')).json.auto.count, 4);
});

test('回测接口：在子进程跑，同样的设置 10 分钟内直接用缓存', async t => {
  let runs = 0;
  const { relay } = await setup(t, AUTO, { backtestRunner: async ({ days, auto }) => ({ days, auto, totals: { pings: ++runs } }) });
  const first = (await control(relay, 'GET', 'backtest?days=3')).json;
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.result.days, 3);
  const second = (await control(relay, 'GET', 'backtest?days=3')).json;
  assert.equal(second.cached, true);
  assert.equal(runs, 1);
  await control(relay, 'POST', 'auto', { count: 2 });
  assert.equal((await control(relay, 'GET', 'backtest?days=3')).json.cached, false, '设置变了重算');
});

test('自动保活预判：没有快照（中继重启前就空闲的会话）时不显示「已就绪」', async t => {
  const { relay } = await setup(t, AUTO);
  await sendMessages(relay, ['hello']);
  let view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.auto.state, 'armed');
  relay.store.dropSnapshot(relay.store.primaryLineage(relay.store.sessions.get(SID)));
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.auto.state, 'ineligible');
  assert.equal(view.auto.code, 'no-snapshot');
});

// ---------------------------------------------------------------- 全局管理

test('全局开始：只给 1h 主对话建计划，跳过 5m 和子代理；已有计划不重复；恢复会话级关闭标记', async t => {
  const { relay } = await setup(t, { minContextTokens: 100 });
  const SID2 = '22222222-3333-4444-5555-666666666666';
  const SID3 = '33333333-4444-5555-6666-777777777777';
  const SID4 = '44444444-5555-6666-7777-888888888888';
  await sendMessages(relay, ['hello'], { sessionId: SID, cwd: '/tmp/ka-ws-a' });
  await sendMessages(relay, ['hello'], { sessionId: SID2, cwd: '/tmp/ka-ws-b' });
  const five = claudeRequest(['hello'], { sessionId: SID3, cwd: '/tmp/ka-ws-c' });
  five.messages[0].content[0].cache_control = { type: 'ephemeral' };
  five.system[0].cache_control = { type: 'ephemeral' };
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: five, headers: claudeHeaders(SID3) });
  const sub = claudeRequest(['subtask'], { sessionId: SID4, cwd: '/tmp/ka-ws-d' });
  sub.system = [{ type: 'text', text: 'You are a subagent.', cache_control: { type: 'ephemeral', ttl: '1h' } }];
  await request(relay.port, { method: 'POST', path: '/v1/messages?beta=true', body: sub, headers: { ...claudeHeaders(SID4), 'x-claude-code-agent-id': 'a1b2c3d4' } });
  // 用户此前单独关闭过 SID 的自动保活
  await control(relay, 'POST', 'sessions/auto', { session: SID, enabled: false });
  assert.ok(relay.store.sessions.get(SID).autoDisabled);

  const started = await control(relay, 'POST', 'plans', { global: true, ttl: '1h', count: 2 });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  assert.equal(started.json.summary.started, 2);
  assert.equal(started.json.summary.filtered, 2, '5m 和子代理不在 1h 主对话范围');
  assert.equal(started.json.summary.restored, 1);
  assert.ok(relay.store.activePlanFor(SID));
  assert.ok(relay.store.activePlanFor(SID2));
  assert.equal(relay.store.activePlanFor(SID3), null);
  assert.equal(relay.store.activePlanFor(SID4), null);
  assert.equal(relay.store.sessions.get(SID).autoDisabled, null, '全局开始恢复会话级关闭标记');

  // 幂等：再跑一次不会重置已有的计划
  const firstPlanId = relay.store.activePlanFor(SID).id;
  const again = await control(relay, 'POST', 'plans', { global: true, ttl: '1h' });
  assert.equal(again.json.summary.started, 0);
  assert.equal(again.json.summary.already, 2);
  assert.equal(relay.store.activePlanFor(SID).id, firstPlanId);
  assert.equal(relay.store.activePlanFor(SID).count, 2);

  // --ttl 5m 只处理 5m 会话，按 5m 默认次数执行
  const fiveStart = await control(relay, 'POST', 'plans', { global: true, ttl: '5m' });
  assert.equal(fiveStart.json.summary.started, 1);
  assert.equal(relay.store.activePlanFor(SID3).count, 3);

  // --ttl any 不会碰子代理（它不是主对话）
  const anyStart = await control(relay, 'POST', 'plans', { global: true, ttl: 'any' });
  assert.equal(anyStart.json.summary.already, 3);
  assert.equal(anyStart.json.summary.started, 0);
  assert.equal(relay.store.activePlanFor(SID4), null);
});

test('全局停止：停掉所有计划并关闭所有会话的自动保活；auto reset --global 只恢复标记、不动未命中锁定', async t => {
  const { relay } = await setup(t);
  const SID2 = '22222222-3333-4444-5555-666666666666';
  await sendMessages(relay, ['hello'], { sessionId: SID, cwd: '/tmp/ka-ws-a' });
  await sendMessages(relay, ['hello'], { sessionId: SID2, cwd: '/tmp/ka-ws-b' });
  const manual = await control(relay, 'POST', 'plans', { session: SID, count: 2 });
  assert.equal(manual.json.ok, true);
  const lineage2 = relay.store.primaryLineage(relay.store.sessions.get(SID2));
  lineage2.blocked = { at: 1, detail: 'test miss' };

  const stopped = await control(relay, 'POST', 'plans/stop', { global: true, reason: '下班' });
  assert.equal(stopped.json.ok, true);
  assert.equal(stopped.json.stopped.length, 1);
  assert.deepEqual(new Set(stopped.json.autoDisabled), new Set([SID, SID2]), '没有计划的会话也一并关闭');
  assert.equal(stopped.json.sessions, 2);
  assert.equal(stopped.json.autoMode, 'on');
  assert.equal(relay.store.activePlans().length, 0);
  assert.ok(relay.store.sessions.get(SID).autoDisabled);
  assert.ok(relay.store.sessions.get(SID2).autoDisabled);
  assert.equal((await control(relay, 'GET', 'auto')).json.auto.disabledSessions, 2);

  const reset = await control(relay, 'POST', 'sessions/auto', { global: true, enabled: true, clearBlocked: false });
  assert.equal(reset.json.ok, true);
  assert.equal(reset.json.changed.length, 2);
  assert.equal(relay.store.sessions.get(SID).autoDisabled, null);
  assert.equal(relay.store.sessions.get(SID2).autoDisabled, null);
  assert.ok(lineage2.blocked, '默认不解除未命中锁定');
  // 单会话 auto on 仍然会解除锁定
  const on = await control(relay, 'POST', 'sessions/auto', { session: SID2, enabled: true });
  assert.equal(on.json.ok, true);
  assert.equal(lineage2.blocked, null);
});

test('全局关闭自动保活：停掉进行中的自动计划，手动计划继续；重新打开后下一段空闲恢复判定', async t => {
  const { clock, relay } = await setup(t, AUTO);
  const SID2 = '22222222-3333-4444-5555-666666666666';
  await sendMessages(relay, ['hello'], { sessionId: SID, cwd: '/tmp/ka-ws-a' });
  await sendMessages(relay, ['hello'], { sessionId: SID2, cwd: '/tmp/ka-ws-b' });
  const manual = await control(relay, 'POST', 'plans', { session: SID2, count: 2, interval: '55m' });
  assert.equal(manual.json.ok, true);
  await idle(relay, clock, 50);
  const auto = autoPlans(relay)[0];
  assert.equal(auto?.status, 'active');
  assert.equal(relay.store.activePlanFor(SID2).status, 'active');

  const off = await control(relay, 'POST', 'auto', { mode: 'off' });
  assert.equal(off.json.ok, true);
  assert.equal(off.json.auto.mode, 'off');
  assert.equal(off.json.cancelledAutoPlans.length, 1);
  assert.equal(auto.status, 'cancelled');
  assert.equal(relay.store.activePlanFor(SID2).status, 'active', '手动计划不受全局自动开关影响');
  assert.equal(off.json.auto.disabledSessions, 0, '全局开关不等同于逐会话关闭');

  const on = await control(relay, 'POST', 'auto', { mode: 'on' });
  assert.equal(on.json.ok, true);
  await sendMessages(relay, ['hello', 'ok', 'back'], { sessionId: SID, cwd: '/tmp/ka-ws-a' });
  await idle(relay, clock, 50);
  const restarted = autoPlans(relay).at(-1);
  assert.equal(restarted.status, 'active', '下一段空闲重新开始自动保活');
  assert.equal(restarted.id === auto.id, false);
});

test('全局开始即使这次没建成计划（缓存已过期），也恢复会话级自动保活标记', async t => {
  const { clock, relay } = await setup(t);
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'sessions/auto', { session: SID, enabled: false });
  assert.ok(relay.store.sessions.get(SID).autoDisabled);
  clock.t += 60 * MIN;
  const started = await control(relay, 'POST', 'plans', { global: true, ttl: '1h' });
  assert.equal(started.json.ok, false, '缓存过期，没有计划可建');
  assert.equal(started.json.summary.skipped, 1);
  assert.equal(started.json.summary.restored, 1);
  assert.equal(started.json.skippedBy.expired, 1);
  assert.equal(relay.store.sessions.get(SID).autoDisabled, null, '自动保活标记仍然恢复');
  assert.equal(relay.store.activePlans().length, 0);
});


// ---------------------------------------------------------------- 2026-10-25 review 修复

test('心跳超时：记为 timeout 并按预估成本记账、计入每日额度；至少等 pingRetryTimeoutDelaySec 再重试，恢复后命中', async t => {
  const { clock, upstream, relay } = await setup(t, { pingTimeoutMs: 200, pingRetryTimeoutDelaySec: 120 });
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  const lineage = relay.store.primaryLineage(relay.store.sessions.get(SID));
  upstream.hangPing = true;
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  const plan = relay.store.activePlans()[0];
  assert.equal(plan.lastOutcome, 'timeout');
  assert.equal(plan.state, 'retrying');
  assert.equal(plan.done, 0, '超时不算命中、不刷新触达时刻');
  const event = relay.store.events.filter(e => e.t === 'ping').at(-1);
  assert.equal(event.outcome, 'timeout');
  assert.equal(event.estimated, true);
  assert.ok(event.costUsd > 0, '按读一遍前缀预估成本');
  assert.ok(Math.abs(event.costUsd - lineage.expectedCached * 0.2 / 1e6) < 1e-9, '预估 = 前缀 × 缓存读取价');
  assert.equal(relay.store.dailyUsage().pings, 1);
  assert.ok(relay.store.dailyUsage().usd > 0, '预估成本计入每日额度');
  assert.ok(plan.retryAt - clock.t >= 120 * 1000, '超时后至少等 120s 再重试，上游可能还在处理');
  // 退避期间不重发
  clock.t += 60 * 1000;
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.events.filter(e => e.t === 'ping').length, 1);
  // 上游恢复后重试命中
  upstream.hangPing = false;
  clock.t += 61 * 1000;
  relay.tick();
  await relay.flush();
  assert.equal(plan.lastOutcome, 'hit');
  assert.equal(plan.done, 1);
  const summary = (await control(relay, 'GET', 'summary?days=1')).json.totals;
  assert.equal(summary.pingTimeouts, 1);
  assert.equal(summary.pingFailures, 0, '超时单独计，不算进失败');
  assert.ok(summary.pingCostEstimatedUsd > 0 && summary.pingCostEstimatedUsd < summary.pingCostUsd);
  assert.equal(summary.pingHitRate, 1, '命中率只看拿到响应的心跳');
  for (const res of upstream.hungPings) res.destroy();
});

test('控制 API 写操作要带口令：没带 / 带错 401，带对放行；页面 HTML 注入口令；controlToken:false 时不校验', async t => {
  const { relay, stateDir } = await setup(t);
  await sendMessages(relay, ['hello']);
  const token = fs.readFileSync(path.join(stateDir, 'control.token'), 'utf8').trim();
  assert.equal(relay.token, token);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((fs.statSync(path.join(stateDir, 'control.token')).mode & 0o777), 0o600);
  const noToken = await request(relay.port, { method: 'POST', path: '/keepalive/api/plans', body: { cwd: '/tmp/ka-ws' }, headers: { 'content-type': 'application/json' } });
  assert.equal(noToken.status, 401);
  assert.match(noToken.json.error, /x-cache-keepalive-token/);
  const wrong = await request(relay.port, { method: 'POST', path: '/keepalive/api/plans', body: { cwd: '/tmp/ka-ws' }, headers: { 'content-type': 'application/json', 'x-cache-keepalive-token': 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(relay.store.activePlans().length, 0, '被拒的请求没有建计划');
  assert.equal(relay.stats.tokenRejected, 2);
  const ok = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 1 });
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
  // 读操作不需要口令
  const health = await request(relay.port, { path: '/keepalive/api/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.controlTokenRequired, true);
  // 页面拿到口令
  const page = await request(relay.port, { path: '/keepalive/' });
  assert.match(page.text, new RegExp(`<meta name="cache-keepalive-token" content="${token}">`));
  // 关闭校验
  const { relay: open } = await setup(t, { controlToken: false });
  await sendMessages(open, ['hello']);
  const free = await request(open.port, { method: 'POST', path: '/keepalive/api/plans', body: { cwd: '/tmp/ka-ws', count: 1 }, headers: { 'content-type': 'application/json' } });
  assert.equal(free.status, 200);
  assert.equal(free.json.ok, true);
  const openPage = await request(open.port, { path: '/keepalive/' });
  assert.match(openPage.text, /<meta name="cache-keepalive-token" content="">/, '不校验时不注入口令');
});

test('请求体超过 maxBodyBytes 直接 413，不转发也不留快照', async t => {
  const { relay, upstream } = await setup(t, { maxBodyBytes: 2048 });
  const big = claudeRequest(['x'.repeat(4096)]);
  const res = await request(relay.port, { method: 'POST', path: '/v1/messages', body: big, headers: claudeHeaders(SID) });
  assert.equal(res.status, 413);
  assert.equal(upstream.requests.length, 0);
  assert.equal(relay.store.sessions.size, 0);
  assert.equal(relay.stats.rejectedTooLarge, 1);
  assert.equal(relay.inflight, 0, '被拒的请求不占在途计数');
  const small = await sendMessages(relay, ['hi']);
  assert.equal(small.status, 200, '正常请求照常转发');
});

test('重启后恢复的快照：原 token 没再出现，但同一会话换了新 token 再来，也能借用新 token 发心跳', async t => {
  const { clock, relay, stateDir, upstream } = await setup(t);
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  await relay.close();
  const cfg = mergeConfig(DEFAULT_CONFIG, { upstream: upstream.url, minContextTokens: 100 });
  const reborn = createRelay({ cfg, stateDir, now: () => clock.t, log: () => {} });
  await reborn.listen(0, '127.0.0.1');
  t.after(() => reborn.close());
  const plan = reborn.store.activePlans()[0];
  clock.t += 50 * MIN;
  reborn.tick();
  await reborn.flush();
  assert.equal(plan.state, 'waiting-auth');
  // 别的会话用别的 token：不借
  await request(reborn.port, { method: 'POST', path: '/v1/messages', body: claudeRequest(['other'], { sessionId: OTHER_SID, cwd: '/tmp/ka-other' }), headers: { ...claudeHeaders(OTHER_SID), authorization: 'Bearer someone-else' } });
  reborn.tick();
  await reborn.flush();
  assert.equal(plan.state, 'waiting-auth', '别的会话、别的 token 不借');
  assert.equal(plan.done, 0);
  // 同一会话 token 轮换后回来（这次真实请求本身会刷新缓存，计划顺延）；之后到点的心跳用新 token
  const before = upstream.requests.length;
  await request(reborn.port, { method: 'POST', path: '/v1/messages', body: claudeRequest(['hello', 'ok', 'again']), headers: { ...claudeHeaders(SID), authorization: 'Bearer rotated-key' } });
  clock.t += 50 * MIN;
  reborn.tick();
  await reborn.flush();
  assert.equal(upstream.requests.length, before + 2);
  const ping = upstream.requests.at(-1);
  assert.equal(JSON.parse(ping.raw).max_tokens, 0);
  assert.equal(ping.headers.authorization, 'Bearer rotated-key', '借同一会话的新 token');
  assert.equal(plan.lastOutcome, 'hit');
});

test('告警：未命中锁定与全局冷却推送到 webhook；同类告警在 minIntervalSec 内只发一次；feishu 格式', async t => {
  const received = [];
  const hook = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise(resolve => hook.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => hook.close(resolve)));
  const webhookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  const { clock, upstream, relay } = await setup(t, { ...AUTO, alerts: { webhookUrl, minIntervalSec: 600 } });
  await sendMessages(relay, ['hello']);
  // 缓存在上游过期（假上游 TTL 60m），自动心跳 50m 到点时让上游缓存先失效 → miss
  clock.t += 50 * MIN;
  upstream.cache.clear();
  relay.tick();
  await relay.flush();
  await relay.notifier.flush();
  const kinds = received.map(alert => alert.kind);
  assert.deepEqual(kinds, ['miss', 'cooldown'], JSON.stringify(received));
  assert.equal(received[0].source, 'cache-keepalive');
  assert.match(received[0].title, /锁定/);
  assert.match(received[0].text, /解锁/);
  assert.equal(relay.stats.alertsSent, 2);
  const health = (await control(relay, 'GET', 'health')).json;
  assert.equal(health.alerts.configured, true);
  assert.equal(health.alerts.sent, 2);
  // 同类告警 10 分钟内去重
  relay.notifier.send({ kind: 'miss', title: 'again', text: 'x' });
  await relay.notifier.flush();
  assert.equal(received.length, 2);
  clock.t += 11 * MIN;
  relay.notifier.send({ kind: 'miss', title: 'again', text: 'x' });
  await relay.notifier.flush();
  assert.equal(received.length, 3);
  // 不在 kinds 列表里的不发
  relay.notifier.send({ kind: 'something-else', title: 'no', text: 'x' });
  await relay.notifier.flush();
  assert.equal(received.length, 3);
  // feishu 格式
  const { relay: feishu } = await setup(t, { alerts: { webhookUrl, format: 'feishu', minIntervalSec: 0 } });
  feishu.notifier.send({ kind: 'miss', title: '标题', text: '正文' });
  await feishu.notifier.flush();
  assert.deepEqual(received.at(-1), { msg_type: 'text', content: { text: '[cache-keepalive] 标题\n正文' } });
});

test('告警：心跳连续超时、重启后等凭证、额度用尽也会推送；webhook 失败只计数不影响心跳', async t => {
  const alerts = [];
  const { clock, upstream, relay } = await setup(t, { pingTimeoutMs: 200, pingRetryTimeoutDelaySec: 15, pingRetryDelaySec: 15, alerts: { webhookUrl: 'http://127.0.0.1:1/dead', minIntervalSec: 0 } });
  relay.notifier.send = alert => alerts.push(alert);
  relay.store.notify = alert => alerts.push(alert);
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 3 });
  upstream.hangPing = true;
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(alerts.filter(alert => alert.kind === 'ping-timeout').length, 0, '第一次超时不告警');
  clock.t += 16 * 1000;
  relay.tick();
  await relay.flush();
  assert.equal(alerts.filter(alert => alert.kind === 'ping-timeout').length, 1, '连续两次超时告警');
  for (const res of upstream.hungPings) res.destroy();
  // 额度用尽
  const { clock: clock2, relay: relay2 } = await setup(t, { maxUsdPerDay: 0.0000001 });
  relay2.store.notify = alert => alerts.push(alert);
  await sendMessages(relay2, ['hello']);
  await control(relay2, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 1 });
  clock2.t += 50 * MIN;
  relay2.tick();
  await relay2.flush();
  assert.equal(relay2.store.activePlans()[0].state, 'daily-budget');
  assert.equal(alerts.filter(alert => alert.kind === 'daily-budget').length, 1);
  relay2.tick();
  assert.equal(alerts.filter(alert => alert.kind === 'daily-budget').length, 1, '持续额度满不重复告警');
  // 真实 webhook 不通：失败计数，心跳照常
  const dead = (await control(relay, 'GET', 'health')).json;
  assert.equal(dead.alerts.configured, true);
});

test('自动保活：中继错过了 50–58 分钟的判定窗口时，记为 missed-window，页面不再显示「已就绪」；冷启动按它归因', async t => {
  const { clock, relay } = await setup(t, { ...AUTO, maxPingWriteTokens: 100 });
  await sendMessages(relay, ['hello']);
  let view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.auto.state, 'armed');
  // 中继「停了」70 分钟：没有 tick
  clock.t += 70 * MIN;
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.auto.state, 'skipped', '窗口已过，不能再显示 armed');
  assert.equal(view.auto.code, 'missed-window');
  relay.tick();
  await relay.flush();
  assert.equal(autoPlans(relay).length, 0, '不发心跳：缓存多半已过期');
  const lineage = relay.store.primaryLineage(relay.store.sessions.get(SID));
  assert.equal(lineage.autoEpisode.code, 'missed-window');
  assert.equal(relay.store.events.filter(e => e.t === 'auto' && e.code === 'missed-window').length, 1);
  relay.tick();
  assert.equal(relay.store.events.filter(e => e.t === 'auto' && e.code === 'missed-window').length, 1, '只记一次');
  // 回来：冷启动按 missed-window 归因
  await sendMessages(relay, ['hello', 'ok', 'back']);
  const summary = (await control(relay, 'GET', 'summary?days=1')).json.totals;
  assert.equal(summary.coldByAuto['missed-window']?.count, 1);
  assert.equal(summary.autoSkipped['missed-window'], 1);
});

test('自动保活：本段空闲手动发过心跳后，自动状态显示「本段已保活」而不是「已就绪」', async t => {
  const { clock, relay } = await setup(t, AUTO);
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'ping', { cwd: '/tmp/ka-ws' });
  clock.t += 20 * MIN;
  const view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.plan.status, 'completed');
  assert.equal(view.auto.state, 'done');
  assert.equal(view.auto.code, 'manual-pinged');
});

test('优雅退出：热快照与状态在排空之前就落盘；在途心跳最多等 flushMs', async t => {
  const { clock, relay, upstream, stateDir } = await setup(t, { pingTimeoutMs: 60000 });
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  // 一个挂住的在途心跳 + 一个挂住的在途流式请求
  upstream.hangPing = true;
  clock.t += 50 * MIN;
  relay.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relay.store.activePlans()[0].inflight, true);
  upstream.hangAfterStart = true;
  const streaming = request(relay.port, { method: 'POST', path: '/v1/messages', body: claudeRequest(['streaming'], { sessionId: OTHER_SID, cwd: '/tmp/ka-other' }), headers: claudeHeaders(OTHER_SID) });
  for (let i = 0; i < 100 && relay.inflight < 1; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  const started = Date.now();
  const closing = relay.close({ drainMs: 300, flushMs: 300 });
  await new Promise(resolve => setTimeout(resolve, 100));
  // 排空还没结束，快照和状态已经在盘上
  const snapDir = path.join(stateDir, 'snapshots');
  assert.ok(fs.readdirSync(snapDir).some(name => name.endsWith('.json')), '排空前已落盘快照');
  assert.ok(fs.existsSync(path.join(stateDir, 'state.json')));
  for (const res of upstream.hungPings) res.destroy();
  upstream.finishHanging();
  await closing;
  await streaming.catch(() => null);
  assert.ok(Date.now() - started < 5000, `close 不应等到 pingTimeout：${Date.now() - started}ms`);
});

test('执行记录：按计划聚合心跳与回来结果（生效 / 没回来 / 保住中），同一段空闲多个计划只记一次收益', async t => {
  const { clock, upstream, relay } = await setup(t);
  // 会话 A：手动 2 次，回来时保住
  await sendMessages(relay, ['hello']);
  const a = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 2 });
  const planA = a.json.results[0].plan.id;
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  // 手动再开一个计划替换（同一段空闲、两个计划）
  const a2 = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 1 });
  const planA2 = a2.json.results[0].plan.id;
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  clock.t += 30 * MIN;
  await sendMessages(relay, ['hello', 'ok', 'back']);
  // 会话 B：1 次心跳后没人回来，缓存过期
  await sendMessages(relay, ['other'], { sessionId: OTHER_SID, cwd: '/tmp/ka-other' });
  const b = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-other', count: 1 });
  const planB = b.json.results[0].plan.id;
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  // 会话 C：心跳后缓存仍有效
  const SID_C = '77777777-6666-5555-4444-333333333333';
  await sendMessages(relay, ['third'], { sessionId: SID_C, cwd: '/tmp/ka-third' });
  const c = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-third', count: 3 });
  const planC = c.json.results[0].plan.id;
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  clock.t += 20 * MIN;

  const result = (await control(relay, 'GET', 'episodes?days=7')).json;
  assert.equal(result.ok, true);
  assert.equal(result.totals.episodes, 4);
  const byId = new Map(result.episodes.map(episode => [episode.planId, episode]));
  const epA = byId.get(planA);
  const epA2 = byId.get(planA2);
  assert.equal(epA.pings.length, 1);
  assert.equal(epA.end.status, 'replaced');
  assert.equal(epA.outcome, 'kept', '被替换的计划也属于这段空闲，回来时同样算保住');
  assert.equal(epA.benefitUsd, 0, '收益只记给最后一次命中心跳所在的计划');
  assert.equal(epA2.outcome, 'kept');
  assert.ok(epA2.benefitUsd > 0);
  assert.ok(epA2.resume.kept);
  assert.ok(epA2.resume.gapSec > 3600);
  assert.equal(epA2.pings[0].outcome, 'hit');
  assert.ok(epA2.pings[0].cacheRead > 0);
  assert.equal(epA2.source, 'manual');
  assert.equal(epA2.active, false);
  assert.equal(byId.get(planB).outcome, 'expired-unused');
  assert.equal(byId.get(planB).end.status, 'completed');
  assert.equal(byId.get(planC).outcome, 'pending');
  assert.equal(byId.get(planC).active, true);
  assert.equal(byId.get(planC).count, 3);
  assert.equal(result.totals.byOutcome.kept, 2);
  assert.equal(result.totals.byOutcome['expired-unused'], 1);
  assert.equal(result.totals.byOutcome.pending, 1);
  assert.ok(Math.abs(result.totals.benefitUsd - epA2.benefitUsd) < 1e-9);
  assert.equal(result.totals.pings, 4);
  // 按会话过滤（前缀）
  const onlyB = (await control(relay, 'GET', `episodes?days=7&session=${OTHER_SID.slice(0, 8)}`)).json;
  assert.deepEqual(onlyB.episodes.map(episode => episode.planId), [planB]);
  // 和账本汇总口径一致
  const summary = (await control(relay, 'GET', 'summary?days=7')).json.totals;
  assert.ok(Math.abs(summary.benefitUsd - result.totals.benefitUsd) < 1e-9);
  assert.ok(Math.abs(summary.pingCostUsd - result.totals.pingCostUsd) < 1e-9);
  assert.ok(upstream.requests.length > 0);
});

test('自动保活：Paseo 任务已关闭的空闲不保活（没人会回来）；skipClosedAgents=false 时照常', async t => {
  const status = { value: 'idle' };
  const { clock, relay } = await setup(t, AUTO, { agentLookup: () => ({ status: status.value, archived: false }) });
  await sendMessages(relay, ['hello']);
  status.value = 'closed';
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(autoPlans(relay).length, 0);
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(SID)).autoEpisode.code, 'agent-closed');
  const view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.auto.code, 'agent-closed');
  // 关掉该门槛
  const { clock: clock2, relay: relay2 } = await setup(t, { auto: { ...AUTO.auto, skipClosedAgents: false } }, { agentLookup: () => ({ status: 'closed', archived: false }) });
  await sendMessages(relay2, ['hello']);
  clock2.t += 50 * MIN;
  relay2.tick();
  await relay2.flush();
  assert.equal(autoPlans(relay2).length, 1);
});

test('主对话识别：带会话头的新版客户端里，没有 Agent 工具但带其他工具的请求也是主对话；没有工具的旁路请求不是', async t => {
  const { clock, relay } = await setup(t);
  const body = claudeRequest(['hello']);
  body.tools = [{ name: 'Bash', input_schema: { type: 'object' } }, { name: 'Read', input_schema: { type: 'object' } }];
  await request(relay.port, { method: 'POST', path: '/v1/messages', body, headers: claudeHeaders(SID) });
  const bypass = claudeRequest(['give this conversation a title'], { sessionId: SID });
  delete bypass.tools;
  await request(relay.port, { method: 'POST', path: '/v1/messages', body: bypass, headers: claudeHeaders(SID) });
  const session = relay.store.sessions.get(SID);
  const lineages = relay.store.sessionLineages(session);
  assert.equal(lineages.filter(lineage => lineage.isMainThread).length, 1);
  assert.equal(relay.store.primaryLineage(session).toolCount, 2);
  const started = await control(relay, 'POST', 'plans', { cwd: '/tmp/ka-ws', count: 1 });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  assert.ok(clock.t > 0);
});


// ---------------------------------------------------------------- 长保活（pin）与活跃判定

test('长保活：默认 12 小时；空闲到间隔就发、会话继续就结束本段并顺延、下一段空闲再接上；到期自动取消', async t => {
  const { clock, upstream, relay } = await setup(t, { auto: { mode: 'off' } });
  await sendMessages(relay, ['hello']);
  const res = await control(relay, 'POST', 'sessions/pin', { cwd: '/tmp/ka-ws', source: 'cli' });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  const item = res.json.results[0];
  assert.equal(item.pin.durationSec, 12 * 3600);
  assert.equal(item.pin.intervalSec, 3000);
  assert.equal(item.pin.untilAt, clock.t + 12 * 3600 * 1000);
  assert.equal(item.plan, null, '刚发过请求，还没到间隔，不建计划');
  assert.equal(item.estimate.maxPings, Math.ceil(12 * 3600 / 3000));
  assert.ok(item.estimate.maxUsd > 0);
  let view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.pin.active, false);
  assert.equal(view.auto.state, 'pinned', '自动保活显示由长保活接管');
  // 未到间隔不发
  clock.t += 30 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(upstream.requests.length, 1);
  // 到间隔：建长保活计划并心跳，次数 = 到期前能发的次数（不受 maxCount 12 限制）
  clock.t += 20 * MIN;
  relay.tick();
  await relay.flush();
  let plan = relay.store.activePlans()[0];
  assert.equal(plan.source, 'pin');
  assert.ok(plan.count > 12, `次数不受上限约束: ${plan.count}`);
  assert.equal(plan.done, 1);
  assert.equal(plan.lastOutcome, 'hit');
  assert.equal(relay.store.events.filter(e => e.t === 'ping').at(-1).source, 'pin');
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.pin.active, true);
  assert.equal(view.plan.source, 'pin');
  // 第二次心跳按间隔
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(plan.done, 2);
  // 人回来了：本段计划结束，不多发；长保活仍在
  clock.t += 10 * MIN;
  await sendMessages(relay, ['hello', 'ok', 'back']);
  assert.equal(plan.status, 'completed');
  assert.match(plan.reason, /长保活/);
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.ok(view.pin);
  assert.equal(view.plan.status, 'completed');
  const summary = (await control(relay, 'GET', 'summary?days=7')).json.totals;
  assert.equal(summary.bySource.pin.pings, 2);
  assert.equal(summary.bySource.pin.keptResumes, 1, '回来时保住，收益记在长保活名下');
  // 连续工作期间不发
  const before = upstream.requests.length;
  for (let i = 0; i < 3; i += 1) {
    clock.t += 20 * MIN;
    await sendMessages(relay, ['hello', 'ok', 'back', 'a', `more ${i}`]);
    relay.tick();
    await relay.flush();
  }
  assert.equal(upstream.requests.length, before + 3, '工作期间只有真实请求，没有心跳');
  // 下一段空闲再接上
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  plan = relay.store.activePlans()[0];
  assert.equal(plan?.source, 'pin');
  assert.equal(plan.done, 1);
  // 到期：取消长保活，进行中的计划停止
  clock.t = view.pin.untilAt + 1000;
  relay.tick();
  await relay.flush();
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.pin, null);
  assert.equal(relay.store.activePlans().length, 0);
  assert.equal(relay.store.events.filter(e => e.t === 'pin' && e.action === 'expired').length, 1);
});

test('长保活：心跳未命中即锁定并取消长保活；unpin / stop 也取消；--for 超过上限按上限；在途与重试宽限期不发', async t => {
  const { clock, upstream, relay } = await setup(t, { auto: { mode: 'off' } });
  await sendMessages(relay, ['hello']);
  const long = await control(relay, 'POST', 'sessions/pin', { session: SID, for: '100h' });
  assert.equal(long.json.results[0].pin.durationSec, 48 * 3600);
  assert.match(long.json.results[0].warnings[0], /最长 48 小时/);
  // 真实请求失败（529）后 90s 内算活跃：到点也不发
  clock.t += 50 * MIN;
  upstream.failNext = true;
  const failed = await sendMessages(relay, ['hello', 'ok', 'retrying']);
  assert.equal(failed.status, 529);
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.events.filter(e => e.t === 'ping').length, 0, '客户端在重试，不发心跳');
  clock.t += 91 * 1000;
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.events.filter(e => e.t === 'ping').length, 1, '宽限期过后照常');
  // 未命中：假上游缓存清掉 → 锁定并取消长保活
  clock.t += 50 * MIN;
  upstream.cache.clear();
  relay.tick();
  await relay.flush();
  let view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.pin, null, '未命中取消长保活');
  assert.ok(view.primary.blocked);
  assert.equal(relay.store.activePlans().length, 0);
  assert.ok(relay.store.events.some(e => e.t === 'pin' && e.action === 'cancelled' && /锁定/.test(e.reason)));
  // 锁定状态下不能再设
  const denied = await control(relay, 'POST', 'sessions/pin', { session: SID });
  assert.equal(denied.json.results[0].ok, false);
  assert.equal(denied.json.results[0].errors[0].code, 'blocked');
  // 新请求 + 强制心跳解锁后可以再设；unpin 取消
  await sendMessages(relay, ['hello', 'ok', 'retrying', 'x', 'fresh']);
  await control(relay, 'POST', 'ping', { session: SID, force: true });
  assert.equal((await control(relay, 'POST', 'sessions/pin', { session: SID })).json.results[0].ok, true);
  const un = await control(relay, 'POST', 'sessions/pin', { session: SID, enabled: false });
  assert.equal(un.json.results[0].changed, true);
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.pin, null);
  // stop 也取消长保活
  await control(relay, 'POST', 'sessions/pin', { session: SID });
  const stopped = await control(relay, 'POST', 'plans/stop', { cwd: '/tmp/ka-ws' });
  assert.deepEqual(stopped.json.unpinned, [SID]);
  assert.equal(relay.store.sessions.get(SID).pin, null);
  // --global 不能和 --session 混用
  const mixed = await control(relay, 'POST', 'sessions/pin', { global: true, session: SID });
  assert.equal(mixed.json.ok, false);
});

test('长保活：自动保活让位；手动计划优先并在结束后由长保活接上；Paseo 归档即取消；空闲已超安全窗口的那段不发', async t => {
  const archived = { value: false };
  const { clock, upstream, relay } = await setup(t, AUTO, { agentLookup: () => ({ status: 'idle', archived: archived.value }) });
  await sendMessages(relay, ['hello']);
  // 12h：本用例要跨 5 个多小时，别撞到到期（到期前剩余不足一个间隔时计划只有 1 次、发完即完成，属正常）
  await control(relay, 'POST', 'sessions/pin', { session: SID, for: '12h' });
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(autoPlans(relay).length, 0, '长保活接管，不建自动计划');
  assert.equal(relay.store.activePlans()[0].source, 'pin');
  // 手动计划替换长保活计划；手动完成后下一次到点由长保活接上
  const manual = await control(relay, 'POST', 'plans', { session: SID, count: 1 });
  assert.equal(manual.json.ok, true);
  assert.equal(relay.store.activePlans()[0].source, 'api');
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.activePlans().length, 0, '手动 1 次完成');
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.activePlans()[0]?.source, 'pin', '长保活接上');
  // 空闲已超过安全窗口（中继停了 2 小时）：这段不发，记一次 missed-window，等下一次请求
  await sendMessages(relay, ['hello', 'ok', 'later']);
  const before = upstream.requests.length;
  clock.t += 120 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(upstream.requests.length, before, '缓存多半已过期，不发');
  assert.equal(relay.store.events.filter(e => e.t === 'pin' && e.action === 'missed-window').length, 1);
  relay.tick();
  assert.equal(relay.store.events.filter(e => e.t === 'pin' && e.action === 'missed-window').length, 1, '每段只记一次');
  assert.ok(relay.store.sessions.get(SID).pin, '长保活本身还在');
  await sendMessages(relay, ['hello', 'ok', 'later', 'x', 'back']);
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.activePlans()[0]?.source, 'pin', '下一段空闲接上');
  // Paseo 归档：取消
  archived.value = true;
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.sessions.get(SID).pin, null);
  assert.equal(relay.store.activePlans().length, 0);
  // 长保活状态与计划一起落盘，重启后还在
  const health = (await control(relay, 'GET', 'health')).json;
  assert.equal(health.pinnedSessions, 0);
});

test('长保活：重启后保留，并随快照恢复接着发', async t => {
  const { clock, relay, stateDir, upstream } = await setup(t, { auto: { mode: 'off' } });
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'sessions/pin', { session: SID, for: '6h' });
  await relay.close();
  const cfg = mergeConfig(DEFAULT_CONFIG, { upstream: upstream.url, minContextTokens: 100, auto: { mode: 'off' } });
  const reborn = createRelay({ cfg, stateDir, now: () => clock.t, log: () => {} });
  await reborn.listen(0, '127.0.0.1');
  t.after(() => reborn.close());
  const session = reborn.store.sessions.get(SID);
  assert.ok(session.pin);
  assert.equal(session.pin.durationSec, 6 * 3600);
  // 凭证进来后到点心跳
  await request(reborn.port, { method: 'POST', path: '/v1/messages', body: claudeRequest(['other'], { sessionId: OTHER_SID, cwd: '/tmp/ka-other' }), headers: claudeHeaders(OTHER_SID) });
  clock.t += 50 * MIN;
  reborn.tick();
  await reborn.flush();
  const plan = reborn.store.activePlans().find(item => item.sessionId === SID);
  assert.equal(plan?.source, 'pin');
  assert.equal(plan.done, 1);
  assert.equal((await control(reborn, 'GET', 'health')).json.pinnedSessions, 1);
});


// ---------------------------------------------------------------- 总开关

test('总开关 off：停掉所有计划与长保活、不再自动、不能新开、写入配置；on 恢复；热加载配置 enabled=false 同样生效', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-cfg-'));
  const configFile = path.join(stateDir, 'config.json');
  const clock = { t: Date.UTC(2026, 9, 21, 2, 0, 0) };
  const upstream = await startFakeUpstream(clock);
  const load = () => {
    let fileCfg = {};
    try {
      fileCfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch { /* 没有 */ }
    return mergeConfig(mergeConfig(DEFAULT_CONFIG, { upstream: upstream.url, minContextTokens: 100, ...AUTO }), fileCfg);
  };
  const relay = createRelay({ cfg: load(), stateDir, now: () => clock.t, log: () => {}, agentLookup: () => null, watchConfig: { file: configFile, load } });
  await relay.listen(0, '127.0.0.1');
  t.after(async () => {
    await relay.close();
    upstream.server.closeAllConnections?.();
    await new Promise(resolve => upstream.server.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await sendMessages(relay, ['hello']);
  await sendMessages(relay, ['other'], { sessionId: OTHER_SID, cwd: '/tmp/ka-other' });
  await control(relay, 'POST', 'plans', { session: SID, count: 3 });
  await control(relay, 'POST', 'sessions/pin', { session: OTHER_SID });
  assert.equal(relay.store.activePlans().length, 1);
  const off = await control(relay, 'POST', 'keepalive', { enabled: false, reason: '下班', source: 'cli' });
  assert.equal(off.json.ok, true);
  assert.equal(off.json.stopped.length, 1);
  assert.deepEqual(off.json.unpinned, [OTHER_SID]);
  assert.equal(off.json.persisted, true);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).enabled, false);
  assert.equal(relay.store.activePlans().length, 0);
  assert.equal(relay.store.sessions.get(OTHER_SID).pin, null);
  assert.equal((await control(relay, 'GET', 'health')).json.enabled, false);
  // 到点也不自动、不发
  const before = upstream.requests.length;
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(upstream.requests.length, before);
  assert.equal(relay.store.activePlans().length, 0);
  // 不能新开
  for (const [route, body] of [['plans', { session: SID, count: 1 }], ['sessions/pin', { session: SID }], ['ping', { session: SID }]]) {
    const res = await control(relay, 'POST', route, body);
    const item = res.json.results?.[0] || res.json;
    assert.equal(item.ok, false, route);
    assert.equal(item.errors[0].code, 'keepalive-off', route);
  }
  const view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.auto.state, 'off');
  assert.equal(view.auto.code, 'keepalive-off');
  assert.equal(relay.store.events.filter(e => e.t === 'global' && e.action === 'off').length, 1);
  // on：自动保活下一个到点恢复
  const on = await control(relay, 'POST', 'keepalive', { enabled: true });
  assert.equal(on.json.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).enabled, true);
  await sendMessages(relay, ['hello', 'ok', 'again']);
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(autoPlans(relay).length, 1, '打开后自动保活恢复');
  assert.equal((await control(relay, 'POST', 'sessions/pin', { session: SID })).json.results[0].ok, true);
  // 外部改配置文件 enabled=false 热加载：残留的计划被取消
  const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  current.enabled = false;
  fs.writeFileSync(configFile, JSON.stringify(current));
  fs.utimesSync(configFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.activePlans().length, 0, '热加载关闭后残留计划取消');
  assert.equal((await control(relay, 'GET', 'health')).json.enabled, false);
});


test('自动保活：没有 Paseo 时按进程探测——会话的 claude 进程退出后这段空闲不保活；进程还在照常', async t => {
  const { createAgentLookup } = await import('./agents.js');
  const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-proc-'));
  t.after(() => fs.rmSync(procDir, { recursive: true, force: true }));
  const addProc = (pid, argv, cwd) => {
    fs.mkdirSync(path.join(procDir, String(pid)));
    fs.writeFileSync(path.join(procDir, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
    fs.symlinkSync(cwd, path.join(procDir, String(pid), 'cwd'));
  };
  const clockRef = { t: 0 };
  const lookup = createAgentLookup({ cfg: { agentProbe: { paseo: false } }, now: () => clockRef.t, procDir });
  const { clock, relay } = await setup(t, AUTO, { agentLookup: lookup });
  clockRef.t = clock.t;
  addProc(4242, ['/opt/node/bin/claude', '--resume', SID], '/tmp/ka-ws');
  await sendMessages(relay, ['hello']);
  let view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.agent?.status, 'idle');
  assert.equal(view.agent?.match, 'session-id');
  // 进程退出后到点：跳过
  fs.rmSync(path.join(procDir, '4242'), { recursive: true });
  clock.t += 50 * MIN;
  clockRef.t = clock.t;
  relay.tick();
  await relay.flush();
  assert.equal(autoPlans(relay).length, 0);
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(SID)).autoEpisode.code, 'agent-closed');
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.equal(view.agent?.status, 'closed');
  // 进程以 --resume 回来并继续工作：下一段空闲照常保活
  addProc(4300, ['claude', `--resume=${SID}`], '/tmp/ka-ws');
  clock.t += 5 * MIN;
  clockRef.t = clock.t;
  await sendMessages(relay, ['hello', 'ok', 'back']);
  clock.t += 50 * MIN;
  clockRef.t = clock.t;
  relay.tick();
  await relay.flush();
  assert.equal(autoPlans(relay).length, 1);
});


// ---------------------------------------------------------------- 2026-10-26：预计节省 / 未命中整会话停 / pin --global

test('执行记录与计划视图带「回来可省」预计节省；未命中后该会话全部保活停止（自动 / 长保活 / 新谱系），auto on 才恢复', async t => {
  const { clock, upstream, relay } = await setup(t, AUTO);
  await sendMessages(relay, ['hello']);
  await control(relay, 'POST', 'sessions/pin', { session: SID });
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  let view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.ok(view.plan.saveUsd > 0, '计划视图带预计节省');
  assert.equal(view.plan.contextTokens, view.primary.contextTokens);
  const episodes = (await control(relay, 'GET', 'episodes?days=7')).json.episodes;
  assert.ok(episodes[0].expectedSaveUsd > 0);
  assert.ok(Math.abs(episodes[0].expectedSaveUsd - view.plan.saveUsd) < 1e-9, '执行记录与计划口径一致');
  assert.equal(episodes[0].contextTokens, view.primary.contextTokens);
  // 未命中：缓存被清 → 锁定 + 取消长保活 + 会话级关闭自动
  clock.t += 50 * MIN;
  upstream.cache.clear();
  relay.tick();
  await relay.flush();
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.ok(view.primary.blocked);
  assert.equal(view.pin, null);
  assert.equal(view.auto.state, 'stopped');
  assert.match(view.auto.disabled.reason, /auto on 恢复/);
  // 新请求换了模型（新谱系）后空闲到点：仍不自动保活
  const other = claudeRequest(['hello', 'ok', 'switch model']);
  other.model = 'passthrough/claude-sonnet-5-5';
  await request(relay.port, { method: 'POST', path: '/v1/messages', body: other, headers: claudeHeaders(SID) });
  assert.equal(relay.store.sessionLineages(relay.store.sessions.get(SID)).length, 2);
  clock.t += 50 * MIN;
  relay.tick();
  await relay.flush();
  assert.equal(autoPlans(relay).length, 0, '换模型也不绕过');
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(SID)).autoEpisode.code, 'session-stopped');
  // 人工操作即确认：auto on 恢复自动；pin 是人工显式动作，可直接设
  const re = await control(relay, 'POST', 'sessions/auto', { session: SID, enabled: true });
  assert.equal(re.json.ok, true);
  view = (await control(relay, 'GET', `sessions?session=${SID}`)).json.sessions[0];
  assert.notEqual(view.auto.state, 'stopped');
  assert.equal((await control(relay, 'POST', 'sessions/pin', { session: SID })).json.results[0].ok, true);
});

test('pin --global：只给缓存仍有效的 1h 主对话设长保活，已有的延长；--all-sessions 连过期的也设；unpin --global 全部取消', async t => {
  const { clock, relay } = await setup(t, { auto: { mode: 'off' } });
  const SID2 = '22222222-3333-4444-5555-666666666666';
  const SID3 = '33333333-4444-5555-6666-777777777777';
  await sendMessages(relay, ['a'], { sessionId: SID, cwd: '/tmp/ka-a' });
  await sendMessages(relay, ['b'], { sessionId: SID2, cwd: '/tmp/ka-b' });
  const five = claudeRequest(['c'], { sessionId: SID3, cwd: '/tmp/ka-c' });
  five.system[0].cache_control = { type: 'ephemeral' };
  five.messages[0].content[0].cache_control = { type: 'ephemeral' };
  await request(relay.port, { method: 'POST', path: '/v1/messages', body: five, headers: claudeHeaders(SID3) });
  assert.equal(relay.store.primaryLineage(relay.store.sessions.get(SID3)).ttl, '5m');
  // SID 已有长保活 6h → 延长到 12h
  await control(relay, 'POST', 'sessions/pin', { session: SID, for: '6h' });
  const res = await control(relay, 'POST', 'sessions/pin', { global: true });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.equal(res.json.summary.pinned, 1);
  assert.equal(res.json.summary.extended, 1);
  assert.equal(res.json.summary.filtered, 1, '5m 会话不在默认范围');
  assert.equal(relay.store.sessions.get(SID).pin.durationSec, 12 * 3600);
  assert.ok(relay.store.sessions.get(SID2).pin);
  assert.ok(!relay.store.sessions.get(SID3).pin);
  assert.equal((await control(relay, 'GET', 'health')).json.pinnedSessions, 2);
  // 全部取消
  const un = await control(relay, 'POST', 'sessions/pin', { global: true, enabled: false });
  assert.equal(un.json.summary.unpinned, 2);
  assert.equal((await control(relay, 'GET', 'health')).json.pinnedSessions, 0);
  // 缓存过期的默认跳过，--all-sessions 也设（等下一次请求后接上，这段不发）
  clock.t += 70 * MIN;
  const skipExpired = await control(relay, 'POST', 'sessions/pin', { global: true });
  assert.equal(skipExpired.json.ok, false);
  assert.equal(skipExpired.json.summary.filtered, 3);
  const all = await control(relay, 'POST', 'sessions/pin', { global: true, allSessions: true, ttl: 'any' });
  assert.equal(all.json.summary.pinned, 3);
  relay.tick();
  await relay.flush();
  assert.equal(relay.store.activePlans().length, 0, '过期这段不发心跳');
});
