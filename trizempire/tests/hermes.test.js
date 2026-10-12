'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');
const { hashPassword } = require('../lib/auth');
const hermes = require('../lib/hermes');

const ADMIN_HASH = hashPassword('correct horse battery staple');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function withServer(run, options = {}) {
  const server = createServer(options);
  const port = await listen(server);
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await close(server);
  }
}

async function withUpstream(handler, run) {
  const upstream = http.createServer(handler);
  const port = await listen(upstream);
  try {
    await run(`http://127.0.0.1:${port}`, upstream);
  } finally {
    await close(upstream);
  }
}

test('proxy relays a connected upstream as normalized JSON', async () => {
  await withUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ gateway_running: true, profiles: ['default', 'data'], overall: 'ok' }));
  }, async upstreamBase => {
    await withServer(async base => {
      const res = await fetch(`${base}/api/hermes/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.state, 'connected');
      assert.equal(body.status.gateway_running, true);
      assert.deepEqual(body.status.profiles, ['default', 'data']);
    }, { users: [], hermesBaseUrl: upstreamBase });
  });
});

test('unreachable upstream maps to disconnected (502), not a hang', async () => {
  const probe = http.createServer(() => {});
  const closedPort = await listen(probe);
  await close(probe); // now a guaranteed-closed local port
  await withServer(async base => {
    const res = await fetch(`${base}/api/hermes/status`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.state, 'disconnected');
    assert.equal(body.error, 'upstream_unreachable');
  }, { users: [], hermesBaseUrl: `http://127.0.0.1:${closedPort}`, hermesTimeoutMs: 500 });
});

test('slow upstream maps to timeout (504)', async () => {
  await withUpstream((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }, 800);
  }, async upstreamBase => {
    await withServer(async base => {
      const res = await fetch(`${base}/api/hermes/status`);
      assert.equal(res.status, 504);
      const body = await res.json();
      assert.equal(body.state, 'error');
      assert.equal(body.error, 'timeout');
    }, { users: [], hermesBaseUrl: upstreamBase, hermesTimeoutMs: 120 });
  });
});

test('non-JSON upstream responses are rejected as bad_response', async () => {
  await withUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not json</html>');
  }, async upstreamBase => {
    await withServer(async base => {
      const res = await fetch(`${base}/api/hermes/status`);
      assert.equal(res.status, 504);
      const body = await res.json();
      assert.equal(body.error, 'upstream_bad_response');
    }, { users: [], hermesBaseUrl: upstreamBase });
  });
});

test('proxy is not an open relay: only the fixed path is fetched', async () => {
  const seen = [];
  await withUpstream((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  }, async upstreamBase => {
    await withServer(async base => {
      // Even a path-injection attempt on our side cannot change the upstream path.
      await fetch(`${base}/api/hermes/status?path=../../etc/passwd`);
      assert.deepEqual(seen, ['/api/status']);
    }, { users: [], hermesBaseUrl: upstreamBase });
  });
});

