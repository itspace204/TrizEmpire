'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConfig } = require('../lib/config');
const { neonQuery, endpointCandidates } = require('../lib/neon');
const { createStore, loadAssignmentsNeon, saveAssignmentsNeon, NEON_KEY, NEON_TABLE } = require('../lib/workspaces');
const { createServer } = require('../server');

const DSN = 'postgres://triz:sekret-password@ep-cool-forest-123456.us-east-2.aws.neon.tech/neondb?sslmode=require';
const NEON = { dsn: DSN };

/* ── configuration ────────────────────────────────────────────────────── */

test('NEON_DATABASE_URL is parsed and DATABASE_URL is accepted as a fallback', () => {
  const primary = resolveConfig({}, { NODE_ENV: 'test', NEON_DATABASE_URL: DSN, DATABASE_URL: 'postgres://other@h/db' });
  assert.equal(primary.neon.dsn, DSN, 'NEON_DATABASE_URL wins when both are set');

  const fallback = resolveConfig({}, { NODE_ENV: 'test', DATABASE_URL: DSN });
  assert.equal(fallback.neon.dsn, DSN);

  const unset = resolveConfig({}, { NODE_ENV: 'test' });
  assert.equal(unset.neon, null);
});

test('the connection string is validated without ever echoing it', () => {
  const cases = [
    ['https://triz:sekret-password@example.com/db', /postgres:\/\//],
    ['postgres://user@ep-x.neon.tech/neondb', /must include a user and a password/],
    ['postgres://user:pass@ep-x.neon.tech', /must include a database name/],
    ['not a url', /postgres:\/\//],
  ];
  for (const [value, pattern] of cases) {
    let message = '';
    try {
      resolveConfig({}, { NODE_ENV: 'test', NEON_DATABASE_URL: value });
    } catch (error) {
      message = error.message;
    }
    assert.match(message, pattern, `rejects ${value.slice(0, 24)}`);
    assert.ok(!message.includes('sekret-password'), 'the password must never be echoed');
  }
});

test('a non-postgres scheme never becomes a fetch target', () => {
  assert.throws(
    () => resolveConfig({}, { NODE_ENV: 'test', NEON_DATABASE_URL: 'http://user:pass@example.com/db' }),
    /postgres:\/\/ or postgresql:\/\//,
  );
});

/* ── HTTPS SQL client ─────────────────────────────────────────────────── */

test('the endpoint follows the official driver: first label rewritten to api.', () => {
  const candidates = endpointCandidates(DSN);
  assert.equal(candidates[0], 'https://api.us-east-2.aws.neon.tech/sql');
  assert.equal(candidates[1], 'https://ep-cool-forest-123456.us-east-2.aws.neon.tech/sql');
});

test('neonQuery sends the documented headers and a parameterized body', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        command: 'SELECT',
        fields: [{ name: 'value', dataTypeID: 114 }],
        rows: [['{"version":1}']],
        rowCount: 1,
      }),
    };
  };

  const result = await neonQuery(DSN, `SELECT value FROM ${NEON_TABLE} WHERE key = $1`, [NEON_KEY], { fetchImpl: fetchMock });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.us-east-2.aws.neon.tech/sql');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Neon-Connection-String'], DSN);
  assert.equal(calls[0].init.headers['Neon-Array-Mode'], 'true');
  assert.equal(calls[0].init.headers['Neon-Raw-Text-Output'], 'true');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: `SELECT value FROM ${NEON_TABLE} WHERE key = $1`,
    params: [NEON_KEY],
  });

  // Array-mode rows are re-keyed by field name.
  assert.deepEqual(result.rows, [{ value: '{"version":1}' }]);
  assert.equal(result.rowCount, 1);
});

test('neonQuery accepts object rows as well as array rows', async () => {
  const fetchMock = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ command: 'SELECT', fields: [{ name: 'value' }], rows: [{ value: 'x' }], rowCount: 1 }),
  });
  const result = await neonQuery(DSN, 'SELECT 1', [], { fetchImpl: fetchMock });
  assert.deepEqual(result.rows, [{ value: 'x' }]);
});

test('a Postgres error (HTTP 400) surfaces its SQLSTATE and is never retried', async () => {
  let calls = 0;
  const fetchMock = async () => {
    calls += 1;
    return {
      ok: false,
      status: 400,
      json: async () => ({ message: 'relation "trizempire_settings" does not exist', code: '42P01' }),
    };
  };
  await assert.rejects(
    () => neonQuery(DSN, 'SELECT 1', [], { fetchImpl: fetchMock }),
    error => error.code === '42P01',
  );
  assert.equal(calls, 1, 'a real database answer must not trigger an endpoint retry');
});

