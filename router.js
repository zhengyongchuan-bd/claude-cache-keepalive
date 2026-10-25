// 可选：把 /keepalive/ 挂到你自己的 Express 总入口下，页面与 API 都转发给常驻的保活中继。
// 中继独立运行（在 Claude Code 的请求链路上，不能依赖总入口的生命周期）。

import http from 'node:http';

const HOP_BY_HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

export function createRouter({ relayUrl = process.env.CACHE_KEEPALIVE_URL || 'http://127.0.0.1:18110' } = {}) {
  const target = new URL(relayUrl);
  return (req, res) => {
    // 写操作在这里先做同源校验，再以中继自己的 Host 转发（中继只认回环 Host）
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let originHost = '';
      try {
        originHost = new URL(req.headers.origin).host;
      } catch { /* 非法 Origin */ }
      if (originHost !== req.headers.host) {
        res.status(403).json({ ok: false, error: `跨站请求被拒绝: ${req.headers.origin}` });
        return;
      }
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && name !== 'host' && name !== 'origin' && name !== 'referer') headers[name] = value;
    }
    headers.host = target.host;
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `/keepalive${req.url}`,
      headers,
    }, upstreamRes => {
      const out = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
      res.writeHead(upstreamRes.statusCode || 502, out);
      upstreamRes.pipe(res);
    });
    upstream.on('error', error => {
      if (res.headersSent) return res.destroy();
      res.status(502).type('html').send(`<!doctype html><meta charset="utf-8"><title>缓存保活</title>
<body style="font-family:sans-serif;background:#0f1115;color:#e6e8ee;padding:40px">
<h2>保活中继未运行</h2><p>连不上 ${target.origin}（${error.code || error.message}）。</p>
<p>运行 <code>node cache-keepalive/cli.js install</code>（systemd --user 常驻）或 <code>node cache-keepalive/cli.js serve</code>。</p></body>`);
      return undefined;
    });
    req.pipe(upstream);
  };
}
