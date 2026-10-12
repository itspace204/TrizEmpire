'use strict';

/* Zero-dependency authentication primitives.
 *
 * Passwords never live in the repo or in plaintext: the operator stores scrypt
 * hashes in environment variables (see scripts/hash-password.js). Sessions are
 * random bearer tokens held server-side with idle + absolute expiry, delivered
 * in HttpOnly SameSite=Strict cookies. State-changing requests must carry an
 * X-Triz-CSRF header and a same-origin Origin/Referer (defense in depth on top
 * of SameSite=Strict).
 */

const crypto = require('node:crypto');

const SCRYPT_KEYLEN = 64;
const DUMMY_HASH = 'scrypt$16384$8$1$00000000000000000000000000000000$' + '00'.repeat(SCRYPT_KEYLEN);

/* ── password hashing ─────────────────────────────────────────────────── */

function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, saltHex, hashHex] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return null;
  return { params, salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
}

function hashPassword(password, params = { N: 16384, r: 8, p: 1 }) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const candidate = crypto.scryptSync(String(password), parsed.salt, SCRYPT_KEYLEN, parsed.params);
    return candidate.length === parsed.hash.length && crypto.timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

/* Equalize timing for unknown usernames so response time does not reveal
 * whether an account exists. */
function burnVerify(password) {
  verifyPassword(password, DUMMY_HASH);
}

/* ── users from environment configuration ────────────────────────────── */

function usersFromEnv(env = process.env) {
  const users = [];
  if (env.TRIZ_ADMIN_PASSWORD_HASH) {
    users.push({ username: 'admin', role: 'admin', hash: env.TRIZ_ADMIN_PASSWORD_HASH });
  }
  if (env.TRIZ_OPERATOR_PASSWORD_HASH) {
    users.push({ username: 'operator', role: 'operator', hash: env.TRIZ_OPERATOR_PASSWORD_HASH });
  }
  return users;
}

function verifyCredentials(users, username, password) {
  const user = users.find(u => u.username === String(username || ''));
  if (!user) {
    burnVerify(password);
    return null;
  }
  return verifyPassword(password, user.hash) ? { username: user.username, role: user.role } : null;
}

/* ── server-side session store ────────────────────────────────────────── */

class SessionStore {
  constructor({ idleMs = 8 * 60 * 60 * 1000, absoluteMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.now = now;
    this.sessions = new Map();
  }

  create(user, role) {
    const token = crypto.randomBytes(32).toString('hex');
    const t = this.now();
    this.sessions.set(token, { user, role, created: t, lastSeen: t });
    this.sweep();
    return token;
  }

  /* Returns the session (touching idle expiry) or null. */
  get(token) {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const t = this.now();
    if (t - s.lastSeen > this.idleMs || t - s.created > this.absoluteMs) {
      this.sessions.delete(token);
      return null;
    }
    s.lastSeen = t;
    return s;
  }

  destroy(token) {
    this.sessions.delete(token);
  }

  sweep() {
    const t = this.now();
    for (const [token, s] of this.sessions) {
      if (t - s.lastSeen > this.idleMs || t - s.created > this.absoluteMs) this.sessions.delete(token);
    }
  }
}

/* ── stateless (HMAC-signed) sessions for serverless hosts ────────────────
 * On serverless platforms (Vercel and friends) every function instance has
 * its own memory, so a server-side token map can reject a valid login as
 * soon as the next request lands on another instance. This store keeps the
 * SAME interface but carries the session inside the cookie as
 * base64url(JSON).HMAC-SHA256 — verifiable anywhere with the shared secret.
 * Trade-offs (honest, by design):
 *   - idle expiry is NOT tracked (nothing shared to track it on): only the
 *     absolute lifetime is enforced — keep TRIZ_SESSION_ABS_MINUTES short;
 *   - there is NO revocation before expiry: destroy() is a no-op. Rotating
 *     TRIZ_SESSION_SECRET cuts every session off at once.
 * Tampering is caught by a timing-safe HMAC comparison; a forged cookie is
 * rejected exactly like a wrong server-side token. */
class StatelessSessionStore {
  constructor({ secret, absoluteMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new Error('StatelessSessionStore requires a secret of at least 32 characters');
    }
    this.secret = secret;
    this.absoluteMs = absoluteMs;
    this.now = now;
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  create(user, role) {
    const t = this.now();
    const payload = Buffer.from(JSON.stringify({ u: user, r: role, c: t })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /* Returns { user, role, created } for a valid, unexpired cookie, else null. */
  get(token) {
    if (typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sign(payload));
    if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!claims || typeof claims.u !== 'string' || typeof claims.r !== 'string' || !Number.isFinite(claims.c)) {
      return null;
    }
    if (this.now() - claims.c > this.absoluteMs) return null;
    return { user: claims.u, role: claims.r, created: claims.c, lastSeen: claims.c };
  }

  /* Cannot revoke a signed cookie before expiry — see the trade-offs above. */
  destroy() {}
}

/* ── login rate limiter (per client key, e.g. IP) ─────────────────────── */

class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map();
  }

  /* Returns { allowed, retryAfterSeconds }. */
  check(key) {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b) return { allowed: true, retryAfterSeconds: 0 };
    if (t - b.first > this.windowMs) {
      this.buckets.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (b.blockedUntil && t < b.blockedUntil) {
      return { allowed: false, retryAfterSeconds: Math.ceil((b.blockedUntil - t) / 1000) };
    }
    if (b.fails >= this.max) {
      b.blockedUntil = t + this.windowMs;
      return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  fail(key) {
    const t = this.now();
    const b = this.buckets.get(key) || { fails: 0, first: t, blockedUntil: 0 };
    b.fails += 1;
    if (b.fails >= this.max) b.blockedUntil = t + this.windowMs;
    this.buckets.set(key, b);
  }

  clear(key) {
    this.buckets.delete(key);
  }
}

/* ── cookies and CSRF ─────────────────────────────────────────────────── */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function sessionCookie(token, { secure = false, maxAgeSeconds } = {}) {
  return [
    `triz_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    Number.isFinite(maxAgeSeconds) ? `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}` : '',
  ].filter(Boolean).join('; ');
}

function clearedCookie({ secure = false } = {}) {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}

/* Origin/Referer must match the request host for state-changing requests.
 * Browsers always send Origin on POST fetch, so a missing Origin means a
 * non-browser client — rejected when auth is enabled. */
function isSameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function hasCsrfHeader(req) {
  return typeof req.headers['x-triz-csrf'] === 'string' && req.headers['x-triz-csrf'].length > 0;
}

module.exports = {
  hashPassword,
  verifyPassword,
  parseHash,
  usersFromEnv,
  verifyCredentials,
  SessionStore,
  StatelessSessionStore,
  RateLimiter,
  parseCookies,
  sessionCookie,
  clearedCookie,
  isSameOrigin,
  hasCsrfHeader,
};