test('a 400 without a SQLSTATE (auth/gateway failure) still reports a code', async () => {
  // Real Neon answers 400 with "code": "" when the DSN password is wrong —
  // a falsy code would break every caller that reads error.code.
  const fetchMock = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ message: "password authentication failed for user 'probe'", code: '' }),
  });
  await assert.rejects(
    () => neonQuery(DSN, 'SELECT 1', [], { fetchImpl: fetchMock }),
    error => {
      assert.equal(error.code, 'sql_error');
      assert.match(error.message, /password authentication failed/);
      return true;
    },
  );
});

test('a non-400 failure falls back to the plain endpoint host', async () => {
  const urls = [];
  const fetchMock = async url => {
    urls.push(url);
    return { ok: false, status: 502, text: async () => 'bad gateway', json: async () => ({}) };
  };
  await assert.rejects(
    () => neonQuery(DSN, 'SELECT 1', [], { fetchImpl: fetchMock }),
    error => error.code === 'neon_http_502',
  );
  assert.deepEqual(urls, [
    'https://api.us-east-2.aws.neon.tech/sql',
    'https://ep-cool-forest-123456.us-east-2.aws.neon.tech/sql',
  ]);
});

test('network failures report neon_unreachable and never leak the DSN', async () => {
  const fetchMock = async () => { throw new Error('getaddrinfo ENOTFOUND api.us-east-2.aws.neon.tech'); };
  await assert.rejects(
    () => neonQuery(DSN, 'SELECT 1', [], { fetchImpl: fetchMock }),
    error => {
      assert.equal(error.code, 'neon_unreachable');
      assert.ok(!error.message.includes('sekret-password'));
      assert.ok(!error.message.includes(DSN));
      assert.ok(!error.message.includes('ENOTFOUND'));
      return true;
    },
  );
});

test('unsupported parameter types are refused before any request', async () => {
  let calls = 0;
  const fetchMock = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ rows: [] }) }; };
  await assert.rejects(
    () => neonQuery(DSN, 'SELECT $1', [{ nested: true }], { fetchImpl: fetchMock }),
    error => error.code === 'unsupported_param',
  );
  assert.equal(calls, 0);
});

/* ── store backend ────────────────────────────────────────────────────── */

function fakeNeon() {
  const queries = [];
  let tableExists = false;
  let stored = null;
  const run = async (dsn, query, params) => {
    queries.push({ dsn, query, params });
    if (query.startsWith('CREATE TABLE')) {
      tableExists = true;
      return { rows: [], rowCount: 0, command: 'CREATE TABLE' };
    }
    if (!tableExists) {
      const err = new Error('relation does not exist');
      err.code = '42P01';
      throw err;
    }
    if (query.startsWith('SELECT')) {
      return { rows: stored ? [{ value: stored }] : [], rowCount: stored ? 1 : 0, command: 'SELECT' };
    }
    if (query.startsWith('INSERT')) {
      stored = params[1];
      return { rows: [], rowCount: 1, command: 'INSERT' };
    }
    const err = new Error('unexpected query');
    err.code = 'XX000';
    throw err;
  };
  return { run, queries, get stored() { return stored; } };
}

test('the store creates its table on first use and then reads nothing as defaults', async () => {
  const fake = fakeNeon();
  const loaded = await loadAssignmentsNeon(NEON, { neonQueryImpl: fake.run });
  assert.deepEqual(loaded, { assignments: null, source: 'defaults', error: null });
  assert.equal(fake.queries.length, 3, 'select → create table → select');
  assert.match(fake.queries[1].query, /^CREATE TABLE IF NOT EXISTS trizempire_settings/);
  assert.equal(fake.queries[0].params[0], NEON_KEY);
});

test('save then load round-trips the mapping through the database', async () => {
  const fake = fakeNeon();
  const assignments = { content: ['default'], work: [] };
  const saved = await saveAssignmentsNeon(NEON, assignments, { neonQueryImpl: fake.run });
  assert.deepEqual(saved, { ok: true, assignments });
  assert.match(fake.queries[fake.queries.length - 1].query, /^INSERT INTO trizempire_settings/);
  assert.equal(fake.queries[fake.queries.length - 1].params[0], NEON_KEY);

  const loaded = await loadAssignmentsNeon(NEON, { neonQueryImpl: fake.run });
  assert.deepEqual(loaded, { assignments, source: 'stored', error: null });
});

