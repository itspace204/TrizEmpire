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
