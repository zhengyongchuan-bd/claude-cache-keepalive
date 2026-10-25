// 中继开销实测：同一个假上游（读完请求体立刻回 SSE），分别直连与经中继，测首字节延迟；另测 parseMessagesRequest 单独耗时。
// 用法：node cache-keepalive/bench.mjs [每档次数=30] <Claude Code 会话记录 .jsonl>（用真实文本填充请求体）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_CONFIG, mergeConfig, parseMessagesRequest } from './core.js';
import { createRelay } from './relay.js';

const N = Number(process.argv[2] || 30);
const transcript = process.argv[3];
// 用真实会话记录里的文本填充消息，接近 Claude Code 请求体的字符分布与转义密度
const texts = [];
for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
  try {
    const r = JSON.parse(line);
    const content = r.message?.content;
    if (typeof content === 'string') texts.push(content);
    else for (const b of content || []) {
      if (typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'tool_result') texts.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
      else if (b.type === 'tool_use') texts.push(JSON.stringify(b.input));
    }
  } catch {}
}
const tools = Array.from({ length: 23 }, (_, i) => ({ name: i === 0 ? 'Agent' : `Tool${i}`, description: 'x'.repeat(2500), input_schema: { type: 'object', properties: { a: { type: 'string' } } } }));
function body(targetBytes) {
  const messages = [];
  let size = 0, i = 0;
  while (size < targetBytes) {
    const t = texts[i++ % texts.length];
    messages.push({ role: messages.length % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: t }] });
    size += t.length + 60;
  }
  if (messages.at(-1).role === 'assistant') messages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] });
  messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral', ttl: '1h' };
  return JSON.stringify({ model: 'passthrough/claude-opus-5-5', max_tokens: 32000, thinking: { type: 'adaptive' }, stream: true,
    system: [{ type: 'text', text: 'You are Claude Code.\n - Primary working directory: /tmp/ka-bench\n' + 'sys '.repeat(4000), cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools, messages, metadata: { user_id: 'user_a_account_b_session_99999999-2222-3333-4444-555555555555' } });
}

const upstream = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } });
    send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
    send({ type: 'message_stop' });
    res.end();
  });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-bench-'));
const relay = createRelay({ cfg: mergeConfig(DEFAULT_CONFIG, { upstream: `http://127.0.0.1:${upPort}` }), stateDir, log: () => {} });
await relay.listen(0, '127.0.0.1');

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
function once(port, payload) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let ttfb = null;
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages?beta=true', agent,
      headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-claude-code-session-id': '99999999-2222-3333-4444-555555555555', authorization: 'Bearer bench' } }, res => {
      res.once('data', () => { ttfb = performance.now() - t0; });
      res.on('data', () => {});
      res.on('end', () => resolve({ ttfb, total: performance.now() - t0 }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const stat = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s.at(-1), mean: s.reduce((a, b) => a + b, 0) / s.length };
};
const fmt = o => `n=${o.n} min=${o.min.toFixed(2)} p50=${o.p50.toFixed(2)} p90=${o.p90.toFixed(2)} max=${o.max.toFixed(2)} mean=${o.mean.toFixed(2)}`;

for (const target of [100e3, 1e6, 3e6]) {
  const text = body(target);
  const payload = Buffer.from(text);
  for (let w = 0; w < 3; w++) { await once(upPort, payload); await once(relay.port, payload); }
  const direct = [], via = [], parse = [];
  for (let i = 0; i < N; i++) {
    direct.push((await once(upPort, payload)).ttfb);
    via.push((await once(relay.port, payload)).ttfb);
    const p0 = performance.now();
    parseMessagesRequest(payload.toString('utf8'), {});
    parse.push(performance.now() - p0);
  }
  const delta = via.map((v, i) => v - direct[i]);
  console.log(`\n== 请求体 ${(payload.length / 1e6).toFixed(2)}MB（约 ${Math.round(payload.length / 4 / 1000)}K tokens 量级）`);
  console.log('直连 TTFB ms  ', fmt(stat(direct)));
  console.log('经中继 TTFB ms', fmt(stat(via)));
  console.log('增加 ms       ', fmt(stat(delta)));
  console.log('解析 ms       ', fmt(stat(parse)));
}
const mem = process.memoryUsage();
console.log(`\nrss=${(mem.rss / 1e6).toFixed(0)}MB heapUsed=${(mem.heapUsed / 1e6).toFixed(0)}MB snapshots=${relay.store.snapshotBytes / 1e6}MB`);
await relay.close();
upstream.close();
agent.destroy();
fs.rmSync(stateDir, { recursive: true, force: true });
