'use strict';

/* Server-side Hermes proxy.
 *
 * The browser never talks to 127.0.0.1:9119 directly (that address means the
 * *visitor's* machine once this app is hosted). Instead the server fetches
 * fixed paths on the configured upstream and relays normalized results:
 *
 *   fetchStatus()  → { ok: true, state: 'connected', status: {...} }
 *                  | { ok: false, state: 'disconnected', error: 'upstream_unreachable' }
 *                  | { ok: false, state: 'error', error: 'timeout' | 'upstream_bad_response' }
 *
 *   fetchAgentStates() → { ok: true, state: 'connected', activeWindowSec, agents: [...] }
 *                      | { ok: false, state: 'unauthorized' | 'unconfigured' | ... }
 *
 *   fetchProfileMemory()  → { ok, state, memory: { provider, files, providers } }
 *   fetchProfileMessaging() → { ok, state, messaging: { gatewayRunning,
 *                                  startCommand, platforms } }
 *   (the last two additionally take a profile name, validated and passed as
 *    a query parameter on fixed upstream paths — never part of the path)
 *
 * Hard limits by design:
 * - only GET, only paths from the fixed UPSTREAM_PATHS allowlist (never a
 *   user-controlled URL or path, so this can not be used as an open proxy),
 * - per-attempt timeout, one retry on network errors,
 * - 1 MiB response cap, JSON content-type enforcement,
 * - the upstream session token is sent whenever one is configured — to the
 *   /api/status probe and the authenticated per-profile paths alike (the
 *   token-gated public proxy scripts/hermes-public-proxy.js requires it on
 *   EVERY path; a direct Hermes serves /api/status publicly and simply
 *   ignores the header) — and never to browsers. With no token configured
 *   nothing is sent, so a direct Hermes needs no credentials at all.
 *
 * Upstream auth (verified against the Hermes source):
 * - /api/status and /api/health are on Hermes' public path list; no credent-
 *   ials are needed or sent for them.
 * - /api/profiles and /api/profiles/sessions are NOT public: in loopback
 *   mode Hermes requires the dashboard session token in the
 *   X-Hermes-Session-Token header (minted from HERMES_DASHBOARD_SESSION_TOKEN
 *   on the Hermes side, or random per process). We expose the same value as
 *   HERMES_SESSION_TOKEN. When it is absent, per-agent facts are reported as
 *   'unconfigured' rather than guessed.
 * - per-agent "active" flags come from Hermes itself: _tag_rows stamps each
 *   session is_active = (ended_at is null) && (now - last_active < 300).
 *   ACTIVE_WINDOW_SEC mirrors that window so the UI can label it honestly.
 */

/* Per-attempt ceiling. The aggregation endpoints open per-profile state and
 * probe gateway liveness — the running gateway's own profile legitimately
 * takes ~4s, so a lower ceiling mislabels a healthy backend as a timeout. */
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BYTES = 1024 * 1024;
const ACTIVE_WINDOW_SEC = 300;

/* Fixed upstream allowlist. Every path is a constant chosen here; none is
 * derived from request input, so no caller can steer the fetch. */
const UPSTREAM_PATHS = Object.freeze([
  '/api/status',
  '/api/profiles',
  '/api/profiles/sessions',
  '/api/memory',
  '/api/messaging/platforms',
]);

/* Profile names are caller-supplied. They only ever ride as a query
 * parameter on a fixed allowlisted path (never part of the path itself),
 * and are additionally restricted to sane identifier characters before
 * anything is encoded and forwarded. */
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function normalizeBaseUrl(raw) {
  try {
    const url = new URL('/api/status', raw || 'http://127.0.0.1:9119');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/* Absolute URL for an allowlisted path on the configured upstream, or null
 * for anything outside the allowlist (including path-injection attempts). */
function upstreamUrl(baseUrl, path) {
  const url = normalizeBaseUrl(baseUrl);
  if (!url || !UPSTREAM_PATHS.includes(path)) return null;
  url.pathname = path;
  url.search = '';
  return url;
}

function requestHeaders(sessionToken) {
  const headers = { accept: 'application/json' };
  /* Hermes' dedicated header: unlike Authorization it cannot collide with a
   * reverse proxy's own auth scheme. Only sent where a token is configured. */
  if (sessionToken) headers['x-hermes-session-token'] = sessionToken;
  return headers;
}

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('oversize');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* One GET with timeout/retry/size/JSON discipline. Returns
 * { ok: true, state: 'connected', body } or a normalized failure.
 * Never throws. */
async function fetchJson(url, timeoutMs, { sessionToken, retryDelayMs } = {}) {
  let lastError = 'upstream_unreachable';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: requestHeaders(sessionToken),
      });
      const text = await readCapped(res, MAX_BYTES);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // The upstream rejected OUR credentials (bad/expired token, or an
          // OAuth-gated dashboard). Reported distinctly: this is not a
          // connectivity problem and must not read as 'disconnected'.
          return { ok: false, state: 'unauthorized', error: 'upstream_unauthorized' };
        }
        return { ok: false, state: 'error', error: 'upstream_http_error' };
      }
      const ct = String(res.headers.get('content-type') || '');
      if (!ct.includes('json')) return { ok: false, state: 'error', error: 'upstream_bad_response' };
      try {
        return { ok: true, state: 'connected', body: JSON.parse(text) };
      } catch {
        return { ok: false, state: 'error', error: 'upstream_bad_response' };
      }
    } catch (err) {
      const name = err && err.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, state: 'error', error: 'timeout' };
      }
      const message = String((err && err.message) || '');
      lastError = message === 'oversize' ? 'upstream_bad_response' : 'upstream_unreachable';
      if (attempt === 0 && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  return { ok: false, state: 'disconnected', error: lastError };
}

