// 会话对应的「任务」还在不在：用来判断这段空闲有没有人会回来（自动保活的 agent-closed / archived 门槛）。
// 两个来源叠加，都是可选的：
//   1. 进程探测（通用）：扫 /proc 里的 Claude Code 进程，先按命令行里的 --resume / --session-id 精确匹配会话 ID，
//      没带 ID 的再按工作区匹配。只有「以前见过它的进程、现在找不到了」才判 closed，从没见过的返回未知，不误伤
//      通过别的方式启动的客户端。非 Linux（没有 /proc）自动失效。
//   2. Paseo（可选）：~/.paseo/agents 下的任务状态与归档标记，有就优先用（它还知道 archived 和标题）。

import fs from 'node:fs';
import path from 'node:path';
import { lookupPaseoAgents, paseoAgentsDir } from './paseo.js';

const SCAN_CACHE_MS = 10000;
const LOOKUP_CACHE_MS = 30000;

// Claude Code 进程：argv[0] / argv[1] 的文件名是 claude，或者是 @anthropic-ai/claude-code 的 cli.js
export function isClaudeArgv(argv) {
  return argv.slice(0, 2).some(arg => {
    const base = path.basename(String(arg || ''));
    return base === 'claude' || base === 'claude.exe' || /claude-code[\\/]cli\.(m?js)$/.test(String(arg));
  });
}

// 命令行里带的会话 ID（--resume <id> / --resume=<id> / --session-id <id> / -r <id>）
export function sessionIdFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const m = arg.match(/^--?(resume|session-id|r)(?:=(.+))?$/);
    if (!m) continue;
    const value = m[2] ?? argv[i + 1];
    if (typeof value === 'string' && /^[\w.:-]{6,128}$/.test(value)) return value;
  }
  return null;
}

// 扫一遍 /proc（或测试给的假目录）：返回 [{ pid, argv, cwd, sessionId }]，只留 Claude Code 进程
export function scanClaudeProcesses(procDir = '/proc') {
  let names;
  try {
    names = fs.readdirSync(procDir);
  } catch {
    return null; // 没有 /proc：探测不可用
  }
  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let argv;
    try {
      argv = fs.readFileSync(path.join(procDir, name, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.length || !isClaudeArgv(argv)) continue;
    let cwd = null;
    try {
      cwd = fs.readlinkSync(path.join(procDir, name, 'cwd')).replace(/ \(deleted\)$/, '');
    } catch { /* 读不到 cwd（权限）就只按会话 ID 匹配 */ }
    out.push({ pid: Number(name), argv, cwd, sessionId: sessionIdFromArgv(argv) });
  }
  return out;
}

// agentLookup(session) → { status, archived, source, pid?, title? } | null
export function createAgentLookup({ cfg = {}, now = () => Date.now(), log = () => {}, procDir = '/proc', paseoDir = null } = {}) {
  const probe = cfg.agentProbe || {};
  const useProcess = probe.process !== false;
  const usePaseo = probe.paseo !== false;
  let scan = { at: 0, list: null };
  const cache = new Map();

  const processes = () => {
    if (!useProcess) return null;
    if (now() - scan.at > SCAN_CACHE_MS) {
      let list = null;
      try {
        list = scanClaudeProcesses(procDir);
      } catch (error) {
        log(`进程探测失败: ${error.message}`);
      }
      scan = { at: now(), list };
    }
    return scan.list;
  };

  const paseoAvailable = () => {
    if (!usePaseo) return false;
    try {
      return fs.statSync(paseoDir || paseoAgentsDir()).isDirectory();
    } catch {
      return false;
    }
  };

  function processStatus(session) {
    const list = processes();
    if (!list) return null; // 探测不可用
    const exact = list.find(proc => proc.sessionId && proc.sessionId === session.id);
    const byCwd = !exact && session.cwd ? list.find(proc => proc.cwd && (proc.cwd === session.cwdReal || proc.cwd === session.cwd)) : null;
    const alive = exact || byCwd;
    if (alive) {
      session.processSeenAt = now();
      session.processMatch = exact ? 'session-id' : 'cwd';
      return { status: 'idle', archived: false, source: 'process', pid: alive.pid, match: session.processMatch };
    }
    // 从没在进程表里见过它：可能是别的机器 / 容器 / 别的启动方式，不下结论
    if (!session.processSeenAt) return null;
    return { status: 'closed', archived: false, source: 'process', lastSeenAt: session.processSeenAt };
  }

  return function lookup(session) {
    if (!session) return null;
    const cached = cache.get(session.id);
    if (cached && now() - cached.at < LOOKUP_CACHE_MS) return cached.agent;
    let agent = null;
    if (paseoAvailable() && session.cwd) {
      try {
        const paseo = lookupPaseoAgents([session.cwd]).get(session.id) || null;
        if (paseo) agent = { ...paseo, source: 'paseo' };
      } catch { /* 读不到 Paseo 数据就当没有 */ }
    }
    if (!agent) agent = processStatus(session);
    cache.set(session.id, { at: now(), agent });
    return agent;
  };
}
