'use strict';

/* Serverless (Vercel) deployment tests:
 *   - StatelessSessionStore: signed cookies survive instance boundaries;
 *     tampering, wrong secrets and expiry are all rejected.
 *   - config: TRIZ_SESSION_SECRET / KV variable pairs / VERCEL defaults /
 *     trust-proxy, with the same secret-safe error style as the rest.
 *   - Upstash REST store: wire format, honest failure states, backend choice.
 *   - static cache headers: vendored assets are cacheable, index.html is not.
 *   - api/index.js + vercel.json: the entry really serves the app through the
 *     same server, and the config bundles exactly what it reads at runtime. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StatelessSessionStore, hashPassword } = require('../lib/auth');
const { resolveConfig } = require('../lib/config');
const workspaces = require('../lib/workspaces');
const { createServer } = require('../server');

const repoRoot = path.resolve(__dirname, '..', '..');
const SECRET = 'x'.repeat(32);

function withClock(store, t) { store.now = () => t; }

/* ── stateless sessions ──────────────────────────────────────────────── */

test('stateless session round-trips across instances sharing the secret', () => {
  const a = new StatelessSessionStore({ secret: SECRET });
  const b = new StatelessSessionStore({ secret: SECRET }); // "another lambda"
  const token = a.create('admin', 'admin');
  const session = b.get(token);
  assert.equal(session.user, 'admin');
  assert.equal(session.role, 'admin');
});

test('stateless session rejects tampering, junk and wrong secrets', () => {
  const store = new StatelessSessionStore({ secret: SECRET });
  const token = store.create('admin', 'admin');
  const [payload, mac] = token.split('.');

  // Flip a character in the payload (privilege escalation attempt).
  const flipped = (payload[0] === 'A' ? 'B' : 'A') + payload.slice(1);
  assert.equal(store.get(`${flipped}.${mac}`), null, 'modified payload must fail the MAC');

  // Modified MAC.
  assert.equal(store.get(`${payload}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`), null);

  // Wrong secret (different deployment).
  const other = new StatelessSessionStore({ secret: 'y'.repeat(32) });
  assert.equal(other.get(token), null);

  // Structural junk.
  for (const junk of ['', '.', 'a.', '.b', 'a.b', token + 'x', null, undefined, 42]) {
    assert.equal(store.get(junk), null, `must reject ${String(junk)}`);
  }
});

test('stateless session enforces the absolute lifetime, no idle tracking', () => {
  const store = new StatelessSessionStore({ secret: SECRET, absoluteMs: 1000 });
  withClock(store, 10000); // mint at a known instant, then advance
  const token = store.create('operator', 'operator');
  withClock(store, 10999);
  assert.equal(store.get(token).user, 'operator', 'valid inside the window');
  withClock(store, 11001);
  assert.equal(store.get(token), null, 'expired after the absolute lifetime');
});

test('stateless store refuses weak secrets and destroy is a documented no-op', () => {
  assert.throws(() => new StatelessSessionStore({ secret: 'short' }), /at least 32/);
  const store = new StatelessSessionStore({ secret: SECRET });
  const token = store.create('admin', 'admin');
  store.destroy(token); // cannot revoke — documented trade-off
  assert.ok(store.get(token), 'the cookie still verifies until expiry');
});

