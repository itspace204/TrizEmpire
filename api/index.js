'use strict';

/* Vercel serverless entry — the SAME TrizEmpire server, dispatched per
 * request instead of listening on a port.
 *
 * How it works: createServer() from trizempire/server.js builds an
 * http.Server whose request pipeline (security headers, auth, CSRF, the
 * Hermes proxy, the workspace API, allowlisted static delivery) is attached
 * as its 'request' listener. Vercel invokes this handler with a real
 * http.IncomingMessage/ServerResponse pair, so re-emitting 'request' runs the
 * exact code path `npm start` runs — one implementation, one set of rules.
 *
 * Deployment facts this file depends on (see DEPLOYMENT.md → Vercel):
 *   - vercel.json rewrites every path to /api/index; req.url keeps the
 *     original path, so static and API routing work unchanged.
 *   - vercel.json's includeFiles bundles trizempire/index.html, crew/ and
 *     vendor/ into the function (the filesystem is read-only at runtime).
 *   - NODE_ENV=production is set by the platform, so authentication is
 *     mandatory: set TRIZ_ADMIN_PASSWORD_HASH (and TRIZ_SESSION_SECRET for
 *     stateless sessions — instances share no memory). The server fails fast
 *     at cold start with the variable's name if either is missing/invalid.
 *   - Workspace mapping is stored in Upstash Redis REST (KV_REST_API_URL /
 *     KV_REST_API_TOKEN) since the lambda filesystem is read-only; without
 *     it the mapping falls back to /tmp, which is wiped on every deploy.
 */

const { createServer } = require('../trizempire/server');

/* One server per cold start: the session/rate-limit stores live for as long
 * as the instance stays warm. */
const server = createServer();

module.exports = (req, res) => {
  /* Vercel rewrites internally route the request to /api/index. Carry the
   * source pathname in a reserved query parameter so this shared server sees
   * the real route (/, /crew/..., /api/...) regardless of whether the
   * platform exposes the source or destination URL as req.url. */
  try {
    const routed = new URL(req.url || '/', 'http://vercel.internal');
    const originalPath = routed.searchParams.get('__triz_vc_original_path');
    if (originalPath && originalPath.startsWith('/')
      && !originalPath.startsWith('//')
      && !originalPath.includes('\\')
      && !/[\\r\\n?#]/.test(originalPath)) {
      routed.searchParams.delete('__triz_vc_original_path');
      const query = routed.searchParams.toString();
      req.url = originalPath + (query ? `?${query}` : '');
    }
  } catch {
    // Invalid URL shapes fall through to the server's normal safe 404 path.
  }
  server.emit('request', req, res);
};
