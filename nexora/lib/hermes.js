'use strict';

/* Server-side Hermes proxy.
 *
 * The browser never talks to 127.0.0.1:9119 directly (that address means the
 * *visitor's* machine once this app is hosted). Instead the server fetches a
 * single fixed path on the configured upstream and relays a normalized result:
 *
 *   { ok: true,  state: 'connected',    status: {...} }
 *   { ok: false, state: 'disconnected', error: 'upstream_unreachable' }
 *   { ok: false, state: 'error',        error: 'timeout' | 'upstream_bad_response' }
 *
 * Hard limits by design:
 * - only GET, only the fixed /api/status path (never a user-controlled URL,
 *   so this can not be used as an open network proxy),
 * - per-attempt timeout, one retry on network errors,
 * - 1 MiB response cap, JSON content-type enforcement.
 */

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BYTES = 1024 * 1024;

function normalizeBaseUrl(raw) {
  try {
    const url = new URL('/api/status', raw || 'http://127.0.0.1:9119');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
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

async function fetchOnce(url, timeoutMs) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  const text = await readCapped(res, MAX_BYTES);
  if (!res.ok) throw new Error('upstream_http_' + res.status);
  const ct = String(res.headers.get('content-type') || '');
  if (!ct.includes('json')) return { ok: false, state: 'error', error: 'upstream_bad_response' };
  try {
    return { ok: true, state: 'connected', status: JSON.parse(text) };
  } catch {
    return { ok: false, state: 'error', error: 'upstream_bad_response' };
  }
}

/* Returns a normalized proxy result. Never throws. */
async function fetchStatus({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = 150 } = {}) {
  const url = normalizeBaseUrl(baseUrl);
  if (!url) return { ok: false, state: 'error', error: 'bad_upstream_config' };

  let lastError = 'upstream_unreachable';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchOnce(url, timeoutMs);
    } catch (err) {
      const name = err && err.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, state: 'error', error: 'timeout' };
      }
      const message = String((err && err.message) || '');
      if (message.startsWith('upstream_http_')) {
        return { ok: false, state: 'error', error: 'upstream_http_error' };
      }
      lastError = message === 'oversize' ? 'upstream_bad_response' : 'upstream_unreachable';
      if (attempt === 0 && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  return { ok: false, state: 'disconnected', error: lastError };
}

module.exports = { fetchStatus, normalizeBaseUrl, DEFAULT_TIMEOUT_MS };