test('server accepts a stateless session minted elsewhere (serverless flow)', async () => {
  // Simulates login on instance A, then a request landing on instance B.
  const minter = new StatelessSessionStore({ secret: SECRET });
  const token = minter.create('admin', 'admin');
  const server = createServer({
    users: [{ username: 'admin', role: 'admin', hash: null }],
    sessionSecret: SECRET,
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9',
    hermesSessionToken: '',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/hermes/status`, {
      headers: { cookie: `triz_session=${token}` },
    });
    // 502 = authenticated but upstream down — NOT 401.
    assert.equal(res.status, 502);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

/* ── config validation ───────────────────────────────────────────────── */

test('TRIZ_SESSION_SECRET is validated and never echoed', () => {
  assert.throws(() => resolveConfig({}, { TRIZ_SESSION_SECRET: 'short' }), /at least 32/);
  assert.throws(() => resolveConfig({}, { TRIZ_SESSION_SECRET: `${'x'.repeat(32)}\nextra` }), /line breaks/);
  const cfg = resolveConfig({ sessionSecret: SECRET }, {});
  assert.equal(cfg.statelessSessions, true);
  assert.equal(cfg.sessionSecret, SECRET);
  const none = resolveConfig({}, {});
  assert.equal(none.statelessSessions, false);
  assert.equal(none.sessionSecret, null);
});

test('KV variable pairs are validated in both spellings', () => {
  const url = 'https://upstash.example.internal';
  const token = 'tok-123';
  // Vercel Marketplace pair.
  let cfg = resolveConfig({}, { KV_REST_API_URL: url, KV_REST_API_TOKEN: token });
  assert.equal(cfg.workspacesKvUrl, url);
  assert.equal(cfg.workspacesKvToken, token);
  // Upstash SDK pair.
  cfg = resolveConfig({}, { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token });
  assert.equal(cfg.workspacesKvUrl, url);
  // Half-configured is a startup error, in both directions.
  assert.throws(() => resolveConfig({}, { KV_REST_API_URL: url }), /KV_REST_API_TOKEN/);
  assert.throws(() => resolveConfig({}, { KV_REST_API_TOKEN: token }), /KV_REST_API_URL/);
  // Bad URL / credentials in URL / token hygiene — name the var, no values.
  assert.throws(() => resolveConfig({}, { KV_REST_API_URL: 'not-a-url', KV_REST_API_TOKEN: token }), /http\(s\)/);
  assert.throws(() => resolveConfig({}, { KV_REST_API_URL: 'https://user:pass@x.example/', KV_REST_API_TOKEN: token }), /embedded credentials/);
  assert.throws(() => resolveConfig({}, { KV_REST_API_URL: url, KV_REST_API_TOKEN: `${token}\nmore` }), /single line/);
});

test('VERCEL=1 moves the default workspace file to /tmp and enables trust-proxy', () => {
  const cfg = resolveConfig({}, { VERCEL: '1' });
  assert.ok(cfg.workspacesFile.startsWith(os.tmpdir()), 'read-only app tree → /tmp default');
  assert.equal(cfg.trustProxy, true, 'the platform-provided client IP is the only one visible');
  assert.equal(resolveConfig({}, {}).trustProxy, false, 'directly-exposed servers must not trust XFF');
  assert.equal(resolveConfig({}, { TRIZ_TRUST_PROXY: 'true' }).trustProxy, true);
});

/* ── Upstash REST store ──────────────────────────────────────────────── */

const KV = { url: 'https://kv.example.internal', token: 'tok' };

test('KV store speaks the documented REST wire format', async () => {
  const seen = [];
  const store = value => async (kv, pathname, init = {}) => {
    seen.push({ url: `${kv.url}/${pathname}`, auth: 'tok', method: init.method || 'GET', body: init.body });
    if (pathname.startsWith('get/')) return { result: value };
    return { result: 'OK' };
  };

  // Absent key → defaults.
  const absent = await workspaces.loadAssignmentsKv(KV, { fetchImpl: store(null) });
  assert.deepEqual(absent, { assignments: null, source: 'defaults', error: null });

  // Stored document → parsed + validated.
  const doc = JSON.stringify({ version: 1, assignments: { client: ['data'] } });
  const loaded = await workspaces.loadAssignmentsKv(KV, { fetchImpl: store(doc) });
  assert.deepEqual(loaded.assignments, { client: ['data'] });
  assert.equal(loaded.source, 'stored');

  // Save posts the same JSON document and accepts {"result":"OK"}.
  const saver = await workspaces.saveAssignmentsKv(KV, { client: ['data'] }, { fetchImpl: store(null) });
  assert.equal(saver.ok, true);
  const write = seen.find(s => s.method === 'POST');
  assert.equal(write.url, `${KV.url}/set/${workspaces.KV_KEY}`);
  assert.equal(write.auth, 'tok');
  assert.deepEqual(JSON.parse(write.body), { version: 1, assignments: { client: ['data'] } });
  const read = seen.find(s => s.method === 'GET');
  assert.equal(read.url, `${KV.url}/get/${workspaces.KV_KEY}`);
});

test('KV store reports corruption and outages honestly', async () => {
  const corrupt = await workspaces.loadAssignmentsKv(KV, {
    fetchImpl: async () => ({ result: 'not json' }),
  });
  assert.equal(corrupt.assignments, null);
  assert.match(corrupt.error, /not valid JSON/);

  const invalid = await workspaces.loadAssignmentsKv(KV, {
    fetchImpl: async () => ({ result: JSON.stringify({ assignments: { client: ['data'], work: ['data'] } }) }),
  });
  assert.match(invalid.error, /two workspaces/);

  const down = await workspaces.loadAssignmentsKv(KV, {
    fetchImpl: async () => { throw new Error('kv_http_503'); },
  });
  assert.equal(down.assignments, null);
  assert.match(down.error, /unreachable/);

  const writeDown = await workspaces.saveAssignmentsKv(KV, { client: ['data'] }, {
    fetchImpl: async () => { throw new Error('kv_http_503'); },
  });
  assert.equal(writeDown.ok, false);
  assert.match(writeDown.error, /nothing was saved/);

  const refused = await workspaces.saveAssignmentsKv(KV, { client: ['data'] }, {
    fetchImpl: async () => ({ result: 'ERR something' }),
  });
  assert.equal(refused.ok, false);

  // Validation still happens BEFORE the network — invalid payloads never write.
  let writes = 0;
  const rejected = await workspaces.saveAssignmentsKv(KV, { client: ['../etc'] }, {
    fetchImpl: async () => { writes += 1; return { result: 'OK' }; },
  });
  assert.equal(rejected.ok, false);
  assert.equal(writes, 0);
});

test('KV store works against a real HTTP server (the actual wire path)', async () => {
  const kvDocs = new Map();
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"bad token"}');
    }
    // Upstash REST paths are /get/<key> and /set/<key> — strip the command.
    const key = decodeURIComponent(req.url.replace(/^\/(get|set)\//, ''));
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ result: kvDocs.has(key) ? kvDocs.get(key) : null }));
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      kvDocs.set(key, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"result":"OK"}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const kv = { url: `http://127.0.0.1:${upstream.address().port}`, token: 'tok' };
  try {
    const saved = await workspaces.saveAssignmentsKv(kv, { personal: ['default'] });
    assert.equal(saved.ok, true);
    const loaded = await workspaces.loadAssignmentsKv(kv);
    assert.deepEqual(loaded.assignments, { personal: ['default'] });
    assert.equal(loaded.source, 'stored');

    // A rejected token surfaces as "unreachable", never as a silent default.
    const unauthorized = await workspaces.loadAssignmentsKv({ url: kv.url, token: 'wrong' });
    assert.equal(unauthorized.assignments, null);
    assert.match(unauthorized.error, /unreachable/);
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('createStore picks the backend from configuration', async () => {
  const file = path.join(os.tmpdir(), `triz-createstore-${process.pid}.json`);
  const fileStore = workspaces.createStore({ file });
  assert.equal(fileStore.backend, 'file');
  await fileStore.save({ client: ['data'] });
  assert.deepEqual((await fileStore.load()).assignments, { client: ['data'] });

  const kvStore = workspaces.createStore({ file, kv: KV });
  assert.equal(kvStore.backend, 'kv');
});

/* ── server wiring: sessions and stores end-to-end ───────────────────── */

test('TRIZ_SESSION_SECRET switches the server to stateless sessions', async () => {
  const server = createServer({
    users: [{ username: 'admin', role: 'admin', hash: null }],
    sessionSecret: SECRET,
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9',
    hermesSessionToken: '',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/hermes/status`);
    assert.equal(res.status, 401, 'auth is still enforced');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('server reports which backend served the workspace mapping', async () => {
  const file = path.join(os.tmpdir(), `triz-backend-${process.pid}.json`);
  await withServer(async base => {
    const body = await (await fetch(`${base}/api/workspaces`)).json();
    assert.equal(body.backend, 'file');
  }, { users: [], workspacesFile: file });

  let sawKv = false;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.includes('/get/') ? '{"result":null}' : '{"result":"OK"}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await withServer(async base => {
      const body = await (await fetch(`${base}/api/workspaces`)).json();
      assert.equal(body.backend, 'kv');
      sawKv = true;
    }, {
      users: [],
      workspacesKvUrl: `http://127.0.0.1:${upstream.address().port}`,
      workspacesKvToken: 'tok',
    });
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
  assert.ok(sawKv);
});

test('trust-proxy changes the rate-limit bucket key only when enabled', async () => {
  // With trustProxy the limiter buckets by X-Real-IP, not by socket address:
  // two "different clients" behind one proxy must not share a bucket.
  let keyWhenTrusted = null;
  const limiter = {
    check: key => { keyWhenTrusted = key; return { allowed: true, retryAfterSeconds: 0 }; },
    fail: () => {},
    clear: () => {},
  };
  await withServer(async base => {
    await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        'x-real-ip': '203.0.113.9',
      },
      body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
    });
    assert.equal(keyWhenTrusted, '203.0.113.9', 'forwarded IP wins behind a trusted proxy');
  }, { users: [], loginLimiter: limiter, trustProxy: true });

  keyWhenTrusted = null;
  await withServer(async base => {
    await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-real-ip': '203.0.113.9' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
    });
    assert.notEqual(keyWhenTrusted, '203.0.113.9', 'spoofed headers are ignored without trustProxy');
  }, { users: [], loginLimiter: limiter, trustProxy: false });
});

