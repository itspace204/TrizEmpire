'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { hashPassword, SessionStore, RateLimiter } = require('../lib/auth');

const ADMIN_HASH = hashPassword('correct horse battery staple');
const OPERATOR_HASH = hashPassword('operator password 123');

function withServer(run, options = {}) {
  const server = createServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await run(base);
      } finally {
        await new Promise(r => server.close(r));
      }
      resolve();
    });
  });
}

function authOptions(extra = {}) {
  return {
    users: [
      { username: 'admin', role: 'admin', hash: ADMIN_HASH },
      { username: 'operator', role: 'operator', hash: OPERATOR_HASH },
    ],
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9', // closed port: proxy tests are separate
    ...extra,
  };
}

async function login(base, username, password, origin) {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: origin || base },
    body: JSON.stringify({ username, password }),
  });
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

test('login with valid credentials sets an HttpOnly SameSite session cookie', async () => {
  await withServer(async base => {
    const res = await login(base, 'admin', 'correct horse battery staple');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, user: 'admin', role: 'admin' });
    const cookie = res.headers.get('set-cookie') || '';
    assert.match(cookie, /triz_session=[0-9a-f]{64}/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const session = await fetch(`${base}/api/auth/session`, { headers: { cookie: cookieFrom(res) } });
    assert.deepEqual(await session.json(), { authenticated: true, user: 'admin', role: 'admin' });
  }, authOptions());
});

test('login with invalid credentials returns 401 and sets no cookie', async () => {
  await withServer(async base => {
    const res = await login(base, 'admin', 'wrong password');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.deepEqual(await res.json(), { error: 'invalid_credentials' });
  }, authOptions());
});

test('unknown usernames are rejected without revealing existence', async () => {
  await withServer(async base => {
    const res = await login(base, 'nobody', 'whatever');
    assert.equal(res.status, 401);
  }, authOptions());
});

test('cross-origin login attempts are rejected', async () => {
  await withServer(async base => {
    const res = await login(base, 'admin', 'correct horse battery staple', 'https://evil.example');
    assert.equal(res.status, 403);
  }, authOptions());
});

test('login rate limit kicks in after repeated failures and reports Retry-After', async () => {
  const clock = { t: 1_000_000, now: () => clock.t };
  await withServer(async base => {
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000, now: clock.now });
    for (let i = 0; i < 3; i++) {
      const res = await login(base, 'admin', 'nope');
      assert.equal(res.status, 401);
    }
    const blocked = await login(base, 'admin', 'correct horse battery staple');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  }, { ...authOptions(), loginLimiter: new RateLimiter({ max: 3, windowMs: 60_000, now: clock.now }) });
});

test('protected API requires a session when auth is configured', async () => {
  await withServer(async base => {
    const anon = await fetch(`${base}/api/hermes/status`);
    assert.equal(anon.status, 401);
    assert.deepEqual(await anon.json(), { error: 'authentication_required' });
  }, authOptions());
});

test('state-changing requests without the CSRF header are rejected', async () => {
  await withServer(async base => {
    const res = await login(base, 'operator', 'operator password 123');
    const cookie = cookieFrom(res);
    const noHeader = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(noHeader.status, 403);
    const badOrigin = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { cookie, 'x-triz-csrf': '1', origin: 'https://evil.example' },
    });
    assert.equal(badOrigin.status, 403);
    const ok = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { cookie, 'x-triz-csrf': '1', origin: base },
    });
    assert.equal(ok.status, 200);
  }, authOptions());
});

test('logout destroys the session and clears the cookie', async () => {
  await withServer(async base => {
    const res = await login(base, 'admin', 'correct horse battery staple');
    const cookie = cookieFrom(res);
    const out = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { cookie, 'x-triz-csrf': '1', origin: base },
    });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/);
    const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
    assert.deepEqual(await session.json(), { authenticated: false });
  }, authOptions());
});

test('sessions expire after the idle window', async () => {
  const clock = { t: 5_000_000, now: () => clock.t };
  await withServer(async base => {
    const res = await login(base, 'admin', 'correct horse battery staple');
    const cookie = cookieFrom(res);
    clock.t += 61_000; // idle window is 60s below
    const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
    assert.deepEqual(await session.json(), { authenticated: false });
    const guarded = await fetch(`${base}/api/hermes/status`, { headers: { cookie } });
    assert.equal(guarded.status, 401);
  }, authOptions({
    sessions: new SessionStore({ idleMs: 60_000, absoluteMs: 10 * 60_000, now: clock.now }),
  }));
});

test('admin-only diagnostics reject operator sessions', async () => {
  await withServer(async base => {
    const res = await login(base, 'operator', 'operator password 123');
    const detail = await fetch(`${base}/api/health/detail`, { headers: { cookie: cookieFrom(res) } });
    assert.equal(detail.status, 403);
  }, authOptions());
});

test('diagnostics expose no filesystem paths, env values or tokens', async () => {
  await withServer(async base => {
    const res = await login(base, 'admin', 'correct horse battery staple');
    const detail = await fetch(`${base}/api/health/detail`, { headers: { cookie: cookieFrom(res) } });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ['authRequired', 'hermes', 'node', 'uptimeSeconds']);
    assert.ok(!JSON.stringify(body).includes('TRIZ_'));
  }, authOptions());
});

test('protected sources are never served statically', async () => {
  await withServer(async base => {
    for (const p of ['/lib/auth.js', '/server.js', '/package.json', '/tests/server.test.js']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, `${p} must not be served`);
    }
  }, authOptions());
});

test('non-loopback binding is refused without explicit override', () => {
  assert.throws(
    () => createServer({ host: '0.0.0.0', users: [] }),
    /Refusing non-loopback HOST/,
  );
});

test('non-loopback binding is refused when no authentication is configured', () => {
  assert.throws(
    () => createServer({ host: '0.0.0.0', allowRemoteHost: true, users: [] }),
    /Refusing non-loopback bind without authentication/,
  );
});
