'use strict';

/* Zero-dependency Supabase Auth client (GoTrue password grant).
 *
 * The exchange happens entirely on the server: the browser posts its email
 * and password to OUR /api/auth/login, we trade them at
 *   POST {SUPABASE_URL}/auth/v1/token?grant_type=password
 * with the project's publishable/anon key in the `apikey` header, and then
 * mint the app's own session cookie. The Supabase access token never reaches
 * the browser, so it cannot be replayed, stored or stolen from client code.
 *
 * Rules honored here (same as the rest of the codebase):
 *   - errors carry a short machine `code`, never the upstream body, the
 *     password or the API key;
 *   - the upstream call is bounded by a timeout;
 *   - the fetch implementation is injectable so tests never hit the network.
 *
 * Contract reference: https://supabase.com/docs/reference/self-hosting-auth
 */

const TOKEN_PATH = '/auth/v1/token?grant_type=password';
const DEFAULT_TIMEOUT_MS = 8000;

/* Codes produced by this module:
 *   invalid_credentials   400 from GoTrue — wrong password or unknown user
 *   email_not_confirmed   400 from GoTrue — password OK, email unverified
 *   upstream_auth         401/403 — the project API key was rejected (config)
 *   upstream_unavailable  network error, timeout, 5xx, or an unparseable body
 */
class SupabaseAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SupabaseAuthError';
    this.code = code;
  }
}

function isEmailLike(value) {
  return typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

/* config: { url, key } — both already validated by lib/config.js.
 * Returns { user: { id, email }, expiresInSeconds } on success. */
async function supabaseSignIn(config, email, password, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  if (typeof fetchImpl !== 'function') {
    throw new SupabaseAuthError('upstream_unavailable', 'fetch is not available');
  }

  let response;
  try {
    response = await fetchImpl(`${config.url}${TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ email: String(email), password: String(password) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network failure or timeout: the message would describe infrastructure,
    // not the caller's input, and must not leak the URL or key.
    throw new SupabaseAuthError('upstream_unavailable', 'Supabase Auth is unreachable');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errCode = payload && typeof payload.error_code === 'string' ? payload.error_code
      : (payload && typeof payload.code === 'string' ? payload.code : '');
    if (errCode === 'email_not_confirmed') {
      throw new SupabaseAuthError('email_not_confirmed', 'Email address is not confirmed');
    }
    if (response.status === 400) {
      throw new SupabaseAuthError('invalid_credentials', 'Invalid login credentials');
    }
    if (response.status === 401 || response.status === 403) {
      throw new SupabaseAuthError('upstream_auth', 'Supabase Auth rejected the project API key');
    }
    throw new SupabaseAuthError('upstream_unavailable', 'Supabase Auth returned an error');
  }

  const accessToken = payload && payload.access_token;
  const user = payload && payload.user;
  if (typeof accessToken !== 'string' || accessToken.length === 0
      || !user || typeof user.email !== 'string' || user.email.length === 0) {
    throw new SupabaseAuthError('upstream_unavailable', 'Unexpected Supabase Auth response');
  }

  return {
    user: { id: typeof user.id === 'string' ? user.id : null, email: user.email },
    expiresInSeconds: Number.isFinite(payload.expires_in) ? payload.expires_in : null,
  };
}

module.exports = { supabaseSignIn, isEmailLike, SupabaseAuthError, TOKEN_PATH };
