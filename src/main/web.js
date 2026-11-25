'use strict';
// Local / remote Web UI server for TermClaw: serves the same renderer bundle over HTTP
// with a small window.termclaw bridge (POST /api + SSE /events) protected by an access token.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const DIST_DIR = path.join(ROOT, 'dist');
const COOKIE_NAME = 'termclaw_web';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const WEB_BRIDGE_JS = `'use strict';
(() => {
  if (window.termclaw) return;
  const listeners = new Map();
  let es = null;
  let retryMs = 500;

  function connectEvents() {
    if (es) { try { es.close(); } catch {} }
    es = new EventSource('/events');
    es.onopen = () => { retryMs = 500; };
    es.onmessage = (ev) => {
      try {
        const { channel, payload } = JSON.parse(ev.data);
        for (const cb of listeners.get(channel) || []) {
          try { cb(payload); } catch (err) { console.error(err); }
        }
      } catch {}
    };
    es.onerror = () => {
      try { es.close(); } catch {}
      es = null;
      setTimeout(connectEvents, retryMs);
      retryMs = Math.min(10000, retryMs * 2);
    };
  }
  connectEvents();

  window.termclaw = {
    isWeb: true,
    async call(method, ...args) {
      const r = await fetch('/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      });
      if (r.status === 401) {
        location.reload();
        throw new Error('Authentication required');
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
      return data.result;
    },
    pathForFile() { return ''; },
    on(channel, cb) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(cb);
      return () => listeners.get(channel).delete(cb);
    },
  };
})();
`;

