'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { resolveConfig } = require('../lib/config');
const { hashPassword } = require('../lib/auth');
const { supabaseSignIn, isEmailLike } = require('../lib/supabase');

const ADMIN_HASH = hashPassword('correct horse battery staple');
const SUPABASE = Object.freeze({
  url: 'https://example-ref.supabase.co',
  key: 'sb_publishable_test_key',
  role: 'admin',
});

/* ── config validation ────────────────────────────────────────────────── */

test('Supabase URL and key must be configured together', () => {
  assert.throws(
    () => resolveConfig({}, { NODE_ENV: 'test', SUPABASE_URL: 'https://example-ref.supabase.co' }),
    /SUPABASE_ANON_KEY/,
  );
  assert.throws(
    () => resolveConfig({}, { NODE_ENV: 'test', SUPABASE_ANON_KEY: 'sb_publishable_test_key' }),
    /SUPABASE_URL/,
  );
});

test('Supabase config validates the URL and role without echoing values', () => {
  assert.throws(
    () => resolveConfig({}, {
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://user:pass@example-ref.supabase.co',
      SUPABASE_ANON_KEY: 'sb_publishable_test_key',
    }),
    /must not contain embedded credentials/,
  );
  assert.throws(
    () => resolveConfig({}, {
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://example-ref.supabase.co',
      SUPABASE_ANON_KEY: 'sb_publishable_test_key',
      TRIZ_SUPABASE_ROLE: 'superuser',
    }),
    /TRIZ_SUPABASE_ROLE must be one of: admin, operator/,
  );

  // A malformed value must fail fast WITHOUT leaking the secret key.
  let message = '';
  try {
    resolveConfig({}, {
      NODE_ENV: 'test',
      SUPABASE_URL: 'not-a-url',
      SUPABASE_ANON_KEY: 'sb_super_secret_value',
    });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /SUPABASE_URL/);
  assert.ok(!message.includes('sb_super_secret_value'), 'secret must never be echoed');
});

test('production accepts Supabase as the only authentication', () => {
  const cfg = resolveConfig({}, {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://example-ref.supabase.co/',
    SUPABASE_ANON_KEY: 'sb_publishable_test_key',
  });
  assert.equal(cfg.authRequired, true);
  assert.equal(cfg.supabase.url, 'https://example-ref.supabase.co', 'trailing slash trimmed');
  assert.equal(cfg.supabase.role, 'admin');
  assert.equal(cfg.users.length, 0);
  // The no-auth-at-all production guard is unchanged.
  assert.throws(() => resolveConfig({}, { NODE_ENV: 'production' }), /requires authentication/);
});

test('Supabase stays optional: no variables means no supabase config', () => {
  const cfg = resolveConfig({}, { NODE_ENV: 'test' });
  assert.equal(cfg.supabase, null);
  assert.equal(cfg.authRequired, false);
});

/* ── GoTrue exchange client ───────────────────────────────────────────── */

function jsonResponse(ok, status, payload) {
  return { ok, status, json: async () => payload };
}

test('isEmailLike accepts addresses and rejects usernames', () => {
  assert.equal(isEmailLike('operator@example.com'), true);
  assert.equal(isEmailLike('admin'), false);
  assert.equal(isEmailLike('a b@example.com'), false);
  assert.equal(isEmailLike(undefined), false);
});

test('supabaseSignIn posts the password grant with the apikey header', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(true, 200, {
      access_token: 'sb-access-token',
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'user-1', email: 'operator@example.com' },
    });
  };
  const result = await supabaseSignIn(SUPABASE, 'operator@example.com', 'pw', { fetchImpl: fetchMock });
  assert.equal(result.user.email, 'operator@example.com');
  assert.equal(result.user.id, 'user-1');
  assert.equal(result.expiresInSeconds, 3600);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example-ref.supabase.co/auth/v1/token?grant_type=password');
  assert.equal(calls[0].init.headers.apikey, SUPABASE.key);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { email: 'operator@example.com', password: 'pw' });
});

test('supabaseSignIn maps upstream failures to stable codes', async () => {
  const cases = [
    [400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 'invalid_credentials'],
    [400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' }, 'email_not_confirmed'],
    [400, { code: 'user_not_found', msg: 'User not found' }, 'invalid_credentials'],
    [401, { msg: 'Invalid API key' }, 'upstream_auth'],
    [500, { msg: 'boom' }, 'upstream_unavailable'],
  ];
  for (const [status, payload, expected] of cases) {
    const fetchMock = async () => jsonResponse(false, status, payload);
    await assert.rejects(
      () => supabaseSignIn(SUPABASE, 'a@example.com', 'pw', { fetchImpl: fetchMock }),
      error => error.code === expected,
      `status ${status} → ${expected}`,
    );
  }
});

test('supabaseSignIn reports network failures without leaking inputs', async () => {
  const fetchMock = async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); };
  await assert.rejects(
    () => supabaseSignIn(SUPABASE, 'a@example.com', 'super-secret-pw', { fetchImpl: fetchMock }),
    error => {
      assert.equal(error.code, 'upstream_unavailable');
      assert.ok(!error.message.includes('super-secret-pw'));
      assert.ok(!error.message.includes(SUPABASE.key));
      assert.ok(!error.message.includes('ECONNREFUSED'));
      return true;
    },
  );
});

