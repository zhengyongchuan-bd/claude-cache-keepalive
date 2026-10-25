import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentLookup, isClaudeArgv, scanClaudeProcesses, sessionIdFromArgv } from './agents.js';

const SID = '11111111-2222-3333-4444-555555555555';

// 假 /proc：<pid>/cmdline（NUL 分隔）+ <pid>/cwd（符号链接）
function fakeProc(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-proc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const add = (pid, argv, cwd) => {
    fs.mkdirSync(path.join(dir, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(dir, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
    if (cwd) fs.symlinkSync(cwd, path.join(dir, String(pid), 'cwd'));
  };
  const remove = pid => fs.rmSync(path.join(dir, String(pid)), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'self'));
  fs.writeFileSync(path.join(dir, 'uptime'), '1 1');
  return { dir, add, remove };
}

test('isClaudeArgv / sessionIdFromArgv：识别 claude 进程与命令行里的会话 ID', () => {
  assert.equal(isClaudeArgv(['/home/u/.local/node/bin/claude', '--output-format', 'stream-json']), true);
  assert.equal(isClaudeArgv(['node', '/x/node_modules/@anthropic-ai/claude-code/cli.js']), true);
  assert.equal(isClaudeArgv(['/usr/bin/zsh', '-c', 'source ~/.cache/paseo/claude-router/x.sh']), false, '路径里含 claude 的 shell 不算');
  assert.equal(isClaudeArgv(['node', 'relay.js']), false);
  assert.equal(sessionIdFromArgv(['claude', `--resume=${SID}`]), SID);
  assert.equal(sessionIdFromArgv(['claude', '--resume', SID, '--model', 'x']), SID);
  assert.equal(sessionIdFromArgv(['claude', '--session-id', SID]), SID);
  assert.equal(sessionIdFromArgv(['claude', '-r', SID]), SID);
  assert.equal(sessionIdFromArgv(['claude', '--resume']), null);
  assert.equal(sessionIdFromArgv(['claude', '--model', 'opus']), null);
});

test('scanClaudeProcesses：只留 claude 进程，带 cwd 与会话 ID；没有 /proc 返回 null', t => {
  const proc = fakeProc(t);
  proc.add(100, ['/opt/node/bin/claude', '--resume', SID], '/tmp/ws-a');
  proc.add(101, ['/usr/bin/zsh', '-c', 'claude something'], '/tmp/ws-a');
  proc.add(102, ['node', '/x/@anthropic-ai/claude-code/cli.js'], '/tmp/ws-b');
  const list = scanClaudeProcesses(proc.dir);
  assert.deepEqual(list.map(p => [p.pid, p.cwd, p.sessionId]).sort(), [[100, '/tmp/ws-a', SID], [102, '/tmp/ws-b', null]]);
  assert.equal(scanClaudeProcesses(path.join(proc.dir, 'nope')), null);
});

test('createAgentLookup：会话 ID 精确匹配 > 工作区匹配；没见过进程的会话返回未知；见过之后进程消失才判 closed；30s 缓存', t => {
  const proc = fakeProc(t);
  let t0 = 1_000_000;
  const now = () => t0;
  const lookup = createAgentLookup({ cfg: { agentProbe: { paseo: false } }, now, procDir: proc.dir });
  const byId = { id: SID, cwd: '/tmp/ws-a', cwdReal: '/tmp/ws-a' };
  const byCwd = { id: '22222222-3333-4444-5555-666666666666', cwd: '/tmp/ws-b', cwdReal: '/tmp/ws-b' };
  const unknown = { id: '33333333-4444-5555-6666-777777777777', cwd: '/tmp/ws-c', cwdReal: '/tmp/ws-c' };
  proc.add(100, ['claude', `--resume=${SID}`], '/tmp/ws-x');
  proc.add(102, ['claude'], '/tmp/ws-b');
  assert.deepEqual([lookup(byId).status, lookup(byId).match, lookup(byId).pid], ['idle', 'session-id', 100], '会话 ID 命中，cwd 不同也算');
  assert.deepEqual([lookup(byCwd).status, lookup(byCwd).match], ['idle', 'cwd']);
  assert.equal(lookup(unknown), null, '从没见过：未知，不误伤');
  assert.ok(byId.processSeenAt && byCwd.processSeenAt && !unknown.processSeenAt);
  // 进程退出：缓存期内仍是旧结果，过期后判 closed
  proc.remove(100);
  proc.remove(102);
  assert.equal(lookup(byId).status, 'idle', '30s 内走缓存');
  t0 += 31_000;
  assert.equal(lookup(byId).status, 'closed');
  assert.equal(lookup(byId).source, 'process');
  assert.equal(lookup(byCwd).status, 'closed');
  assert.equal(lookup(unknown), null, '仍然未知');
  // 进程回来（resume 同一会话）：又是 idle
  proc.add(200, ['claude', '--resume', SID], '/tmp/ws-a');
  t0 += 31_000;
  assert.equal(lookup(byId).status, 'idle');
});

test('createAgentLookup：有 Paseo 任务数据时优先用它（带 archived）；agentProbe.process=false 时只看 Paseo', t => {
  const proc = fakeProc(t);
  const paseoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-paseo-'));
  t.after(() => fs.rmSync(paseoDir, { recursive: true, force: true }));
  process.env.PASEO_AGENTS_DIR = paseoDir;
  t.after(() => { delete process.env.PASEO_AGENTS_DIR; });
  const agentDir = path.join(paseoDir, 'tmp-ws-a');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'ag1.json'), JSON.stringify({ id: 'ag1', title: 'task', cwd: '/tmp/ws-a', lastStatus: 'closed', archivedAt: '2026-10-21T00:00:00Z', persistence: { sessionId: SID } }));
  proc.add(100, ['claude', `--resume=${SID}`], '/tmp/ws-a');
  const session = { id: SID, cwd: '/tmp/ws-a', cwdReal: '/tmp/ws-a' };
  const lookup = createAgentLookup({ cfg: {}, now: () => 1, procDir: proc.dir, paseoDir });
  const agent = lookup(session);
  assert.equal(agent.source, 'paseo');
  assert.equal(agent.status, 'closed');
  assert.equal(agent.archived, true);
  assert.equal(agent.title, 'task');
  // 只看 Paseo，且会话不在 Paseo 里 → null
  const other = { id: '99999999-8888-7777-6666-555555555555', cwd: '/tmp/ws-z', cwdReal: '/tmp/ws-z' };
  const paseoOnly = createAgentLookup({ cfg: { agentProbe: { process: false } }, now: () => 1, procDir: proc.dir, paseoDir });
  assert.equal(paseoOnly(other), null);
  // 都关：永远 null
  const none = createAgentLookup({ cfg: { agentProbe: { process: false, paseo: false } }, now: () => 1, procDir: proc.dir, paseoDir });
  assert.equal(none(session), null);
});