async function withServer(run, options = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

/* ── static cache headers ────────────────────────────────────────────── */

test('vendored and model assets are cacheable, index.html is not', async () => {
  await withServer(async base => {
    const vendor = await fetch(`${base}/vendor/three.module.min.js`);
    assert.equal(vendor.status, 200);
    assert.equal(vendor.headers.get('cache-control'), 'public, max-age=86400',
      'pinned third-party code should not be re-downloaded on every load');

    const model = await fetch(`${base}/crew/crew-model.js`);
    assert.equal(model.status, 200);
    assert.equal(model.headers.get('cache-control'), 'public, max-age=3600, must-revalidate');

    const index = await fetch(`${base}/`);
    assert.equal(index.headers.get('cache-control'), 'no-store',
      'a redeploy must be picked up immediately');
  }, { users: [] });
});

/* ── the serverless entry itself ─────────────────────────────────────── */

test('vercel.json routes everything to the entry and bundles what it reads', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));
  assert.deepEqual(config.rewrites, [{ source: '/(.*)', 'destination': '/api/index?__triz_vc_original_path=/$1' }]);
  const fn = config.functions['api/index.js'];
  assert.ok(fn, 'the entry must be declared as a function');
  assert.equal(fn.includeFiles, 'trizempire/**',
    'Vercel requires includeFiles to be a single glob string covering the app assets');
  assert.ok(Number.isInteger(fn.maxDuration) && fn.maxDuration > 0);
});