/* ── login route ──────────────────────────────────────────────────────── */

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

function supabaseOptions(fetchImpl, extra = {}) {
  return {
    users: [{ username: 'admin', role: 'admin', hash: ADMIN_HASH }],
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9',
    supabase: SUPABASE,
    supabaseFetch: fetchImpl,
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

test('config advertises that Supabase sign-in is available', async () => {
  await withServer(async base => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.auth.required, true);
    assert.equal(config.auth.supabase, true);
  }, supabaseOptions(async () => jsonResponse(true, 200, {})));
});

test('local credentials win and are never sent upstream', async () => {
  let upstreamCalls = 0;
  const fetchMock = async () => { upstreamCalls += 1; return jsonResponse(true, 200, {}); };
  await withServer(async base => {
    const res = await login(base, 'admin', 'correct horse battery staple');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, user: 'admin', role: 'admin' });
    assert.equal(upstreamCalls, 0, 'local passwords must not travel to Supabase');
  }, supabaseOptions(fetchMock));
});

test('a Supabase sign-in mints the app session cookie', async () => {
  let seen = null;
  const fetchMock = async (url, init) => {
    seen = { url, init };
    return jsonResponse(true, 200, {
      access_token: 'sb-access-token',
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'user-1', email: 'operator@example.com' },
    });
  };
  await withServer(async base => {
    const res = await login(base, 'operator@example.com', 'their-supabase-password');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, user: 'operator@example.com', role: 'admin' });
    const cookie = res.headers.get('set-cookie') || '';
    assert.match(cookie, /triz_session=/);
    assert.match(cookie, /HttpOnly/i);

    const session = await fetch(`${base}/api/auth/session`, { headers: { cookie: cookie.split(';')[0] } });
    assert.deepEqual(await session.json(), {
      authenticated: true,
      user: 'operator@example.com',
      role: 'admin',
    });

    // The exchange stays server-side: correct endpoint, key in header only.
    assert.match(seen.url, /\/auth\/v1\/token\?grant_type=password$/);
    assert.equal(seen.init.headers.apikey, SUPABASE.key);
    assert.equal(JSON.parse(seen.init.body).password, 'their-supabase-password');
  }, supabaseOptions(fetchMock));
});

test('a wrong Supabase password returns 401 invalid_credentials', async () => {
  const fetchMock = async () => jsonResponse(false, 400, {
    error_code: 'invalid_credentials',
    msg: 'Invalid login credentials',
  });
  await withServer(async base => {
    const res = await login(base, 'operator@example.com', 'wrong');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.deepEqual(await res.json(), { error: 'invalid_credentials' });
  }, supabaseOptions(fetchMock));
});

test('an unconfirmed email is reported distinctly', async () => {
  const fetchMock = async () => jsonResponse(false, 400, {
    error_code: 'email_not_confirmed',
    msg: 'Email not confirmed',
  });
  await withServer(async base => {
    const res = await login(base, 'operator@example.com', 'right');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'email_not_confirmed' });
  }, supabaseOptions(fetchMock));
});

test('an upstream outage returns 502 and does not burn the rate limit', async () => {
  const fetchMock = async () => { throw new Error('connect ECONNREFUSED'); };
  await withServer(async base => {
    // Far more than the limiter's max of 5 — upstream trouble must not
    // lock out a legitimate user.
    for (let i = 0; i < 7; i += 1) {
      const failed = await login(base, 'operator@example.com', 'pw');
      assert.equal(failed.status, 502);
      assert.deepEqual(await failed.json(), { error: 'auth_upstream_unavailable' });
    }
    // The local account still works afterwards.
    const ok = await login(base, 'admin', 'correct horse battery staple');
    assert.equal(ok.status, 200);
  }, supabaseOptions(fetchMock));
});

test('non-email identifiers never reach Supabase', async () => {
  let upstreamCalls = 0;
  const fetchMock = async () => { upstreamCalls += 1; return jsonResponse(true, 200, {}); };
  await withServer(async base => {
    const res = await login(base, 'not-a-local-user', 'whatever');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'invalid_credentials' });
    assert.equal(upstreamCalls, 0);
  }, supabaseOptions(fetchMock));
});

test('cross-origin Supabase sign-ins are rejected before any exchange', async () => {
  let upstreamCalls = 0;
  const fetchMock = async () => { upstreamCalls += 1; return jsonResponse(true, 200, {}); };
  await withServer(async base => {
    const res = await login(base, 'operator@example.com', 'pw', 'https://evil.example');
    assert.equal(res.status, 403);
    assert.equal(upstreamCalls, 0);
  }, supabaseOptions(fetchMock));
});

test('without Supabase configured the login route behaves exactly as before', async () => {
  await withServer(async base => {
    const good = await login(base, 'admin', 'correct horse battery staple');
    assert.equal(good.status, 200);
    const bad = await login(base, 'admin', 'wrong');
    assert.equal(bad.status, 401);
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.auth.supabase, false);
  }, {
    users: [{ username: 'admin', role: 'admin', hash: ADMIN_HASH }],
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9',
  });
});
