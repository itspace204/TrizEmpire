/* TrizEmpire — local-first, zero-dependency Node.js operator server.
 * Run with Node.js 20+. Binds loopback by default; refuses a non-loopback
 * bind unless ALLOW_REMOTE_HOST=true AND authentication is configured.
 *
 * Responsibilities:
 *   - static delivery of the operator UI (allowlisted paths only)
 *   - server-side auth (scrypt env hashes, sessions, rate limiting, CSRF)
 *   - server-side Hermes proxy for live status (single fixed upstream path)
 *   - health endpoints (/healthz public-minimal, /api/health/detail authorized)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { applySecurityHeaders } = require('./lib/security');
const {
  verifyCredentials, SessionStore, RateLimiter,
  parseCookies, sessionCookie, clearedCookie, isSameOrigin, hasCsrfHeader,
} = require('./lib/auth');
const { loadEnvFile, resolveConfig } = require('./lib/config');
const hermesProxy = require('./lib/hermes');

const DEFAULT_ROOT = __dirname;
const SESSION_COOKIE = 'triz_session';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

/* Only these top-level entries of the app directory are ever served. */
const STATIC_ALLOWLIST = new Set(['index.html', 'vendor', 'crew']);

function send(res, status, body, type = 'text/plain; charset=utf-8', method = 'GET') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, obj, method = 'GET') {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', method);
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function clientKey(req) {
  return req.socket.remoteAddress || 'unknown';
}

function resolveOptions(options = {}, env = process.env) {
  const cfg = resolveConfig(options, env);
  cfg.sessions = options.sessions || new SessionStore({
    idleMs: cfg.sessionIdleMs,
    absoluteMs: cfg.sessionAbsoluteMs,
  });
  cfg.loginLimiter = options.loginLimiter || new RateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  cfg.statusLimiter = options.statusLimiter || new RateLimiter({ max: 120, windowMs: 60 * 1000 });
  delete cfg.sessionIdleMs;
  delete cfg.sessionAbsoluteMs;
  return cfg;
}

function createServer(options = {}) {
  const cfg = resolveOptions(options);
  const safeRoot = path.resolve(cfg.root);

  const getSession = req => cfg.sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  const requireAuth = (req, res) => {
    if (!cfg.authRequired) return { ok: true, session: null };
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { error: 'authentication_required' }, req.method);
      return { ok: false };
    }
    return { ok: true, session };
  };

  const requireCsrf = (req, res) => {
    if (!cfg.authRequired) return true;
    if (!hasCsrfHeader(req) || !isSameOrigin(req)) {
      sendJson(res, 403, { error: 'csrf_check_failed' }, req.method);
      return false;
    }
    return true;
  };

  return http.createServer((req, res) => {
    applySecurityHeaders(res);

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(res, 400, 'Bad request', undefined, req.method);
    }

    const method = req.method;

    /* ── public health (minimal, no operational detail) ── */
    if (pathname === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      return sendJson(res, 200, { status: 'ok' }, method);
    }

    /* ── public config for the UI bootstrap ── */
    if (pathname === '/api/config') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      return sendJson(res, 200, {
        hermesPublicUrl: cfg.hermesPublicUrl || null,
        auth: { required: cfg.authRequired, users: cfg.users.map(u => u.username) },
      });
    }

    /* ── auth API ── */
    if (pathname === '/api/auth/login') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      if (!isSameOrigin(req)) {
        return sendJson(res, 403, { error: 'cross_origin_rejected' });
      }
      const key = clientKey(req);
      const limit = cfg.loginLimiter.check(key);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'too_many_attempts' });
      }
      return readJsonBody(req)
        .then(body => {
          const identity = verifyCredentials(cfg.users, body.username, body.password);
          if (!identity) {
            cfg.loginLimiter.fail(key);
            console.log(`auth login-fail user=${String(body.username).slice(0, 64)} ip=${key}`);
            return sendJson(res, 401, { error: 'invalid_credentials' });
          }
          cfg.loginLimiter.clear(key);
          const token = cfg.sessions.create(identity.username, identity.role);
          res.setHeader('Set-Cookie', sessionCookie(token, {
            secure: cfg.secureCookies,
            maxAgeSeconds: cfg.sessions.idleMs / 1000,
          }));
          console.log(`auth login-ok user=${identity.username} ip=${key}`);
          return sendJson(res, 200, { ok: true, user: identity.username, role: identity.role });
        })
        .catch(err => {
          if (res.headersSent) return;
          const status = String(err.message) === 'body_too_large' ? 413 : 400;
          return sendJson(res, status, { error: String(err.message) || 'bad_request' });
        });
    }

    if (pathname === '/api/auth/session') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      const session = getSession(req);
      if (!session) return sendJson(res, 200, { authenticated: false });
      return sendJson(res, 200, { authenticated: true, user: session.user, role: session.role });
    }

    if (pathname === '/api/auth/logout') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      if (!requireCsrf(req, res)) return;
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      cfg.sessions.destroy(token);
      res.setHeader('Set-Cookie', clearedCookie({ secure: cfg.secureCookies }));
      return sendJson(res, 200, { ok: true });
    }

    /* ── Hermes live status (server-side proxy; single fixed upstream path) ── */
    if (pathname === '/api/hermes/status') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      const gate = requireAuth(req, res);
      if (!gate.ok) return;
      const key = clientKey(req);
      const limit = cfg.statusLimiter.check(key);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'rate_limited' });
      }
      return hermesProxy
        .fetchStatus({ baseUrl: cfg.hermesBaseUrl, timeoutMs: cfg.hermesTimeoutMs })
        .then(result => {
          const status = result.ok ? 200 : (result.state === 'error' ? 504 : 502);
          return sendJson(res, status, result);
        });
    }

    /* ── Hermes per-agent facts (server-side; upstream session token).
       Read-only, fixed allowlisted upstream paths, same gate and rate limit
       as the status proxy. Returns FACTS (sessions, activity ages) — the
       working/idle vocabulary is derived in the UI from these numbers. ── */
    if (pathname === '/api/hermes/agents') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      const gate = requireAuth(req, res);
      if (!gate.ok) return;
      const key = clientKey(req);
      const limit = cfg.statusLimiter.check(key);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'rate_limited' });
      }
      return hermesProxy
        .fetchAgentStates({
          baseUrl: cfg.hermesBaseUrl,
          sessionToken: cfg.hermesSessionToken,
          timeoutMs: cfg.hermesTimeoutMs,
        })
        .then(result => {
          const status = result.ok ? 200
            : result.state === 'unconfigured' ? 503
              : result.state === 'error' ? 504 : 502;
          return sendJson(res, status, result);
        });
    }

    /* ── authorized diagnostics (no paths, env values or tokens) ── */
    if (pathname === '/api/health/detail') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      const gate = requireAuth(req, res);
      if (!gate.ok) return;
      if (cfg.authRequired && gate.session.role !== 'admin') {
        return sendJson(res, 403, { error: 'admin_required' });
      }
      return hermesProxy
        .fetchStatus({ baseUrl: cfg.hermesBaseUrl, timeoutMs: cfg.hermesTimeoutMs })
        .then(result => sendJson(res, 200, {
          uptimeSeconds: Math.round(process.uptime()),
          node: process.version,
          authRequired: cfg.authRequired,
          hermes: { state: result.state, error: result.ok ? null : result.error },
        }));
    }

    /* ── any other /api path is unknown (do not fall through to static) ── */
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not_found' }, method);
    }

    /* ── static UI (allowlisted paths only, GET/HEAD) ── */
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'Method not allowed', undefined, method);
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    const firstSegment = pathname.replace(/^\/+/, '').split('/')[0];
    if (!STATIC_ALLOWLIST.has(firstSegment)) {
      return send(res, 404, 'Not found', undefined, method);
    }

    const filePath = path.resolve(safeRoot, '.' + pathname);
    if (!filePath.startsWith(safeRoot + path.sep) || path.basename(filePath).startsWith('.')) {
      return send(res, 404, 'Not found', undefined, method);
    }

    fs.realpath(filePath, (realErr, realPath) => {
      // Block symlinks that point outside the served directory.
      if (realErr || (realPath !== safeRoot && !realPath.startsWith(safeRoot + path.sep))) {
        return send(res, 404, 'Not found', undefined, method);
      }
      fs.stat(realPath, (err, stat) => {
        if (err || !stat.isFile()) return send(res, 404, 'Not found', undefined, method);
        const type = MIME[path.extname(realPath).toLowerCase()] || 'application/octet-stream';
        res.statusCode = 200;
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Length', stat.size);
        if (method === 'HEAD') return res.end();
        const stream = fs.createReadStream(realPath);
        stream.on('error', () => {
          if (!res.headersSent) send(res, 500, 'Internal server error');
          else res.destroy();
        });
        stream.pipe(res);
        // Log only method and pathname; never query strings or bodies.
        console.log(`${method} ${pathname} ${new Date().toISOString()}`);
      });
    });
  });
}

if (require.main === module) {
  /* Load trizempire/.env if present (OS env always wins over the file). */
  const loadedEnv = loadEnvFile(path.join(DEFAULT_ROOT, '.env'));
  const cfg = resolveOptions();
  const server = createServer();
  server.listen(cfg.port, cfg.host, () => {
    const bound = server.address().port;
    console.log(`TrizEmpire serving local files from ${DEFAULT_ROOT}`);
    console.log(`  http://${cfg.host}:${bound}/`);
    if (loadedEnv.length) console.log(`  Loaded .env (${loadedEnv.length} variables; OS environment takes precedence)`);
    console.log(cfg.authRequired
      ? `  Authentication: enabled (${cfg.users.map(u => u.username).join(', ')})`
      : '  Authentication: DISABLED — loopback-only mode. Set TRIZ_ADMIN_PASSWORD_HASH to enable login.');
    console.log(`  Hermes upstream: ${cfg.hermesBaseUrl}${cfg.hermesPublicUrl ? '' : ' (console embed disabled: HERMES_PUBLIC_URL is empty)'}`);
  });
}

module.exports = { createServer };
