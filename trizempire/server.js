/* TrizEmpire — local-first, zero-dependency Node.js operator server.
 * Run with Node.js 20+. Binds loopback by default; refuses a non-loopback
 * bind unless ALLOW_REMOTE_HOST=true AND authentication is configured.
 *
 * Responsibilities:
 *   - static delivery of the operator UI (allowlisted paths only)
 *   - server-side auth (scrypt env hashes, optional Supabase Auth sign-in,
 *     sessions, rate limiting, CSRF)
 *   - server-side Hermes proxy for live status (single fixed upstream path)
 *   - health endpoints (/healthz public-minimal, /api/health/detail authorized)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { applySecurityHeaders } = require('./lib/security');
const {
  verifyCredentials, SessionStore, StatelessSessionStore, RateLimiter,
  parseCookies, sessionCookie, clearedCookie, isSameOrigin, hasCsrfHeader,
} = require('./lib/auth');
const { loadEnvFile, resolveConfig } = require('./lib/config');
const { supabaseSignIn, isEmailLike } = require('./lib/supabase');
const hermesProxy = require('./lib/hermes');
const workspacesLib = require('./lib/workspaces');
const missionsLib = require('./lib/missions');
const terminalLib = require('./lib/terminal');

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

/* Client identity for rate limiting. Behind a trusted proxy (Vercel, or
   TRIZ_TRUST_PROXY=true) the real client is the first forwarded hop; on a
   directly-exposed server the socket address is the only trustworthy key. */
function clientKey(req, cfg) {
  if (cfg && cfg.trustProxy) {
    const realIp = String(req.headers['x-real-ip'] || '').trim()
      || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (realIp) return realIp;
  }
  return req.socket.remoteAddress || 'unknown';
}

function resolveOptions(options = {}, env = process.env) {
  const cfg = resolveConfig(options, env);
  /* Stateless HMAC-signed sessions when TRIZ_SESSION_SECRET is set —
     required on serverless hosts (Vercel), where instances share no memory. */
  cfg.sessions = options.sessions || (cfg.statelessSessions
    ? new StatelessSessionStore({ secret: cfg.sessionSecret, absoluteMs: cfg.sessionAbsoluteMs })
    : new SessionStore({ idleMs: cfg.sessionIdleMs, absoluteMs: cfg.sessionAbsoluteMs }));
  cfg.loginLimiter = options.loginLimiter || new RateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  /* Test seam for the Supabase Auth exchange — production always uses
     the platform's fetch. */
  cfg.supabaseFetch = options.supabaseFetch || undefined;
  cfg.statusLimiter = options.statusLimiter || new RateLimiter({ max: 120, windowMs: 60 * 1000 });
  /* TERMINAL page: the shell execution engine and its own rate limit.
     Disabled by config (serverless hosts, or TRIZ_TERMINAL_ENABLED=false);
     when disabled the route answers 503 and no engine is ever built. */
  cfg.terminalLimiter = options.terminalLimiter || new RateLimiter({ max: 60, windowMs: 60 * 1000 });
  cfg.terminal = (options.terminal !== undefined ? options.terminal
    : (cfg.terminalEnabled ? terminalLib.createTerminal({
      timeoutMs: cfg.terminalTimeoutMs,
      shell: cfg.terminalShell ? {
        kind: 'custom', file: cfg.terminalShell, args: c => ['-c', c], preamble: '',
      } : undefined,
    }) : null));
  /* Workspace mapping store: Neon (serverless Postgres) when configured,
     else an Upstash-compatible KV store, else the local JSON file. */
  cfg.workspacesStore = options.workspacesStore || workspacesLib.createStore({
    file: cfg.workspacesFile,
    kv: (cfg.workspacesKvUrl && cfg.workspacesKvToken)
      ? { url: cfg.workspacesKvUrl, token: cfg.workspacesKvToken }
      : null,
    neon: cfg.neon,
    // Test seam: production always uses the platform's fetch.
    neonFetchImpl: options.neonFetch,
    neonQueryImpl: options.neonQuery,
  });
  /* Mission records (the MISSIONS page): same three backends, one JSON
     document — see lib/missions.js for the model and lifecycle. */
  cfg.missionsStore = options.missionsStore || missionsLib.createStore({
    file: cfg.missionsFile,
    kv: (cfg.workspacesKvUrl && cfg.workspacesKvToken)
      ? { url: cfg.workspacesKvUrl, token: cfg.workspacesKvToken }
      : null,
    neon: cfg.neon,
    neonFetchImpl: options.neonFetch,
    neonQueryImpl: options.neonQuery,
  });
  delete cfg.sessionIdleMs;
  delete cfg.sessionAbsoluteMs;
  return cfg;
}