/* Global status probe. The token travels only when one is configured: the
 * token-gated public proxy requires it on every path, while a direct Hermes
 * serves /api/status publicly and ignores the header — one behavior covers
 * both topologies. */
async function fetchStatus({ baseUrl, sessionToken = '', timeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = 150 } = {}) {
  const url = normalizeBaseUrl(baseUrl);
  if (!url) return { ok: false, state: 'error', error: 'bad_upstream_config' };
  const result = await fetchJson(url, timeoutMs, { sessionToken: sessionToken || undefined, retryDelayMs });
  if (!result.ok) return result;
  return { ok: true, state: 'connected', status: result.body };
}

/* Merge /api/profiles + /api/profiles/sessions into per-agent facts.
 * Pure: no I/O, so tests can pin the normalization directly. */
function normalizeAgents(profilesPayload, sessionsPayload, nowSec = Date.now() / 1000) {
  const profileRows = Array.isArray(profilesPayload && profilesPayload.profiles)
    ? profilesPayload.profiles : null;
  const sessionRows = Array.isArray(sessionsPayload && sessionsPayload.sessions)
    ? sessionsPayload.sessions : null;
  if (!profileRows || !sessionRows) {
    return { ok: false, state: 'error', error: 'upstream_bad_response' };
  }

  const buckets = new Map();
  for (const row of sessionRows) {
    if (!row || typeof row.profile !== 'string' || !row.profile) continue;
    const bucket = buckets.get(row.profile) || { sessions: 0, active: 0, lastActive: 0 };
    bucket.sessions += 1;
    if (row.is_active === true) bucket.active += 1;
    const last = Number(row.last_active || row.started_at || 0);
    if (Number.isFinite(last) && last > bucket.lastActive) bucket.lastActive = last;
    buckets.set(row.profile, bucket);
  }

  const agents = [];
  const seen = new Set();
  for (const profile of profileRows) {
    const name = profile && typeof profile.name === 'string' ? profile.name : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const bucket = buckets.get(name);
    agents.push({
      profile: name,
      gatewayRunning: !!(profile && profile.gateway_running),
      sessions: bucket ? bucket.sessions : 0,
      activeSessions: bucket ? bucket.active : 0,
      lastActiveAgeSec: bucket && bucket.lastActive > 0
        ? Math.max(0, Math.round(nowSec - bucket.lastActive))
        : null,
    });
  }
  // Sessions for a profile the roster did not list: keep the evidence rather
  // than dropping it (the UI filters to crew members it knows).
  for (const [name, bucket] of buckets) {
    if (seen.has(name)) continue;
    agents.push({
      profile: name,
      gatewayRunning: false,
      sessions: bucket.sessions,
      activeSessions: bucket.active,
      lastActiveAgeSec: bucket.lastActive > 0
        ? Math.max(0, Math.round(nowSec - bucket.lastActive))
        : null,
    });
  }

  return { ok: true, state: 'connected', activeWindowSec: ACTIVE_WINDOW_SEC, agents };
}

/* Per-agent facts for the crew view. Requires the upstream session token:
 * Hermes keeps /api/profiles* off its public path list. Never throws. */
async function fetchAgentStates({
  baseUrl,
  sessionToken = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = 150,
} = {}) {
  if (!sessionToken) {
    return { ok: false, state: 'unconfigured', error: 'no_session_token' };
  }
  const profilesUrl = upstreamUrl(baseUrl, '/api/profiles');
  const sessionsUrl = upstreamUrl(baseUrl, '/api/profiles/sessions');
  if (!profilesUrl || !sessionsUrl) {
    return { ok: false, state: 'error', error: 'bad_upstream_config' };
  }
  // The aggregation endpoint opens every profile's state.db; a bounded page
  // (Hermes caps limit at 500) is enough to cover every active session.
  sessionsUrl.search = '?limit=500&archived=exclude&order=recent';

  const profiles = await fetchJson(profilesUrl, timeoutMs, { sessionToken, retryDelayMs });
  if (!profiles.ok) return profiles;
  const sessions = await fetchJson(sessionsUrl, timeoutMs, { sessionToken, retryDelayMs });
  if (!sessions.ok) return sessions;
  return normalizeAgents(profiles.body, sessions.body);
}

