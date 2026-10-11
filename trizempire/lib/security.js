'use strict';

/* Shared security headers. The CSP is deliberately strict:
 * - scripts and modules are same-origin only (Three.js is vendored under /vendor)
 * - the browser may talk only to this server and, for the local-only console
 *   embed, to the operator's loopback Hermes dashboard
 * - nothing may frame this app. */
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

module.exports = { applySecurityHeaders };
