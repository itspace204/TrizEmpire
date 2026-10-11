'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');
const { hashPassword } = require('../lib/auth');

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
