/* NEXORA — local-first, zero-dependency Node.js static server.
 * Run with Node.js 20+. Defaults to loopback only; do not expose this dashboard
 * to a network until authentication and authorization are implemented.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 57004);
const ROOT = __dirname;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK_HOSTS.has(HOST) && process.env.ALLOW_REMOTE_HOST !== 'true') {
  throw new Error('Refusing non-loopback HOST. Set ALLOW_REMOTE_HOST=true only if you understand this server has no authentication.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:9119 http://localhost:9119",
    "frame-src http://127.0.0.1:9119 http://localhost:9119",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('Cache-Control', 'no-store');
}

function send(res, status, body, type = 'text/plain; charset=utf-8', method = 'GET') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(method === 'HEAD' ? undefined : body);
}

function createServer({ root = ROOT } = {}) {
  const safeRoot = path.resolve(root);

  return http.createServer((req, res) => {
    applySecurityHeaders(res);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'Method not allowed', undefined, req.method);
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(res, 400, 'Bad request', undefined, req.method);
    }

    if (pathname === '/healthz') {
      return send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8', req.method);
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve and validate the final path before accessing the filesystem.
    const filePath = path.resolve(safeRoot, '.' + pathname);
    if (!filePath.startsWith(safeRoot + path.sep) || path.basename(filePath).startsWith('.')) {
      return send(res, 404, 'Not found', undefined, req.method);
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not found', undefined, req.method);

      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.statusCode = 200;
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') return res.end();

      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) send(res, 500, 'Internal server error');
        else res.destroy();
      });
      stream.pipe(res);
      // Log only method and pathname; do not write query strings that may contain secrets.
      console.log(`${req.method} ${pathname} ${new Date().toISOString()}`);
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`NEXORA serving local files from ${ROOT}`);
    console.log(`  http://${HOST}:${PORT}/`);
    console.log('  Local-only mode: no authentication is implemented.');
  });
}

module.exports = { createServer };
