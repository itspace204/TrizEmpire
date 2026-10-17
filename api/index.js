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

/* One server per cold start: the session/rate-limit stores live for as long
 * as the instance stays warm. Configuration resolves here and this target
 * fails fast by design — but an exception escaping the module would only
 * ever surface as Vercel's opaque "500: INTERNAL_SERVER_ERROR", trapping
 * the message that names the offending variable in logs the operator may
 * never open. So a boot failure is captured and answered IN BAND: every
 * request gets HTTP 500 with the startup message (config errors name the
 * variable and never echo its value), straight from the URL. The app never
 * serves a single request on a failed boot. */
let server = null;
let bootError = null;
try {
  /* The require is inside the guard too: a missing or broken bundle is a
     boot failure like any other and must report itself the same way. */
  const { createServer } = require('../trizempire/server');
  server = createServer();
} catch (err) {
  bootError = err instanceof Error ? err : new Error(String(err));
}

module.exports = (req, res) => {
  if (bootError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('TrizEmpire did not start: '
      + (bootError.message || 'unknown startup error') + '\n');
    return;
  }
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
      && !/[\r\n?#]/.test(originalPath)) {
      routed.searchParams.delete('__triz_vc_original_path');
      const query = routed.searchParams.toString();
      req.url = originalPath + (query ? `?${query}` : '');
    }
  } catch {
    // Invalid URL shapes fall through to the server's normal safe 404 path.
  }
  server.emit('request', req, res);
};
