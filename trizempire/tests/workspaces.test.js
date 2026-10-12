'use strict';

/* Tests for the operator-owned workspace→agent mapping:
 *   - GET /api/workspaces   defaults when nothing is stored, corrupt file reported
 *   - PUT /api/workspaces   validation, persistence, auth/CSRF gates
 *   - lib/workspaces.js     storage discipline (atomic write, one home per profile)
 * The endpoint moves no upstream traffic and holds no secrets — the file
 * contains profile names only — so the gates tested here are the ones every
 * state-changing route faces: session auth, CSRF header, same origin. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server');
const { hashPassword } = require('../lib/auth');
const workspaces = require('../lib/workspaces');

const ADMIN_HASH = hashPassword('correct horse battery staple');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triz-ws-'));
  return path.join(dir, 'workspaces.json');
}

async function withServer(run, options = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

/* ── GET: honest defaults, honest corruption reporting ───────────────── */

test('GET returns defaults when nothing is stored', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const res = await fetch(`${base}/api/workspaces`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.assignments, null, 'no stored mapping');
    assert.equal(body.source, 'defaults');
    assert.equal(body.error, null);
  }, { users: [], workspacesFile: file });
});

test('GET reports a corrupt stored file and still answers 200 with defaults', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json at all', 'utf8');
  await withServer(async base => {
    const res = await fetch(`${base}/api/workspaces`);
    assert.equal(res.status, 200, 'a corrupt file must not take the endpoint down');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.assignments, null, 'corrupt file falls back to defaults');
    assert.equal(body.source, 'defaults');
    assert.match(body.error, /not valid JSON/, 'the operator is told why');
  }, { users: [], workspacesFile: file });
});

test('GET rejects a stored file that violates the model (two homes)', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    assignments: { client: ['data'], work: ['data'] },
  }), 'utf8');
  await withServer(async base => {
    const body = await (await fetch(`${base}/api/workspaces`)).json();
    assert.equal(body.assignments, null);
    assert.match(body.error, /two workspaces/, 'the violated invariant is named');
  }, { users: [], workspacesFile: file });
});

/* ── PUT: validate, persist, survive a restart ───────────────────────── */

test('PUT persists the mapping and a fresh server reloads it', async () => {
  const file = tmpFile();
  const mapping = { client: ['data'], work: ['developer'], content: ['writer', 'research'], personal: ['default'] };
  await withServer(async base => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
      body: JSON.stringify({ assignments: mapping }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.assignments, mapping);
    assert.equal(body.source, 'stored');
  }, { users: [], workspacesFile: file });

  // New server instance, same file: the mapping survived the restart.
  await withServer(async base => {
    const body = await (await fetch(`${base}/api/workspaces`)).json();
    assert.deepEqual(body.assignments, mapping, 'a restart must not lose the mapping');
    assert.equal(body.source, 'stored');
  }, { users: [], workspacesFile: file });

  // The file on disk is the validated map, nothing else.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.assignments, mapping);
  assert.ok(!fs.existsSync(`${file}.tmp`), 'atomic write leaves no temp file behind');
});

test('PUT rejects payloads the model would not accept', async () => {
  const file = tmpFile();
  const cases = [
    [{ 'ghost-workspace': ['data'] }, /unknown workspace id/],
    [{ client: ['data'], personal: ['data'] }, /two workspaces/],
    [{ client: ['../etc'] }, /invalid profile id/],
    [{ client: ['Data capital'] }, /invalid profile id/],
    [{ client: 'data' }, /must map to a list/],
    ['not-an-object', /must be an object/],
    [{ client: [123] }, /invalid profile id/],
  ];
  await withServer(async base => {
    for (const [payload, expect] of cases) {
      const res = await fetch(`${base}/api/workspaces`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
        body: JSON.stringify({ assignments: payload }),
      });
      assert.equal(res.status, 400, `must reject ${JSON.stringify(payload)}`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.error, expect);
    }
    assert.ok(!fs.existsSync(file), 'nothing is persisted when validation fails');
    const after = await (await fetch(`${base}/api/workspaces`)).json();
    assert.equal(after.assignments, null, 'the stored mapping is untouched');
  }, { users: [], workspacesFile: file });
});