/* Shared preamble for the per-profile fact endpoints: token present, profile
 * sane, path allowlisted. Returns either { failure } (already normalized) or
 * { url } ready to fetch with the session token attached. Never throws. */
function profileRequestUrl({ baseUrl, sessionToken = '', profile, path }) {
  if (!sessionToken) {
    return { failure: { ok: false, state: 'unconfigured', error: 'no_session_token' } };
  }
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
    return { failure: { ok: false, state: 'bad_request', error: 'bad_profile' } };
  }
  const url = upstreamUrl(baseUrl, path);
  if (!url) {
    return { failure: { ok: false, state: 'error', error: 'bad_upstream_config' } };
  }
  url.search = new URLSearchParams({ profile }).toString();
  return { url };
}

/* One profile's memory facts (Hermes GET /api/memory?profile=…): which
 * provider is active, how large the built-in MEMORY.md / USER.md files are,
 * and every discovered provider's readiness. Read-only; never throws. */
async function fetchProfileMemory({
  baseUrl,
  sessionToken = '',
  profile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = 150,
} = {}) {
  const { failure, url } = profileRequestUrl({ baseUrl, sessionToken, profile, path: '/api/memory' });
  if (failure) return failure;
  const result = await fetchJson(url, timeoutMs, { sessionToken, retryDelayMs });
  if (!result.ok) return result;
  const body = result.body || {};
  const files = body.builtin_files && typeof body.builtin_files === 'object' ? body.builtin_files : {};
  const providers = Array.isArray(body.providers) ? body.providers : [];
  return {
    ok: true,
    state: 'connected',
    memory: {
      // '' means the profile runs on the built-in memory files (no external
      // provider configured) — reported as-is, never guessed.
      provider: typeof body.active === 'string' ? body.active : '',
      files: {
        memoryBytes: Number.isFinite(Number(files.memory)) ? Math.max(0, Number(files.memory)) : 0,
        userBytes: Number.isFinite(Number(files.user)) ? Math.max(0, Number(files.user)) : 0,
      },
      providers: providers.map(p => ({
        name: String((p && p.name) || ''),
        description: String((p && p.description) || ''),
        available: !!(p && p.available),
        configured: !!(p && p.configured),
        status: p && typeof p.status === 'string' ? p.status : '',
      })),
    },
  };
}

/* One profile's messaging-channel facts (Hermes GET /api/messaging/platforms
 * ?profile=…): per-channel enabled/configured/state plus gateway liveness —
 * this is what backs "own telegram bot" per agent. Read-only: starting or
 * stopping the gateway stays inside the Hermes console, this proxy never
 * mutates upstream state. Never throws. */
async function fetchProfileMessaging({
  baseUrl,
  sessionToken = '',
  profile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = 150,
} = {}) {
  const { failure, url } = profileRequestUrl({ baseUrl, sessionToken, profile, path: '/api/messaging/platforms' });
  if (failure) return failure;
  const result = await fetchJson(url, timeoutMs, { sessionToken, retryDelayMs });
  if (!result.ok) return result;
  const body = result.body || {};
  const raw = Array.isArray(body.platforms) ? body.platforms : [];
  const platforms = raw.map(p => ({
    id: String((p && p.id) || ''),
    name: String((p && p.name) || ''),
    enabled: !!(p && p.enabled),
    configured: !!(p && p.configured),
    gatewayRunning: !!(p && p.gateway_running),
    state: p && typeof p.state === 'string' ? p.state : '',
    errorCode: p && typeof p.error_code === 'string' ? p.error_code : '',
    errorMessage: p && typeof p.error_message === 'string' ? p.error_message : '',
  }));
  return {
    ok: true,
    state: 'connected',
    messaging: {
      // The liveness verdict is the same for every channel of a profile; the
      // payload carries it per channel, so derive it from the channels seen.
      gatewayRunning: platforms.some(p => p.gatewayRunning),
      startCommand: typeof body.gateway_start_command === 'string' ? body.gateway_start_command : '',
      platforms,
    },
  };
}

module.exports = {
  fetchStatus,
  fetchAgentStates,
  fetchProfileMemory,
  fetchProfileMessaging,
  normalizeAgents,
  normalizeBaseUrl,
  upstreamUrl,
  UPSTREAM_PATHS,
  PROFILE_RE,
  ACTIVE_WINDOW_SEC,
  DEFAULT_TIMEOUT_MS,
};
