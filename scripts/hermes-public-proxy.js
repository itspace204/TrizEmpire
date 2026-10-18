'use strict';

/* Authenticated public reverse proxy for the LOCAL Hermes dashboard.
 *
 * Why this exists: TrizEmpire on Vercel cannot reach 127.0.0.1:9119, and
 * Hermes itself refuses to serve a public hostname without its OAuth gate —
 * which only a browser can satisfy. The deployment guide's answer is "an
 * authenticated reverse proxy, or a tunnel"; this is both, in one process:
 *
 *   1. every request must carry the session token (the same value TrizEmpire
 *      sends as x-hermes-session-token, paired via HERMES_DASHBOARD_SESSION_TOKEN);
 *   2. authenticated requests are forwarded to the loopback dashboard WITH A
 *      LOOPBACK HOST HEADER, so Hermes never leaves loopback mode and its own
 *      public-exposure gate never engages.
 *
 * Usage:
 *   HERMES_SESSION_TOKEN=<token> node scripts/hermes-public-proxy.js [port]
 *
 * Env:
 *   HERMES_SESSION_TOKEN  required — the shared session token
 *   HERMES_UPSTREAM_HOST  default 127.0.0.1
 *   HERMES_UPSTREAM_PORT  default 9119
 *   PORT / argv[2]        listen port, default 9219, bound to loopback only
 *
 * Point a tunnel (e.g. `cloudflared tunnel --url http://127.0.0.1:9219`)
 * at the listen port and set TrizEmpire's HERMES_BASE_URL to the tunnel URL —
 * or skip the manual steps and run `node scripts/hermes-up.js`, which starts
 * the dashboard, this proxy and the tunnel together and republishes the URL
 * to Vercel automatically (see DEPLOYMENT.md → Remote Hermes behind Vercel).
 */
const http = require('node:http');

const TOKEN = process.env.HERMES_SESSION_TOKEN || '';
if (!TOKEN) {
  console.error('hermes-public-proxy: HERMES_SESSION_TOKEN is required (the paired dashboard session token)');
  process.exit(1);
}
const UP_HOST = process.env.HERMES_UPSTREAM_HOST || '127.0.0.1';
const UP_PORT = Number(process.env.HERMES_UPSTREAM_PORT || 9119);
const LISTEN_PORT = Number(process.argv[2] || process.env.PORT || 9219);

/* Timing-safe comparison for equal-length candidates; length mismatch is
 * already a rejection, so pad nothing. */
function tokenMatches(given) {
  if (typeof given !== 'string' || given.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i += 1) diff |= TOKEN.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const server = http.createServer((req, res) => {
  const header = req.headers['x-hermes-session-token'] || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tokenMatches(header) && !tokenMatches(bearer)) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'unauthenticated', detail: 'A valid x-hermes-session-token header is required.' }));
    return;
  }
  const headers = { ...req.headers, host: `${UP_HOST}:${UP_PORT}` };
  /* The dashboard must see a pure loopback client: its own auth state stays
   * loopback-mode, and nothing we forward may look like a browser session. */
  delete headers.authorization;
  delete headers.cookie;
  delete headers.connection;
  const upstream = http.request(
    { host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers },
    up => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'hermes_upstream_unreachable' }));
  });
  req.pipe(upstream);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`hermes-public-proxy: loopback :${LISTEN_PORT} -> http://${UP_HOST}:${UP_PORT} (session token required on every request)`);
});
