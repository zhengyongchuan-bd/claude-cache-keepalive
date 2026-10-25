// 缓存保活页面：轮询中继 API，渲染成本收益、自动保活设置、会话列表、每日对比图、回测与事件；所有动态文本都走 textContent。
// 自动保活的状态与原因一律用中继给出的判定，页面不另算一套。

const SVG_NS = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 10000;
const OUTCOME = {
  hit: { cls: 'good', ico: '✓', label: '命中' },
  miss: { cls: 'critical', ico: '✗', label: '未命中' },
  partial: { cls: 'serious', ico: '◐', label: '部分命中' },
  rewrite: { cls: 'critical', ico: '✗', label: '未命中(重写)' },
  unknown: { cls: 'warning', ico: '?', label: '用量未知' },
  timeout: { cls: 'warning', ico: '⏱', label: '超时(上游可能已处理)' },
  error: { cls: 'warning', ico: '!', label: '失败' },
};
const EPISODE_OUTCOME = {
  kept: { cls: 'good', ico: '✓', label: '保活生效' },
  'returned-within-ttl': { cls: 'neutral', ico: '○', label: 'TTL 内就回来，心跳多余' },
  'expired-before-return': { cls: 'serious', ico: '✗', label: '心跳停止后才回来，仍重写' },
  'no-hit-ping': { cls: 'critical', ico: '✗', label: '心跳都没命中' },
  'resume-miss': { cls: 'serious', ico: '✗', label: '回来时没读到保住的前缀' },
  pending: { cls: 'good', ico: '◷', label: '缓存保住中，还没回来' },
  'expired-unused': { cls: 'neutral', ico: '■', label: '保活后没人回来' },
  'no-pings': { cls: 'neutral', ico: '·', label: '没发出心跳' },
};
const PLAN_STATUS = {
  active: { cls: 'good', ico: '◷', label: '保活中' },
  completed: { cls: 'neutral', ico: '✓', label: '已完成' },
  stopped: { cls: 'serious', ico: '■', label: '已停止' },
  cancelled: { cls: 'neutral', ico: '■', label: '已取消' },
  expired: { cls: 'neutral', ico: '■', label: '已过期' },
  replaced: { cls: 'neutral', ico: '↻', label: '已替换' },
};
const PLAN_STATE = {
  scheduled: '等待下一次',
  busy: '会话请求进行中，暂缓',
  'waiting-snapshot': '等会话再发一次请求',
  'waiting-after-compact': '会话刚压缩，等下一次请求',
  'waiting-auth': '等任一请求经过中继以取得凭证',
  'daily-budget': '今日额度已满',
  pinging: '发送中',
  retrying: '心跳失败，退避重试',
};
const planStateText = plan => (plan.state === 'retrying'
  ? `心跳失败 ${plan.errorStreak} 次，退避重试：${plan.lastError}`
  : PLAN_STATE[plan.state] || plan.state);
const RESUME_REASON = {
  kept: '回来时命中保住的缓存',
  'returned-within-ttl': 'TTL 内就回来了，心跳多余',
  'expired-before-return': '心跳停止后缓存已过期',
  'no-hit-ping': '心跳都没命中',
  'resume-miss': '回来的请求没读到保住的前缀',
};
// 自动保活对单个会话的状态（中继 autoView.state）
const AUTO_STATE = {
  armed: { cls: 'good', ico: '◷', label: '已就绪' },
  active: { cls: 'good', ico: '◉', label: '自动保活中' },
  done: { cls: 'neutral', ico: '✓', label: '本段已保活' },
  skipped: { cls: 'neutral', ico: '○', label: '本段不保活' },
  ineligible: { cls: 'neutral', ico: '○', label: '不会自动保活' },
  stopped: { cls: 'serious', ico: '■', label: '已关闭' },
  off: { cls: 'neutral', ico: '■', label: '全局已关' },
  'keepalive-off': { cls: 'critical', ico: '■', label: '总开关已关' },
  manual: { cls: 'neutral', ico: '✋', label: '手动计划优先' },
  pinned: { cls: 'good', ico: '📌', label: '长保活接管' },
  waiting: { cls: 'neutral', ico: '…', label: '等主对话请求' },
};
const SOURCE_LABEL = { auto: '自动', manual: '手动', pin: '长保活' };
const INTERVAL_OPTIONS = {
  '1h': [['', '默认 50m'], ['30m', '30m'], ['40m', '40m'], ['45m', '45m'], ['55m', '55m']],
  '5m': [['', '默认 4m'], ['2m', '2m'], ['3m', '3m'], ['4m30s', '4m30s']],
};

const state = {
  days: 7,
  search: '',
  onlyWarm: false,
  health: null,
  sessions: [],
  summary: null,
  events: [],
  skew: 0,
  error: null,
  chartAsTable: false,
  drafts: new Map(),
  messages: new Map(),
  pending: new Set(),
  autoLabels: {},
  autoDraft: null,
  autoSaving: false,
  backtest: { data: null, loading: false, error: null, key: null, grid: false },
  episodes: null,
  episodesAll: false,
  openEpisodes: new Set(),
};
const CONTROL_TOKEN = document.querySelector('meta[name="cache-keepalive-token"]')?.content || '';

const $ = selector => document.querySelector(selector);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'style') el.style.cssText = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) el.setAttribute(key, value);
  return el;
}

// ------------------------------------------------------------------ 格式化