/* Read-only per-profile fact routes: same auth gate, same rate limit, same
 * upstream discipline — only the fetcher and the profile query differ. */
const PROFILE_FACT_ROUTES = Object.freeze({
  '/api/hermes/agents': opts => hermesProxy.fetchAgentStates(opts),
  '/api/hermes/memory': opts => hermesProxy.fetchProfileMemory(opts),
  '/api/hermes/messaging': opts => hermesProxy.fetchProfileMessaging(opts),
});

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
        auth: {
          required: cfg.authRequired,
          users: cfg.users.map(u => u.username),
          supabase: !!cfg.supabase,
        },
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
      const key = clientKey(req, cfg);
      const limit = cfg.loginLimiter.check(key);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'too_many_attempts' });
      }
      return readJsonBody(req)
        .then(async body => {
          const username = String(body.username || '').trim();
          const password = body.password;

          const establishSession = (sessionUser, role) => {
            const token = cfg.sessions.create(sessionUser, role);
            res.setHeader('Set-Cookie', sessionCookie(token, {
              secure: cfg.secureCookies,
              maxAgeSeconds: cfg.sessions.idleMs / 1000,
            }));
            return sendJson(res, 200, { ok: true, user: sessionUser, role });
          };

          /* 1st try: the local scrypt users (unchanged behavior — local
             credentials always win and are never sent upstream). */
          const identity = verifyCredentials(cfg.users, username, password);
          if (identity) {
            cfg.loginLimiter.clear(key);
            console.log(`auth login-ok user=${identity.username} ip=${key} provider=local`);
            return establishSession(identity.username, identity.role);
          }

          /* 2nd try: Supabase Auth, when configured and the identifier is an
             email. The exchange is server-side; on success we mint our own
             session cookie, so the Supabase token never reaches the browser. */
          if (cfg.supabase && isEmailLike(username)) {
            try {
              const signedIn = await supabaseSignIn(cfg.supabase, username, password, {
                fetchImpl: cfg.supabaseFetch,
              });
              cfg.loginLimiter.clear(key);
              console.log(`auth login-ok user=${signedIn.user.email} ip=${key} provider=supabase`);
              return establishSession(signedIn.user.email, cfg.supabase.role || 'admin');
            } catch (error) {
              const code = error && error.code ? error.code : 'upstream_unavailable';
              if (code === 'invalid_credentials' || code === 'email_not_confirmed') {
                cfg.loginLimiter.fail(key);
                console.log(`auth login-fail user=${username.slice(0, 64)} ip=${key} provider=supabase reason=${code}`);
                return sendJson(res, 401, { error: code });
              }
              /* Upstream/config problem, not a wrong password: report it
                 WITHOUT burning the caller's rate-limit budget. */
              console.log(`auth login-error ip=${key} provider=supabase reason=${code}`);
              return sendJson(res, 502, { error: 'auth_upstream_unavailable' });
            }
          }

          cfg.loginLimiter.fail(key);
          console.log(`auth login-fail user=${username.slice(0, 64)} ip=${key}`);
          return sendJson(res, 401, { error: 'invalid_credentials' });
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
      const key = clientKey(req, cfg);
      const limit = cfg.statusLimiter.check(key);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'rate_limited' });
      }
      return hermesProxy
        .fetchStatus({ baseUrl: cfg.hermesBaseUrl, sessionToken: cfg.hermesSessionToken, timeoutMs: cfg.hermesTimeoutMs })
        .then(result => {
          const status = result.ok ? 200 : (result.state === 'error' ? 504 : 502);
          return sendJson(res, status, result);
        });
    }

    /* ── Hermes per-profile facts (server-side; upstream session token).
       Read-only, fixed allowlisted upstream paths, same gate and rate limit
       as the status proxy. Each route returns FACTS the UI derives from:
         /api/hermes/agents    — session activity → working/idle vocabulary
         /api/hermes/memory    — per-profile memory provider/file facts
         /api/hermes/messaging — per-profile channel (telegram bot) facts
       The profile name is validated inside the proxy and rides only as a
       query parameter on those fixed paths. ── */
    const profileFactFetch = PROFILE_FACT_ROUTES[pathname];
    if (profileFactFetch) {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      const gate = requireAuth(req, res);
      if (!gate.ok) return;
      const key = clientKey(req, cfg);
      const limit = cfg.statusLimiter.check(key);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'rate_limited' });
      }
      const profile = new URL(req.url, 'http://localhost').searchParams.get('profile');
      return profileFactFetch({
        baseUrl: cfg.hermesBaseUrl,
        sessionToken: cfg.hermesSessionToken,
        timeoutMs: cfg.hermesTimeoutMs,
        profile,
      }).then(result => {
        const status = result.ok ? 200
          : result.state === 'bad_request' ? 400
            : result.state === 'unconfigured' ? 503
              : result.state === 'error' ? 504 : 502;
        return sendJson(res, status, result);
      });
    }

    /* ── workspace→agent mapping (operator-owned, persisted on the server).
       GET returns the stored mapping (or the shipped defaults when none is
       stored). PUT validates against the shared crew model — known workspace
       ids only, one home per profile — and persists atomically. Writing is
       an authenticated, CSRF-checked mutation; reading carries no upstream
       traffic at all. ── */
    if (pathname === '/api/workspaces') {
      if (method !== 'GET' && method !== 'HEAD' && method !== 'PUT') {
        res.setHeader('Allow', 'GET, HEAD, PUT');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      const gate = requireAuth(req, res);
      if (!gate.ok) return;
      if (method === 'PUT') {
        if (!requireCsrf(req, res)) return;
        return readJsonBody(req)
          .then(body => cfg.workspacesStore.save(body && body.assignments))
          .then(saved => {
            if (!saved.ok) {
              return sendJson(res, 400, { ok: false, error: saved.error }, method);
            }
            console.log(`workspaces saved backend=${cfg.workspacesStore.backend} count=${Object.keys(saved.assignments).length}`);
            return sendJson(res, 200, { ok: true, assignments: saved.assignments, source: 'stored', backend: cfg.workspacesStore.backend }, method);
          })
          .catch(err => {
            if (res.headersSent) return;
            const status = String(err.message) === 'body_too_large' ? 413 : 400;
            return sendJson(res, status, { ok: false, error: String(err.message) || 'bad_request' }, method);
          });
      }
      return cfg.workspacesStore.load().then(loaded => sendJson(res, 200, {
        ok: true,
        assignments: loaded.assignments,
        source: loaded.source,
        error: loaded.error,
        backend: cfg.workspacesStore.backend,
      }, method));
    }

    /* ── missions: the operator's work orders for the crew.
       GET lists the stored missions with computed stats; POST creates one;
       POST /<id>/<action> drives the lifecycle (approve, advance, deliver,
       reopen); DELETE removes unfinished business only. Writes are
       authenticated and CSRF-checked, and the mission model validates
       everything: progress is recorded by the operator because this app
       drives no execution engine — nothing here is inferred. ── */
    if (pathname === '/api/missions' || pathname.startsWith('/api/missions/')) {
      const isCollection = pathname === '/api/missions';
      if (isCollection && method !== 'GET' && method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      if (!isCollection && method !== 'POST' && method !== 'DELETE') {
        res.setHeader('Allow', 'POST, DELETE');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      const gate = requireAuth(req, res);
      if (!gate.ok) return;
      if (method !== 'GET' && !requireCsrf(req, res)) return;

      const respond = (loaded, state, extra, status = 200) => sendJson(res, status, {
        ok: true,
        missions: state.missions,
        stats: missionsLib.computeStats(state, Date.now(), missionsLib.rosterSize()),
        source: loaded.source,
        error: loaded.error,
        backend: cfg.missionsStore.backend,
        ...extra,
      }, method);

      const apply = async operation => {
        const loaded = await cfg.missionsStore.load();
        const state = loaded.doc || missionsLib.emptyState();
        const result = operation(state);
        if (!result.ok) {
          return sendJson(res, 400, { ok: false, error: result.error, backend: cfg.missionsStore.backend }, method);
        }
        if (!result.doc) return respond(loaded, state, { mission: result.mission || null });
        const saved = await cfg.missionsStore.save(result.doc);
        if (!saved.ok) return sendJson(res, 400, { ok: false, error: saved.error }, method);
        /* The write succeeded, so the state is now stored and any earlier
           load complaint (e.g. a corrupt file we just overwrote) is stale. */
        return respond({ ...loaded, source: 'stored', error: null }, saved.doc, { mission: result.mission || null });
      };

      if (isCollection && method === 'GET') {
        return cfg.missionsStore.load().then(loaded => respond(loaded, loaded.doc || missionsLib.emptyState(), {}));
      }

      if (isCollection && method === 'POST') {
        return readJsonBody(req)
          .then(body => apply(state => missionsLib.createMission(state, body, Date.now())))
          .catch(err => {
            if (res.headersSent) return;
            const status = String(err.message) === 'body_too_large' ? 413 : 400;
            return sendJson(res, status, { ok: false, error: String(err.message) || 'bad_request' }, method);
          });
      }

      const route = pathname.match(new RegExp('^/api/missions/(NX-[0-9]{1,9})(?:/([a-z]+))?$'));
      if (!route) return sendJson(res, 404, { ok: false, error: 'not_found' }, method);
      const [, missionId, action] = route;
      if (method === 'DELETE') return apply(state => missionsLib.deleteMission(state, missionId));
      const OPS = {
        approve: state => missionsLib.approveMission(state, missionId, Date.now()),
        advance: state => missionsLib.advanceMission(state, missionId, Date.now()),
        deliver: state => missionsLib.deliverMission(state, missionId, Date.now()),
        reopen: state => missionsLib.reopenMission(state, missionId, Date.now()),
      };
      if (!OPS[action]) return sendJson(res, 404, { ok: false, error: 'unknown mission action' }, method);
      return apply(OPS[action]);
    }
    /* ── TERMINAL: run one shell command per request.
       GET /api/terminal returns the session's identity/prompt facts;
       POST /api/terminal/exec runs { command } in that session's cwd and
       answers with the output, exit code and the (possibly cd-updated)
       prompt facts; POST /api/terminal/reset restarts the session at $HOME.
       Every route is authenticated, CSRF-checked and rate-limited — this
       executes commands as the server user, so it sits behind the same
       gates as every other mutation. Stateless sessions (Vercel) still
       work: the client sends its session id, the server keeps the cwd. ── */
    if (pathname === '/api/terminal' || pathname === '/api/terminal/exec'
      || pathname === '/api/terminal/reset') {
      if (method !== 'GET' && method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      if (pathname === '/api/terminal' && method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      if (pathname !== '/api/terminal' && method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, 'Method not allowed', undefined, method);
      }
      if (!cfg.terminal) {
        return sendJson(res, 503, { error: 'terminal_disabled',
          hint: 'The terminal is unavailable on this host. Self-host to use it.' }, method);
      }
      const gate = requireAuth(req, res);
      if (!gate.ok) return;
      if (method !== 'GET' && !requireCsrf(req, res)) return;
      const key = clientKey(req, cfg);
      const limit = cfg.terminalLimiter.check(key);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        return sendJson(res, 429, { error: 'rate_limited' }, method);
      }
      /* The client mints a session id (one per terminal tab); it is echoed
         back and validated here so a malformed one cannot collide with
         another session's state or grow the map with junk keys. */
      const sessionKey = `${key}|${
        (String(new URL(req.url, 'http://localhost').searchParams.get('sid') || '')
          .match(/^[A-Za-z0-9_-]{8,64}$/) || [''])[0]}`;
      if (pathname === '/api/terminal') {
        return sendJson(res, 200, { ok: true, ...cfg.terminal.info(sessionKey) }, method);
      }
      if (pathname === '/api/terminal/reset') {
        console.log(`terminal reset ip=${key}`);
        return sendJson(res, 200, { ok: true, ...cfg.terminal.reset(sessionKey) }, method);
      }
      return readJsonBody(req, 4096)
        .then(body => cfg.terminal.exec(sessionKey, body && body.command))
        .then(result => {
          /* Log only metadata — command text and output may contain
             secrets the operator typed or read; never log either. */
          console.log(`terminal exec ip=${key} exit=${result.exitCode}`
            + `${result.timedOut ? ' timedout=1' : ''}${result.truncated ? ' truncated=1' : ''}`);
          return sendJson(res, 200, { ok: true, ...result }, method);
        })
        .catch(err => {
          if (res.headersSent) return;
          const message = String(err.message || '');
          if (message === 'command_invalid') {
            return sendJson(res, 400, { ok: false, error: message }, method);
          }
          const status = message === 'body_too_large' ? 413 : 400;
          return sendJson(res, status, { ok: false, error: message || 'bad_request' }, method);
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
      const probeStarted = Date.now();
      return hermesProxy
        .fetchStatus({ baseUrl: cfg.hermesBaseUrl, sessionToken: cfg.hermesSessionToken, timeoutMs: cfg.hermesTimeoutMs })
        .then(result => {
          const latencyMs = Date.now() - probeStarted;
          const cpu = process.cpuUsage();
          const serverless = process.env.VERCEL === '1';
          /* Host metrics are only reported when they are genuinely measurable:
           * a serverless platform exposes no host load or memory, so those
           * fields say why they are absent instead of inventing values. */
          const host = serverless
            ? { available: false, reason: 'not exposed by the serverless platform' }
            : {
                available: true,
                loadAverage: os.loadavg().map(n => Math.round(n * 100) / 100),
                totalMemoryBytes: os.totalmem(),
                freeMemoryBytes: os.freemem(),
              };
          return sendJson(res, 200, {
            uptimeSeconds: Math.round(process.uptime()),
            node: process.version,
            authRequired: cfg.authRequired,
            checkedAt: new Date().toISOString(),
            hermes: {
              state: result.state,
              error: result.ok ? null : result.error,
              configured: Boolean(cfg.hermesBaseUrl),
              latencyMs,
            },
            runtime: {
              scope: serverless ? 'serverless-instance' : 'node-process',
              cpuSeconds: Math.round((cpu.user + cpu.system) / 1000) / 1000,
              rssBytes: process.memoryUsage().rss,
              heapUsedBytes: process.memoryUsage().heapUsed,
              heapTotalBytes: process.memoryUsage().heapTotal,
            },
            host,
            auth: {
              adminConfigured: cfg.users.some(u => u.username === 'admin'),
              operatorConfigured: cfg.users.some(u => u.username === 'operator'),
              supabaseConfigured: Boolean(cfg.supabase),
              statelessSessions: cfg.statelessSessions,
            },
            stores: {
              workspacesBackend: cfg.workspacesStore.backend,
              kvConfigured: Boolean(cfg.workspacesKvUrl && cfg.workspacesKvToken),
              neonConfigured: Boolean(cfg.neon && cfg.neon.dsn),
              terminalEnabled: cfg.terminalEnabled,
            },
          });
        });
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
        /* Cache policy for static delivery (overriding the global no-store):
           - /vendor/ is pinned third-party code that only changes on upgrade
           - /crew/ is versioned app logic (hours, not days, is the risk)
           - index.html stays no-store so a redeploy is picked up immediately */
        if (firstSegment === 'vendor') {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        } else if (firstSegment === 'crew') {
          res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
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
      ? `  Authentication: enabled (${[...cfg.users.map(u => u.username), ...(cfg.supabase ? ['supabase'] : [])].join(', ')})`
      : '  Authentication: DISABLED — loopback-only mode. Set TRIZ_ADMIN_PASSWORD_HASH to enable login.');
    console.log(`  Hermes upstream: ${cfg.hermesBaseUrl}${cfg.hermesPublicUrl ? '' : ' (console embed disabled: HERMES_PUBLIC_URL is empty)'}`);
  });
}

module.exports = { createServer };