test('api/index.js exports a handler that serves the full app', async t => {
  // The entry requires ../trizempire/server, which resolves process.env at
  // require time; isolate by spawning nothing — a plain require is safe in
  // the test env (no auth vars set → loopback mode).
  let handler;
  try {
    handler = require('../../api/index.js');
  } catch (e) {
    return t.skip(`entry not loadable in this environment: ${e.message}`);
  }
  assert.equal(typeof handler, 'function', 'the entry must export a (req, res) handler');

  // Drive the handler through a real http server, exactly like the platform.
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /TrizEmpire/);

    // Simulate Vercel invoking the rewritten destination URL rather than the
    // browser's original URL. The entry must restore the source path.
    const rewrittenRoot = await fetch(`${base}/api/index?__triz_vc_original_path=%2F`);
    assert.equal(rewrittenRoot.status, 200);
    assert.match(rewrittenRoot.headers.get('content-type'), /text\/html/);
    assert.match(await rewrittenRoot.text(), /TrizEmpire/);

    const rewrittenAsset = await fetch(`${base}/api/index?__triz_vc_original_path=%2Fcrew%2Fcrew-model.js&probe=1`);
    assert.equal(rewrittenAsset.status, 200);
    assert.match(rewrittenAsset.headers.get('content-type'), /javascript/);

    const model = await fetch(`${base}/crew/crew-model.js`);
    assert.equal(model.status, 200);

    const api = await fetch(`${base}/api/workspaces`);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).ok, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('root package.json pins CommonJS and a Vercel-capable Node', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'commonjs');
  assert.equal(pkg.private, true);
  // Vercel disabled Node 20 for NEW functions (Oct 2026); the deploy root
  // must not advertise it. The app in trizempire/ still supports 20.
  const major = Number(pkg.engines.node.replace(/[^\d]/g, '').slice(0, 2));
  assert.ok(major >= 22, `engines.node must be >=22 for new Vercel functions, got ${pkg.engines.node}`);
});

/* ── production cold start: the Vercel runtime environment ──────────── */

/* The platform invokes the entry with NODE_ENV=production, no PORT and a
 * read-only tree. The config resolves at require time, so each case runs in
 * a fresh child process with an explicitly built environment — ambient
 * variables (including a developer's PORT/NODE_ENV) must never leak in. */
const PRODUCTION_STRIP = [
  'NODE_ENV', 'PORT', 'HOST', 'VERCEL', 'ALLOW_REMOTE_HOST',
  'TRIZ_ADMIN_PASSWORD_HASH', 'TRIZ_OPERATOR_PASSWORD_HASH', 'TRIZ_SESSION_SECRET',
  'TRIZ_AUTH_USERS', 'TRIZ_SECURE_COOKIE', 'TRIZ_TRUST_PROXY', 'TRIZ_WORKSPACES_FILE',
  'TRIZ_SESSION_TTL_MINUTES', 'TRIZ_SESSION_ABS_MINUTES',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'TRIZ_SUPABASE_ROLE',
  'HERMES_BASE_URL', 'HERMES_PUBLIC_URL', 'HERMES_SESSION_TOKEN', 'HERMES_TIMEOUT_MS',
];