const nowMs = () => Date.now() + state.skew;
function fmtUsd(n, { sign = false } = {}) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const text = abs >= 100 ? abs.toFixed(0) : abs >= 1 ? abs.toFixed(2) : abs >= 0.01 ? abs.toFixed(3) : abs === 0 ? '0' : abs.toFixed(4);
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}$${text}`;
}
function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
function fmtDuration(sec, { seconds = false } = {}) {
  if (sec == null) return '—';
  const s = Math.max(0, Math.round(Math.abs(sec)));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (hours) return `${hours}h${minutes ? `${minutes}m` : ''}`;
  if (minutes) return seconds && minutes < 10 ? `${minutes}m${String(rest).padStart(2, '0')}s` : `${minutes}m`;
  return `${rest}s`;
}
// 计划间隔要精确到秒（5m 缓存的间隔上限是 4m30s）
const fmtInterval = sec => (sec >= 60 && sec < 3600 && sec % 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : fmtDuration(sec));
const fmtTime = at => (at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDay = key => key.slice(5);
const shortId = id => String(id || '').slice(0, 8);
const shortModel = model => String(model || '').replace(/^.*\//, '');
function shortPath(dir) {
  if (!dir) return '—';
  return dir.replace(/^\/(data00\/)?home\/[^/]+/, '~');
}

function statusEl(kind, text) {
  const spec = typeof kind === 'string' ? OUTCOME[kind] || { cls: 'neutral', ico: '·', label: kind } : kind;
  return h('span', { class: `status ${spec.cls}` }, h('span', { class: 'ico', 'aria-hidden': 'true' }, spec.ico), text ?? spec.label);
}

// ------------------------------------------------------------------ 数据

async function api(route, { method = 'GET', body } = {}) {
  const res = await fetch(`api/${route}`, {
    method,
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json', ...(CONTROL_TOKEN ? { 'x-cache-keepalive-token': CONTROL_TOKEN } : {}) } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok && data?.ok === false && !data.results && !data.errors) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refresh() {
  $('#chart').classList.add('loading');
  try {
    const hours = Math.max(24, state.days * 24);
    const [health, sessions, summary, events, episodes, auto] = await Promise.all([
      api('health'),
      api(`sessions?hours=${hours}`),
      api(`summary?days=${state.days}`),
      api('events?limit=60'),
      api(`episodes?days=${state.days}&limit=300`),
      Object.keys(state.autoLabels).length ? null : api('auto'),
    ]);
    if (auto) state.autoLabels = auto.labels || {};
    state.health = health;
    state.sessions = sessions.sessions;
    state.skew = sessions.now - Date.now();
    state.summary = summary;
    state.events = events.events;
    state.episodes = episodes;
    state.error = null;
  } catch (error) {
    state.error = error.message;
  }
  $('#chart').classList.remove('loading');
  render();
}

// ------------------------------------------------------------------ 渲染

function render() {
  renderHeader();
  if (!state.summary) return;
  renderKpis();
  // 正在改设置 / 输入次数时不重绘对应区域，避免丢焦点和草稿
  if (!$('#auto').contains(document.activeElement)) renderAuto();
  renderChart();
  if (!$('#sessions').contains(document.activeElement) || document.activeElement === document.body) renderSessions();
  renderBacktest();
  if (!$('#episodes').contains(document.activeElement) || document.activeElement === document.body) renderEpisodes();
  renderEvents();
  renderOpportunities();
}

const autoLabel = code => state.autoLabels[code] || code;

function renderHeader() {
  const banner = $('#banner');
  if (state.error) {
    banner.hidden = false;
    banner.textContent = `连不上保活中继：${state.error}。页面保留上次数据；中继由 systemd --user 的 cache-keepalive 服务托管（cache-keepalive install）。`;
  } else banner.hidden = true;
  const health = state.health;
  if (!health) return;
  $('#relay-line').textContent = `中继 ${health.listen} → 上游 ${health.upstream} · 已运行 ${fmtDuration(health.uptimeSec)} · 内存快照 ${health.snapshots} 个（${fmtTokens(health.snapshotBytes)}B）`;
  const b = health.budget;
  const auto = health.auto || {};
  $('#pills').replaceChildren(
    h('span', { class: 'pill' }, statusEl({ cls: state.error ? 'critical' : 'good', ico: '●' }, state.error ? '离线' : '在线')),
    health.enabled === false ? h('span', { class: 'pill' }, statusEl({ cls: 'critical', ico: '■' }, '保活已全局关闭')) : null,
    h('span', { class: 'pill' }, statusEl(auto.mode === 'on' ? (auto.cooldownUntil ? { cls: 'warning', ico: '⏸' } : { cls: 'good', ico: '◉' }) : { cls: 'neutral', ico: '■' },
      auto.mode === 'on' ? (auto.cooldownUntil ? `自动保活暂停到 ${fmtTime(auto.cooldownUntil)}` : '自动保活 开') : '自动保活 关')),
    h('span', { class: 'pill' }, `进行中计划 ${health.activePlans}${health.autoPlans ? `（自动 ${health.autoPlans}）` : ''}${health.pinnedSessions ? ` · 长保活 ${health.pinnedSessions} 个会话` : ''}`),
    h('span', { class: 'pill' }, `今日心跳 ${b.pings}/${b.maxPings} 次 · ${fmtUsd(b.usd)}/${fmtUsd(b.maxUsd)}`),
  );
  $('#updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

function kpi(label, value, note, { hero = false, tone = null } = {}) {
  return h('div', { class: `kpi${hero ? ' hero' : ''}` },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, value),
    note ? h('div', { class: `kpi-note${tone ? ` ${tone}` : ''}` }, note) : null);
}

function renderKpis() {
  const t = state.summary.totals;
  const net = t.netUsd;
  const rangeText = state.days === 1 ? '今天' : `近 ${state.days} 天`;
  $('#kpis').replaceChildren(
    kpi(`净收益（${rangeText}）`, fmtUsd(net), `节省 ${fmtUsd(t.benefitUsd)} − 心跳 ${fmtUsd(t.pingCostUsd)}`, { hero: true }),
    kpi('保活节省', fmtUsd(t.benefitUsd), `生效 ${t.keptResumes} 次 · 少写 ${fmtTokens(t.savedTokens)} tokens`),
    kpi('心跳成本', fmtUsd(t.pingCostUsd), `${t.pings} 次心跳${t.wastedPingCostUsd ? ` · 没起作用 ${fmtUsd(t.wastedPingCostUsd)}` : ''}${t.pingCostEstimatedUsd ? ` · 含预估 ${fmtUsd(t.pingCostEstimatedUsd)}` : ''}`),
    kpi('ROI', t.roi == null ? '—' : `${t.roi.toFixed(1)}×`, '节省 ÷ 心跳成本'),
    kpi('心跳命中率', t.pingHitRate == null ? '—' : `${Math.round(t.pingHitRate * 100)}%`, `命中 ${t.pingHits} · 未命中 ${t.pingMisses} · 失败 ${t.pingFailures}${t.pingTimeouts ? ` · 超时 ${t.pingTimeouts}` : ''}`),
    kpi('待兑现', fmtUsd(t.pendingPotentialUsd), t.pendingSessions ? `${t.pendingSessions} 个会话缓存正被保住` : '没有正被保住的缓存'),
    kpi('冷启动可挽救（自动策略）', fmtUsd(t.coldPotentialAutoUsd ?? 0), `手动用满次数上限可救 ${fmtUsd(t.coldPotentialUsd)} · 未保活整段重写 ${t.coldStarts} 次 ${fmtUsd(t.coldRewriteUsd)}`),
  );
}

// ------------------------------------------------------------------ 自动保活设置与统计

function autoRuleText(auto) {
  const quiet = auto.quietHours?.[0] === auto.quietHours?.[1] ? '不设凌晨时段' : `${auto.quietHours[0]}–${auto.quietHours[1]} 点开始的空闲不保活`;
  const interval = fmtDuration(auto.intervalSec || 3000);
  return `主对话空闲 ${interval} 还没有新请求就自动发心跳，之后每 ${interval} 一次，每段空闲最多 ${auto.count} 次；`
    + `缓存前缀 ≥ ${fmtTokens(auto.minContextTokens)}、人工接入 ≥ ${auto.minHumanTurns} 轮${auto.toolGapIgnoresTurns !== false ? '（工具/子代理执行中的空闲不看轮次）' : ''}；${quiet}；`
    + `自动心跳没命中后全局暂停 ${fmtDuration(auto.missCooldownSec)}${auto.skipClosedAgents === false ? '' : '；任务进程已退出（或 Paseo 任务已关闭）的空闲不保活'}。手动「停止」的会话不再自动保活。`
    + (auto.configExists === false ? ' 配置文件不存在，当前全部为默认值（保存设置会重新创建）。' : '');
}

function renderAuto() {
  const auto = state.health?.auto;
  const host = $('#auto');
  if (!auto) return;
  const t = state.summary.totals;
  const a = t.bySource?.auto || {};
  $('#auto-summary').textContent = `${state.days === 1 ? '今天' : `近 ${state.days} 天`}：开启 ${t.autoStarted || 0} 段空闲 · 心跳 ${a.pings || 0} 次 ${fmtUsd(a.pingCostUsd || 0)} · 救回 ${a.keptResumes || 0} 次 ${fmtUsd(a.benefitUsd || 0)}`;
  const draft = state.autoDraft || {
    count: auto.count,
    minContextK: Math.round(auto.minContextTokens / 1000),
    minHumanTurns: auto.minHumanTurns,
    quietStart: auto.quietHours?.[0] ?? 0,
    quietEnd: auto.quietHours?.[1] ?? 0,
    cooldownH: +(auto.missCooldownSec / 3600).toFixed(2),
  };
  const field = (key, label, attrs) => h('label', { class: 'field' }, h('span', { class: 'small muted' }, label),
    h('input', { type: 'number', value: draft[key], 'aria-label': label, ...attrs, oninput: event => { state.autoDraft = { ...(state.autoDraft || draft), [key]: event.target.value }; } }));
  const save = async body => {
    state.autoSaving = true;
    try {
      const result = await api('auto', { method: 'POST', body });
      if (!result.ok) toast(`设置没生效：
