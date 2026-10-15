'use strict';

/* Zero-dependency Neon (serverless Postgres) client — parameterized SQL over
 * HTTPS using global fetch only. No driver, no install.
 *
 * The wire contract mirrors @neondatabase/serverless's HTTP driver exactly
 * (source: github.com/neondatabase/serverless, src/http/index.ts):
 *
 *   POST https://<api-host>/sql
 *   headers:
 *     Neon-Connection-String: <the full postgres:// dsn>   ← the credential
 *     Neon-Raw-Text-Output:   true   (values arrive as text)
 *     Neon-Array-Mode:        true   (rows arrive as arrays of values)
 *     content-type:           application/json
 *   body:   { "query": "… $1 …", "params": [<values>] }
 *   200 →   { command, fields: [{ name, dataTypeID }], rows: [[…]], rowCount }
 *   400 →   { message, code, … }  ← a real Postgres error (code = SQLSTATE)
 *   other → text body
 *
 * Endpoint choice: the driver rewrites the first DNS label of the endpoint
 * host to `api.` (ep-foo.us-east-2.aws.neon.tech → api.us-east-2.aws.neon.tech
 * — both resolve to the same Neon proxy, verified), while older docs describe
 * https://<endpoint-host>/sql. We try the driver's current form first and the
 * plain host second, so either generation of routing works; a 400 is a real
 * database answer and is never retried.
 *
 * Rules honored here (same as the rest of the codebase):
 *   - the DSN is a secret: it travels only in a header and never appears in
 *     an error message, a log line or a response body;
 *   - queries are parameterized ($1, $2, …) — never string-interpolated;
 *   - every request is bounded by a timeout;
 *   - the fetch implementation is injectable so tests never hit the network.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const FIRST_LABEL = /^[^.]+\./;

/* Codes produced by this module:
 *   neon_unreachable     network failure / timeout on every candidate endpoint
 *   neon_http_<status>   non-400 HTTP answer from the endpoint
 *   neon_bad_response     200 whose body was not the expected JSON
 *   unsupported_param     a parameter type we refuse to send
 *   <SQLSTATE>           e.g. 42P01 — passed through from Postgres itself
 */
class NeonError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'NeonError';
    this.code = code;
  }
}

function endpointCandidates(dsn) {
  const url = new URL(dsn);
  const port = url.port ? `:${url.port}` : '';
  const host = url.hostname;
  const driver = `https://${host.replace(FIRST_LABEL, 'api.')}${port}/sql`;
  const plain = `https://${host}${port}/sql`;
  return driver === plain ? [driver] : [driver, plain];
}

/* Postgres accepts strings, numbers, booleans and null as parameters; JSON
 * documents are sent as text and cast in the SQL (value $1::jsonb). */
function prepareParam(value) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  throw new NeonError('unsupported_param', 'SQL parameters must be strings, numbers, booleans or null');
}

/* The HTTP driver returns rows as arrays (Neon-Array-Mode) keyed by `fields`
 * order, with raw text values. Accept object rows too, so a contract change
 * on Neon's side degrades to the same shape instead of an exception. */
function normalize(payload) {
  const fields = Array.isArray(payload && payload.fields) ? payload.fields : [];
  const names = fields.map((field, i) => (field && field.name) || `col${i}`);
  const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
  return {
    rowCount: Number.isFinite(payload && payload.rowCount) ? payload.rowCount : rows.length,
    command: payload && typeof payload.command === 'string' ? payload.command : null,
    rows: rows.map(row => (Array.isArray(row)
      ? Object.fromEntries(row.map((value, i) => [names[i], value]))
      : row)),
  };
}

/* Run one parameterized query. Returns { rows, rowCount, command } with rows
 * as objects keyed by column name. Throws NeonError — never the DSN. */
async function neonQuery(dsn, query, params = [], options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new NeonError('neon_unreachable', 'fetch is not available');
  }
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({ query: String(query), params: params.map(prepareParam) });
  const headers = {
    'Neon-Connection-String': dsn,
    'Neon-Raw-Text-Output': 'true',
    'Neon-Array-Mode': 'true',
    'content-type': 'application/json',
    accept: 'application/json',
  };

  let lastError = null;
  for (const url of endpointCandidates(dsn)) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      lastError = new NeonError('neon_unreachable', 'Neon is unreachable');
      continue; // try the alternate endpoint before giving up
    }

    if (response.ok) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new NeonError('neon_bad_response', 'Neon returned an unreadable response');
      }
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) {
        throw new NeonError('neon_bad_response', 'Neon returned an unexpected response');
      }
      return normalize(payload);
    }

    if (response.status === 400) {
      // A Postgres error: the endpoint answered, so this is final — do not
      // retry elsewhere and do not retry the query.
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      // `code` is a SQLSTATE when Postgres raises one; auth/gateway failures
      // arrive with an empty string, which must not become a falsy code.
      const code = payload && typeof payload.code === 'string' && payload.code !== ''
        ? payload.code
        : 'sql_error';
      const message = payload && typeof payload.message === 'string' ? payload.message : 'SQL error';
      throw new NeonError(code, message);
    }

    lastError = new NeonError(`neon_http_${response.status}`, `Neon answered HTTP ${response.status}`);
  }

  throw lastError || new NeonError('neon_unreachable', 'Neon is unreachable');
}

module.exports = { neonQuery, endpointCandidates, prepareParam, NeonError, DEFAULT_TIMEOUT_MS };
