'use strict';

/* Centralized environment configuration.
 *
 * One place reads, validates and documents every environment variable the
 * server uses. Two rules run through the whole module:
 *
 *   1. Validation errors name the VARIABLE but never echo its value —
 *      password hashes and URLs may carry secrets and must not leak into
 *      logs, crash output or test snapshots.
 *   2. Fail fast at startup with an actionable message rather than at the
 *      first request (or worse, silently): a typo like NODE_ENV=prodcution
 *      or PORT=0 in production must not produce an insecure or unreachable
 *      deployment.
 *
 * .env loading is a minimal, dependency-free parser (the project is
 * deliberately zero-dependency). It runs only in the CLI entry of server.js,
 * never when the server is required as a module (tests stay hermetic), and it
 * NEVER overrides variables already present in the real environment — OS env
 * and process-manager configuration always win over a local .env file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseHash } = require('./auth');

/* ── minimal .env parser ─────────────────────────────────────────────── */

/* Parses KEY=VALUE lines (comments, `export ` prefix and single/double
 * quoted values supported). Returns the names of the variables set —
 * never the values. Existing env entries are left untouched. */
function loadEnvFile(filePath, env = process.env) {
  const set = [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return set; // absent file is fine: local mode needs no .env
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue; // malformed line: skip, never crash on it
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (env[key] !== undefined) continue; // real environment wins
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    }
    env[key] = value;
    set.push(key);
  }
  return set;
}

/* ── validation helpers (messages name variables, never values) ─────── */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const NODE_ENVS = new Set(['development', 'test', 'production']);

function readIntVar(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer number of units (received a non-integer value).`);
  }
  return n;
}

/* http(s) URL, no embedded credentials: these values travel to upstream
 * requests or to the browser (/api/config) and must never carry secrets. */
function readHttpUrlVar(env, name, { allowEmpty = false } = {}) {
  const raw = env[name];
  if (raw === undefined) return null;
  if (raw === '') {
    if (allowEmpty) return '';
    throw new Error(`${name} is set but empty; unset it or provide an http(s) URL.`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid http(s) URL (scheme http:// or https://).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http:// or https:// (other schemes are not allowed).`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain embedded credentials; this server has no upstream-auth support.`);
  }
  return raw;
}

function readHashVar(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  if (!parseHash(raw)) {
    // Deliberately not echoing `raw`: it may be a mistyped real secret.
    throw new Error(`${name} is not a valid scrypt hash. Generate one with: node scripts/hash-password.js`);
  }
  return raw;
}

/* ── the resolved configuration ──────────────────────────────────────── */

function resolveConfig(options = {}, env = process.env) {
  const port = options.port !== undefined ? Number(options.port) : (readIntVar(env, 'PORT') ?? 57004);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535 (0 = ephemeral, rejected in production).');
  }
  const nodeEnv = env.NODE_ENV === undefined || env.NODE_ENV === '' ? '' : String(env.NODE_ENV);
  if (nodeEnv && !NODE_ENVS.has(nodeEnv)) {
    throw new Error('NODE_ENV must be one of: development, test, production (unset for local mode).');
  }
  const isProduction = nodeEnv === 'production';
  if (port === 0 && isProduction) {
    throw new Error('PORT=0 (ephemeral) is not allowed with NODE_ENV=production; set a fixed port.');
  }

  const host = options.host || env.HOST || '127.0.0.1';
  const users = options.users !== undefined ? options.users : usersFromEnvValidated(env);
  const authRequired = users.length > 0;
  const remoteAllowed = env.ALLOW_REMOTE_HOST === 'true' || options.allowRemoteHost === true;
  if (!LOOPBACK_HOSTS.has(host)) {
    if (!remoteAllowed) {
      throw new Error('Refusing non-loopback HOST. Set ALLOW_REMOTE_HOST=true only if you understand this server has no authentication.');
    }
    if (!authRequired) {
      throw new Error('Refusing non-loopback bind without authentication. Configure TRIZ_ADMIN_PASSWORD_HASH (see scripts/hash-password.js) first.');
    }
  }
  /* Production may never run without authentication: there is no default
   * password, and a silent no-auth production mode is exactly the failure
   * this check exists to prevent. */
  if (isProduction && !authRequired) {
    throw new Error('NODE_ENV=production requires authentication: configure TRIZ_ADMIN_PASSWORD_HASH (see scripts/hash-password.js). There is no default password.');
  }

  const ttlMinutes = readIntVar(env, 'TRIZ_SESSION_TTL_MINUTES') ?? 480;
  const absMinutes = readIntVar(env, 'TRIZ_SESSION_ABS_MINUTES') ?? 1440;
  if (ttlMinutes <= 0 || absMinutes <= 0) {
    throw new Error('TRIZ_SESSION_TTL_MINUTES and TRIZ_SESSION_ABS_MINUTES must be positive integers.');
  }

  const hermesBaseUrl = options.hermesBaseUrl || env.HERMES_BASE_URL || 'http://127.0.0.1:9119';
  if (!options.hermesBaseUrl) readHttpUrlVar(env, 'HERMES_BASE_URL');
  const hermesPublicUrl = options.hermesPublicUrl !== undefined ? options.hermesPublicUrl
    : (env.HERMES_PUBLIC_URL !== undefined ? env.HERMES_PUBLIC_URL : 'http://127.0.0.1:9119');
  if (options.hermesPublicUrl === undefined) readHttpUrlVar(env, 'HERMES_PUBLIC_URL', { allowEmpty: true });

  const hermesTimeoutMs = options.hermesTimeoutMs !== undefined ? Number(options.hermesTimeoutMs)
    : (readIntVar(env, 'HERMES_TIMEOUT_MS') ?? 3000);
  if (!Number.isInteger(hermesTimeoutMs) || hermesTimeoutMs <= 0) {
    throw new Error('HERMES_TIMEOUT_MS must be a positive integer (milliseconds).');
  }

  return {
    root: options.root || path.resolve(__dirname, '..'),
    host,
    port,
    users,
    authRequired,
    secureCookies: options.secureCookies !== undefined ? options.secureCookies
      : (isProduction || env.TRIZ_SECURE_COOKIE === 'true'),
    sessions: options.sessions || undefined, // built by the server (SessionStore)
    sessionIdleMs: ttlMinutes * 60 * 1000,
    sessionAbsoluteMs: absMinutes * 60 * 1000,
    loginLimiter: options.loginLimiter || undefined,
    statusLimiter: options.statusLimiter || undefined,
    hermesBaseUrl,
    hermesPublicUrl,
    hermesTimeoutMs,
  };
}

/* Users from env with hash-format validation up front (auth.js consumes
 * the same env vars; validation here fails fast at startup). */
function usersFromEnvValidated(env) {
  const users = [];
  const adminHash = readHashVar(env, 'TRIZ_ADMIN_PASSWORD_HASH');
  if (adminHash) users.push({ username: 'admin', role: 'admin', hash: adminHash });
  const operatorHash = readHashVar(env, 'TRIZ_OPERATOR_PASSWORD_HASH');
  if (operatorHash) users.push({ username: 'operator', role: 'operator', hash: operatorHash });
  return users;
}

module.exports = { loadEnvFile, resolveConfig };