test('proxy requires authentication when configured', async () => {
  await withServer(async base => {
    const anon = await fetch(`${base}/api/hermes/status`);
    assert.equal(anon.status, 401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const authed = await fetch(`${base}/api/hermes/status`, { headers: { cookie } });
    assert.equal(authed.status, 502); // upstream is a closed port in this test
    assert.equal((await authed.json()).state, 'disconnected');
  }, {
    users: [{ username: 'admin', role: 'admin', hash: ADMIN_HASH }],
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9',
  });
});

/* ── per-agent endpoints (authenticated upstream) ──────────────────────── */

function replyJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('per-agent endpoint authenticates upstream and fetches only allowlisted paths', async () => {
  const seen = [];
  const TOKEN = 'upstream-session-token-for-tests';
  const now = Math.floor(Date.now() / 1000);
  await withUpstream((req, res) => {
    const path = req.url.split('?')[0];
    seen.push({ path, token: req.headers['x-hermes-session-token'] || null });
    if (path === '/api/profiles/sessions') {
      return replyJson(res, {
        sessions: [
          { profile: 'default', is_active: true, last_active: now - 5 },
          { profile: 'default', is_active: false, last_active: now - 7200 },
          { profile: 'data', is_active: false, last_active: now - 600 },
        ],
      });
    }
    if (path === '/api/profiles') {
      return replyJson(res, {
        profiles: [
          { name: 'default', gateway_running: true },
          { name: 'data', gateway_running: true },
        ],
      });
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  }, async upstreamBase => {
    await withServer(async base => {
      const res = await fetch(`${base}/api/hermes/agents`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.state, 'connected');
      assert.equal(body.activeWindowSec, 300); // Hermes' own is_active window
      const byName = Object.fromEntries(body.agents.map(a => [a.profile, a]));
      assert.equal(byName.default.activeSessions, 1, 'the active session counts');
      assert.equal(byName.default.sessions, 2);
      assert.ok(Number.isFinite(byName.default.lastActiveAgeSec));
      assert.equal(byName.data.activeSessions, 0);
      assert.ok(Math.abs(byName.data.lastActiveAgeSec - 600) <= 2);
      // Exactly the two allowlisted paths, both carrying the session token.
      assert.deepEqual(seen.map(s => s.path), ['/api/profiles', '/api/profiles/sessions']);
      for (const s of seen) assert.equal(s.token, TOKEN);
    }, { users: [], hermesBaseUrl: upstreamBase, hermesSessionToken: TOKEN });
  });
});

test('without a session token the endpoint reports unconfigured and touches no upstream', async () => {
  let hits = 0;
  await withUpstream((req, res) => {
    hits += 1;
    replyJson(res, {});
  }, async upstreamBase => {
    await withServer(async base => {
      const res = await fetch(`${base}/api/hermes/agents`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.state, 'unconfigured');
      assert.equal(body.error, 'no_session_token');
      assert.deepEqual(body.agents, undefined, 'no fabricated agents');
    }, { users: [], hermesBaseUrl: upstreamBase });
  });
  assert.equal(hits, 0, 'an unconfigured server must not probe the upstream');
});

test('an upstream 401 is reported as unauthorized, not as a disconnected backend', async () => {
  await withUpstream((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"detail":"Unauthorized"}');
  }, async upstreamBase => {
    await withServer(async base => {
      const res = await fetch(`${base}/api/hermes/agents`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.state, 'unauthorized');
      assert.notEqual(body.state, 'disconnected');
    }, { users: [], hermesBaseUrl: upstreamBase, hermesSessionToken: 'stale-token' });
  });
});

test('the session token is never sent to the public status probe', async () => {
  const tokens = [];
  await withUpstream((req, res) => {
    tokens.push(req.headers['x-hermes-session-token'] || null);
    replyJson(res, { gateway_running: true });
  }, async upstreamBase => {
    await withServer(async base => {
      const res = await fetch(`${base}/api/hermes/status`);
      assert.equal(res.status, 200);
    }, {
      users: [],
      hermesBaseUrl: upstreamBase,
      hermesSessionToken: 'should-not-travel',
    });
  });
  assert.deepEqual(tokens, [null], 'the public probe needs no credentials');
});

test('per-agent endpoint requires an authenticated session when auth is configured', async () => {
  await withServer(async base => {
    const anon = await fetch(`${base}/api/hermes/agents`);
    assert.equal(anon.status, 401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const authed = await fetch(`${base}/api/hermes/agents`, { headers: { cookie } });
    assert.equal(authed.status, 502); // upstream is a closed port in this test
    assert.equal((await authed.json()).state, 'disconnected');
  }, {
    users: [{ username: 'admin', role: 'admin', hash: ADMIN_HASH }],
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9',
    hermesSessionToken: 'unused-here',
  });
});

test('the upstream path allowlist rejects anything a caller could inject', () => {
  const base = 'http://127.0.0.1:9119';
  assert.equal(hermes.upstreamUrl(base, '/api/status').pathname, '/api/status');
  assert.equal(hermes.upstreamUrl(base, '/api/profiles').pathname, '/api/profiles');
  for (const evil of ['/etc/passwd', '../../etc/passwd', '/api/profiles/../../admin',
    'http://evil.example/', '//evil.example/', '/api/gateway/drain']) {
    assert.equal(hermes.upstreamUrl(base, evil), null, `must reject ${evil}`);
  }
  assert.deepEqual([...hermes.UPSTREAM_PATHS].sort(),
    ['/api/memory', '/api/messaging/platforms', '/api/profiles', '/api/profiles/sessions', '/api/status']);
  // Profile names only ever ride as a validated query parameter.
  assert.equal(hermes.PROFILE_RE.test('writer'), true);
  assert.equal(hermes.PROFILE_RE.test('../../etc/passwd'), false);
  assert.equal(hermes.PROFILE_RE.test('a b'), false);
  assert.equal(hermes.PROFILE_RE.test(''), false);
});

test('real Hermes backend (when running) is reached through the proxy', async t => {
  let reachable = false;
  try {
    const probe = await fetch('http://127.0.0.1:9119/api/status', { signal: AbortSignal.timeout(1500) });
    reachable = probe.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    return t.skip('Hermes backend not running on 127.0.0.1:9119 — real-integration check skipped');
  }
  await withServer(async base => {
    const res = await fetch(`${base}/api/hermes/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.state, 'connected');
    assert.equal(typeof body.status.gateway_running, 'boolean');
    assert.ok(Array.isArray(body.status.profiles));
  }, { users: [], hermesBaseUrl: 'http://127.0.0.1:9119' });
});

/* ── per-profile fact endpoints: memory + messaging (telegram) ─────── */

test('memory and messaging forward the profile, carry the token, normalize facts', async () => {
  const TOKEN = 'paired-session-token';
  const seen = [];
  await withUpstream((req, res) => {
    const u = new URL(req.url, 'http://upstream');
    seen.push({
      path: u.pathname,
      profile: u.searchParams.get('profile'),
      token: req.headers['x-hermes-session-token'],
    });
    if (u.pathname === '/api/memory') {
      return replyJson(res, {
        active: '',
        providers: [{ name: 'graphite', description: 'g', available: true, configured: true, status: 'ready' }],
        builtin_files: { memory: 2048, user: 10 },
      });
    }
    return replyJson(res, {
      gateway_start_command: 'hermes gateway start --profile writer',
      platforms: [
        { id: 'telegram', name: 'Telegram', enabled: true, configured: true,
          gateway_running: true, state: 'connected', error_code: null, error_message: null },
        { id: 'whatsapp', name: 'WhatsApp', enabled: false, configured: false,
          gateway_running: true, state: 'disabled' },
      ],
    });
  }, async upstreamBase => {
    await withServer(async base => {
      const mem = await fetch(`${base}/api/hermes/memory?profile=writer`);
      assert.equal(mem.status, 200);
      const mb = await mem.json();
      assert.equal(mb.ok, true);
      assert.equal(mb.state, 'connected');
      assert.equal(mb.memory.provider, '');           // built-in files, no external provider
      assert.equal(mb.memory.files.memoryBytes, 2048);
      assert.equal(mb.memory.files.userBytes, 10);
      assert.equal(mb.memory.providers[0].name, 'graphite');
      assert.equal(mb.memory.providers[0].configured, true);

      const msg = await fetch(`${base}/api/hermes/messaging?profile=writer`);
      assert.equal(msg.status, 200);
      const tb = await msg.json();
      assert.equal(tb.ok, true);
      assert.equal(tb.messaging.gatewayRunning, true);
      assert.match(tb.messaging.startCommand, /gateway start/);
      const tg = tb.messaging.platforms.find(p => p.id === 'telegram');
      assert.equal(tg.state, 'connected');
      assert.equal(tg.enabled, true);
      assert.equal(tg.configured, true);
      assert.equal(tg.gatewayRunning, true);

      // Exactly the two fixed paths, both with the profile query + token.
      assert.deepEqual(seen.map(s => `${s.path}?${s.profile}`),
        ['/api/memory?writer', '/api/messaging/platforms?writer']);
      for (const s of seen) assert.equal(s.token, TOKEN);
    }, { users: [], hermesBaseUrl: upstreamBase, hermesSessionToken: TOKEN });
  });
});

test('a bad profile is rejected locally (400) and never reaches the upstream', async () => {
  let hits = 0;
  await withUpstream((req, res) => {
    hits += 1;
    replyJson(res, {});
  }, async upstreamBase => {
    await withServer(async base => {
      for (const evil of ['../../etc/passwd', '../x', 'a b', 'x/y', '']) {
        const res = await fetch(`${base}/api/hermes/memory?profile=${encodeURIComponent(evil)}`);
        assert.equal(res.status, 400, `must reject ${JSON.stringify(evil)}`);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.state, 'bad_request');
        assert.equal(body.error, 'bad_profile');
      }
      const missing = await fetch(`${base}/api/hermes/messaging`);
      assert.equal(missing.status, 400, 'a missing profile is also a bad request');
    }, { users: [], hermesBaseUrl: upstreamBase, hermesSessionToken: 't' });
  });
  assert.equal(hits, 0, 'invalid profiles must not probe the upstream');
});

test('memory/messaging report unconfigured (503) without a token and touch no upstream', async () => {
  let hits = 0;
  await withUpstream((req, res) => {
    hits += 1;
    replyJson(res, {});
  }, async upstreamBase => {
    await withServer(async base => {
      for (const path of ['/api/hermes/memory?profile=default', '/api/hermes/messaging?profile=default']) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.state, 'unconfigured');
        assert.equal(body.error, 'no_session_token');
        assert.equal(body.memory, undefined, 'no fabricated memory');
        assert.equal(body.messaging, undefined, 'no fabricated channels');
      }
    }, { users: [], hermesBaseUrl: upstreamBase });
  });
  assert.equal(hits, 0, 'an unconfigured server must not probe the upstream');
});

test('memory/messaging require an authenticated session when auth is configured', async () => {
  await withServer(async base => {
    const anon = await fetch(`${base}/api/hermes/memory?profile=default`);
    assert.equal(anon.status, 401);
    const anon2 = await fetch(`${base}/api/hermes/messaging?profile=default`);
    assert.equal(anon2.status, 401);
  }, {
    users: [{ username: 'admin', role: 'admin', hash: ADMIN_HASH }],
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9',
    hermesSessionToken: 'unused-here',
  });
});
