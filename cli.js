#!/usr/bin/env node
// 终端入口：查看「当前工作区」Claude 会话的缓存与保活状态；手动开启 / 停止保活，开关自动保活，看成本收益与回测。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AUTO_SKIP_LABELS, DEFAULT_CONFIG, EPISODE_OUTCOME_LABELS, OUTCOME_LABELS, RESUME_REASON_LABELS, SOURCE_LABELS } from './core.js';
import { parseQuiet, parseTokens } from './backtest.js';
import { defaultPaths, serve } from './relay.js';

const __filename = fileURLToPath(import.meta.url);
const SERVICE_NAME = 'cache-keepalive.service';
// 早期安装用的单元名：install 时迁移（停掉并删除），restart / uninstall 也认它
const LEGACY_SERVICE_NAME = 'zyc-cache-keepalive.service';
const DEFAULT_RELAY = 'http://127.0.0.1:18110';
const TOKEN_HEADER = 'x-cache-keepalive-token';

const HELP = `用法: cache-keepalive [命令] [选项]      在任务的工作区（或 Paseo 任务内）执行时，默认作用于「当前任务的会话」

日常只需要这几条:
  status (默认)         当前会话：缓存剩余、自动/长保活状态、上次心跳、能否保活
  list                  所有会话一览：TTL / 前缀 / 缓存剩余 / 计划 / 自动保活（--active 只看有计划的，--warm 只看缓存有效的）
  pin [--for 12h]       当前会话长保活（默认 12h，最长 48h）：每段空闲都心跳到到期，人在工作时不发；按时长不按次数
  pin --forever         长期保活：没有到期时刻，直到 unpin / stop；未命中、任务进程退出等护栏照常
  unpin                 取消当前会话的长保活
  pin --global [...]    所有缓存仍有效的 1h 主对话一起长保活（--ttl 5m|any；--all-sessions 连已过期的也设，等它们下次请求后接上）
  unpin --global        取消所有会话的长保活
  stop                  停掉当前会话的一切保活：计划、长保活，并关闭它的自动保活（auto on 恢复）
  off / on              总开关：off 停掉所有会话的所有保活（自动/手动/长保活）且不能再开；on 打开

自动保活（默认开：1h 主对话空闲 50m 自动心跳，每段最多 3 次）:
  auto                  全局设置 + 当前会话的判定结果
  auto on | off         打开 / 关闭当前会话的自动保活（--global 作用于全局开关）
  auto set ...          --count N --min-context 100k --min-turns N --quiet 1-8|off --cooldown 2h --skip-closed on|off --clear-cooldown
  auto reset [--global] 清除会话级「已关闭」标记（--clear-blocked 同时解除未命中锁定）
  auto status --global  各会话自动保活状态汇总

手动计划（固定次数，一般用 pin 代替）:
  start [N|--for 2h]    当前会话手动保活 N 次（1h 缓存默认 6 次 × 50m）；--for 按保护时长算次数
  start --global [...]  所有缓存仍有效的 1h 主对话一起开（--ttl 5m|any 放宽；--for 2h）
  stop --global         停掉所有会话的计划与长保活，并关闭它们的自动保活（新会话仍按全局开关）
  ping [--force]        立即补一次心跳（--force 越过前缀太小 / 上次未命中锁定）

看数据:
  episodes              执行记录：每段保活发了几次、每次命中没有、花费、最后保住没有（--days N --session ID）
  stats                 成本 / 收益汇总（--days N；自动 / 手动 / 长保活分开）
  events                最近事件：心跳、回来、冷启动、计划、自动、长保活、总开关
  sessions              最近经过中继的全部会话（--hours N）
  backtest              用本机会话记录回测自动保活（--grid 参数对比，--session ID 明细）
  web                   打印页面地址

运维:
  install / uninstall   安装（systemd --user 服务 + ~/.local/bin/cache-keepalive）/ 卸载
  restart [--wait 5m]   等中继空闲后重启服务（部署新代码）
  serve                 前台运行中继

常用选项:
  --session ID          指定会话（≥6 位前缀）    --cwd DIR      指定工作区（默认当前目录）
  --agent ID            指定 Paseo 任务（ID ≥6 位前缀；list / status 会显示；等价于在该任务里执行）
  --all                 作用于工作区全部会话      --global       全局范围
  --for 12h / 2h        时长（pin / start）       --interval 50m 心跳间隔（1h: 5m–55m；5m: 1m–4m30s）
  --count N | --max     手动计划次数              --force        越过软护栏
  --reason TEXT         写进事件的原因            --json         输出 JSON
  --relay URL           中继地址（默认 $CACHE_KEEPALIVE_URL 或 ${DEFAULT_RELAY}）
  --token TOKEN         写操作口令（默认读 $CACHE_KEEPALIVE_TOKEN 或 ~/.local/state/cache-keepalive/control.token）

例子:
  cache-keepalive                      # 看当前任务
  cache-keepalive pin                  # 当前任务长保活 12 小时
  cache-keepalive pin --for 24h --session 3d7c
  cache-keepalive pin --agent 15c60532          # 按 Paseo 任务 ID 指定；status / stop / unpin / auto / episodes 同样可用 --agent
  cache-keepalive pin --global                  # 所有正在跑的 1h 会话长保活 12 小时
  cache-keepalive pin --forever                 # 当前会话长期保活，直到 unpin
  cache-keepalive stop                 # 当前任务全停
  cache-keepalive off --reason 下班     # 全部停、不再发；明天 cache-keepalive on
  cache-keepalive list --active        # 谁在保活
  cache-keepalive episodes             # 保活记录
`;
function parseArgs(argv) {
  const opts = { command: null, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      const v = argv[++index];
      if (v === undefined) throw new Error(`${value} 需要参数`);
      return v;
    };
    if (value === '--session' || value === '-s') opts.session = next();
    else if (value === '--cwd') opts.cwd = path.resolve(next());
    else if (value === '--agent' || value === '--paseo' || value === '--task') opts.agent = next();
    else if (value === '--all') opts.all = true;
    else if (value === '--all-sessions') opts.allSessions = true;
    else if (value === '--forever' || value === '--always') opts.forever = true;
    else if (value === '--count' || value === '-n') opts.count = next();
    else if (value === '--max') opts.count = 'max';
    else if (value === '--interval' || value === '-i') opts.interval = next();
    else if (value === '--force' || value === '-f') opts.force = true;
    else if (value === '--days') opts.days = next();
    else if (value === '--global') opts.global = true;
    else if (value === '--ttl') opts.ttl = next();
    else if (value === '--for' || value === '--duration') opts.for = next();
    else if (value === '--hours') opts.hours = next();
    else if (value === '--active') opts.active = true;
    else if (value === '--warm') opts.warm = true;
    else if (value === '--limit') opts.limit = next();
    else if (value === '--reason') opts.reason = next();
    else if (value === '--wait') opts.wait = next();
    else if (value === '--clear-blocked') opts.clearBlocked = true;
    else if (value === '--min-context') opts.minContext = next();
    else if (value === '--min-turns') opts.minTurns = next();
    else if (value === '--quiet') opts.quiet = next();
    else if (value === '--cooldown') opts.cooldown = next();
    else if (value === '--clear-cooldown') opts.clearCooldown = true;
    else if (value === '--skip-closed') opts.skipClosed = next();
    else if (value === '--token') opts.token = next();
    else if (value === '--grid') opts.grid = true;
    else if (value === '--relay') opts.relay = next();
    else if (value === '--json') opts.json = true;
    else if (value === '--help' || value === '-h') opts.help = true;
    else if (value.startsWith('-')) throw new Error(`未知选项: ${value}`);
    else if (!opts.command) opts.command = value;
    else opts.positional.push(value);
  }
  return opts;
}

function relayBase(opts) {
  return (opts.relay || process.env.CACHE_KEEPALIVE_URL || DEFAULT_RELAY).replace(/\/+$/, '');
}

