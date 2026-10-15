'use strict';

/* Workspace assignment persistence — the operator's mapping of agents to
 * isolated workspaces (the cockpit cards), stored as a small JSON file on
 * the server instead of being hardcoded in the shared crew model.
 *
 * Division of labour:
 *   - crew/crew-model.js owns the DEFAULT table (Client ships empty) and the
 *     pure withAssignments() merge the UI applies on top of it.
 *   - this module owns STORAGE and VALIDATION: what may be persisted must be
 *     a map of known workspace ids to profile ids, with the same invariant
 *     the model promises — one home per profile.
 *
 * Rules enforced here (nothing is persisted that the model would reject):
 *   - workspace ids must exist in the shared model's WORKSPACES table, so a
 *     stale or hostile payload can never invent a card;
 *   - profile ids match a conservative pattern (they ride in URLs, file
 *     paths and DOM attributes on the Hermes side) and are bounded in count;
 *   - a profile may appear under exactly one workspace — the "one home per
 *     profile" invariant that keeps cards from duplicating an agent.
 *
 * Writes are atomic (temp file + rename) so a crash mid-save can never leave
 * a truncated mapping behind. A missing file is not an error: it means "the
 * shipped defaults apply". A corrupt file is reported honestly and the
 * defaults still apply, so a bad save can never take the dashboard down.
 */

const fs = require('node:fs');
const path = require('node:path');
const MODEL = require('../crew/crew-model');
const { neonQuery } = require('./neon');

/* Generous bounds: the real crew is five profiles across four workspaces.
 * The limits exist to bound a bad payload, not to describe reality. */
const MAX_WORKSPACES = 16;
const MAX_PROFILES_PER_WORKSPACE = 32;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/* ── Upstash-compatible Redis REST store (serverless hosts) ──────────────
 * On serverless platforms (Vercel) the function filesystem is read-only
 * outside /tmp, so the mapping lives in an Upstash-compatible REST store
 * instead (Vercel Marketplace "Upstash Redis" or Upstash direct — both
 * inject a REST URL + token; see lib/config.js for the variable pairs).
 * The wire format is the same JSON document the file store writes, so the
 * two backends are interchangeable and the UI cannot tell them apart.
 * Uses global fetch (Node 18+); no SDK, no dependency. */
const KV_KEY = 'trizempire:workspaces';
const KV_TIMEOUT_MS = 8000;