${result.errors.map(error => `· ${error}`).join('\n')}`);
      else {
        state.autoDraft = null;
        toast(`已保存自动保活设置${result.persisted ? '（已写入配置文件）' : '（只在中继本次运行期间生效）'}`);
      }
    } catch (error) {
      toast(`保存失败：${error.message}`);
    }
    state.autoSaving = false;
    document.activeElement?.blur?.();
    await refresh();
  };
  const on = auto.mode === 'on';
  const skipped = Object.entries(t.autoSkipped || {}).sort((x, y) => y[1] - x[1]);
  const coldWhy = Object.entries(t.coldByAuto || {}).sort((x, y) => y[1].rewriteUsd - x[1].rewriteUsd);
  const enabled = state.health?.enabled !== false;
  const toggleAll = async () => {
    if (enabled && !window.confirm('关闭后所有会话的自动 / 手动 / 长保活都会停止，并且不能再开，直到重新打开。确定关闭？')) return;
    state.autoSaving = true;
    try {
      const result = await api('keepalive', { method: 'POST', body: { enabled: !enabled, source: 'web' } });
      toast(enabled ? `保活已全局关闭：停止 ${result.stopped.length} 个计划，取消 ${result.unpinned.length} 个长保活` : '保活已全局打开');
    } catch (error) {
      toast(`操作失败：${error.message}`);
    }
    state.autoSaving = false;
    await refresh();
  };
  host.replaceChildren(
    h('div', { class: 'auto-head' },
      h('span', { class: 'small' }, statusEl(enabled ? { cls: 'good', ico: '●' } : { cls: 'critical', ico: '■' }, enabled ? '保活总开关：开' : '保活总开关：关（不发任何心跳）')),
      h('button', { type: 'button', class: `btn${enabled ? '' : ' primary'}`, disabled: state.autoSaving, title: enabled ? '停掉所有会话的所有保活，并禁止新开' : '重新允许保活', onclick: toggleAll }, enabled ? '全部关闭' : '全部打开'),
      h('span', { class: 'muted small' }, '·'),
      h('button', { type: 'button', class: 'btn', disabled: state.autoSaving, title: '所有缓存仍有效的 1h 主对话一起长保活 12 小时；人在工作时不发', onclick: async () => {
        if (!window.confirm('给所有缓存仍有效的 1h 主对话设 12 小时长保活？只在空闲时发心跳。')) return;
        try {
          const result = await api('sessions/pin', { method: 'POST', body: { global: true, enabled: true, source: 'web' } });
          const s = result.summary || {};
          toast(`全局长保活：新设 ${s.pinned || 0} 个，延长 ${s.extended || 0} 个，跳过 ${s.skipped || 0} 个`);
        } catch (error) {
          toast(`操作失败：${error.message}`);
        }
        await refresh();
      } }, '全部长保活 12h'),
      state.health?.pinnedSessions ? h('button', { type: 'button', class: 'btn', disabled: state.autoSaving, onclick: async () => {
        try {
          const result = await api('sessions/pin', { method: 'POST', body: { global: true, enabled: false, source: 'web' } });
          toast(`已取消 ${result.summary?.unpinned || 0} 个会话的长保活`);
        } catch (error) {
          toast(`操作失败：${error.message}`);
        }
        await refresh();
      } }, `取消全部长保活（${state.health.pinnedSessions}）`) : null,
      h('span', { class: 'muted small' }, '·'),
      statusEl(on ? { cls: 'good', ico: '◉' } : { cls: 'neutral', ico: '■' }, on ? '自动保活已开启' : '自动保活已关闭'),
      h('button', { type: 'button', class: `btn${on ? '' : ' primary'}`, disabled: state.autoSaving, onclick: () => save({ mode: on ? 'off' : 'on' }) }, on ? '全局关闭' : '全局开启'),
      auto.cooldownUntil ? h('span', { class: 'small' }, statusEl({ cls: 'warning', ico: '⏸' }, `有自动心跳没命中，暂停到 ${fmtTime(auto.cooldownUntil)}`), ' ',
        h('button', { type: 'button', class: 'btn', onclick: () => save({ clearCooldown: true }) }, '解除暂停')) : null),
    h('p', { class: 'small rule' }, autoRuleText(auto)),
    h('div', { class: 'auto-form' },
      field('count', '每段空闲最多几次', { min: 1, max: 12 }),
      field('minContextK', '缓存前缀至少（K tokens）', { min: 0, max: 2000 }),
      field('minHumanTurns', '人工接入至少几轮', { min: 0, max: 1000 }),
      field('quietStart', '凌晨时段起（点）', { min: 0, max: 23 }),
      field('quietEnd', '止（点，起止相同 = 不设）', { min: 0, max: 23 }),
      field('cooldownH', '没命中后暂停（小时）', { min: 0, max: 24, step: 0.5 }),
      h('button', {
        type: 'button',
        class: 'btn primary',
        disabled: state.autoSaving,
        onclick: () => {
          const latest = state.autoDraft || draft;
          return save({
            count: Number(latest.count),
            minContextTokens: Math.round(Number(latest.minContextK) * 1000),
            minHumanTurns: Number(latest.minHumanTurns),
            quietHours: [Number(latest.quietStart), Number(latest.quietEnd)],
            missCooldownSec: Math.round(Number(latest.cooldownH) * 3600),
          });
        },
      }, '保存设置')),
    h('div', { class: 'auto-stats' },
      h('div', {}, h('div', { class: 'cell-label' }, '本期自动保活'),
        h('div', { class: 'small' }, `开启 ${t.autoStarted || 0} 段空闲 · 心跳 ${a.pings || 0} 次 ${fmtUsd(a.pingCostUsd || 0)}`),
        h('div', { class: 'small' }, `救回 ${a.keptResumes || 0} 次 ${fmtUsd(a.benefitUsd || 0)} · 没起作用 ${a.wastedResumes || 0} 次 ${fmtUsd(a.wastedPingCostUsd || 0)}`)),
      h('div', {}, h('div', { class: 'cell-label' }, '空闲到点时没开的原因'),
        skipped.length ? h('ul', { class: 'reasons' }, skipped.slice(0, 6).map(([code, n]) => h('li', {}, `${autoLabel(code)} ${n} 段`))) : h('div', { class: 'small muted' }, '—')),
      h('div', {}, h('div', { class: 'cell-label' }, '冷启动重写按当时判定归因'),
        coldWhy.length ? h('ul', { class: 'reasons' }, coldWhy.slice(0, 6).map(([code, v]) => h('li', {},
          `${code === 'started' ? '保活了但没保住（离开太久）' : code === 'undecided' ? '没有判定记录（自动保活上线前，或中继当时没运行）' : autoLabel(code)} ${v.count} 次 ${fmtUsd(v.rewriteUsd)}`))) : h('div', { class: 'small muted' }, '—'))),
  );
}

// ------------------------------------------------------------------ 每日对比图

function dayKeys(days) {
  const keys = [];
  const base = new Date(nowMs());
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return keys;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * exp >= value) return step * exp;
  return 10 * exp;
}

function renderChart() {
  const card = $('#chart-card');
  card.hidden = state.days === 1;
  if (card.hidden) return;
  const bySeries = new Map((state.summary.series || []).map(row => [row.day, row]));
  const rows = dayKeys(state.days).map(day => ({ day, pings: 0, pingCostUsd: 0, benefitUsd: 0, ...bySeries.get(day) }));
  $('#legend').replaceChildren(
    h('span', {}, h('i', { class: 'swatch', style: 'background:var(--series-save)' }), '保活节省'),
    h('span', {}, h('i', { class: 'swatch', style: 'background:var(--series-cost)' }), '心跳成本'),
  );
  const host = $('#chart');
  const toggle = $('#chart-toggle');
  toggle.textContent = state.chartAsTable ? '图表' : '表格';
  toggle.setAttribute('aria-pressed', String(state.chartAsTable));
  if (state.chartAsTable) {
    host.replaceChildren(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, '日期'), h('th', { class: 'r' }, '心跳次数'), h('th', { class: 'r' }, '心跳成本'), h('th', { class: 'r' }, '保活节省'), h('th', { class: 'r' }, '净收益'))),
      h('tbody', {}, rows.map(row => h('tr', {},
        h('td', {}, row.day),
        h('td', { class: 'r' }, row.pings),
        h('td', { class: 'r' }, fmtUsd(row.pingCostUsd)),
        h('td', { class: 'r' }, fmtUsd(row.benefitUsd)),
        h('td', { class: 'r' }, fmtUsd(row.benefitUsd - row.pingCostUsd)))))));
    return;
  }
  if (!rows.some(row => row.pings || row.benefitUsd)) {
    host.replaceChildren(h('div', { class: 'empty' }, `${state.days} 天内还没有心跳。到会话列表里对要离开的任务点「保活」。`));
    return;
  }
  const width = Math.max(320, host.clientWidth || 800);
  const plotH = 180;
  const axisBand = 26;
  const left = 48;
  const right = 8;
  const top = 18;
  const plotW = width - left - right;
  const max = niceMax(Math.max(...rows.map(row => Math.max(row.benefitUsd, row.pingCostUsd))));
  const y = value => top + plotH - (value / max) * plotH;
  const root = svg('svg', { viewBox: `0 0 ${width} ${top + plotH + axisBand}`, width, height: top + plotH + axisBand, role: 'img', 'aria-label': '每日心跳成本与保活节省对比柱状图' });
  for (let i = 0; i <= 4; i += 1) {
    const value = (max / 4) * i;
    const yy = y(value);
    root.append(svg('line', { class: i === 0 ? 'baseline' : 'grid-line', x1: left, x2: width - right, y1: yy, y2: yy }));
    const label = svg('text', { class: 'tick', x: left - 8, y: yy + 4, 'text-anchor': 'end' });
    label.textContent = fmtUsd(value);
    root.append(label);
  }
  const slot = plotW / rows.length;
  const barW = Math.max(3, Math.min(24, (slot - 10) / 2));
  const labelEvery = Math.max(1, Math.ceil(44 / slot));
  const best = rows.reduce((acc, row) => (row.benefitUsd > (acc?.benefitUsd || 0) ? row : acc), null);
  rows.forEach((row, index) => {
    const cx = left + slot * index + slot / 2;
    const bars = [
      { value: row.benefitUsd, x: cx - barW - 1, color: 'var(--series-save)' },
      { value: row.pingCostUsd, x: cx + 1, color: 'var(--series-cost)' },
    ];
    for (const bar of bars) {
      if (bar.value <= 0) continue;
      // 非零值至少 2px 可见；精确值见悬浮提示与表格
      const height = Math.max(2, (bar.value / max) * plotH);
      root.append(svg('path', { d: roundedTop(bar.x, top + plotH - height, barW, height, 4), fill: bar.color }));
    }
    if (best && row === best) {
      const label = svg('text', { class: 'bar-label', x: cx - barW / 2 - 1, y: y(row.benefitUsd) - 6, 'text-anchor': 'middle' });
      label.textContent = fmtUsd(row.benefitUsd);
      root.append(label);
    }
    if (index % labelEvery === 0 || index === rows.length - 1) {
      const tick = svg('text', { class: 'tick', x: cx, y: top + plotH + 17, 'text-anchor': 'middle' });
      tick.textContent = fmtDay(row.day);
      root.append(tick);
    }
    const hit = svg('rect', {
      class: 'hit',
      x: left + slot * index,
      y: top,
      width: slot,
      height: plotH,
      tabindex: 0,
      'aria-label': `${row.day}：保活节省 ${fmtUsd(row.benefitUsd)}，心跳成本 ${fmtUsd(row.pingCostUsd)}，心跳 ${row.pings} 次`,
    });
    const show = event => showTooltip(event, row);
    hit.addEventListener('pointermove', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', hideTooltip);
    hit.addEventListener('blur', hideTooltip);
    root.append(hit);
  });
  host.replaceChildren(root);
}

function roundedTop(x, y, w, hgt, r) {
  const radius = Math.min(r, hgt, w / 2);
  const bottom = y + hgt;
  return `M${x},${bottom}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${bottom}Z`;
}

function showTooltip(event, row) {
  const tip = $('#tooltip');
  tip.replaceChildren(
    h('div', { class: 'tt-title' }, row.day),
    h('div', { class: 'tt-row' }, h('i', { class: 'tt-key', style: 'background:var(--series-save)' }), h('b', {}, fmtUsd(row.benefitUsd)), '保活节省'),
    h('div', { class: 'tt-row' }, h('i', { class: 'tt-key', style: 'background:var(--series-cost)' }), h('b', {}, fmtUsd(row.pingCostUsd)), '心跳成本'),
    h('div', { class: 'tt-title', style: 'margin:4px 0 0' }, `${row.pings} 次心跳 · 净 ${fmtUsd(row.benefitUsd - row.pingCostUsd)}`),
  );
  tip.hidden = false;
  const rect = event.target.getBoundingClientRect();
  const x = event.clientX ?? rect.left + rect.width / 2;
  const yPos = event.clientY ?? rect.top + 20;
  const tipRect = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - tipRect.width - 8, x + 14)}px`;
  tip.style.top = `${Math.max(8, yPos - tipRect.height - 10)}px`;
}