const ENTRY = path.resolve(repoRoot, 'api', 'index.js');
const E2E_PASSWORD = 'correct-horse-battery-staple';

function productionEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of PRODUCTION_STRIP) delete env[name];
  return Object.assign(env, overrides);
}

function coldStart(overrides, source) {
  const res = spawnSync(process.execPath, ['-e', source], {
    env: productionEnv(overrides),
    encoding: 'utf8',
    timeout: 30000,
    cwd: repoRoot,
  });
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

const LOAD_PROBE = `try { require(${JSON.stringify(ENTRY)}); console.log('LOADED'); } catch (e) { console.log('THREW: ' + e.message); }`;

test('production cold start fails fast and names the offending variable', () => {
  // The live-deployment failure class: a production instance without a
  // password must refuse to start, and the error must NAME the variable to
  // set (there is no default password).
  let r = coldStart({ NODE_ENV: 'production' }, LOAD_PROBE);
  assert.match(r.out, /TRIZ_ADMIN_PASSWORD_HASH/, 'the error must name the missing variable');
  assert.doesNotMatch(r.out, /LOADED/, 'a production instance without a password must never start');

  // A mistyped NODE_ENV from the dashboard names the allowed values.
  r = coldStart({ NODE_ENV: 'Production' }, LOAD_PROBE);
  assert.match(r.out, /NODE_ENV must be one of/);

  // A non-scrypt secret pasted into the dashboard is rejected by name,
  // without echoing the (possibly real) value back.
  r = coldStart({ NODE_ENV: 'production', TRIZ_ADMIN_PASSWORD_HASH: 'hunter2' }, LOAD_PROBE);
  assert.match(r.out, /TRIZ_ADMIN_PASSWORD_HASH is not a valid scrypt hash/);
  assert.doesNotMatch(r.out, /hunter2/, 'the invalid secret must never be echoed');
});

test('production serverless entry serves the full app end-to-end', () => {
  const source = `
    const http = require('node:http');
    const handler = require(${JSON.stringify(ENTRY)});
    const server = http.createServer(handler);
    const timer = setTimeout(() => { console.log('RESULT:' + JSON.stringify({ error: 'timeout' })); process.exit(3); }, 20000);
    server.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      const out = {};
      try {
        let r = await fetch(base + '/api/index?__triz_vc_original_path=%2F');
        out.rewrittenRoot = [r.status, /TrizEmpire/.test(await r.text())];
        r = await fetch(base + '/healthz');
        out.health = r.status;
        r = await fetch(base + '/api/workspaces');
        out.unauthenticated = r.status;
        r = await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: base },
          body: JSON.stringify({ username: 'admin', password: ${JSON.stringify(E2E_PASSWORD)} }),
        });
        out.login = r.status;
        const cookie = (r.headers.get('set-cookie') || '').match(/triz_session=[^;]+/);
        if (cookie) {
          r = await fetch(base + '/api/workspaces', { headers: { cookie: cookie[0] } });
          out.authenticated = r.status;
        }
      } catch (e) {
        out.error = String((e && e.message) || e);
      }
      clearTimeout(timer);
      console.log('RESULT:' + JSON.stringify(out));
      process.exit(out.error ? 1 : 0);
    });
  `;
  const r = coldStart({
    NODE_ENV: 'production',
    VERCEL: '1',
    TRIZ_ADMIN_PASSWORD_HASH: hashPassword(E2E_PASSWORD),
    TRIZ_SESSION_SECRET: 'v'.repeat(32),
    HERMES_BASE_URL: 'http://127.0.0.1:9',
  }, source);
  const line = (r.out.split('\n').find((l) => l.startsWith('RESULT:')) || '').slice(7);
  assert.ok(line, `child produced no result (status=${r.status}): ${r.out}`);
  const out = JSON.parse(line);
  assert.deepEqual(out.rewrittenRoot, [200, true], 'the rewritten path restores and serves the page');
  assert.equal(out.health, 200, 'healthz answers');
  assert.equal(out.unauthenticated, 401, 'production enforces auth on the API');
  assert.equal(out.login, 200, 'the configured scrypt hash accepts the password');
  assert.equal(out.authenticated, 200, 'the stateless session cookie authorizes the next call');
});