async function kvFetch(kv, pathname, init = {}) {
  const url = `${kv.url.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`;
  const res = await fetch(url, {
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

/* Read the mapping from KV. Same honest contract as loadAssignments:
 * absent key → defaults; corrupt/invalid value → defaults + error. */
async function loadAssignmentsKv(kv, { fetchImpl } = {}) {
  const doFetch = fetchImpl || kvFetch;
  let body;
  try {
    body = await doFetch(kv, `get/${KV_KEY}`);
  } catch (e) {
    return {
      assignments: null,
      source: 'defaults',
      error: `workspace store unreachable (${e.message}); defaults apply`,
    };
  }
  const raw = body && body.result;
  if (raw === null || raw === undefined || raw === '') {
    return { assignments: null, source: 'defaults', error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  } catch {
    return { assignments: null, source: 'defaults', error: 'stored workspace value is not valid JSON; defaults apply' };
  }
  const result = validateAssignments(parsed && parsed.assignments);
  if (!result.ok) {
    return { assignments: null, source: 'defaults', error: `stored workspace value rejected: ${result.error}; defaults apply` };
  }
  return { assignments: result.assignments, source: 'stored', error: null };
}

/* Validate and persist to KV (same atomicity contract as the file store:
 * validation happens before anything is written). */
async function saveAssignmentsKv(kv, assignments, { fetchImpl } = {}) {
  const result = validateAssignments(assignments);
  if (!result.ok) return result;
  const doFetch = fetchImpl || kvFetch;
  const document = JSON.stringify({ version: 1, assignments: result.assignments });
  try {
    const body = await doFetch(kv, `set/${KV_KEY}`, { method: 'POST', body: document });
    if (body && body.result !== 'OK') {
      return { ok: false, error: `workspace store refused the write (${String(body.result || 'unknown')})` };
    }
  } catch (e) {
    return { ok: false, error: `workspace store unreachable (${e.message}); nothing was saved` };
  }
  return { ok: true, assignments: result.assignments };
}

/* ── Neon (serverless Postgres) store ─────────────────────────────────────
 * The same JSON document the other backends write, kept in one settings row
 * (key/value) so the table stays useful for future settings instead of being
 * a single-purpose blob. The table is created on first use — controlled,
 * server-side, with a fixed statement; no migration tool and no DDL built
 * from request data. Reads never throw: unreachable/error states come back
 * as an honest error with the shipped defaults applying, exactly like the
 * file and KV backends. Uses lib/neon.js (global fetch, no SDK, no dep). */
const NEON_KEY = 'trizempire:workspaces';
const NEON_TABLE = 'trizempire_settings';
const NEON_CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${NEON_TABLE} (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

function neonRunOptions(options) {
  return { fetchImpl: options.neonFetchImpl, timeoutMs: options.neonTimeoutMs };
}

async function loadAssignmentsNeon(neon, options = {}) {
  const run = options.neonQueryImpl || neonQuery;
  const select = `SELECT value FROM ${NEON_TABLE} WHERE key = $1`;
  const opts = neonRunOptions(options);
  let result;
  try {
    result = await run(neon.dsn, select, [NEON_KEY], opts);
  } catch (error) {
    if (!error || error.code !== '42P01') {
      return {
        assignments: null,
        source: 'defaults',
        error: `workspace database unreachable (${(error && error.code) || 'error'}); defaults apply`,
      };
    }
    // Table absent (fresh database): create it server-side, then retry once.
    try {
      await run(neon.dsn, NEON_CREATE_TABLE, [], opts);
      result = await run(neon.dsn, select, [NEON_KEY], opts);
    } catch (retryError) {
      return {
        assignments: null,
        source: 'defaults',
        error: `workspace database unreachable (${(retryError && retryError.code) || 'error'}); defaults apply`,
      };
    }
  }
  const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
  if (!row || row.value === null || row.value === undefined || row.value === '') {
    return { assignments: null, source: 'defaults', error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
  } catch {
    return { assignments: null, source: 'defaults', error: 'stored workspace value is not valid JSON; defaults apply' };
  }
  const validated = validateAssignments(parsed && parsed.assignments);
  if (!validated.ok) {
    return { assignments: null, source: 'defaults', error: `stored workspace value rejected: ${validated.error}; defaults apply` };
  }
  return { assignments: validated.assignments, source: 'stored', error: null };
}

async function saveAssignmentsNeon(neon, assignments, options = {}) {
  // Validation first: a rejected mapping must never reach the database.
  const result = validateAssignments(assignments);
  if (!result.ok) return result;
  const run = options.neonQueryImpl || neonQuery;
  const opts = neonRunOptions(options);
  const document = JSON.stringify({ version: 1, assignments: result.assignments });
  const upsert = `INSERT INTO ${NEON_TABLE} (key, value) VALUES ($1, $2::jsonb) `
    + 'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()';
  try {
    await run(neon.dsn, upsert, [NEON_KEY, document], opts);
  } catch (error) {
    if (!error || error.code !== '42P01') {
      return { ok: false, error: `workspace database unreachable (${(error && error.code) || 'error'}); nothing was saved` };
    }
    try {
      await run(neon.dsn, NEON_CREATE_TABLE, [], opts);
      await run(neon.dsn, upsert, [NEON_KEY, document], opts);
    } catch (retryError) {
      return { ok: false, error: `workspace database unreachable (${(retryError && retryError.code) || 'error'}); nothing was saved` };
    }
  }
  return { ok: true, assignments: result.assignments };
}

/* Backend-neutral store: picks Neon when configured, else KV, else the local
 * file. load()/save() share one shape so server.js does not care which it got. */
function createStore(config) {
  if (config && config.neon && config.neon.dsn) {
    return {
      backend: 'neon',
      load: () => loadAssignmentsNeon(config.neon, config),
      save: assignments => saveAssignmentsNeon(config.neon, assignments, config),
    };
  }
  if (config && config.kv && config.kv.url && config.kv.token) {
    return {
      backend: 'kv',
      load: () => loadAssignmentsKv(config.kv, config),
      save: assignments => saveAssignmentsKv(config.kv, assignments, config),
    };
  }
  const file = config && config.file;
  return {    backend: 'file',
    load: () => Promise.resolve(loadAssignments(file)),
    save: assignments => Promise.resolve(saveAssignments(file, assignments)),
  };
}

/* Validate an assignment map against the shared model. Returns
 * { ok: true, assignments } with a cleaned, order-preserving copy, or
 * { ok: false, error } where error names the problem (identifiers are not
 * secrets — they are shown in this very UI — so naming them helps). */
function validateAssignments(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'assignments must be an object mapping workspace id to a list of profile ids' };
  }
  const ids = Object.keys(input);
  if (ids.length > MAX_WORKSPACES) {
    return { ok: false, error: `too many workspaces (max ${MAX_WORKSPACES})` };
  }
  const known = new Set(MODEL.WORKSPACES.map(ws => ws.id));
  const seen = new Set();
  const out = {};
  for (const id of ids) {
    if (!known.has(id)) {
      return { ok: false, error: `unknown workspace id: ${id}` };
    }
    const list = input[id];
    if (!Array.isArray(list)) {
      return { ok: false, error: `workspace ${id} must map to a list of profile ids` };
    }
    if (list.length > MAX_PROFILES_PER_WORKSPACE) {
      return { ok: false, error: `workspace ${id} has too many profiles (max ${MAX_PROFILES_PER_WORKSPACE})` };
    }
    const clean = [];
    for (const profile of list) {
      if (typeof profile !== 'string' || !PROFILE_ID.test(profile)) {
        return { ok: false, error: `invalid profile id in workspace ${id}` };
      }
      if (seen.has(profile)) {
        return { ok: false, error: `profile assigned to two workspaces: ${profile}` };
      }
      seen.add(profile);
      clean.push(profile);
    }
    out[id] = clean;
  }
  return { ok: true, assignments: out };
}

/* Read the persisted mapping. Never throws:
 *   absent file      → { assignments: null, source: 'defaults', error: null }
 *   valid file       → { assignments,     source: 'stored',    error: null }
 *   corrupt/invalid  → { assignments: null, source: 'defaults', error } */
function loadAssignments(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { assignments: null, source: 'defaults', error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { assignments: null, source: 'defaults', error: 'stored workspace file is not valid JSON; defaults apply' };
  }
  const result = validateAssignments(parsed && parsed.assignments);
  if (!result.ok) {
    return { assignments: null, source: 'defaults', error: `stored workspace file rejected: ${result.error}; defaults apply` };
  }
  return { assignments: result.assignments, source: 'stored', error: null };
}

/* Validate and atomically persist the mapping. Returns the same shape as
 * validateAssignments plus the file path that was written. Filesystem
 * failures (read-only filesystems, missing permissions) are reported as a
 * clean error — never as a crash, and never leaking absolute paths. */
function saveAssignments(file, assignments) {
  const result = validateAssignments(assignments);
  if (!result.ok) return result;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, assignments: result.assignments }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, error: `cannot write the workspace file (${e.code || 'error'}); configure KV storage or a writable TRIZ_WORKSPACES_FILE` };
  }
  return { ok: true, assignments: result.assignments, file };
}

module.exports = {
  loadAssignments,
  saveAssignments,
  validateAssignments,
  loadAssignmentsKv,
  saveAssignmentsKv,
  loadAssignmentsNeon,
  saveAssignmentsNeon,
  createStore,
  KV_KEY,
  NEON_KEY,
  NEON_TABLE,
};