function hideTooltip() {
  $('#tooltip').hidden = true;
}

// ------------------------------------------------------------------ 会话

function sessionMatches(view) {
  if (state.onlyWarm && !view.primary?.warm) return false;
  if (!state.search) return true;
  const needle = state.search.toLowerCase();
  return [view.id, view.cwd, view.paseo?.title, view.paseo?.agentId, view.primary?.model].some(text => text && text.toLowerCase().includes(needle));
}

function renderSessions() {
  const list = state.sessions.filter(sessionMatches);
  $('#session-count').textContent = `${list.length} / ${state.sessions.length} 个会话（近 ${Math.max(1, state.days)} 天经过中继）`;
  const host = $('#sessions');
  if (!list.length) {
    host.replaceChildren(h('div', { class: 'empty' }, state.sessions.length ? '没有符合筛选条件的会话' : '还没有经过保活中继的会话。让任务的模型路由指向中继（ANTHROPIC_BASE_URL），发一次请求后就会出现在这里。'));
    return;
  }
  const perSession = new Map((state.summary.sessions || []).map(row => [row.sessionId, row]));
  host.replaceChildren(...list.map(view => sessionRow(view, perSession.get(view.id))));
  tickCountdowns();
}

function sessionRow(view, stats) {
  const p = view.primary;
  const ttlSec = p?.ttl === '1h' ? 3600 : p?.ttl === '5m' ? 300 : 0;
  const title = view.paseo?.title || `会话 ${shortId(view.id)}`;

  const identity = h('div', {},
    h('div', { class: 's-title', title }, title.length > 80 ? `${title.slice(0, 80)}…` : title),
    h('div', { class: 's-meta', title: view.paseo?.agentId ? `Paseo 任务 ID ${view.paseo.agentId}（终端可用 --agent ${shortId(view.paseo.agentId)}）` : undefined }, `${shortPath(view.cwd)} · ${shortId(view.id)}${view.paseo?.agentId ? ` · 任务 ${shortId(view.paseo.agentId)}` : ''}`),
    h('div', { class: 'badges' },
      p ? h('span', { class: 'badge' }, shortModel(p.model)) : null,
      p?.ttl ? h('span', { class: 'badge' }, `TTL ${p.ttl}`) : h('span', { class: 'badge' }, '无缓存断点'),
      view.paseo?.status ? h('span', { class: 'badge' }, `Paseo ${view.paseo.status}`) : null,
      view.agent && view.agent.source !== 'paseo' ? h('span', { class: 'badge', title: view.agent.match === 'session-id' ? '按命令行里的会话 ID 匹配到进程' : '按工作区匹配到进程' }, view.agent.status === 'closed' ? '进程已退出' : '进程在') : null,
      h('span', { class: 'badge', title: '主对话里人发的消息数（不含工具结果、系统注入、压缩摘要）' }, `人工 ${view.humanTurns || 0} 轮`),
      view.lineages.length > 1 ? h('span', { class: 'badge', title: '同一会话里的主对话、子代理与旁路请求' }, `${view.lineages.length} 条请求谱系`) : null));

  const cacheCell = h('div', {},
    h('div', { class: 'cell-label' }, '缓存前缀'),
    h('div', { class: 'cell-value' }, p ? `${fmtTokens(p.contextTokens)} tokens` : '—'));
  if (p && ttlSec) {
    const meter = h('div', { class: 'meter', dataset: { expires: String(p.expiresAt), ttl: String(ttlSec) } }, h('span', { style: 'width:0%' }));
    const text = h('div', { class: 'small muted', dataset: { countdown: String(p.expiresAt), busy: view.busy ? '1' : '' } });
    cacheCell.append(meter, text);
  }
  if (p?.lastPing) {
    const u = p.lastPing.usage;
    cacheCell.append(h('div', { class: 'small' }, statusEl(p.lastPing.outcome, `心跳${OUTCOME[p.lastPing.outcome]?.label || p.lastPing.outcome}`),
      ` ${fmtTime(p.lastPing.at)} · 读 ${fmtTokens(u?.cacheRead)} · 写 ${fmtTokens(u?.cacheWrite)} · ${fmtUsd(p.lastPing.costUsd)}`));
  }
  if (p?.blocked) cacheCell.append(h('div', { class: 'small' }, statusEl({ cls: 'critical', ico: '✗' }, '已锁定'), ` 上次心跳未命中（${p.blocked.detail}）`));
  if (p?.ttlDowngraded) cacheCell.append(h('div', { class: 'small' }, statusEl({ cls: 'warning', ico: '!' }, 'TTL 被降级'), ' 请求标了 1h，上游按 5m 写入'));
  if (p?.pingAnomaly) cacheCell.append(h('div', { class: 'small' }, statusEl({ cls: 'warning', ico: '!' }, '心跳有输出'), ` ${p.pingAnomaly.output} 个输出 token，上游没遵守 max_tokens，已停发`));

  const planCell = h('div', {});
  const auto = view.auto;
  if (auto) {
    const spec = (auto.code === 'keepalive-off' ? AUTO_STATE['keepalive-off'] : AUTO_STATE[auto.state]) || { cls: 'neutral', ico: '·', label: auto.state };
    let detail = '';
    if (auto.state === 'armed') detail = `${fmtTime(auto.dueAt)} 还没有新请求就自动心跳`;
    else if (auto.state === 'pinned') detail = auto.untilAt == null ? '长期' : `到 ${new Date(auto.untilAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
    else if (auto.state === 'active') detail = auto.trigger === 'tool-gap' ? '工具/子代理执行中的空闲' : '空闲中';
    else if (auto.state === 'stopped') detail = `${auto.disabled?.reason || '手动停止'} · ${fmtTime(auto.disabled?.at)}`;
    else if (auto.message || auto.code) detail = auto.message || autoLabel(auto.code);
    planCell.append(h('div', { class: 'auto-line' }, statusEl(spec, `自动：${spec.label}`), detail ? h('span', { class: 'small muted' }, ` ${detail}`) : null));
  }
  if (view.pin) {
    const until = view.pin.untilAt == null ? '长期（直到取消）' : `到 ${new Date(view.pin.untilAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · 剩 ${fmtDuration(view.pin.remainingSec)}`;
    planCell.append(h('div', { class: 'auto-line' }, statusEl({ cls: 'good', ico: '📌' }, '长保活'), h('span', { class: 'small muted' }, ` ${until} · 每 ${fmtInterval(view.pin.intervalSec)} · 只在空闲时发`)));
  }
  const plan = view.plan;
  if (plan) {
    const spec = PLAN_STATUS[plan.status] || { cls: 'neutral', ico: '·', label: plan.status };
    planCell.append(h('div', {}, statusEl(spec, `${SOURCE_LABEL[plan.source] || '手动'}${spec.label} ${plan.done}/${plan.count ?? '∞'}`), h('span', { class: 'small muted' }, ` · 间隔 ${fmtInterval(plan.intervalSec)}`)));
    if (plan.status === 'active') {
      if (plan.count != null) planCell.append(h('div', { class: 'meter' }, h('span', { style: `width:${Math.round((plan.done / plan.count) * 100)}%` })));
      planCell.append(h('div', { class: 'small muted' }, `下一次 ${fmtTime(plan.nextPingAt)}（${planStateText(plan)}）· 已花 ${fmtUsd(plan.costUsd)}${plan.saveUsd != null ? ` · 保住回来可省 ${fmtUsd(plan.saveUsd)}` : ''}`));
    } else {
      planCell.append(h('div', { class: 'small muted' }, `${fmtTime(plan.endedAt)} ${plan.reason || ''} · 花费 ${fmtUsd(plan.costUsd)}`));
    }
  } else {
    planCell.append(h('div', { class: 'small muted' }, '没有保活计划'));
  }
  if (view.economics) {
    const e = view.economics;
    planCell.append(h('div', { class: 'small', style: 'margin-top:6px' },
      `每次心跳 ≈ ${fmtUsd(e.pingUsd)} · 保住回来省 ≈ ${fmtUsd(e.saveUsd)}`));
  }
  if (stats && (stats.pings || stats.keptResumes)) {
    planCell.append(h('div', { class: 'small muted' }, `统计期内：心跳 ${stats.pings} 次 ${fmtUsd(stats.pingCostUsd)} · 生效 ${stats.keptResumes} 次 ${fmtUsd(stats.benefitUsd)}`));
  }

  planCell.prepend(h('div', { class: 'cell-label' }, '保活计划'));
  return h('div', { class: 'session' }, identity, cacheCell, planCell, actionsCell(view));
}

function actionsCell(view) {
  const p = view.primary;
  const check = view.check;
  const id = view.id;
  const busy = state.pending.has(id);
  const draft = key => state.drafts.get(`${id}:${key}`) ?? '';
  const remember = key => event => state.drafts.set(`${id}:${key}`, event.target.type === 'checkbox' ? event.target.checked : event.target.value);
  const maxCount = p?.ttl && state.health?.defaults?.ttl?.[p.ttl]?.maxCount;
  const countInput = h('input', {
    type: 'number',
    min: 1,
    max: maxCount || 12,
    placeholder: check?.count ? `默认 ${check.count}` : '次数',
    value: draft('count'),
    'aria-label': '心跳次数',
    oninput: remember('count'),
  });
  const intervalSelect = h('select', { 'aria-label': '心跳间隔', onchange: remember('interval') },
    (INTERVAL_OPTIONS[p?.ttl] || INTERVAL_OPTIONS['1h']).map(([value, label]) => h('option', { value, selected: draft('interval') === value }, label)));
  const force = h('input', { type: 'checkbox', checked: draft('force') === true, onchange: remember('force') });
  const run = (label, fn) => async () => {
    state.pending.add(id);
    renderSessions();
    try {
      await fn();
    } catch (error) {
      toast(`${label}失败：${error.message}`);
    }
    state.pending.delete(id);
    await refresh();
  };
  const start = run('开启保活', async () => {
    const count = draft('count');
    const result = await api('plans', { method: 'POST', body: { session: id, count: count === '' ? undefined : Number(count), interval: draft('interval') || undefined, force: draft('force') === true, source: 'web' } });
    const item = result.results?.[0];
    if (item?.ok) {
      const e = item.economics;
      toast(`已开启保活：${item.plan.count} 次 × ${fmtInterval(item.plan.intervalSec)}，首次心跳 ${fmtTime(item.plan.nextPingAt)}，覆盖到 ${fmtTime(e?.coveredUntil)}${item.warnings?.length ? `\n${item.warnings.join('\n')}` : ''}`);
    } else {
      toast(`无法保活：\n${(item?.errors || [{ message: result.error }]).map(error => `· ${error.message}${error.soft ? '（勾选「强制」可越过）' : ''}`).join('\n')}`);
    }
  });
  const pingNow = run('立即心跳', async () => {
    const result = await api('ping', { method: 'POST', body: { session: id, force: draft('force') === true, source: 'web' } });
    if (result.errors?.length) {
      toast(`无法发送心跳：\n${result.errors.map(error => `· ${error.message}${error.soft ? '（勾选「强制」可越过）' : ''}`).join('\n')}`);
      return;
    }
    const r = result.result || {};
    toast(`心跳${OUTCOME[r.outcome]?.label || r.outcome}：读 ${fmtTokens(r.usage?.cacheRead)} · 写 ${fmtTokens(r.usage?.cacheWrite)} · 花费 ${fmtUsd(r.costUsd)}${r.error ? `\n${r.error}` : ''}${result.plan?.status !== 'active' && result.plan?.reason ? `\n${result.plan.reason}` : ''}${result.plan?.state === 'retrying' ? `\n网关/上游暂时不可用，${fmtTime(result.plan.nextPingAt)} 自动重试` : ''}`);
  });
  const stop = run('停止保活', async () => {
    const result = await api('plans/stop', { method: 'POST', body: { session: id, source: 'web' } });
    toast(`${result.stopped?.length ? '已停止保活计划' : '没有进行中的计划'}${result.autoDisabled?.length ? '，并关闭了该会话的自动保活（「恢复自动」可重新打开）' : ''}`);
  });
  const setAuto = enabled => run(enabled ? '恢复自动保活' : '关闭自动保活', async () => {
    const result = await api('sessions/auto', { method: 'POST', body: { session: id, enabled, source: 'web' } });
    if (!result.ok) throw new Error(result.error);
    toast(enabled ? '已恢复该会话的自动保活' : '已关闭该会话的自动保活（进行中的计划一并停止）');
  });
  const pinHours = h('input', { type: 'number', min: 1, max: Math.round((state.health?.defaults?.pin?.maxSec || 172800) / 3600), step: 1, value: draft('pinHours') || String(Math.round((state.health?.defaults?.pin?.defaultSec || 43200) / 3600)), 'aria-label': '长保活小时数', oninput: remember('pinHours'), style: 'width:64px' });
  const doPin = async body => {
    const result = await api('sessions/pin', { method: 'POST', body: { session: id, enabled: true, source: 'web', ...body } });
    const item = result.results?.[0];
    if (!item?.ok) {
      toast(`无法设长保活：\n${(item?.errors || [{ message: result.error }]).map(error => `· ${error.message}`).join('\n')}`);
      return;
    }
    const e = item.estimate;
    const bound = e.maxPings == null ? `整天空闲约 ${e.perDayPings} 次 ${fmtUsd(e.perDayUsd)}/天` : `整段都空闲最多 ${e.maxPings} 次 ${fmtUsd(e.maxUsd)}`;
    const until = item.pin.untilAt == null ? '长期保活（直到取消）' : `长保活到 ${new Date(item.pin.untilAt).toLocaleString('zh-CN', { hour12: false })}`;
    toast(`已设${until}：只在空闲时每 ${fmtInterval(item.pin.intervalSec)} 一次，${bound}；人在工作时不发${item.warnings?.length ? `\n${item.warnings.join('\n')}` : ''}`);
  };
  const pin = run('设置长保活', async () => {
    const hours = Number(draft('pinHours') || Math.round((state.health?.defaults?.pin?.defaultSec || 43200) / 3600));
    await doPin({ for: `${hours}h` });
  });
  const pinForever = run('长期保活', async () => {
    if (!window.confirm('长期保活没有到期时刻，每段空闲都会一直心跳到人回来；未命中、任务进程退出、每日额度照常生效。确定？')) return;
    await doPin({ forever: true });
  });
  const unpin = run('取消长保活', async () => {
    const result = await api('sessions/pin', { method: 'POST', body: { session: id, enabled: false, source: 'web' } });
    toast(result.results?.[0]?.changed ? '已取消长保活' : '该会话没有长保活');
  });
  const activePlan = view.plan?.status === 'active';
  const autoState = view.auto?.state;
  const autoButton = autoState === 'stopped'
    ? h('button', { type: 'button', class: 'btn', disabled: busy, onclick: setAuto(true) }, '恢复自动')
    : autoState && autoState !== 'off' ? h('button', { type: 'button', class: 'btn', disabled: busy, title: '整个会话不再自动保活', onclick: setAuto(false) }, '关闭自动') : null;
  const cell = h('div', { class: 'actions' },
    h('div', { class: 'action-row' }, countInput, intervalSelect,
      h('button', { type: 'button', class: 'btn primary', disabled: busy || !p, onclick: start }, activePlan ? '重新保活' : '保活')),
    h('div', { class: 'action-row' },
      h('button', { type: 'button', class: 'btn', disabled: busy || !p, onclick: pingNow }, '立即补一次'),
      activePlan ? h('button', { type: 'button', class: 'btn', disabled: busy, title: '停止计划，并关闭该会话的自动保活', onclick: stop }, '停止') : null,
      autoButton,
      h('label', { class: 'check small', title: '越过软护栏：上下文过小、上次心跳未命中' }, force, '强制')),
    h('div', { class: 'action-row' },
      view.pin
        ? h('button', { type: 'button', class: 'btn', disabled: busy, title: '取消长保活（进行中的心跳计划一并停止）', onclick: unpin }, '取消长保活')
        : [pinHours, h('span', { class: 'small muted' }, '小时'), h('button', { type: 'button', class: 'btn', disabled: busy || !p, title: '期间每段空闲都按间隔心跳直到到期；人在工作时不发；未命中即锁定并取消', onclick: pin }, '长保活'), h('button', { type: 'button', class: 'btn', disabled: busy || !p, title: '没有到期时刻，直到取消；每段空闲都心跳到人回来；未命中、任务进程退出、每日额度照常', onclick: pinForever }, '长期')]));
  if (check && !check.ok && !activePlan) cell.append(h('ul', { class: 'reasons' }, check.errors.map(error => h('li', {}, `${error.message}${error.soft ? '（可强制）' : ''}`))));
  return cell;
}

// 每秒刷新倒计时与剩余进度条，不重绘整块
function tickCountdowns() {
  const now = nowMs();
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const expires = Number(el.dataset.countdown);
    const left = (expires - now) / 1000;
    if (el.dataset.busy) el.textContent = '会话请求进行中';
    else el.textContent = left > 0 ? `剩 ${fmtDuration(left, { seconds: true })} · ${fmtTime(expires)} 过期` : `已过期（${fmtTime(expires)}）`;
  }
  for (const el of document.querySelectorAll('.meter[data-expires]')) {
    const left = (Number(el.dataset.expires) - now) / 1000;
    const ratio = Math.max(0, Math.min(1, left / Number(el.dataset.ttl)));
    el.classList.toggle('warn', ratio > 0 && ratio < 0.17);
    el.classList.toggle('off', ratio <= 0);
    el.firstChild.style.width = `${(ratio * 100).toFixed(1)}%`;
  }
}

// ------------------------------------------------------------------ 事件与机会

function sessionLabel(sid) {
  const view = state.sessions.find(item => item.id === sid);
  const title = view?.paseo?.title;
  return title ? `${title.slice(0, 24)}${title.length > 24 ? '…' : ''}` : shortId(sid);
}

function renderEvents() {
  const host = $('#events');
  const events = state.events.filter(event => event.t !== 'plan' || ['start', 'stopped', 'completed', 'expired'].includes(event.action)).slice(0, 40);
  if (!events.length) {
    host.replaceChildren(h('div', { class: 'empty' }, '暂无事件'));
    return;
  }
  host.replaceChildren(h('ul', { class: 'events' }, events.map(event => {
    let what;
    let amount = '';
    if (event.t === 'global') {
      what = h('span', {}, statusEl(event.action === 'off' ? { cls: 'critical', ico: '■' } : { cls: 'good', ico: '●' }, event.action === 'off' ? `保活全局关闭（停 ${event.stopped} 个计划、取消 ${event.unpinned} 个长保活）` : '保活全局打开'), event.reason ? ` · ${event.reason}` : '');
    } else if (event.t === 'pin') {
      const label = { set: event.untilAt == null ? '设长期保活' : `设长保活到 ${fmtTime(event.untilAt)}`, extend: event.untilAt == null ? '长保活改为长期' : `延长长保活到 ${fmtTime(event.untilAt)}`, unset: '取消长保活', expired: '长保活到期', cancelled: '长保活取消', 'missed-window': '长保活：本段空闲已超安全窗口，等下一次请求', 'agent-closed': '长保活：任务进程已退出，本段空闲不发' }[event.action] || event.action;
      what = h('span', {}, statusEl({ cls: event.action === 'set' || event.action === 'extend' ? 'good' : 'neutral', ico: '📌' }, label), ` ${sessionLabel(event.sid)}${event.reason ? ` · ${event.reason}` : ''}`);
    } else if (event.t === 'ping') {
      what = h('span', {}, statusEl(event.outcome, `${event.source === 'auto' ? '自动' : event.source === 'pin' ? '长保活' : ''}心跳${OUTCOME[event.outcome]?.label || event.outcome}`), ` ${sessionLabel(event.sid)} · 读 ${fmtTokens(event.usage?.cacheRead)}${event.usage?.cacheWrite ? ` · 写 ${fmtTokens(event.usage.cacheWrite)}` : ''}${event.error ? ` · ${event.error}` : ''}`);
      amount = fmtUsd(-(event.costUsd || 0));
    } else if (event.t === 'auto' && event.action) {
      const label = { enable: '恢复自动保活', disable: '关闭自动保活', cooldown: `自动保活暂停到 ${fmtTime(event.until)}` }[event.action] || event.action;
      what = h('span', {}, statusEl({ cls: event.action === 'cooldown' ? 'warning' : 'neutral', ico: event.action === 'enable' ? '▶' : '■' }, label), ` ${sessionLabel(event.sid)}${event.reason ? ` · ${event.reason}` : ''}`);
    } else if (event.t === 'auto') {
      what = event.ok
        ? h('span', {}, statusEl({ cls: 'good', ico: '◉' }, '自动保活开始'), ` ${sessionLabel(event.sid)} · 前缀 ${fmtTokens(event.contextTokens)} · 人工 ${event.humanTurns} 轮${event.code === 'tool-gap' ? ' · 工具执行中' : ''}`)
        : h('span', {}, statusEl({ cls: 'neutral', ico: '○' }, '本段不自动保活'), ` ${sessionLabel(event.sid)} · ${event.message || autoLabel(event.code)}`);
    } else if (event.t === 'req' && event.resume) {
      const kept = event.resume.kept;
      what = h('span', {}, statusEl(kept ? { cls: 'good', ico: '✓' } : { cls: 'neutral', ico: '○' }, kept ? '保活生效' : '心跳没起作用'),
        ` ${sessionLabel(event.sid)} · ${RESUME_REASON[event.resume.reason] || event.resume.reason}${kept ? ` · 少写 ${fmtTokens(event.resume.savedTokens)}` : ''}`);
      amount = kept ? fmtUsd(event.resume.benefitUsd, { sign: true }) : '';
    } else if (event.t === 'req' && event.cold) {
      what = h('span', {}, statusEl({ cls: 'neutral', ico: '❄' }, '冷启动重写'), ` ${sessionLabel(event.sid)} · 空闲 ${fmtDuration(event.gapSec)} · 写 ${fmtTokens(event.cold.rewriteTokens)}`);
      amount = fmtUsd(event.cold.rewriteUsd);
    } else if (event.t === 'plan') {
      if ((event.source === 'auto' || event.source === 'pin') && event.action === 'start') return null;
      const label = { start: `开启保活 ${event.count} 次 × ${fmtInterval(event.intervalSec)}`, stopped: '计划停止', completed: '计划完成', expired: '计划过期' }[event.action];
      what = h('span', {}, statusEl({ cls: event.action === 'stopped' ? 'serious' : 'neutral', ico: event.action === 'start' ? '▶' : '■' }, label), ` ${sessionLabel(event.sid)}${event.reason ? ` · ${event.reason}` : ''}`);
    } else {
      return null;
    }
    return h('li', {}, h('span', { class: 't' }, fmtTime(event.at)), what, h('span', { class: 'amt' }, amount));
  })));
}

function renderOpportunities() {
  const host = $('#opportunities');
  const items = (state.summary.opportunities || []).slice(0, 12);
  if (!items.length) {
    host.replaceChildren(h('div', { class: 'empty' }, '统计期内没有超过 TTL 的整段重写'));
    return;
  }
  host.replaceChildren(h('table', { class: 'data' },
    h('thead', {}, h('tr', {},
      h('th', {}, '时间'), h('th', {}, '会话'), h('th', { class: 'r' }, '空闲'), h('th', { class: 'r' }, '重写'), h('th', { class: 'r' }, '重写花费'), h('th', { class: 'r' }, '需心跳'), h('th', { class: 'r' }, '可省'), h('th', {}, '自动保活当时'))),
    h('tbody', {}, items.map(item => h('tr', {},
      h('td', {}, `${new Date(item.at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${fmtTime(item.at)}`),
      h('td', { title: item.cwd || '' }, sessionLabel(item.sessionId)),
      h('td', { class: 'r' }, fmtDuration(item.gapSec)),
      h('td', { class: 'r' }, fmtTokens(item.rewriteTokens)),
      h('td', { class: 'r' }, fmtUsd(item.rewriteUsd)),
      h('td', { class: 'r' }, item.coverable ? `${item.pingsNeeded} 次${item.coverableByAuto === false ? `（超自动 ${item.autoCount} 次）` : ''}` : `${item.pingsNeeded} 次（超上限）`),
      h('td', { class: 'r' }, item.coverable ? fmtUsd(item.potentialSavingUsd) : '—'),
      h('td', { class: 'small' }, item.auto ? (item.auto.ok ? '开了，但离开太久没保住' : autoLabel(item.auto.code)) : '没有判定记录'))))));
}

// ------------------------------------------------------------------ 保活执行记录

function episodeMatches(episode) {
  if (!state.episodesAll && (episode.outcome === 'pending' || episode.outcome === 'expired-unused' || episode.outcome === 'no-pings') && !episode.active) return false;
  if (state.onlyWarm) {
    const view = state.sessions.find(item => item.id === episode.sessionId);
    if (!view?.primary?.warm) return false;
  }
  if (!state.search) return true;
  const needle = state.search.toLowerCase();
  return [episode.sessionId, episode.cwd, episode.paseo?.title, episode.paseo?.agentId, episode.model].some(text => text && String(text).toLowerCase().includes(needle));
}

function amountEl(value, { zero = '—' } = {}) {
  if (!value) return h('span', { class: 'muted' }, zero);
  return h('span', { class: value > 0 ? 'amt-pos' : 'amt-neg' }, fmtUsd(value, { sign: true }));
}

function pingDots(episode) {
  const dots = episode.pings.map(ping => {
    const spec = OUTCOME[ping.outcome] || { ico: '·', label: ping.outcome };
    return h('span', { class: `dot ${ping.outcome}`, title: `${fmtTime(ping.at)} ${spec.label}${ping.cacheRead != null ? ` · 读 ${fmtTokens(ping.cacheRead)} · 写 ${fmtTokens(ping.cacheWrite)}` : ''} · ${fmtUsd(ping.costUsd)}${ping.estimated ? '（估）' : ''}` }, spec.ico === '✓' ? '' : spec.ico);
  });
  const planned = Math.max(0, (episode.count || 0) - episode.pings.length);
  for (let i = 0; i < Math.min(planned, 12); i += 1) dots.push(h('span', { class: 'dot todo', title: episode.active ? '待发' : '未发出（计划提前结束）' }));
  return h('span', { class: 'pings', 'aria-label': `${episode.pings.length} 次心跳` }, dots);
}

function renderEpisodes() {
  const host = $('#episodes');
  const data = state.episodes;
  if (!data) return;
  const all = data.episodes || [];
  const list = all.filter(episodeMatches);
  const t = data.totals || {};
  $('#episodes-summary').textContent = `${state.days === 1 ? '今天' : `近 ${state.days} 天`}：${t.episodes || 0} 段（自动 ${t.auto || 0} · 手动 ${t.manual || 0}${t.pin ? ` · 长保活 ${t.pin}` : ''}）· 心跳 ${t.pings || 0} 次 ${fmtUsd(t.pingCostUsd || 0)}${t.pingCostEstimatedUsd ? `（含预估 ${fmtUsd(t.pingCostEstimatedUsd)}）` : ''} · 收益 ${fmtUsd(t.benefitUsd || 0)} · 净 ${fmtUsd(t.netUsd || 0)}`;
  const byOutcome = Object.entries(t.byOutcome || {}).sort((a, b) => b[1] - a[1]);
  const summaryBar = h('div', { class: 'ep-summary' }, byOutcome.map(([code, n]) => {
    const spec = EPISODE_OUTCOME[code] || { cls: 'neutral', ico: '·', label: code };
    return h('span', {}, statusEl(spec, `${spec.label} `), h('b', {}, String(n)));
  }));
  if (!list.length) {
    host.replaceChildren(summaryBar, h('div', { class: 'empty' }, all.length ? '没有符合筛选条件的记录（勾选「包含进行中 / 没回来的」或清空搜索）' : `${state.days === 1 ? '今天' : `近 ${state.days} 天`}还没有保活记录`));
    return;
  }
  const rows = [];
  for (const episode of list.slice(0, 120)) {
    const spec = episode.active ? { cls: 'good', ico: '◉', label: '进行中' } : EPISODE_OUTCOME[episode.outcome] || { cls: 'neutral', ico: '·', label: episode.outcome };
    const title = episode.paseo?.title || shortPath(episode.cwd) || shortId(episode.sessionId);
    const open = state.openEpisodes.has(episode.planId);
    const detailId = `ep-${episode.planId}`;
    const resumeText = episode.resume
      ? `回来 ${fmtTime(episode.resume.at)}（空闲 ${fmtDuration(episode.resume.gapSec)}${episode.resume.kept ? `，少写 ${fmtTokens(episode.resume.savedTokens)}` : ''}）`
      : episode.end?.reason && !episode.active ? episode.end.reason : '';
    const row = h('tr', {
      class: 'ep-row',
      tabindex: 0,
      'aria-expanded': String(open),
      'aria-controls': detailId,
      onclick: () => toggleEpisode(episode.planId),
      onkeydown: event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleEpisode(episode.planId);
        }
      },
    },
    h('td', {}, `${new Date(episode.startedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${fmtTime(episode.startedAt)}`),
    h('td', { title: `${episode.sessionId}\n${episode.cwd || ''}` }, h('div', {}, title.length > 36 ? `${title.slice(0, 36)}…` : title), h('div', { class: 'small muted' }, `${shortId(episode.sessionId)} · ${shortModel(episode.model)}${episode.ttl ? ` · ${episode.ttl}` : ''}`)),
    h('td', {}, `${SOURCE_LABEL[episode.source] || '手动'}${episode.trigger === 'tool-gap' ? '（工具空闲）' : ''}${episode.forced ? ' · 强制' : ''}`),
    h('td', {}, h('div', {}, pingDots(episode)), h('div', { class: 'small muted' }, `${episode.pings.length}/${episode.count ?? (episode.source === 'pin' ? '∞' : '?')} 次 · 间隔 ${fmtInterval(episode.intervalSec || 0)}`)),
    h('td', { class: 'r' }, fmtUsd(-episode.pingCostUsd), episode.pingCostEstimatedUsd ? h('div', { class: 'small muted' }, `含估 ${fmtUsd(episode.pingCostEstimatedUsd)}`) : null),
    h('td', { class: 'r', title: '这段前缀保住后、人按时回来能省的整段重写费' }, episode.expectedSaveUsd != null ? fmtUsd(episode.expectedSaveUsd) : '—', episode.contextTokens ? h('div', { class: 'small muted' }, `${fmtTokens(episode.contextTokens)} tokens`) : null),
    h('td', {}, statusEl(spec), resumeText ? h('div', { class: 'small muted' }, resumeText) : null),
    h('td', { class: 'r' }, amountEl(episode.benefitUsd)),
    h('td', { class: 'r' }, amountEl(episode.netUsd, { zero: '0' })));
    rows.push(row);
    rows.push(h('tr', { class: 'ep-detail', id: detailId, hidden: !open }, h('td', { colspan: 9 },
      h('div', { class: 'small muted' }, `计划 ${episode.planId} · 开始 ${new Date(episode.startedAt).toLocaleString('zh-CN', { hour12: false })}${episode.idleStartAt ? ` · 空闲从 ${fmtTime(episode.idleStartAt)} 开始` : ''}${episode.end ? ` · ${fmtTime(episode.end.at)} ${PLAN_STATUS[episode.end.status]?.label || episode.end.status}${episode.end.reason ? `：${episode.end.reason}` : ''}` : ''}`),
      episode.resume ? h('div', { class: 'small' }, statusEl(episode.resume.kept ? { cls: 'good', ico: '✓' } : { cls: 'neutral', ico: '○' }, RESUME_REASON[episode.resume.reason] || episode.resume.reason), ` · 回来 ${new Date(episode.resume.at).toLocaleString('zh-CN', { hour12: false })}，距上次真实请求 ${fmtDuration(episode.resume.gapSec)}${episode.resume.kept ? ` · 少写 ${fmtTokens(episode.resume.savedTokens)} tokens，收益 ${fmtUsd(episode.resume.benefitUsd)}` : ''}`) : null,
      episode.pings.length ? h('ul', { class: 'ep-pings' }, episode.pings.map(ping => h('li', {},
        h('span', { class: 't' }, fmtTime(ping.at)),
        statusEl(ping.outcome, OUTCOME[ping.outcome]?.label || ping.outcome),
        h('span', {}, ping.cacheRead != null ? `读 ${fmtTokens(ping.cacheRead)} · 写 ${fmtTokens(ping.cacheWrite)} · 出 ${ping.output ?? 0}${ping.expected ? ` · 预期 ${fmtTokens(ping.expected)}` : ''}` : (ping.error || `HTTP ${ping.status ?? '—'}`)),
        h('span', { class: 'r' }, fmtDuration((ping.ms || 0) / 1000, { seconds: true })),
        h('span', { class: 'r' }, `${fmtUsd(ping.costUsd)}${ping.estimated ? '（估）' : ''}`)))) : h('div', { class: 'small muted' }, '没有发出心跳'))));
  }
  host.replaceChildren(summaryBar, h('table', { class: 'data episodes' },
    h('thead', {}, h('tr', {}, h('th', {}, '开始'), h('th', {}, '任务 / 会话'), h('th', {}, '来源'), h('th', {}, '心跳'), h('th', { class: 'r' }, '心跳花费'), h('th', { class: 'r' }, '回来可省'), h('th', {}, '结局'), h('th', { class: 'r' }, '实际收益'), h('th', { class: 'r' }, '净'))),
    h('tbody', {}, rows)),
  list.length > 120 ? h('div', { class: 'small muted', style: 'margin-top:8px' }, `只显示最近 120 段，共 ${list.length} 段；用搜索缩小范围`) : null);
}

function toggleEpisode(planId) {
  if (state.openEpisodes.has(planId)) state.openEpisodes.delete(planId);
  else state.openEpisodes.add(planId);
  renderEpisodes();
}

// ------------------------------------------------------------------ 回测

async function loadBacktest({ refresh: force = false, grid = state.backtest.grid } = {}) {
  const days = Math.min(35, state.days);
  state.backtest = { ...state.backtest, loading: true, error: null, grid };
  renderBacktest();
  try {
    const result = await api(`backtest?days=${days}${grid ? '&grid=1' : ''}${force ? '&refresh=1' : ''}`);
    if (!result.ok) throw new Error(result.error);
    state.backtest = { ...state.backtest, data: result, loading: false, key: `${days}:${grid}` };
  } catch (error) {
    state.backtest = { ...state.backtest, loading: false, error: error.message };
  }
  renderBacktest();
}

function renderBacktest() {
  const host = $('#backtest');
  const bt = state.backtest;
  const button = $('#backtest-run');
  button.disabled = bt.loading;
  button.textContent = bt.loading ? '回测中…' : bt.data ? '重新回测' : '运行回测';
  if (bt.error) {
    host.replaceChildren(h('div', { class: 'empty' }, `回测失败：${bt.error}`));
    return;
  }
  if (!bt.data) {
    host.replaceChildren(h('div', { class: 'empty' }, bt.loading ? '正在读取会话记录…' : '点「运行回测」：用本机会话记录估算，如果一直按当前设置自动保活，会发多少心跳、救回多少重写。'));
    return;
  }
  const r = bt.data.result;
  const t = r.totals;
  const labels = r.labels || {};
  const order = ['kept', 'kept-no-rewrite', 'redundant', 'expired', 'no-return', 'missed', 'skipped', 'pending'];
  const outcomes = order.filter(key => t.outcomes?.[key]).map(key => [key, t.outcomes[key]]);
  const missed = Object.entries(t.missedByReason || {}).sort((x, y) => y[1].usd - x[1].usd);
  const top = (r.sessions || []).filter(row => row.pings || row.coldUsd).slice(0, 8);
  host.replaceChildren(
    h('div', { class: 'kpis compact' },
      kpi('净收益', fmtUsd(t.netUsd), `救回 ${t.kept} 次 ${fmtUsd(t.benefitUsd)} − 心跳 ${fmtUsd(t.pingUsd)}`, { hero: true }),
      kpi('心跳', `${t.pings} 次`, `有用 ${t.usefulPings} · 白发 ${t.wastedPings}（${fmtUsd(t.wastedUsd)}）`),
      kpi('ROI', t.roi == null ? '—' : `${t.roi.toFixed(1)}×`, '救回 ÷ 心跳花费'),
      kpi('不保活时的重写', fmtUsd(t.coldUsd), `${t.coldStarts} 次；开了之后仍要重写 ${t.missed} 次 ${fmtUsd(t.missedUsd)}`)),
    h('p', { class: 'small muted' }, `近 ${r.days} 天 · ${t.sessions} 个 1h 会话 · ${t.idleGaps} 段超过 50 分钟的空闲 · ${bt.data.cached ? `缓存于 ${fmtTime(bt.data.at)}` : `计算于 ${fmtTime(bt.data.at)}`}。心跳按全部命中计。`),
    h('div', { class: 'grid2 tight' },
      h('div', {}, h('div', { class: 'cell-label' }, '每段空闲的结局'),
        h('table', { class: 'data' }, h('tbody', {}, outcomes.map(([key, n]) => h('tr', {}, h('td', {}, labels[key] || key), h('td', { class: 'r' }, `${n} 段`)))))),
      h('div', {}, h('div', { class: 'cell-label' }, '开了之后仍要重写的原因'),
        missed.length
          ? h('table', { class: 'data' }, h('tbody', {}, missed.map(([code, v]) => h('tr', {}, h('td', {}, code === 'coverage' ? '离开太久，超出覆盖' : autoLabel(code)), h('td', { class: 'r' }, `${v.count} 次`), h('td', { class: 'r' }, fmtUsd(v.usd))))))
          : h('div', { class: 'small muted' }, '—'))),
    top.length ? h('details', { class: 'sub-details' }, h('summary', {}, `按会话（${top.length}）`),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, '会话'), h('th', {}, '模型'), h('th', { class: 'r' }, '空闲段'), h('th', { class: 'r' }, '心跳'), h('th', { class: 'r' }, '救回'), h('th', { class: 'r' }, '净'))),
        h('tbody', {}, top.map(row => h('tr', {},
          h('td', { title: row.cwd || '' }, `${shortId(row.sid)} ${shortPath(row.cwd)}`),
          h('td', {}, shortModel(row.model)),
          h('td', { class: 'r' }, row.idleGaps),
          h('td', { class: 'r' }, `${row.pings} 次 ${fmtUsd(row.pingUsd)}`),
          h('td', { class: 'r' }, `${row.kept} 次 ${fmtUsd(row.benefitUsd)}`),
          h('td', { class: 'r' }, fmtUsd(row.netUsd))))))) : null,
    r.variants ? h('details', { class: 'sub-details', open: true }, h('summary', {}, '参数对比（同一份数据、同一套判定）'),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, '规则'), h('th', { class: 'r' }, '心跳'), h('th', { class: 'r' }, '白发'), h('th', { class: 'r' }, '救回'), h('th', { class: 'r' }, '净收益'))),
        h('tbody', {}, r.variants.map(v => h('tr', {},
          h('td', {}, v.label),
          h('td', { class: 'r' }, `${v.totals.pings} 次 ${fmtUsd(v.totals.pingUsd)}`),
          h('td', { class: 'r' }, v.totals.pings ? `${Math.round((v.totals.wastedPings / v.totals.pings) * 100)}%` : '—'),
          h('td', { class: 'r' }, `${v.totals.kept} 次 ${fmtUsd(v.totals.benefitUsd)}`),
          h('td', { class: 'r' }, fmtUsd(v.totals.netUsd))))))) : h('button', { type: 'button', class: 'ghost small', onclick: () => loadBacktest({ grid: true }) }, '展开参数对比'),
  );
}

// ------------------------------------------------------------------ 交互

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 7000);
}

function bindControls() {
  for (const button of document.querySelectorAll('#range button')) {
    button.addEventListener('click', () => {
      state.days = Number(button.dataset.days);
      for (const other of document.querySelectorAll('#range button')) other.setAttribute('aria-checked', String(other === button));
      refresh();
    });
  }
  $('#search').addEventListener('input', event => {
    state.search = event.target.value.trim();
    renderSessions();
    renderEpisodes();
  });
  $('#only-warm').addEventListener('change', event => {
    state.onlyWarm = event.target.checked;
    renderSessions();
    renderEpisodes();
  });
  $('#episodes-all').addEventListener('change', event => {
    state.episodesAll = event.target.checked;
    renderEpisodes();
  });
  $('#chart-toggle').addEventListener('click', () => {
    state.chartAsTable = !state.chartAsTable;
    renderChart();
  });
  $('#backtest-run').addEventListener('click', () => loadBacktest({ refresh: Boolean(state.backtest.data) }));
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.summary && renderChart(), 150);
  });
}

bindControls();
refresh();
setInterval(refresh, REFRESH_MS);
setInterval(tickCountdowns, 1000);
