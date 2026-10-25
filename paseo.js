// 把 Claude 会话 ID 映射到 Paseo 任务（agent），用于在页面/终端显示任务标题。
// Paseo 把每个 agent 存在 ~/.paseo/agents/<cwd 去掉开头斜杠、/ 换成 ->/<agentId>.json。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fileCache = new Map();

export function paseoAgentsDir() {
  return process.env.PASEO_AGENTS_DIR || path.join(os.homedir(), '.paseo', 'agents');
}

export function encodeCwd(cwd) {
  return String(cwd).replace(/^\/+/, '').replace(/\//g, '-');
}

function readAgent(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.agent;
  let agent = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    agent = {
      agentId: raw.id,
      title: raw.title || null,
      cwd: raw.cwd || null,
      model: raw.config?.model || null,
      status: raw.lastStatus || null,
      archived: Boolean(raw.archivedAt),
      updatedAt: raw.updatedAt || null,
      sessionIds: [raw.persistence?.sessionId, raw.persistence?.nativeHandle, raw.runtimeInfo?.sessionId].filter(Boolean),
    };
  } catch {
    agent = null;
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, agent });
  return agent;
}

function agentsInDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
    .map(name => readAgent(path.join(dir, name)))
    .filter(Boolean);
}

// 返回 sessionId → agent；只扫描这些工作区对应的目录。
export function lookupPaseoAgents(cwds) {
  const root = paseoAgentsDir();
  const bySession = new Map();
  const dirs = new Set();
  for (const cwd of cwds) {
    if (!cwd) continue;
    dirs.add(path.join(root, encodeCwd(cwd)));
    try {
      dirs.add(path.join(root, encodeCwd(fs.realpathSync(cwd))));
    } catch { /* 工作区已删除 */ }
  }
  for (const dir of dirs) {
    for (const agent of agentsInDir(dir)) {
      for (const sessionId of agent.sessionIds) bySession.set(sessionId, agent);
    }
  }
  return bySession;
}

export function findPaseoAgent(agentId, cwdHint) {
  if (!agentId || !/^[\w-]+$/.test(agentId)) return null;
  const root = paseoAgentsDir();
  if (cwdHint) {
    const agent = readAgent(path.join(root, encodeCwd(cwdHint), `${agentId}.json`));
    if (agent) return agent;
  }
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(root, dir, `${agentId}.json`);
    if (fs.existsSync(file)) return readAgent(file);
  }
  return null;
}
