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
const os = require('node:os');
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

/* A non-empty single-line secret (API keys). Validation names the variable
 * and never echoes the value — it may be a real credential. */
function readSecretVar(env, name, { maxLength = 2048 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  if (/[\r\n\0]/.test(raw)) {
    throw new Error(`${name} must be a single line without control characters.`);
  }
  if (raw.length > maxLength) {
    throw new Error(`${name} is too long (maximum ${maxLength} characters).`);
  }
  return raw;
}

/* Supabase Auth — an OPTIONAL second identity provider, used alongside the
 * local scrypt users (never instead of them). SUPABASE_URL and
 * SUPABASE_ANON_KEY (the publishable/anon key, NOT the secret key) must be
 * set together; TRIZ_SUPABASE_ROLE picks the role a Supabase user receives.
 * Returns null when unconfigured, which keeps local-only deployments and
 * every existing test untouched. */
function readSupabaseConfig(env) {
  const url = readHttpUrlVar(env, 'SUPABASE_URL');
  const key = readSecretVar(env, 'SUPABASE_ANON_KEY');
  if (url && !key) {
    throw new Error('SUPABASE_URL is set but SUPABASE_ANON_KEY is empty — configure both (Supabase project → Settings → API).');
  }
  if (key && !url) {
    throw new Error('SUPABASE_ANON_KEY is set but SUPABASE_URL is empty — configure both (Supabase project → Settings → API).');
  }
  if (!url) return null;
  const role = env.TRIZ_SUPABASE_ROLE || 'admin';
  if (role !== 'admin' && role !== 'operator') {
    throw new Error('TRIZ_SUPABASE_ROLE must be one of: admin, operator.');
  }
  // Trailing slashes would double up against the fixed /auth/v1 path.
  return { url: url.replace(/\/+$/, ''), key, role };
}

/* Neon (serverless Postgres) — OPTIONAL durable storage for the workspace
 * mapping. NEON_DATABASE_URL is preferred; DATABASE_URL (the name the Vercel
 * Marketplace integration injects) works too. The value is a full connection
 * string containing a password: validation names the variable and never
 * echoes the value. Returns null when unconfigured (file/KV stores apply). */
function readNeonConfig(env) {
  const name = (env.NEON_DATABASE_URL !== undefined && env.NEON_DATABASE_URL !== '')
    ? 'NEON_DATABASE_URL'
    : ((env.DATABASE_URL !== undefined && env.DATABASE_URL !== '') ? 'DATABASE_URL' : null);
  if (!name) return null;
  const dsn = readSecretVar(env, name, { maxLength: 4096 });
  let url;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`${name} must be a postgres:// connection string (Neon console → Connection string).`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must use the postgres:// or postgresql:// scheme.`);
  }
  if (!url.username || !url.password) {
    throw new Error(`${name} must include a user and a password (Neon console → Connection string).`);
  }
  if (!url.hostname) {
    throw new Error(`${name} must include a database host (Neon console → Connection string).`);
  }
  if (!url.pathname || url.pathname.length < 2) {
    throw new Error(`${name} must include a database name after the host.`);
  }
  return { dsn };
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
  /* Auth is required when EITHER a local scrypt user OR Supabase Auth is
   * configured: production must never boot unauthenticated, and Supabase
   * counts as authentication. */
  const supabase = options.supabase !== undefined ? options.supabase : readSupabaseConfig(env);
  const neon = options.neon !== undefined ? options.neon : readNeonConfig(env);
  const authRequired = users.length > 0 || !!supabase;
  const remoteAllowed = env.ALLOW_REMOTE_HOST === 'true' || options.allowRemoteHost === true;
  if (!LOOPBACK_HOSTS.has(host)) {
    if (!remoteAllowed) {
      throw new Error('Refusing non-loopback HOST. Set ALLOW_REMOTE_HOST=true only if you understand this server has no authentication.');
    }
    if (!authRequired) {
      throw new Error('Refusing non-loopback bind without authentication. Configure TRIZ_ADMIN_PASSWORD_HASH (see scripts/hash-password.js) or Supabase Auth (SUPABASE_URL + SUPABASE_ANON_KEY) first.');
    }
  }
  /* Production may never run without authentication: there is no default
   * password, and a silent no-auth production mode is exactly the failure
   * this check exists to prevent. */
  if (isProduction && !authRequired) {
    throw new Error('NODE_ENV=production requires authentication: configure TRIZ_ADMIN_PASSWORD_HASH (see scripts/hash-password.js) or Supabase Auth (SUPABASE_URL + SUPABASE_ANON_KEY). There is no default password.');
  }

  const ttlMinutes = readIntVar(env, 'TRIZ_SESSION_TTL_MINUTES') ?? 480;
  const absMinutes = readIntVar(env, 'TRIZ_SESSION_ABS_MINUTES') ?? 1440;
  if (ttlMinutes <= 0 || absMinutes <= 0) {
    throw new Error('TRIZ_SESSION_TTL_MINUTES and TRIZ_SESSION_ABS_MINUTES must be positive integers.');
  }

  /* Stateless (HMAC-signed) session mode for SERVERLESS hosts (Vercel):
   * function instances do not share memory, so server-side session tokens
   * would reject logins that land on another instance. When
   * TRIZ_SESSION_SECRET is set, the session lives inside the cookie as an
   * HMAC-signed payload instead. It is a secret — validation names the
   * variable and never echoes the value. */
  const sessionSecret = options.sessionSecret !== undefined ? String(options.sessionSecret)
    : String(env.TRIZ_SESSION_SECRET || '');
  if (sessionSecret && /[\r\n]/.test(sessionSecret)) {
    throw new Error('TRIZ_SESSION_SECRET must not contain line breaks (it is used as an HMAC key).');
  }
  if (sessionSecret && sessionSecret.length < 32) {
    throw new Error('TRIZ_SESSION_SECRET must be at least 32 characters (generate: openssl rand -hex 32).');
  }

  const hermesBaseUrl = options.hermesBaseUrl || env.HERMES_BASE_URL || 'http://127.0.0.1:9119';
  if (!options.hermesBaseUrl) readHttpUrlVar(env, 'HERMES_BASE_URL');
  const hermesPublicUrl = options.hermesPublicUrl !== undefined ? options.hermesPublicUrl
    : (env.HERMES_PUBLIC_URL !== undefined ? env.HERMES_PUBLIC_URL : 'http://127.0.0.1:9119');
  if (options.hermesPublicUrl === undefined) readHttpUrlVar(env, 'HERMES_PUBLIC_URL', { allowEmpty: true });

  const hermesTimeoutMs = options.hermesTimeoutMs !== undefined ? Number(options.hermesTimeoutMs)
    : (readIntVar(env, 'HERMES_TIMEOUT_MS') ?? 8000);
  if (!Number.isInteger(hermesTimeoutMs) || hermesTimeoutMs <= 0) {
    throw new Error('HERMES_TIMEOUT_MS must be a positive integer (milliseconds).');
  }

  /* Upstream session token for the authenticated per-agent endpoints
   * (Hermes' X-Hermes-Session-Token, minted as HERMES_DASHBOARD_SESSION_TOKEN
   * on the Hermes side). Optional: without it per-agent facts are reported
   * as unconfigured and the UI keeps the global derivation. It is a secret —
   * validation errors name the variable and never echo the value, and it is
   * only ever sent to the fixed allowlisted upstream paths. */
  const hermesSessionToken = options.hermesSessionToken !== undefined ? String(options.hermesSessionToken)
    : String(env.HERMES_SESSION_TOKEN || '');
  if (hermesSessionToken && /[\r\n]/.test(hermesSessionToken)) {
    throw new Error('HERMES_SESSION_TOKEN must not contain line breaks (it is sent as an HTTP header).');
  }
  if (hermesSessionToken.length > 512) {
    throw new Error('HERMES_SESSION_TOKEN is too long (maximum 512 characters).');
  }

  const root = options.root || path.resolve(__dirname, '..');

  /* Where the operator's workspace→agent mapping is persisted. Default is
   * inside the app root (data/workspaces.json); deployments may point it
   * outside the (read-only) app tree. On Vercel the app tree is read-only
   * and only /tmp is writable, so the default lands there (ephemeral —
   * configure KV storage for durable mapping). Validation names the
   * variable only. */
  const workspacesFile = options.workspacesFile || env.TRIZ_WORKSPACES_FILE
    || (env.VERCEL ? path.join(os.tmpdir(), 'trizempire-workspaces.json')
      : path.join(root, 'data', 'workspaces.json'));
  if (typeof workspacesFile !== 'string' || workspacesFile.trim() === '' || /[\0\r\n]/.test(workspacesFile)) {
    throw new Error('TRIZ_WORKSPACES_FILE must be a non-empty file path without control characters.');
  }

  /* Optional Upstash-compatible Redis REST store for the workspace mapping
   * (serverless hosts have a read-only filesystem). Both variable pairs
   * seen in the wild are accepted: Vercel Marketplace injects
   * KV_REST_API_URL / KV_REST_API_TOKEN; Upstash's own docs use
   * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. When configured it
   * takes precedence over the file store. Secrets are never echoed. */
  const workspacesKvUrl = options.workspacesKvUrl !== undefined ? String(options.workspacesKvUrl)
    : String(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '');
  const workspacesKvToken = options.workspacesKvToken !== undefined ? String(options.workspacesKvToken)
    : String(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '');
  if (workspacesKvUrl) {
    let parsedKvUrl;
    try {
      parsedKvUrl = new URL(workspacesKvUrl);
    } catch {
      parsedKvUrl = null;
    }
    if (!parsedKvUrl || (parsedKvUrl.protocol !== 'http:' && parsedKvUrl.protocol !== 'https:')) {
      throw new Error('KV_REST_API_URL must be a valid http(s) URL (UPSTASH_REDIS_REST_URL is also accepted).');
    }
    if (parsedKvUrl.username || parsedKvUrl.password) {
      throw new Error('KV_REST_API_URL must not contain embedded credentials.');
    }
  }
  if (workspacesKvUrl && !workspacesKvToken) {
    throw new Error('KV_REST_API_URL is set but KV_REST_API_TOKEN is empty — configure both (or the UPSTASH_REDIS_REST_* pair).');
  }
  if (workspacesKvToken && !workspacesKvUrl) {
    throw new Error('KV_REST_API_TOKEN is set but KV_REST_API_URL is empty — configure both (or the UPSTASH_REDIS_REST_* pair).');
  }
  if (workspacesKvToken.length > 512 || /[\r\n]/.test(workspacesKvToken)) {
    throw new Error('KV_REST_API_TOKEN must be a single line of at most 512 characters.');
  }

  /* Trust the platform's forwarded client IP for rate limiting. On Vercel
   * (or behind any reverse proxy you control) every request arrives from an
   * internal address, so without this the login limiter would bucket all
   * visitors together. Off by default: a directly-exposed server must not
   * trust client-supplied X-Forwarded-For. */
  const trustProxy = options.trustProxy !== undefined ? options.trustProxy === true
    : (env.TRIZ_TRUST_PROXY === 'true' || env.VERCEL === '1');

  return {
    root,
    trustProxy,
    host,
    port,
    users,
    supabase: supabase || null,
    neon: neon || null,
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
    hermesSessionToken,
    workspacesFile: path.isAbsolute(workspacesFile) ? workspacesFile : path.resolve(root, workspacesFile),
    workspacesKvUrl: workspacesKvUrl || null,
    workspacesKvToken: workspacesKvToken || null,
    sessionSecret: sessionSecret || null,
    statelessSessions: sessionSecret !== '',
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

module.exports = { loadEnvFile, resolveConfig, readSupabaseConfig, readNeonConfig };