// 写操作的口令：--token > $CACHE_KEEPALIVE_TOKEN > 中继状态目录里的 control.token（和中继同一用户时自动读到）
let cachedToken;
function controlToken(opts) {
  if (opts.token) return opts.token;
  if (process.env.CACHE_KEEPALIVE_TOKEN) return process.env.CACHE_KEEPALIVE_TOKEN;
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = fs.readFileSync(path.join(defaultPaths().stateDir, 'control.token'), 'utf8').trim() || null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

function api(opts, method, route, body, timeoutMs = 15000) {
  const url = new URL(`${relayBase(opts)}/keepalive/api/${route}`);
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  const token = payload ? controlToken(opts) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      timeout: timeoutMs,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length, ...(token ? { [TOKEN_HEADER]: token } : {}) } : {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const value = JSON.parse(text);
          if (res.statusCode === 401 && value.ok === false) reject(new Error(`${value.error}\n  本机用 --token 或 CACHE_KEEPALIVE_TOKEN 提供口令；远端中继请把它的 control.token 内容带过来`));
          else if (res.statusCode >= 400 && value.ok === false) reject(new Error(value.error || `HTTP ${res.statusCode}`));
          else resolve(value);
        } catch {
          reject(new Error(`中继返回非 JSON（HTTP ${res.statusCode}）: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求中继超时')));
    req.on('error', error => {
      if (error.code === 'ECONNREFUSED') reject(new Error(`连不上保活中继 ${relayBase(opts)}，先运行 cache-keepalive install 或 cache-keepalive serve`));
      else reject(error);
    });
    req.end(payload);
  });
}

// 「当前任务」：显式 --session > 显式 --agent（Paseo 任务 ID）> Paseo 任务内运行（PASEO_AGENT_ID）> 当前目录
function target(opts) {
  if (opts.session) return { session: opts.session };
  if (opts.agent) return { agent: String(opts.agent).trim(), ...(opts.cwd ? { agentCwd: opts.cwd } : {}) };
  const out = { cwd: opts.cwd || process.cwd() };
  if (!opts.cwd && process.env.PASEO_AGENT_ID) {
    out.agent = process.env.PASEO_AGENT_ID;
    out.agentCwd = process.env.PASEO_AGENT_CWD;
  }
  return out;
}

// ------------------------------------------------------------------ 格式化

const fmtTokens = n => {
  if (n == null) return '-';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};
function fmtUsd(n) {
  if (n == null) return '-';
  const abs = Math.abs(n);
  // 便宜模型的单次心跳不到一美分，保留到 4 位小数
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 || abs === 0 ? 3 : 4;
  return `${n < 0 ? '-' : ''}$${abs.toFixed(digits)}`;
}
const fmtTime = at => (at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '-');
function fmtDuration(sec) {
  if (sec == null) return '-';
  const s = Math.abs(Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${m ? `${m}m` : ''}`;
  if (m) return `${m}m`;
  return `${s}s`;
}
// 计划间隔要精确到秒（5m 缓存的间隔上限是 4m30s）
const fmtInterval = sec => (sec >= 60 && sec < 3600 && sec % 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : fmtDuration(sec));
const ago = (at, now) => (at ? `${fmtDuration((now - at) / 1000)}前` : '-');
const short = id => String(id || '').slice(0, 8);

const PLAN_STATUS = {
  active: '进行中',
  completed: '已完成',
  stopped: '已停止',
  cancelled: '已取消',
  expired: '已过期',
  replaced: '已替换',
};
const PLAN_STATE = {
  scheduled: '等待下一次',
  busy: '会话请求进行中，暂缓',
  'waiting-snapshot': '等待会话再发一次请求（中继无快照）',
  'waiting-after-compact': '会话刚压缩，等压缩后的下一次请求',
  'waiting-auth': '中继重启后等任一请求经过以取得凭证',
  'daily-budget': '今日额度已满，暂停',
  pinging: '正在发送',
  retrying: '心跳失败，退避重试',
};
const fmtDateTime = at => (at ? new Date(at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');

// 自动保活对这个会话现在是什么状态、为什么（判定来自中继，CLI 不另算）
function autoLine(view) {
  const a = view.auto;
  if (!a) return null;
  const turns = `人工接入 ${a.humanTurns} 轮`;
  switch (a.state) {
    case 'off':
      return a.code === 'keepalive-off' ? '保活已全局关闭（cache-keepalive on 打开）' : '自动保活：全局已关闭（cache-keepalive auto on --global 打开）';
    case 'stopped':
      return `自动保活：已对该会话关闭（${fmtDateTime(a.disabled?.at)} ${a.disabled?.reason || '手动 stop'}）；恢复：cache-keepalive auto on`;
    case 'active':
      return `自动保活：进行中（${a.trigger === 'tool-gap' ? '工具执行中的空闲' : '空闲'}）· ${turns}`;
    case 'armed':
      return `自动保活：已就绪，${fmtTime(a.dueAt)} 还没有新请求就自动发第一次心跳 · ${turns}`;
    case 'ineligible':
      return `自动保活：现在不会自动发 — ${a.message || AUTO_SKIP_LABELS[a.code] || a.code} · ${turns}`;
    case 'skipped':
      return `自动保活：本段空闲没有保活 — ${a.message || AUTO_SKIP_LABELS[a.code] || a.code}`;
    case 'done':
      return '自动保活：本段空闲已保活过，下一段空闲重新判定';
    case 'manual':
      return '自动保活：有手动计划进行中，手动优先';
    case 'pinned':
      return `自动保活：由长保活接管（${a.untilAt == null ? '长期' : `到 ${fmtDateTime(a.untilAt)}`}）`;
    default:
      return `自动保活：等待会话的主对话请求 · ${turns}`;
  }
}

const planStateText = plan => (plan.state === 'retrying'
  ? `心跳失败 ${plan.errorStreak} 次，退避重试，最后：${plan.lastError}`
  : PLAN_STATE[plan.state] || plan.state);

function printSession(view, now) {
  const p = view.primary;
  const title = view.paseo ? `（Paseo: ${(view.paseo.title || '无标题').slice(0, 40)}${(view.paseo.title || '').length > 40 ? '…' : ''} · 任务 ID ${short(view.paseo.agentId)}）` : '';
  console.log(`● 会话 ${short(view.id)}${title}`);
  console.log(`  工作区 ${view.cwd || '-'}`);
  if (!p) {
    console.log('  还没有成功的请求记录');
    return;
  }
  const state = view.busy ? '请求进行中' : p.warm ? `缓存剩余 ${fmtDuration(p.remainingSec)}（${fmtTime(p.expiresAt)} 过期）` : `缓存已过期（${fmtTime(p.expiresAt)}）`;
  console.log(`  模型 ${p.model} · TTL ${p.ttl || '无缓存'} · 缓存前缀 ${fmtTokens(p.contextTokens)} tokens${view.agent ? ` · 进程${view.agent.status === 'closed' ? '已退出' : '在'}（${view.agent.source === 'paseo' ? 'Paseo' : view.agent.match === 'session-id' ? '按会话 ID 匹配' : '按工作区匹配'}）` : ''}`);
  console.log(`  最近触达 ${fmtTime(p.lastTouchAt)}（${ago(p.lastTouchAt, now)}）→ ${state}`);
  if (p.lastPing) {
    const u = p.lastPing.usage;
    console.log(`  上次心跳 ${fmtTime(p.lastPing.at)} ${OUTCOME_LABELS[p.lastPing.outcome] || p.lastPing.outcome} read=${fmtTokens(u?.cacheRead)} write=${fmtTokens(u?.cacheWrite)} ${fmtUsd(p.lastPing.costUsd)}`);
  }
  if (p.blocked) console.log(`  ⚠ 已锁定：上次心跳未命中缓存（${p.blocked.detail}），该会话全部保活已停止；人工确认后 cache-keepalive auto on 恢复（或 ping --force 试一次）`);
  if (p.ttlDowngraded) console.log('  ⚠ 请求标了 1h，上游实际按 5m 写入缓存：1h 间隔的心跳不会命中');
  if (p.pingAnomaly) console.log(`  ⚠ 上次心跳产生了 ${p.pingAnomaly.output} 个输出 token（上游没遵守 max_tokens），已停发`);
  if (view.pin) console.log(`  长保活：${view.pin.untilAt == null ? '长期（直到取消）' : `到 ${fmtDateTime(view.pin.untilAt)}（剩 ${fmtDuration(view.pin.remainingSec)}`}，每 ${fmtInterval(view.pin.intervalSec)} 一次，只在空闲时发${view.pin.untilAt == null ? '' : '）'}${view.pin.active ? ' · 本段空闲心跳中' : ''}；取消：cache-keepalive unpin`);
  const line = autoLine(view);
  if (line) console.log(`  ${line}`);
  if (view.auto?.cooldownUntil) console.log(`  ⚠ 有自动心跳没命中，自动保活全局暂停到 ${fmtTime(view.auto.cooldownUntil)}（cache-keepalive auto set --clear-cooldown 解除）`);
  const plan = view.plan;
  if (plan) {
    const head = `  ${SOURCE_LABELS[plan.source] || '手动'}计划 ${PLAN_STATUS[plan.status] || plan.status} ${plan.done}/${plan.count ?? '∞'} 次 · 间隔 ${fmtInterval(plan.intervalSec)} · 心跳花费 ${fmtUsd(plan.costUsd)}`;
    if (plan.status === 'active') console.log(`${head} · 下一次 ${fmtTime(plan.nextPingAt)}（${planStateText(plan)}）${plan.saveUsd != null ? ` · 保住后回来可省约 ${fmtUsd(plan.saveUsd)}` : ''}`);
    else console.log(`${head}${plan.reason ? ` · ${plan.reason}` : ''}`);
  }
  if (view.check && plan?.status !== 'active') {
    if (view.check.ok && view.economics) {
      const e = view.economics;
      console.log(`  手动保活：默认 ${view.check.count} 次 × ${fmtInterval(view.check.intervalSec)}，覆盖到 ${fmtTime(e.coveredUntil)}；每次心跳约 ${fmtUsd(e.pingUsd)}，保住后回来约省 ${fmtUsd(e.saveUsd)}（≈${e.breakEvenPings ?? '-'} 次心跳回本）`);
    } else if (!view.check.ok) {
      for (const error of view.check.errors) console.log(`  ✗ ${error.message}${error.soft ? '（可 --force）' : ''}`);
    }
  }
}

function printPlanResults(result) {
  for (const item of result.results || []) {
    if (item.ok) {
      const e = item.economics;
      console.log(`✓ 会话 ${short(item.sessionId)} 已开启保活：${item.plan.count} 次 × ${fmtInterval(item.plan.intervalSec)}，首次心跳 ${fmtTime(item.plan.nextPingAt)}，覆盖到 ${fmtTime(e?.coveredUntil)}`);
      if (e) console.log(`  缓存前缀 ${fmtTokens(e.contextTokens)} tokens；每次心跳约 ${fmtUsd(e.pingUsd)}（最多 ${fmtUsd(e.maxPingsUsd)}），保住后回来约省 ${fmtUsd(e.saveUsd)}`);
    } else {
      console.log(`✗ 会话 ${short(item.sessionId)} 无法保活：`);
      for (const error of item.errors) console.log(`  - ${error.message}${error.soft ? '（可加 --force 越过）' : ''}`);
    }
    for (const warning of item.warnings || []) console.log(`  ! ${warning}`);
  }
  if (result.alternatives?.length) {
    console.log('该工作区还有其他会话（用 --session 指定，或 --all 全部开启）：');
    for (const alt of result.alternatives) console.log(`  ${short(alt.id)}  ${alt.paseo?.title?.slice(0, 40) || ''}  ${alt.primary ? `${fmtTokens(alt.primary.contextTokens)} tokens` : ''}`);
  }
}

// 全局列表/概览用：一行说清计划与自动保活
const PLAN_ERROR_LABELS = {
  expired: '缓存已过期',
  'no-snapshot': '没有请求快照',
  'no-session': '没有会话请求',
  'no-cache-control': '没有缓存断点',
  'not-cacheable': '没有读写缓存',
  'small-context': '前缀太小',
  blocked: '上次心跳未命中已锁定',
  'ttl-downgraded': '上游按 5m 写入',
  'ping-anomaly': '心跳有输出',
  'thinking-enabled': 'thinking.enabled 无法零输出',
  'daily-budget': '今日额度已满',
  'bad-count': '次数不合法',
  'bad-interval': '间隔不合法',
};
const planErrorLabel = code => PLAN_ERROR_LABELS[code] || code;
const pinUntilText = pin => (pin?.untilAt == null ? '长期' : `到 ${fmtDateTime(pin.untilAt)}`);
const pinBoundText = e => (e.maxPings == null ? `整天空闲约 ${e.perDayPings} 次 ${fmtUsd(e.perDayUsd)}/天` : `整段空闲最多 ${e.maxPings} 次 ${fmtUsd(e.maxUsd)}`);

const PLAN_STATE_SHORT = {
  busy: '请求中',
  'waiting-snapshot': '等请求',
  'waiting-after-compact': '等压缩后',
  'waiting-auth': '等凭证',
  'daily-budget': '额度满',
  pinging: '发送中',
  retrying: '重试中',
};

function planShort(plan) {
  if (!plan) return '没有计划';
  const head = `${SOURCE_LABELS[plan.source] || '手动'} ${plan.done}/${plan.count ?? '∞'}`;
  if (plan.status === 'active') {
    const note = PLAN_STATE_SHORT[plan.state] ? `（${PLAN_STATE_SHORT[plan.state]}）` : '';
    return `${head}${note} · 下次 ${fmtTime(plan.nextPingAt)}`;
  }
  return `${head} · ${PLAN_STATUS[plan.status] || plan.status}`;
}

function autoShort(auto) {
  if (!auto) return '-';
  switch (auto.state) {
    case 'off': return auto.code === 'keepalive-off' ? '保活总开关已关' : auto.disabled ? '全局已关 · 本会话已关' : '全局已关';
    case 'stopped': return '本会话已关';
    case 'active': return auto.trigger === 'tool-gap' ? '自动中（工具空闲）' : '自动中';
    case 'armed': return `就绪 ${fmtTime(auto.dueAt)}`;
    case 'ineligible': return `不会自动：${AUTO_SKIP_LABELS[auto.code] || auto.code}`;
    case 'skipped': return `本段跳过：${AUTO_SKIP_LABELS[auto.code] || auto.code}`;
    case 'done': return '本段已保活';
    case 'manual': return '手动计划优先';
    case 'pinned': return auto.untilAt == null ? '长期保活中' : `长保活到 ${fmtTime(auto.untilAt)}`;
    default: return '等待主对话请求';
  }
}

const out = value => console.log(JSON.stringify(value, null, 2));

const clip = (text, max) => {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
};
// 路径保留尾部（项目目录比前缀更有辨识度）
const clipPath = (value, max) => {
  const text = String(value || '');
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
};

const autoStopped = view => Boolean(view.auto?.disabled) || view.auto?.state === 'stopped';

function printSessionList(views, { hours, health, filters, stats }) {
  const total = stats?.total ?? views.length;
  const warm = stats?.warm ?? views.filter(view => view.primary?.warm).length;
  const active = stats?.active ?? views.filter(view => view.plan?.status === 'active').length;
  const autoActive = stats?.autoActive ?? views.filter(view => view.plan?.status === 'active' && view.plan.source === 'auto').length;
  const stopped = stats?.stopped ?? views.filter(autoStopped).length;
  const windowText = hours >= 24 && hours % 24 === 0 ? `近 ${hours / 24} 天` : `近 ${hours} 小时`;
  const shown = views.length < total ? `（显示 ${views.length} 个）` : '';
  console.log(`${windowText}的 ${total} 个会话${shown}：缓存有效 ${warm}，进行中计划 ${active}${autoActive ? `（自动 ${autoActive}）` : ''}，已关闭自动 ${stopped}`);
  if (health) {
    const auto = health.auto || {};
    const budget = health.budget || {};
    if (health.enabled === false) console.log('⚠ 保活已全局关闭：不发任何心跳，也不能新开；cache-keepalive on 打开');
    console.log(`中继 ${health.listen} → ${health.upstream} · 自动保活 ${auto.mode === 'on' ? '开' : '关'}${auto.cooldownUntil ? `（暂停到 ${fmtTime(auto.cooldownUntil)}）` : ''} · 今日心跳 ${budget.pings ?? '-'}/${budget.maxPings ?? '-'} ${fmtUsd(budget.usd ?? 0)}/${fmtUsd(budget.maxUsd ?? 0)}`);
  }
  if (filters) console.log(`筛选：${filters}`);
  console.log('');
  for (const view of views) {
    const p = view.primary;
    const cache = view.busy ? '请求进行中' : p?.warm ? `剩 ${fmtDuration(p.remainingSec)}` : p ? '已过期' : '无缓存';
    console.log(`${short(view.id)}  ${(p?.ttl || '-').padEnd(3)}  ${fmtTokens(p?.contextTokens).padStart(7)}  ${cache.padEnd(8)}  ${clip(planShort(view.plan), 30)}  ${clip(autoShort(view.auto), 28)}`);
    const title = view.paseo ? `  (Paseo ${short(view.paseo.agentId)} ${clip(view.paseo.title || '', 32)})` : '';
    console.log(`  ${clipPath(view.cwd || '-', 72)}${title}`);
  }
}

function printGlobalPlanResults(result) {
  const s = result.summary || {};
  const reasons = Object.entries(result.skippedBy || {}).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${planErrorLabel(code)} ${count}`).join('，');
  console.log(`${s.started || s.already ? '✓' : '○'} 全局保活（${result.ttl === 'any' ? '所有 TTL' : result.ttl}）：开始 ${s.started || 0} 个，已有计划 ${s.already || 0} 个，跳过 ${s.skipped || 0} 个${reasons ? `（${reasons}）` : ''}${s.restored ? `，恢复自动保活标记 ${s.restored} 个` : ''}`);
  if (s.filtered) console.log(`  另有 ${s.filtered} 个会话不在范围（不是主对话 / TTL 不匹配 / 没有缓存）`);
  if (s.restored && result.autoMode === 'off') console.log('  ! 全局自动保活仍是关闭状态：cache-keepalive auto on --global 打开（手动计划不受影响）');
  const startedItems = (result.results || []).filter(item => item.ok && !item.already);
  for (const item of startedItems.slice(0, 12)) {
    const e = item.economics;
    console.log(`  ✓ ${short(item.sessionId)} ${item.plan.count} 次 × ${fmtInterval(item.plan.intervalSec)}，首次心跳 ${fmtTime(item.plan.nextPingAt)}${e ? `，前缀 ${fmtTokens(e.contextTokens)} tokens` : ''}`);
    for (const warning of item.warnings || []) console.log(`    ! ${warning}`);
  }
  if (startedItems.length > 12) console.log(`  …另有 ${startedItems.length - 12} 个已开始，用 --json 查看`);
  const alreadyItems = (result.results || []).filter(item => item.already);
  for (const item of alreadyItems.slice(0, 12)) {
    console.log(`  · ${short(item.sessionId)} 已有计划（${planShort(item.plan)}），未改动`);
  }
  if (alreadyItems.length > 12) console.log(`  …另有 ${alreadyItems.length - 12} 个已有计划，用 --json 查看`);
  const failed = (result.results || []).filter(item => !item.ok);
  for (const item of failed.slice(0, 10)) console.log(`  ✗ ${short(item.sessionId)} ${(item.errors || []).map(error => error.message).join('；')}`);
  if (failed.length > 10) console.log(`  …另有 ${failed.length - 10} 个未开始，用 --json 查看全部原因`);
  if (!result.ok) console.log('  没有可开始的会话：缓存已过期需等会话再发一次请求；前缀小或上次心跳未命中的会话可加 --force。');
}

// 保活执行记录：一段 = 一个计划；每段一行 + 逐次心跳
const PING_MARK = { hit: '✓', miss: '✗', rewrite: '✗', partial: '◐', timeout: '⏱', unknown: '?', error: '!' };
function printEpisodes(result) {
  const t = result.totals;
  const by = Object.entries(t.byOutcome || {}).sort((a, b) => b[1] - a[1]).map(([code, n]) => `${EPISODE_OUTCOME_LABELS[code] || code} ${n}`).join('，');
  console.log(`近 ${result.days} 天保活执行记录：${t.episodes} 段（自动 ${t.auto}、手动 ${t.manual}${t.pin ? `、长保活 ${t.pin}` : ''}），心跳 ${t.pings} 次 ${fmtUsd(t.pingCostUsd)}${t.pingCostEstimatedUsd ? `（含预估 ${fmtUsd(t.pingCostEstimatedUsd)}）` : ''}，收益 ${fmtUsd(t.benefitUsd)}，净 ${fmtUsd(t.netUsd)}`);
  if (by) console.log(`  结局：${by}`);
  if (!result.episodes.length) {
    console.log('  没有记录');
    return;
  }
  console.log('');
  for (const e of result.episodes) {
    const title = e.paseo?.title ? `（${clip(e.paseo.title, 30)}）` : '';
    const marks = e.pings.map(p => PING_MARK[p.outcome] || '·').join('') || '-';
    const outcome = EPISODE_OUTCOME_LABELS[e.outcome] || e.outcome;
    const resume = e.resume ? ` · 回来 ${fmtTime(e.resume.at)}（空闲 ${fmtDuration(e.resume.gapSec)}）` : '';
    const expect = e.expectedSaveUsd != null ? `  回来可省约 ${fmtUsd(e.expectedSaveUsd)}` : '';
    console.log(`${fmtDateTime(e.startedAt)}  ${SOURCE_LABELS[e.source] || '手动'}${e.trigger === 'tool-gap' ? '(工具空闲)' : ''} ${short(e.sessionId)}${title}  心跳 ${e.pings.length}/${e.count ?? (e.source === 'pin' ? '∞' : '?')} ${marks}  花费 ${fmtUsd(e.pingCostUsd)}${expect}  实际收益 ${fmtUsd(e.benefitUsd)}  净 ${fmtUsd(e.netUsd)}`);
    console.log(`  ${e.active ? '进行中' : outcome}${resume}${e.end?.reason && !e.active ? ` · ${e.end.reason}` : ''}`);
    for (const p of e.pings) {
      const usage = p.cacheRead != null ? `read=${fmtTokens(p.cacheRead)} write=${fmtTokens(p.cacheWrite)} out=${p.output ?? 0}` : (p.error || '-');
      console.log(`    ${fmtTime(p.at)} ${PING_MARK[p.outcome] || '·'} ${OUTCOME_LABELS[p.outcome] || p.outcome} ${usage} ${fmtDuration((p.ms || 0) / 1000)} ${fmtUsd(p.costUsd)}${p.estimated ? '(估)' : ''}`);
    }
  }
}

function printStats(summary) {
  const t = summary.totals;
  console.log(`近 ${summary.days} 天缓存保活收益`);
  const timeouts = t.pingTimeouts ? `、超时/用量未知 ${t.pingTimeouts}` : '';
  const estimated = t.pingCostEstimatedUsd ? `（含预估 ${fmtUsd(t.pingCostEstimatedUsd)}：超时的心跳上游多半已处理并计费）` : '';
  console.log(`  心跳 ${t.pings} 次（命中 ${t.pingHits}、未命中 ${t.pingMisses}、失败 ${t.pingFailures}${timeouts}），心跳成本 ${fmtUsd(t.pingCostUsd)}${estimated}`);
  console.log(`  保活生效 ${t.keptResumes} 次：回来时少写 ${fmtTokens(t.savedTokens)} tokens，收益 ${fmtUsd(t.benefitUsd)}`);
  console.log(`  净收益 ${fmtUsd(t.netUsd)} · ROI ${t.roi == null ? '-' : `${t.roi.toFixed(1)}×`}`);
  if (t.wastedResumes) console.log(`  没起作用的保活 ${t.wastedResumes} 次（TTL 内就回来 / 心跳停后过期 / 前缀变化），对应心跳 ${fmtUsd(t.wastedPingCostUsd)}`);
  if (t.pendingSessions) console.log(`  进行中：${t.pendingSessions} 个会话的缓存正被保住，按时回来可省约 ${fmtUsd(t.pendingPotentialUsd)}`);
  if (t.expiredUnusedSessions) console.log(`  ${t.expiredUnusedSessions} 个会话保活结束后没回来，缓存已过期`);
  const a = t.bySource?.auto;
  const m = t.bySource?.manual;
  if (a && (a.pings || t.autoStarted)) {
    console.log(`  自动保活：开启 ${t.autoStarted} 段空闲，心跳 ${a.pings} 次 ${fmtUsd(a.pingCostUsd)}，救回 ${a.keptResumes} 次 ${fmtUsd(a.benefitUsd)}，没起作用 ${a.wastedResumes} 次`);
  }
  if (m?.pings) console.log(`  手动保活：心跳 ${m.pings} 次 ${fmtUsd(m.pingCostUsd)}，救回 ${m.keptResumes} 次 ${fmtUsd(m.benefitUsd)}，没起作用 ${m.wastedResumes} 次`);
  const pn = t.bySource?.pin;
  if (pn?.pings) console.log(`  长保活：心跳 ${pn.pings} 次 ${fmtUsd(pn.pingCostUsd)}，救回 ${pn.keptResumes} 次 ${fmtUsd(pn.benefitUsd)}，没起作用 ${pn.wastedResumes} 次`);
  console.log(`  未保活的冷启动重写 ${t.coldStarts} 次 ${fmtUsd(t.coldRewriteUsd)}：按当前自动策略能救回 ${fmtUsd(t.coldPotentialAutoUsd ?? 0)}，手动用满次数上限能救回 ${fmtUsd(t.coldPotentialUsd)}`);
  const why = Object.entries(t.coldByAuto || {}).filter(([code]) => code !== 'undecided').sort((x, y) => y[1].rewriteUsd - x[1].rewriteUsd);
  if (why.length) console.log(`    自动保活没覆盖的原因：${why.map(([code, v]) => `${code === 'started' ? '保活了但没保住' : AUTO_SKIP_LABELS[code] || code} ${v.count} 次 ${fmtUsd(v.rewriteUsd)}`).join('；')}`);
  const skipped = Object.entries(t.autoSkipped || {}).sort((x, y) => y[1] - x[1]);
  if (skipped.length) console.log(`  自动保活没开的空闲：${skipped.map(([code, n]) => `${AUTO_SKIP_LABELS[code] || code} ${n}`).join('，')}`);
  const b = summary.budget;
  console.log(`  今日额度：${b.pings}/${b.maxPings} 次，${fmtUsd(b.usd)}/${fmtUsd(b.maxUsd)}`);
  if (summary.sessions.length) {
    console.log('\n按会话：');
    for (const row of summary.sessions.slice(0, 15)) {
      console.log(`  ${short(row.sessionId)}  心跳 ${row.pings} 次 ${fmtUsd(row.pingCostUsd)} · 生效 ${row.keptResumes} 次 ${fmtUsd(row.benefitUsd)} · 冷启动 ${row.coldStarts} 次  ${row.cwd || ''}`);
    }
  }
}

// ------------------------------------------------------------------ 安装

function serviceUnit() {
  const relay = path.join(path.dirname(__filename), 'relay.js');
  return `[Unit]
Description=prompt cache keepalive relay (Claude Code -> upstream gateway)
After=network.target

[Service]
Type=simple
Environment=HOME=%h
ExecStart=${process.execPath} ${relay}
Restart=always
RestartSec=1
# 退出时拒绝新请求、等已在途的流式响应结束（最多 120s），再等在途心跳记账（最多 60s）
TimeoutStopSec=200

[Install]
WantedBy=default.target
`;
}

async function install(opts) {
  if (process.platform !== 'linux') throw new Error('install 目前只支持 Linux systemd --user；其他平台请用 cache-keepalive serve');
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, SERVICE_NAME);
  // 旧单元名迁移：先停掉旧服务并删掉单元文件，端口才能让给新服务
  const legacyPath = path.join(unitDir, LEGACY_SERVICE_NAME);
  if (fs.existsSync(legacyPath)) {
    console.log(`发现旧服务 ${LEGACY_SERVICE_NAME}，迁移为 ${SERVICE_NAME}`);
    await waitIdle(opts);
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', LEGACY_SERVICE_NAME], { stdio: 'inherit' });
    } catch { /* 可能已停止 */ }
    fs.rmSync(legacyPath, { force: true });
  }
  fs.writeFileSync(unitPath, serviceUnit());
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'inherit' });
  await restart(opts);
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const link = path.join(binDir, 'cache-keepalive');
  fs.mkdirSync(binDir, { recursive: true });
  try {
    const current = fs.readlinkSync(link);
    if (current !== __filename) throw new Error(`${link} 已指向 ${current}，未覆盖`);
  } catch (error) {
    if (error.code === 'ENOENT') fs.symlinkSync(__filename, link);
    else if (error.code === 'EINVAL') throw new Error(`${link} 已存在且不是链接，未覆盖`);
    else throw error;
  }
  fs.chmodSync(__filename, 0o755);
  console.log(`已安装 ${unitPath}，并链接 ${link}`);
  console.log(`页面：${relayBase(opts)}/keepalive/`);
}

// 中继一次只等「退出前已在途」的请求；挑没有在途请求的时刻重启，忙碌的会话也不会被打断
async function restart(opts) {
  await waitIdle(opts);
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unit = !fs.existsSync(path.join(unitDir, SERVICE_NAME)) && fs.existsSync(path.join(unitDir, LEGACY_SERVICE_NAME)) ? LEGACY_SERVICE_NAME : SERVICE_NAME;
  execFileSync('systemctl', ['--user', 'restart', unit], { stdio: 'inherit' });
  console.log(`已重启 ${unit}${unit === LEGACY_SERVICE_NAME ? '（旧单元名；执行 cache-keepalive install 可迁移为 cache-keepalive.service）' : ''}`);
}

async function waitIdle(opts) {
  const waitSec = opts.wait ? parseDurationArg(opts.wait) : 120;
  const deadline = Date.now() + waitSec * 1000;
  const started = Date.now();
  let health = null;
  let announced = false;
  for (;;) {
    health = await api(opts, 'GET', 'health').catch(() => null);
    if (!health || health.inflight === 0 || Date.now() > deadline) break;
    if (!announced) {
      console.log(`中继还有 ${health.inflight} 个在途请求，等它们结束（最多 ${fmtDuration(waitSec)}）…`);
      announced = true;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (health?.inflight > 0) console.log(`等了 ${fmtDuration(waitSec)}仍有 ${health.inflight} 个在途请求，照常重启（中继会等它们结束，最多 120s）`);
  else if (announced) console.log(`中继已空闲（等了 ${fmtDuration((Date.now() - started) / 1000)}），开始重启`);
}

function uninstall() {
  for (const name of [SERVICE_NAME, LEGACY_SERVICE_NAME]) {
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', name);
    if (!fs.existsSync(unitPath)) continue;
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', name], { stdio: 'inherit' });
    } catch { /* 服务可能已停止 */ }
    fs.rmSync(unitPath, { force: true });
  }
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  } catch { /* 忽略 */ }
  const link = path.join(os.homedir(), '.local', 'bin', 'cache-keepalive');
  try {
    if (fs.readlinkSync(link) === __filename) fs.rmSync(link);
  } catch { /* 不存在或不是本工具的链接 */ }
  console.log('已卸载保活中继服务');
}

// ------------------------------------------------------------------ 自动保活 / 回测

function printAutoSettings(auto) {
  const quiet = auto.quietHours?.[0] === auto.quietHours?.[1] ? '不设' : `${auto.quietHours[0]}–${auto.quietHours[1]} 点开始的空闲不保活`;
  console.log(`自动保活（全局）：${auto.mode === 'on' ? '开' : '关'}`);
  console.log(`  主对话空闲 50m 自动心跳，每段空闲最多 ${auto.count} 次；缓存前缀 ≥ ${fmtTokens(auto.minContextTokens)}；人工接入 ≥ ${auto.minHumanTurns} 轮${auto.toolGapIgnoresTurns !== false ? '（工具执行中的空闲不看）' : ''}`);
  console.log(`  凌晨时段：${quiet}；心跳没命中后全局暂停 ${fmtDuration(auto.missCooldownSec)}${auto.cooldownUntil ? `（暂停中，到 ${fmtTime(auto.cooldownUntil)}）` : ''}；任务进程已退出的空闲${auto.skipClosedAgents === false ? '照常保活' : '不保活'}`);
  if (auto.disabledSessions) console.log(`  会话级关闭：${auto.disabledSessions} 个会话不再自动保活（cache-keepalive auto reset --global 恢复）`);
  if (auto.configFile) console.log(`  配置文件 ${auto.configFile}${auto.configExists === false ? '（不存在：当前全部为默认值，auto set / 页面保存会重新创建）' : ''}`);
}

async function autoCommand(opts, out) {
  const action = opts.positional[0] || 'status';
  if (action === 'status') {
    if (opts.global) {
      if (opts.session || opts.cwd) throw new Error('auto status --global 不能和 --session / --cwd 一起使用');
      const [settings, sessions] = await Promise.all([api(opts, 'GET', 'auto'), api(opts, 'GET', 'sessions?hours=24')]);
      if (opts.json) return out({ auto: settings.auto, sessions: sessions.sessions });
      printAutoSettings(settings.auto);
      const labels = {
        active: '自动进行中', armed: '已就绪', done: '本段已保活', skipped: '本段不保活',
        ineligible: '不会自动', stopped: '已关闭', off: '全局已关', manual: '手动优先', waiting: '等主对话请求',
      };
      const counts = new Map();
      for (const view of sessions.sessions) {
        const state = view.auto?.state || 'waiting';
        counts.set(state, (counts.get(state) || 0) + 1);
      }
      const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([state, count]) => `${labels[state] || state} ${count}`);
      console.log(`\n近 24h 会话 ${sessions.sessions.length} 个：${parts.join('，') || '无'}`);
      const stopped = sessions.sessions.filter(autoStopped).slice(0, 10);
      if (stopped.length) console.log(`已关闭自动保活的会话：${stopped.map(view => short(view.id)).join('、')}（cache-keepalive auto reset --global 恢复）`);
      return undefined;
    }
    const settings = await api(opts, 'GET', 'auto');
    const params = new URLSearchParams(Object.entries(target(opts)).filter(([, v]) => v));
    const sessions = await api(opts, 'GET', `sessions?${params}`);
    if (opts.json) return out({ auto: settings.auto, sessions: sessions.sessions });
    printAutoSettings(settings.auto);
    const view = sessions.sessions[0];
    if (view) {
      console.log(`
当前会话 ${short(view.id)}${view.paseo?.title ? `（${view.paseo.title.slice(0, 40)}）` : ''}`);
      console.log(`  ${autoLine(view)}`);
    }
    return undefined;
  }
  if (action === 'on' || action === 'off') {
    if (opts.global) {
      if (opts.session || opts.cwd) throw new Error('auto on|off --global 不能和 --session / --cwd 一起使用');
      const result = await api(opts, 'POST', 'auto', { mode: action });
      if (opts.json) return out(result);
      if (!result.ok) throw new Error(result.errors.join('；'));
      printAutoSettings(result.auto);
      if (action === 'off' && result.cancelledAutoPlans?.length) {
        console.log(`  已停止 ${result.cancelledAutoPlans.length} 个进行中的自动计划；手动计划不受影响`);
      }
      if (action === 'on' && result.auto.disabledSessions) {
        console.log(`  ! 仍有 ${result.auto.disabledSessions} 个会话被单独关闭自动保活：cache-keepalive auto reset --global 恢复`);
      }
      if (!result.persisted) console.log('  ! 没写进配置文件，只在中继这次运行期间生效');
      return undefined;
    }
    const result = await api(opts, 'POST', 'sessions/auto', { ...target(opts), enabled: action === 'on', all: opts.all, reason: opts.reason || null, source: 'cli' });
    if (opts.json) return out(result);
    if (!result.ok) throw new Error(result.error);
    for (const view of result.sessions) console.log(`${action === 'on' ? '✓ 已打开' : '✓ 已关闭'}会话 ${short(view.id)} 的自动保活 — ${autoLine(view)}`);
    return undefined;
  }
  if (action === 'reset') {
    if (opts.global && (opts.session || opts.cwd)) throw new Error('auto reset --global 不能和 --session / --cwd 一起使用');
    const result = await api(opts, 'POST', 'sessions/auto', {
      ...(opts.global ? {} : target(opts)),
      global: Boolean(opts.global),
      enabled: true,
      clearBlocked: Boolean(opts.clearBlocked),
      reason: opts.reason || 'auto reset',
      source: 'cli',
    });
    if (opts.json) return out(result);
    if (!result.ok) throw new Error(result.error);
    console.log(`✓ 已恢复 ${result.changed.length} 个会话的自动保活${opts.global ? '（全局）' : ''}`);
    console.log(opts.clearBlocked ? '  同时解除了「上次心跳未命中」锁定' : '  未命中锁定保持不变；要解除用 auto on（单会话）或 ping --force');
    if (result.autoMode === 'off') console.log('  ! 全局自动保活仍是关闭状态：cache-keepalive auto on --global 打开');
    return undefined;
  }
  if (action === 'set') {
    const body = {};
    if (opts.count != null) body.count = Number(opts.count);
    if (opts.minContext != null) body.minContextTokens = parseTokens(opts.minContext);
    if (opts.minTurns != null) body.minHumanTurns = Number(opts.minTurns);
    if (opts.quiet != null) body.quietHours = parseQuiet(opts.quiet);
    if (opts.cooldown != null) {
      const sec = parseDurationArg(opts.cooldown);
      body.missCooldownSec = sec;
    }
    if (opts.skipClosed != null) {
      if (!['on', 'off'].includes(opts.skipClosed)) throw new Error('--skip-closed 只能是 on / off');
      body.skipClosedAgents = opts.skipClosed === 'on';
    }
    if (opts.clearCooldown) body.clearCooldown = true;
    if (!Object.keys(body).length) throw new Error('auto set 需要至少一个参数：--count / --min-context / --min-turns / --quiet / --cooldown / --skip-closed / --clear-cooldown');
    const result = await api(opts, 'POST', 'auto', body);
    if (opts.json) return out(result);
    if (!result.ok) throw new Error(result.errors.join('；'));
    printAutoSettings(result.auto);
    if (!result.persisted && Object.keys(body).some(key => key !== 'clearCooldown')) console.log('  ! 没写进配置文件，只在中继这次运行期间生效');
    return undefined;
  }
  throw new Error(`未知的 auto 子命令: ${action}（status / on / off / set / reset）`);
}

function parseDurationArg(value) {
  const m = String(value).trim().toLowerCase().match(/^(\d+)(h|m|s)?$/);
  if (!m) throw new Error(`无法解析时长: ${value}（例如 2h、30m）`);
  return Number(m[1]) * ({ h: 3600, m: 60, s: 1 }[m[2] || 's']);
}

// 回测在独立进程里读会话记录（不经过中继）；规则取中继当前的自动保活设置，命令行参数可覆盖
async function backtestCommand(opts) {
  const settings = await api(opts, 'GET', 'auto').catch(() => null);
  const auto = { ...(settings?.auto || {}) };
  delete auto.cooldownUntil;
  delete auto.configFile;
  const args = [path.join(path.dirname(__filename), 'backtest.js'), '--days', String(opts.days || 7), '--auto', JSON.stringify(auto)];
  if (opts.count != null) args.push('--count', String(opts.count));
  if (opts.minContext != null) args.push('--min-context', String(opts.minContext));
  if (opts.minTurns != null) args.push('--min-turns', String(opts.minTurns));
  if (opts.quiet != null) args.push('--quiet', String(opts.quiet));
  if (opts.grid) args.push('--grid');
  if (opts.session) args.push('--session', opts.session);
  if (opts.json) args.push('--json');
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}

// ------------------------------------------------------------------ 全局列表

async function listCommand(opts) {
  if (opts.session || opts.cwd || opts.agent) throw new Error('list 不支持 --session / --cwd / --agent；查看单个会话或工作区用 status [--all]');
  const hours = opts.hours != null ? Math.round(Number(opts.hours)) : Math.round(Number(opts.days || 1) * 24);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error('--hours 需要是 1–168 的整数（或 --days 1–7）');
  const limit = opts.limit == null ? 0 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('--limit 需要是 ≥0 的整数');
  const [health, result] = await Promise.all([
    api(opts, 'GET', 'health').catch(() => null),
    api(opts, 'GET', `sessions?hours=${hours}`),
  ]);
  let views = result.sessions || [];
  // 默认隐藏没有会话 ID、也没有缓存的旁路请求（与 sessions 一致）
  if (!opts.all) views = views.filter(view => !(view.id.startsWith('anon-') && !view.primary?.ttl));
  const available = views.length;
  if (opts.active) views = views.filter(view => view.plan?.status === 'active');
  if (opts.warm) views = views.filter(view => view.primary?.warm);
  const stats = {
    total: views.length,
    warm: views.filter(view => view.primary?.warm).length,
    active: views.filter(view => view.plan?.status === 'active').length,
    autoActive: views.filter(view => view.plan?.status === 'active' && view.plan.source === 'auto').length,
    stopped: views.filter(autoStopped).length,
  };
  if (limit) views = views.slice(0, limit);
  const filters = [opts.active && '有进行中计划', opts.warm && '缓存有效'].filter(Boolean).join(' / ');
  if (opts.json) return out({ hours, filters, health, stats, sessions: views });
  if (!views.length) {
    if (health?.enabled === false) console.log('⚠ 保活已全局关闭：不发任何心跳，也不能新开；cache-keepalive on 打开');
    if (filters && available) {
      console.log(`没有符合筛选条件的会话（${filters}）；${available} 个会话去掉筛选参数后可见。`);
    } else {
      console.log(result.hint || `近 ${hours} 小时没有符合条件的会话。`);
      console.log(`确认会话的 ANTHROPIC_BASE_URL 指向保活中继 ${relayBase(opts)}，且发过至少一次请求。`);
    }
    return undefined;
  }
  printSessionList(views, { hours, health, filters, stats });
  return undefined;
}

// 按「保护多久」自动算心跳次数：最后一次心跳后缓存仍有效 ttlSec - safetySec，
// 因此 n 次 × interval + 安全后的 TTL 覆盖时长 ≥ 目标时长。次数按中继当前 TTL 参数计算，受 maxCount 限制。
async function resolveForInfo(opts, count) {
  if (opts.for == null) return null;
  if (count != null && count !== '') throw new Error('--for 不能和 --count / 位置参数一起使用');
  const requested = parseDurationArg(opts.for);
  if (!requested) throw new Error('--for 需要大于 0 的时长，例如 2h、90m');
  let ttl = opts.ttl;
  if (ttl === 'any') throw new Error('--for 不能和 --ttl any 一起使用：不同 TTL 的次数不同，请分别用 --ttl 1h / 5m 执行');
  if (!ttl) {
    if (opts.global) ttl = '1h';
    else {
      const params = new URLSearchParams(Object.entries(target(opts)).filter(([, value]) => value));
      const result = await api(opts, 'GET', `sessions?${params}`).catch(() => null);
      const ttls = new Set((result?.sessions || []).map(view => view.primary?.ttl).filter(Boolean));
      if (ttls.size > 1) throw new Error('目标下混用了 1h / 5m 缓存，请用 --ttl 指定后再 --for');
      ttl = [...ttls][0] || '1h';
    }
  }
  const health = await api(opts, 'GET', 'health').catch(() => null);
  const settings = health?.defaults?.ttl?.[ttl] || DEFAULT_CONFIG.ttl[ttl];
  if (!settings) throw new Error(`未知的 TTL：${ttl}`);
  let interval = opts.interval ? parseDurationArg(opts.interval) : settings.intervalSec;
  interval = Math.min(settings.maxIntervalSec, Math.max(settings.minIntervalSec, interval));
  const perIdle = Math.max(0, settings.ttlSec - settings.safetySec);
  const resolvedCount = Math.max(1, Math.min(settings.maxCount, Math.ceil((requested - perIdle) / interval)));
  const coverageSec = resolvedCount * interval + perIdle;
  const maxCoverageSec = settings.maxCount * interval + perIdle;
  return { ttl, interval, count: resolvedCount, requested, coverageSec, maxCoverageSec, clamped: requested > maxCoverageSec };
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'serve') return serve(argv.slice(1));
  const opts = parseArgs(argv);
  const command = opts.command || 'status';
  if (opts.help || command === 'help') {
    console.log(HELP);
    return undefined;
  }
  if (command === 'install') return install(opts);
  if (command === 'restart') return restart(opts);
  if (command === 'uninstall') return uninstall();
  if (command === 'web') {
    console.log(`${relayBase(opts)}/keepalive/`);
    return undefined;
  }
  if (command === 'list' || (command === 'status' && opts.global)) return listCommand(opts);

  if (command === 'status' || command === 'sessions') {
    const query = command === 'sessions' ? { hours: opts.hours } : target(opts);
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v));
    const result = await api(opts, 'GET', `sessions?${params}`);
    if (opts.json) return out(result);
    if (!result.sessions.length) {
      console.log(result.hint || '最近没有经过保活中继的会话。');
      if ((query.cwd || query.agent) && !/匹配到|没有找到 Paseo/.test(result.hint || '')) console.log(`确认该任务的模型路由已接入中继（ANTHROPIC_BASE_URL 指向 ${relayBase(opts)}），且发过至少一次请求。`);
      return undefined;
    }
    // sessions 默认不列没有会话 ID、也没有缓存的旁路请求（--all 显示全部）
    const visible = command === 'sessions' && !opts.all
      ? result.sessions.filter(view => !(view.id.startsWith('anon-') && !view.primary?.ttl))
      : result.sessions;
    const list = command === 'status' && !opts.all ? visible.slice(0, 1) : visible;
    for (const view of list) printSession(view, result.now);
    if (list.length < result.sessions.length) {
      console.log(command === 'status'
        ? `\n该工作区还有 ${result.sessions.length - list.length} 个会话，用 --all 查看`
        : `\n另有 ${result.sessions.length - list.length} 个没有会话 ID、也没有缓存的请求，用 --all 查看`);
    }
    return undefined;
  }
  if (command === 'start') {
    const count = opts.count ?? opts.positional[0];
    const forInfo = await resolveForInfo(opts, count);
    const effectiveCount = forInfo ? forInfo.count : count;
    if (forInfo && !opts.json) {
      console.log(`按 ${fmtDuration(forInfo.requested)} 保护窗口自动计算：${forInfo.count} 次 × ${fmtInterval(forInfo.interval)}（缓存可覆盖约 ${fmtInterval(forInfo.coverageSec)}${forInfo.clamped ? '，已到该 TTL 上限' : ''}）`);
      if (forInfo.clamped) console.log(`  ! ${forInfo.ttl} 缓存最多覆盖约 ${fmtInterval(forInfo.maxCoverageSec)}，已按上限 ${forInfo.count} 次执行`);
    }
    if (!opts.global && opts.ttl) throw new Error('--ttl 只用于 start --global');
    if (opts.global) {
      if (opts.session || opts.cwd) throw new Error('start --global 不能和 --session / --cwd 一起使用');
      const result = await api(opts, 'POST', 'plans', { global: true, count: effectiveCount, interval: opts.interval, force: opts.force, ttl: opts.ttl, source: 'cli' }, 60000);
      if (opts.json) return out(forInfo ? { ...result, for: forInfo } : result);
      if (result.error) throw new Error(result.error);
      printGlobalPlanResults(result);
      if (!result.ok) process.exitCode = 2;
      return undefined;
    }
    const result = await api(opts, 'POST', 'plans', { ...target(opts), count: effectiveCount, interval: opts.interval, force: opts.force, all: opts.all, source: 'cli' });
    if (opts.json) return out(forInfo ? { ...result, for: forInfo } : result);
    if (result.error) throw new Error(result.error);
    printPlanResults(result);
    if (!result.ok) process.exitCode = 2;
    return undefined;
  }
  if (command === 'stop') {
    if (opts.global) {
      if (opts.session || opts.cwd) throw new Error('stop --global 不能和 --session / --cwd 一起使用');
      const result = await api(opts, 'POST', 'plans/stop', { global: true, reason: opts.reason || '手动全局停止', source: 'cli' });
      if (opts.json) return out(result);
      if (!result.ok) throw new Error(result.error);
      console.log(`已停止 ${result.stopped.length} 个保活计划，关闭 ${result.autoDisabled.length} 个会话的自动保活（共 ${result.sessions} 个会话）${result.unpinned?.length ? `，取消 ${result.unpinned.length} 个长保活` : ''}`);
      if (!result.stopped.length && !result.autoDisabled.length) console.log('  没有进行中的计划，也没有需要关闭的会话');
      if (result.autoMode === 'on') console.log('  全局自动保活模式仍是「开」：新出现的会话会在符合条件的空闲自动保活；要彻底停止：cache-keepalive auto off --global');
      else console.log('  全局自动保活模式已是「关」，新出现的会话也不会自动保活');
      return undefined;
    }
    const body = opts.all && !opts.cwd && !opts.session ? { all: true } : target(opts);
    const result = await api(opts, 'POST', 'plans/stop', { ...body, reason: opts.reason, source: 'cli' });
    if (opts.json) return out(result);
    if (!result.ok) throw new Error(result.error);
    console.log(result.stopped.length ? `已停止 ${result.stopped.length} 个保活计划` : '没有进行中的保活计划');
    if (result.unpinned?.length) console.log(`已取消 ${result.unpinned.length} 个会话的长保活`);
    if (result.autoDisabled?.length) {
      console.log(`已关闭 ${result.autoDisabled.length} 个会话的自动保活（${result.autoDisabled.map(short).join('、')}），整个会话不再自动保活；恢复：cache-keepalive auto on${result.autoDisabled.length === 1 ? '' : ' --session <ID>'}`);
    }
    return undefined;
  }
  if (command === 'off' || command === 'on') {
    const result = await api(opts, 'POST', 'keepalive', { enabled: command === 'on', reason: opts.reason || null, source: 'cli' });
    if (opts.json) return out(result);
    if (!result.ok) throw new Error(result.error);
    if (command === 'off') {
      console.log(`✓ 保活已全局关闭：停止 ${result.stopped.length} 个计划，取消 ${result.unpinned.length} 个长保活；自动 / 手动 / 长保活都不再发，也不能再开${result.persisted ? '（已写入配置文件，重启后仍关）' : '（没写进配置文件，中继重启后会恢复为开）'}`);
      console.log('  打开：cache-keepalive on');
    } else {
      console.log(`✓ 保活已全局打开${result.persisted ? '（已写入配置文件）' : ''}；自动保活模式 ${result.autoMode === 'on' ? '开' : '关（cache-keepalive auto on --global 打开）'}`);
      if (result.disabledSessions) console.log(`  ! 仍有 ${result.disabledSessions} 个会话被单独关闭自动保活：cache-keepalive auto reset --global 恢复`);
      console.log('  关闭时取消的长保活不会自动恢复，需要的会话重新 cache-keepalive pin');
    }
    return undefined;
  }
  if (command === 'pin' || command === 'unpin') {
    if (command === 'pin' && opts.count != null) throw new Error('pin 按时长设置，用 --for 12h，不用 --count');
    if (opts.global) {
      if (opts.session || opts.cwd || opts.agent) throw new Error(`${command} --global 不能和 --session / --cwd / --agent 一起使用`);
      const result = await api(opts, 'POST', 'sessions/pin', { global: true, enabled: command === 'pin', for: opts.for, forever: opts.forever || undefined, interval: opts.interval, ttl: opts.ttl, allSessions: opts.allSessions, reason: opts.reason || null, source: 'cli' }, 60000);
      if (opts.json) return out(result);
      if (result.error) throw new Error(result.error);
      const s = result.summary || {};
      if (command === 'unpin') {
        console.log(`✓ 已取消 ${s.unpinned || 0} 个会话的长保活`);
        return undefined;
      }
      const reasons = Object.entries(result.skippedBy || {}).sort((a, b) => b[1] - a[1]).map(([code, n]) => `${planErrorLabel(code)} ${n}`).join('，');
      console.log(`${result.ok ? '✓' : '○'} 全局${opts.forever ? '长期' : '长'}保活（${result.ttl === 'any' ? '所有 TTL' : result.ttl}）：新设 ${s.pinned || 0} 个，延长 ${s.extended || 0} 个，跳过 ${s.skipped || 0} 个${reasons ? `（${reasons}）` : ''}`);
      if (s.filtered) console.log(`  另有 ${s.filtered} 个会话不在范围（不是主对话 / TTL 不匹配 / 缓存已过期；--all-sessions 可连已过期的一起设）`);
      for (const item of (result.results || []).filter(r => r.ok && r.pin).slice(0, 12)) {
        const e = item.estimate;
        console.log(`  ✓ ${short(item.sessionId)} ${pinUntilText(item.pin)}${e ? `，前缀 ${fmtTokens(e.contextTokens)}，每次约 ${fmtUsd(e.pingUsd)}，${pinBoundText(e)}，保住回来省 ${fmtUsd(e.saveUsd)}` : ''}`);
      }
      for (const item of (result.results || []).filter(r => !r.ok).slice(0, 10)) console.log(`  ✗ ${short(item.sessionId)} ${(item.errors || []).map(e => e.message).join('；')}`);
      if (!result.ok) process.exitCode = 2;
      return undefined;
    }
    if (command === 'pin' && opts.forever && opts.for != null) throw new Error('--forever 和 --for 只能用一个');
    const result = await api(opts, 'POST', 'sessions/pin', { ...target(opts), enabled: command === 'pin', for: opts.for, forever: opts.forever || undefined, interval: opts.interval, all: opts.all, reason: opts.reason || null, source: 'cli' });
    if (opts.json) return out(result);
    if (result.error) throw new Error(result.error);
    for (const item of result.results || []) {
      if (!item.ok) {
        console.log(`✗ 会话 ${short(item.sessionId)} 无法设长保活：`);
        for (const error of item.errors || []) console.log(`  - ${error.message}`);
        continue;
      }
      if (command === 'unpin') {
        console.log(item.changed ? `✓ 已取消会话 ${short(item.sessionId)} 的长保活${item.stopped?.length ? '，并停止了进行中的心跳计划' : ''}` : `会话 ${short(item.sessionId)} 没有设置长保活`);
        continue;
      }
      const pin = item.pin;
      const e = item.estimate;
      if (pin.untilAt == null) console.log(`✓ 会话 ${short(item.sessionId)} 长期保活（没有到期时刻，直到 cache-keepalive unpin / stop）：每 ${fmtInterval(pin.intervalSec)} 一次，只在空闲时发；人在工作时不发，会话继续后下一段空闲接着保；未命中、任务进程退出、每日额度照常`);
      else console.log(`✓ 会话 ${short(item.sessionId)} 长保活到 ${fmtDateTime(pin.untilAt)}（${fmtDuration(pin.durationSec)}，每 ${fmtInterval(pin.intervalSec)} 一次，只在空闲时发；人在工作时不发，会话继续后下一段空闲接着保）`);
      if (e) console.log(`  缓存前缀 ${fmtTokens(e.contextTokens)} tokens；每次心跳约 ${fmtUsd(e.pingUsd)}，${e.maxPings == null ? `整天都空闲约 ${e.perDayPings} 次 ${fmtUsd(e.perDayUsd)}/天` : `整段都空闲时最多 ${e.maxPings} 次 ${fmtUsd(e.maxUsd)}`}；保住后回来约省 ${fmtUsd(e.saveUsd)}`);
      if (item.plan) console.log(`  本段空闲已到点：计划 ${item.plan.count} 次，首次心跳 ${fmtTime(item.plan.nextPingAt)}`);
      for (const warning of item.warnings || []) console.log(`  ! ${warning}`);
    }
    if (result.alternatives?.length) {
      console.log('该工作区还有其他会话（用 --session 指定，或 --all 全部）：');
      for (const alt of result.alternatives) console.log(`  ${short(alt.id)}  ${alt.paseo?.title?.slice(0, 40) || ''}  ${alt.primary ? `${fmtTokens(alt.primary.contextTokens)} tokens` : ''}`);
    }
    if (!result.ok) process.exitCode = 2;
    return undefined;
  }
  if (command === 'auto') return autoCommand(opts, out);
  if (command === 'backtest') return backtestCommand(opts);
  if (command === 'ping') {
    if (opts.global) throw new Error('ping 不支持 --global：心跳逐会话执行，先用 list 找到会话，再用 --session');
    const result = await api(opts, 'POST', 'ping', { ...target(opts), force: opts.force, source: 'cli' }, 180000);
    if (opts.json) return out(result);
    if (result.error && !result.result) throw new Error(result.error);
    if (result.errors?.length) {
      for (const error of result.errors) console.log(`✗ ${error.message}${error.soft ? '（可加 --force 越过）' : ''}`);
      process.exitCode = 2;
      return undefined;
    }
    const r = result.result || {};
    const u = r.usage;
    console.log(`${r.outcome === 'hit' ? '✓' : '✗'} 会话 ${short(result.sessionId)} 心跳${OUTCOME_LABELS[r.outcome] || r.outcome}：read=${fmtTokens(u?.cacheRead)} write=${fmtTokens(u?.cacheWrite)} out=${u?.output ?? '-'} 花费 ${fmtUsd(r.costUsd)}${r.error ? ` 错误: ${r.error}` : ''}`);
    if (result.plan?.reason && result.plan.status !== 'active') console.log(`  ${result.plan.reason}`);
    if (result.plan?.state === 'retrying') console.log(`  网关/上游暂时不可用，${fmtTime(result.plan.nextPingAt)} 自动重试（退避到缓存安全窗口截止）`);
    if (r.outcome !== 'hit') process.exitCode = 2;
    return undefined;
  }
  if (command === 'stats') {
    const result = await api(opts, 'GET', `summary?days=${encodeURIComponent(opts.days || 7)}`);
    if (opts.json) return out(result);
    printStats(result);
    return undefined;
  }
  if (command === 'episodes') {
    const params = new URLSearchParams({ days: String(opts.days || 7), limit: String(opts.limit || 50) });
    if (opts.session) params.set('session', opts.session);
    else if (opts.agent) {
      params.set('agent', String(opts.agent).trim());
      if (opts.cwd) params.set('agentCwd', opts.cwd);
    }
    const result = await api(opts, 'GET', `episodes?${params}`);
    if (opts.json) return out(result);
    if (result.error) throw new Error(result.error);
    printEpisodes(result);
    return undefined;
  }
  if (command === 'events') {
    const result = await api(opts, 'GET', `events?limit=${encodeURIComponent(opts.limit || 50)}`);
    if (opts.json) return out(result);
    for (const event of result.events) {
      if (event.t === 'global') console.log(`${fmtTime(event.at)} 总开关 ${event.action === 'off' ? `关闭（停 ${event.stopped} 个计划、取消 ${event.unpinned} 个长保活）` : '打开'}${event.reason ? ` ${event.reason}` : ''}`);
      else if (event.t === 'pin') console.log(`${fmtTime(event.at)} 长保活 ${short(event.sid)} ${{ set: event.untilAt == null ? '设置为长期' : `设置到 ${fmtDateTime(event.untilAt)}`, extend: event.untilAt == null ? '改为长期' : `延长到 ${fmtDateTime(event.untilAt)}`, unset: '取消', expired: '到期', cancelled: '取消', 'missed-window': '本段空闲已超过缓存安全窗口，等下一次请求后接上', 'agent-closed': '任务进程已退出，本段空闲不发，等它 resume 后接上' }[event.action] || event.action}${event.reason ? ` ${event.reason}` : ''}`);
      else if (event.t === 'ping') console.log(`${fmtTime(event.at)} ${SOURCE_LABELS[event.source] || '手动'}心跳 ${short(event.sid)} ${OUTCOME_LABELS[event.outcome] || event.outcome} read=${fmtTokens(event.usage?.cacheRead)} ${fmtUsd(event.costUsd)}${event.estimated ? '(估)' : ''}`);
      else if (event.t === 'plan') console.log(`${fmtTime(event.at)} ${event.source === 'auto' ? '自动' : event.source === 'pin' ? '长保活' : ''}计划 ${short(event.sid)} ${event.action}${event.reason ? ` ${event.reason}` : ''}`);
      else if (event.t === 'auto' && event.action) console.log(`${fmtTime(event.at)} 自动保活 ${short(event.sid)} ${{ enable: '打开', disable: '关闭', cooldown: `全局暂停到 ${fmtTime(event.until)}` }[event.action] || event.action}${event.reason ? ` ${event.reason}` : ''}`);
      else if (event.t === 'auto') console.log(`${fmtTime(event.at)} 自动保活 ${short(event.sid)} ${event.ok ? '开始' : `不保活：${event.message || AUTO_SKIP_LABELS[event.code] || event.code}`}（前缀 ${fmtTokens(event.contextTokens)}，人工 ${event.humanTurns} 轮）`);
      else if (event.resume) console.log(`${fmtTime(event.at)} 回来 ${short(event.sid)} ${RESUME_REASON_LABELS[event.resume.reason] || event.resume.reason} ${fmtUsd(event.resume.benefitUsd)}`);
      else if (event.cold) console.log(`${fmtTime(event.at)} 冷启动 ${short(event.sid)} 重写 ${fmtTokens(event.cold.rewriteTokens)} ${fmtUsd(event.cold.rewriteUsd)}`);
    }
    return undefined;
  }
  throw new Error(`未知命令: ${command}\n\n${HELP}`);
}

main().catch(error => {
  console.error(`cache-keepalive: ${error.message}`);
  process.exitCode = 1;
});