function loginHtml(error = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TermClaw — Sign in</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #141414; color: #e4e4e4; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .card { width: min(400px, calc(100vw - 32px)); background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 24px; }
    h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
    p { margin: 0 0 16px; color: #a3a3a3; font-size: 13px; }
    input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #2a2a2a; background: #141414; color: #e4e4e4; font: 13px "SF Mono", Menlo, Consolas, monospace; margin-bottom: 12px; }
    input:focus { outline: 1px solid #3a6fd1; border-color: #3a6fd1; }
    button { width: 100%; padding: 8px 12px; border-radius: 6px; border: none; background: #ececec; color: #141414; font: 600 13px inherit; cursor: pointer; }
    button:hover { background: #fff; }
    .err { color: #f85149; font-size: 12px; margin: -4px 0 12px; }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/auth">
    <h1>TermClaw Web</h1>
    <p>Enter the Web UI access token from TermClaw Settings (or open the full URL with <code>?token=…</code>).</p>
    <input name="token" type="password" placeholder="Access token" autocomplete="off" autofocus required />
    ${error ? `<div class="err">${error}</div>` : ''}
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('Request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function renderIndexHtml() {
  const raw = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  return raw
    .replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/i,
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:; connect-src \'self\'" />',
    )
    .replace('../../dist/renderer.css', '/dist/renderer.css')
    .replace('href="styles.css"', 'href="/styles.css"')
    .replace('<script src="../../dist/renderer.js"></script>', '<script src="/web-bridge.js"></script>\n  <script src="/dist/renderer.js"></script>');
}

class WebServer {
  constructor({ store, api, audit, overrides = {} }) {
    this.store = store;
    this.api = api;
    this.audit = audit;
    this.overrides = overrides; // { enabled, port, bind } from CLI / env
    this.server = null;
    this.clients = new Set(); // active SSE responses
    this.pingTimer = null;
    this.status = { running: false, url: '', bind: '127.0.0.1', port: 47901, error: '' };
  }

  effectiveConfig() {
    const cfg = (this.store.settings && this.store.settings.web) || {};
    const enabled = this.overrides.enabled != null ? !!this.overrides.enabled : !!cfg.enabled;
    const port = Number(this.overrides.port || cfg.port) || 47901;
    const bind = String(this.overrides.bind || cfg.bind || '127.0.0.1').trim() || '127.0.0.1';
    return { enabled, port, bind };
  }

  token() {
    return this.store.getWebToken();
  }

  _isAuthed(req) {
    const tok = this.token();
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), tok)) return true;
    const cookies = parseCookies(req.headers.cookie);
    return safeEqual(cookies[COOKIE_NAME], tok);
  }

  _setCookieHeader(tok) {
    return `${COOKIE_NAME}=${encodeURIComponent(tok)}; HttpOnly; Path=/; SameSite=Lax`;
  }

  async start() {
    const { enabled, port, bind } = this.effectiveConfig();
    if (!enabled) {
      this.stop();
      this.status = { running: false, url: '', bind, port, error: '' };
      return this.status;
    }
    this.stop();
    const srv = http.createServer((req, res) => this._handle(req, res));
    this.server = srv;
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, bind, resolve);
      });
      const addr = srv.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      const hostForUrl = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
      this.status = { running: true, url: `http://${hostForUrl}:${actualPort}`, bind, port: actualPort, error: '' };
      this.pingTimer = setInterval(() => {
        for (const res of this.clients) {
          try { res.write(': ping\n\n'); } catch { this.clients.delete(res); }
        }
      }, 25000);
      if (this.audit) this.audit.add({ source: 'app', action: 'web.start', detail: `${bind}:${actualPort}` });
    } catch (e) {
      this.server = null;
      this.status = { running: false, url: '', bind, port, error: e.message };
    }
    return this.status;
  }

  stop() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const res of this.clients) { try { res.end(); } catch {} }
    this.clients.clear();
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
    this.status = { ...this.status, running: false, url: '' };
  }

  async restart() {
    this.stop();
    return this.start();
  }

  broadcast(channel, payload) {
    if (!this.clients.size) return;
    let line;
    try { line = `data: ${JSON.stringify({ channel, payload })}\n\n`; } catch { return; }
    for (const res of this.clients) {
      try { res.write(line); } catch { this.clients.delete(res); }
    }
  }

  async _handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      // Token sign-in via query parameter: /?token=<tok> → set HttpOnly cookie and redirect cleanly to /.
      if (req.method === 'GET' && pathname === '/' && url.searchParams.has('token')) {
        const supplied = url.searchParams.get('token') || '';
        if (safeEqual(supplied, this.token())) {
          res.writeHead(302, { 'set-cookie': this._setCookieHeader(this.token()), location: '/' });
          res.end();
          return;
        }
        res.writeHead(401, { 'content-type': MIME['.html'] });
        res.end(loginHtml('Invalid access token.'));
        return;
      }

      // Form login: POST /auth
      if (req.method === 'POST' && pathname === '/auth') {
        const raw = await readBody(req, 8192);
        const params = new URLSearchParams(raw);
        const supplied = (params.get('token') || '').trim();
        if (safeEqual(supplied, this.token())) {
          res.writeHead(302, { 'set-cookie': this._setCookieHeader(this.token()), location: '/' });
          res.end();
          return;
        }
        res.writeHead(401, { 'content-type': MIME['.html'] });
        res.end(loginHtml('Invalid access token.'));
        return;
      }

      if (req.method === 'POST' && pathname === '/logout') {
        res.writeHead(200, { 'set-cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`, 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      // Everything else requires authentication.
      if (!this._isAuthed(req)) {
        if (pathname === '/api' || pathname === '/events') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication required' }));
        } else {
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(loginHtml());
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(renderIndexHtml());
        return;
      }

      if (req.method === 'GET' && pathname === '/web-bridge.js') {
        res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
        res.end(WEB_BRIDGE_JS);
        return;
      }

      if (req.method === 'GET' && pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }

      if (req.method === 'POST' && pathname === '/api') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        const method = body && body.method;
        const args = Array.isArray(body && body.args) ? body.args : [];
        const fn = typeof method === 'string' && Object.prototype.hasOwnProperty.call(this.api, method) ? this.api[method] : null;
        if (!fn) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown API method ' + method }));
          return;
        }
        try {
          const result = await fn(...args);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: result === undefined ? null : result }));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
        }
        return;
      }

      // Static renderer & dist files
      if (req.method === 'GET') {
        const map = {
          '/styles.css': path.join(RENDERER_DIR, 'styles.css'),
          '/dist/renderer.js': path.join(DIST_DIR, 'renderer.js'),
          '/dist/renderer.css': path.join(DIST_DIR, 'renderer.css'),
          '/dist/renderer.js.map': path.join(DIST_DIR, 'renderer.js.map'),
          '/dist/renderer.css.map': path.join(DIST_DIR, 'renderer.css.map'),
        };
        const file = map[pathname];
        if (file && fs.existsSync(file)) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
    }
  }
}

module.exports = { WebServer, parseCookies, renderIndexHtml };
