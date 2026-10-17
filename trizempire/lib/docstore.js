'use strict';

/* Generic JSON document persistence over the three storage backends the app
 * already has: a local file, an Upstash-compatible KV REST store, and Neon
 * (serverless Postgres via lib/neon.js). One document per key, so the same
 * honest contract the workspace mapping uses applies to every caller:
 *
 *   load()        → { doc, source: 'stored' | 'defaults', error }
 *   save(doc)     → { ok: true, doc } | { ok: false, error }
 *
 * Rules (mirrors lib/workspaces.js):
 *   - a caller-supplied validate() runs BEFORE anything is written and on
 *     every read, so a corrupt or hostile stored value can never reach the
 *     rest of the app;
 *   - an absent store means "defaults apply" — never an error;
 *   - an unreachable store is reported honestly and never throws;
 *   - the Neon table is created on first use with a fixed statement.
 *
 * The seams (fetchImpl / neonFetchImpl / neonQueryImpl) exist so tests run
 * without a network; production uses the platform's global fetch.
 */

const fs = require('node:fs');
const path = require('node:path');
const { neonQuery } = require('./neon');

const KV_TIMEOUT_MS = 8000;
const NEON_TABLE = 'trizempire_settings';
const NEON_CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${NEON_TABLE} (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

/* ── file backend ──────────────────────────────────────────────────────── */

function loadFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { doc: null, source: 'defaults', error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { doc: null, source: 'defaults', error: 'stored file is not valid JSON; defaults apply' };
  }
  return { raw: parsed, source: 'stored', error: null };
}

function saveFile(file, document) {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return null;
  } catch (e) {
    return `cannot write the file (${e.code || 'error'}); configure KV/Neon storage or a writable path`;
  }
}

/* ── KV backend (Upstash-compatible REST) ──────────────────────────────── */

async function kvFetch(kv, pathname, init = {}, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${kv.url.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`;
  const res = await doFetch(url, {
    method: init.method || 'GET',
    headers: {
      authorization: `Bearer ${kv.token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body,
    signal: AbortSignal.timeout(KV_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`kv_http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ── store ─────────────────────────────────────────────────────────────── */

function createStore(config = {}) {
  const key = config.key;
  const validate = config.validate || (doc => ({ ok: true, doc }));
  const wrap = doc => ({ version: 1, data: doc });
  const unwrap = envelope => (envelope && typeof envelope === 'object' && 'data' in envelope
    ? envelope.data
    : envelope); // tolerate a bare document written by an older version

  if (config.neon && config.neon.dsn) {
    const run = config.neonQueryImpl || neonQuery;
    const neonOpts = { fetchImpl: config.neonFetchImpl, timeoutMs: config.neonTimeoutMs };
    const select = `SELECT value FROM ${NEON_TABLE} WHERE key = $1`;
    const upsert = `INSERT INTO ${NEON_TABLE} (key, value) VALUES ($1, $2::jsonb) `
      + 'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()';

    const query = async (sql, params) => {
      try {
        return await run(config.neon.dsn, sql, params, neonOpts);
      } catch (error) {
        if (!error || error.code !== '42P01') throw error;
        await run(config.neon.dsn, NEON_CREATE_TABLE, [], neonOpts);
        return run(config.neon.dsn, sql, params, neonOpts);
      }
    };

    return {
      backend: 'neon',
      load: async () => {
        let result;
        try {
          result = await query(select, [key]);
        } catch (error) {
          return { doc: null, source: 'defaults', error: `store unreachable (${(error && error.code) || 'error'}); defaults apply` };
        }
        const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
        if (!row || row.value === null || row.value === undefined || row.value === '') {
          return { doc: null, source: 'defaults', error: null };
        }
        let parsed;
        try {
          parsed = JSON.parse(typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
        } catch {
          return { doc: null, source: 'defaults', error: 'stored value is not valid JSON; defaults apply' };
        }
        const checked = validate(unwrap(parsed));
        if (!checked.ok) return { doc: null, source: 'defaults', error: `stored value rejected: ${checked.error}; defaults apply` };
        return { doc: checked.doc, source: 'stored', error: null };
      },
      save: async doc => {
        const checked = validate(doc);
        if (!checked.ok) return { ok: false, error: checked.error };
        try {
          await query(upsert, [key, JSON.stringify(wrap(checked.doc))]);
        } catch (error) {
          return { ok: false, error: `store unreachable (${(error && error.code) || 'error'}); nothing was saved` };
        }
        return { ok: true, doc: checked.doc };
      },
    };
  }

  if (config.kv && config.kv.url && config.kv.token) {
    const doFetch = config.fetchImpl;
    return {
      backend: 'kv',
      load: async () => {
        let body;
        try {
          body = await kvFetch(config.kv, `get/${key}`, {}, doFetch);
        } catch (error) {
          return { doc: null, source: 'defaults', error: `store unreachable (${error.message}); defaults apply` };
        }
        const raw = body && body.result;
        if (raw === null || raw === undefined || raw === '') return { doc: null, source: 'defaults', error: null };
        let parsed;
        try {
          parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
        } catch {
          return { doc: null, source: 'defaults', error: 'stored value is not valid JSON; defaults apply' };
        }
        const checked = validate(unwrap(parsed));
        if (!checked.ok) return { doc: null, source: 'defaults', error: `stored value rejected: ${checked.error}; defaults apply` };
        return { doc: checked.doc, source: 'stored', error: null };
      },
      save: async doc => {
        const checked = validate(doc);
        if (!checked.ok) return { ok: false, error: checked.error };
        let body;
        try {
          body = await kvFetch(config.kv, `set/${key}`, { method: 'POST', body: JSON.stringify(wrap(checked.doc)) }, doFetch);
        } catch (error) {
          return { ok: false, error: `store unreachable (${error.message}); nothing was saved` };
        }
        if (body && body.result !== 'OK') return { ok: false, error: 'store refused the write' };
        return { ok: true, doc: checked.doc };
      },
    };
  }

  const file = config.file;
  return {
    backend: 'file',
    load: () => Promise.resolve((() => {
      const res = loadFile(file);
      if (res.error) return { doc: null, source: 'defaults', error: res.error };
      if (res.source === 'defaults' || res.raw === null) return { doc: null, source: 'defaults', error: null };
      const checked = validate(unwrap(res.raw));
      if (!checked.ok) return { doc: null, source: 'defaults', error: `stored file rejected: ${checked.error}; defaults apply` };
      return { doc: checked.doc, source: 'stored', error: null };
    })()),
    save: doc => Promise.resolve((() => {
      const checked = validate(doc);
      if (!checked.ok) return { ok: false, error: checked.error };
      const failure = saveFile(file, wrap(checked.doc));
      if (failure) return { ok: false, error: failure };
      return { ok: true, doc: checked.doc };
    })()),
  };
}

module.exports = { createStore, NEON_TABLE, NEON_CREATE_TABLE };