test('PUT tolerates extra body keys but only persists assignments', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const body = await (await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
      body: JSON.stringify({ assignments: { client: ['data'] }, sneaky: 'ignored' }),
    })).json();
    assert.deepEqual(body.assignments, { client: ['data'] });
  }, { users: [], workspacesFile: file });
});

test('an empty assignment map is valid (operator can clear every override)', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const body = await (await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
      body: JSON.stringify({ assignments: {} }),
    })).json();
    assert.deepEqual(body.assignments, {});
  }, { users: [], workspacesFile: file });
});

/* ── gates: auth, CSRF, methods ──────────────────────────────────────── */

test('when auth is configured, both directions require a session', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const anonGet = await fetch(`${base}/api/workspaces`);
    assert.equal(anonGet.status, 401);
    const anonPut = await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
      body: JSON.stringify({ assignments: {} }),
    });
    assert.equal(anonPut.status, 401, 'an unauthenticated write must never reach validation');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const authedGet = await fetch(`${base}/api/workspaces`, { headers: { cookie } });
    assert.equal(authedGet.status, 200);

    // Missing CSRF header → 403 even with a valid session.
    const noCsrf = await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ assignments: {} }),
    });
    assert.equal(noCsrf.status, 403);

    // Foreign origin → 403 even with session + CSRF header.
    const crossOrigin = await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ assignments: {} }),
    });
    assert.equal(crossOrigin.status, 403);

    // Same-origin write with session + CSRF → accepted.
    const ok = await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', cookie, origin: base },
      body: JSON.stringify({ assignments: { client: ['data'] } }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).assignments, { client: ['data'] });
  }, {
    users: [{ username: 'admin', role: 'admin', hash: ADMIN_HASH }],
    secureCookies: false,
    workspacesFile: file,
  });
});

test('methods other than GET/HEAD/PUT get a 405 with Allow', async () => {
  const file = tmpFile();
  await withServer(async base => {
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/api/workspaces`, { method });
      assert.equal(res.status, 405, `${method} must not be allowed`);
      assert.equal(res.headers.get('allow'), 'GET, HEAD, PUT');
    }
  }, { users: [], workspacesFile: file });
});

test('a malformed JSON body is a 400, not a crash', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
      body: '{broken',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  }, { users: [], workspacesFile: file });
});

/* ── lib/workspaces.js: storage discipline ───────────────────────────── */

test('validateAssignments preserves workspace order and profile order', () => {
  const result = workspaces.validateAssignments({
    work: ['developer', 'data'],
    client: ['research'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.assignments), ['work', 'client']);
  assert.deepEqual(result.assignments.work, ['developer', 'data'], 'operator order is kept');
});

test('loadAssignments distinguishes absent, valid and corrupt files', () => {
  const absent = workspaces.loadAssignments(path.join(os.tmpdir(), 'triz-nope-404.json'));
  assert.deepEqual(absent, { assignments: null, source: 'defaults', error: null });

  const file = tmpFile();
  workspaces.saveAssignments(file, { client: ['data'] });
  const loaded = workspaces.loadAssignments(file);
  assert.deepEqual(loaded.assignments, { client: ['data'] });
  assert.equal(loaded.source, 'stored');

  fs.writeFileSync(file, '{"assignments": {"client": ["data"], "work": ["data"]}}', 'utf8');
  const dup = workspaces.loadAssignments(file);
  assert.equal(dup.assignments, null);
  assert.match(dup.error, /two workspaces/);
});

test('saveAssignments writes atomically and creates missing directories', () => {
  const file = path.join(path.join(os.tmpdir(), 'triz-ws-nest-' + process.pid), 'deep', 'ws.json');
  const result = workspaces.saveAssignments(file, { personal: ['default'] });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(`${file}.tmp`), 'temp file is renamed away');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).assignments, { personal: ['default'] });
});