test('invalid assignments never reach the database', async () => {
  const fake = fakeNeon();
  const saved = await saveAssignmentsNeon(NEON, { bogus_workspace: ['default'] }, { neonQueryImpl: fake.run });
  assert.equal(saved.ok, false);
  assert.match(saved.error, /unknown workspace id/);
  assert.equal(fake.queries.length, 0);
});

test('an unreachable database reports an honest error instead of throwing', async () => {
  const failing = async () => {
    const err = new Error('connect failed');
    err.code = 'neon_unreachable';
    throw err;
  };
  const loaded = await loadAssignmentsNeon(NEON, { neonQueryImpl: failing });
  assert.equal(loaded.assignments, null);
  assert.equal(loaded.source, 'defaults');
  assert.match(loaded.error, /workspace database unreachable \(neon_unreachable\)/);

  const saved = await saveAssignmentsNeon(NEON, { content: [] }, { neonQueryImpl: failing });
  assert.equal(saved.ok, false);
  assert.match(saved.error, /nothing was saved/);
});

test('stored JSON that fails validation falls back to defaults with an error', async () => {
  const run = async () => ({ rows: [{ value: JSON.stringify({ version: 1, assignments: { nope: ['default'] } }) }], rowCount: 1 });
  const loaded = await loadAssignmentsNeon(NEON, { neonQueryImpl: run });
  assert.equal(loaded.assignments, null);
  assert.equal(loaded.source, 'defaults');
  assert.match(loaded.error, /rejected: unknown workspace id/);
});

test('backend precedence is neon > kv > file', () => {
  const config = {
    file: '/tmp/workspaces.json',
    kv: { url: 'https://kv.example', token: 't' },
    neon: { dsn: DSN },
  };
  assert.equal(createStore(config).backend, 'neon');
  assert.equal(createStore({ ...config, neon: null }).backend, 'kv');
  assert.equal(createStore({ file: config.file }).backend, 'file');
});

/* ── the HTTP route ───────────────────────────────────────────────────── */

/* A tiny in-memory Neon: speaks the wire contract (400 + SQLSTATE for a
 * missing table, 200 with array-mode rows otherwise) over plain fetch. */
function fakeNeonFetch() {
  const state = { table: false, value: null, urls: [] };
  const fetchMock = async (url, init) => {
    state.urls.push(url);
    const { query, params } = JSON.parse(init.body);
    const ok = payload => ({ ok: true, status: 200, json: async () => payload });
    if (query.startsWith('CREATE TABLE')) {
      state.table = true;
      return ok({ command: 'CREATE TABLE', fields: [], rows: [], rowCount: 0 });
    }
    if (!state.table) {
      return { ok: false, status: 400, json: async () => ({ message: 'relation does not exist', code: '42P01' }) };
    }
    if (query.startsWith('SELECT')) {
      return ok({
        command: 'SELECT',
        fields: [{ name: 'value', dataTypeID: 114 }],
        rows: state.value ? [[state.value]] : [],
        rowCount: state.value ? 1 : 0,
      });
    }
    if (query.startsWith('INSERT')) {
      state.value = params[1];
      return ok({ command: 'INSERT', fields: [], rows: [], rowCount: 1 });
    }
    return { ok: false, status: 400, json: async () => ({ message: 'unexpected query', code: 'XX000' }) };
  };
  return { fetchMock, state };
}

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

test('the workspaces route reads and writes through the Neon backend', async () => {
  const neon = fakeNeonFetch();
  await withServer(async base => {
    const first = await (await fetch(`${base}/api/workspaces`)).json();
    assert.equal(first.backend, 'neon');
    assert.equal(first.source, 'defaults');
    assert.equal(first.error, null);

    const assignments = { content: ['default'], work: [] };
    const put = await fetch(`${base}/api/workspaces`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignments }),
    });
    assert.equal(put.status, 200);
    const saved = await put.json();
    assert.equal(saved.ok, true);
    assert.equal(saved.backend, 'neon');

    const second = await (await fetch(`${base}/api/workspaces`)).json();
    assert.equal(second.source, 'stored');
    assert.deepEqual(second.assignments, assignments);
    assert.ok(neon.state.urls.every(url => url.startsWith('https://')), 'SQL must go to Neon over HTTPS');
  }, { neon: NEON, neonFetch: neon.fetchMock, hermesBaseUrl: 'http://127.0.0.1:9' });
});
