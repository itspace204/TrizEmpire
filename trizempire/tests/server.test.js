'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('health endpoint returns a minimal status and security headers', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('serves the TrizEmpire entry page', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /TrizEmpire/);
  });
});

test('health detail reports live runtime, gateway and store facts', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/health/detail`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.node, process.version);
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.ok(new Date(body.checkedAt).toISOString() === body.checkedAt);
    assert.ok(['serverless-instance', 'node-process'].includes(body.runtime.scope));
    assert.ok(body.runtime.cpuSeconds >= 0);
    assert.ok(body.runtime.rssBytes > 0);
    assert.ok(typeof body.hermes.latencyMs === 'number' && body.hermes.latencyMs >= 0);
    assert.equal(typeof body.hermes.state, 'string');
    assert.ok(['neon', 'kv', 'file'].includes(body.stores.workspacesBackend));
    assert.equal(typeof body.host.available, 'boolean');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('health detail rejects non-GET with an Allow header', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/health/detail`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  });
});

test('rejects methods other than GET and HEAD', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });
});

test('does not disclose missing filesystem paths', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/not-a-real-file`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  });
});

test('sends a strict same-origin content security policy', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/`);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header must be present');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    // Vendored modules only: the policy must not allow arbitrary CDNs.
    assert.ok(!csp.includes('cdn.jsdelivr.net'));
  });
});

test('serves vendored same-origin modules', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/vendor/three.module.min.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    const controls = await fetch(`${base}/vendor/OrbitControls.js`);
    assert.equal(controls.status, 200);
  });
});

test('serves the shared crew model with a JavaScript content type', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/crew/crew-model.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    // The UI refuses to run it otherwise (strict MIME checking), so pin it.
    const body = await response.text();
    assert.match(body, /NEXORA_MODEL/);
    // Non-model paths inside the allowlisted folder still obey the rules.
    const dotfile = await fetch(`${base}/crew/.hidden`);
    assert.equal(dotfile.status, 404);
  });
});

test('unknown API paths return JSON 404, not the UI page', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/does-not-exist`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /json/);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });
});

test('healthz rejects POST with an Allow header', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/healthz`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });
});
