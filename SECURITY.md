# Security policy

## Deployment boundary

TrizEmpire implements server-side authentication and authorization, but it is
still an operator tool, not a public multi-user service. Follow
[DEPLOYMENT.md](DEPLOYMENT.md) for a controlled deployment behind HTTPS; it
ships a hardened systemd unit and a TLS-terminating nginx snippet as a
committed bundle in `deploy/`.

Binding behavior:

- Default bind is loopback (`127.0.0.1`).
- A non-loopback `HOST` requires **both** `ALLOW_REMOTE_HOST=true` **and**
  configured password hashes; otherwise the server refuses to start.
- `ALLOW_REMOTE_HOST=true` is not authentication and never secures anything by
  itself.

## Implemented protections

- **Authentication:** scrypt-hashed passwords in environment variables
  (`TRIZ_ADMIN_PASSWORD_HASH`, `TRIZ_OPERATOR_PASSWORD_HASH`); no plaintext,
  no default credentials. `NODE_ENV=production` refuses to start without a
  configured admin hash.
- **Configuration validation:** startup validates every environment variable
  (ports, URLs, session limits, hash format) in one module
  (`lib/config.js`) and fails fast naming the *variable*, never the value —
  so validation errors and logs cannot leak secrets. `PORT=0` (ephemeral) is
  rejected in production. Local `.env` files are gitignored; the server
  loads `nexora/.env` at startup with OS environment taking precedence.
- **Sessions:** random 32-byte tokens held server-side with idle and absolute
  expiry; `HttpOnly`, `SameSite=Strict` cookies (`Secure` in production).
- **CSRF:** state-changing endpoints require the `X-Triz-CSRF` header and a
  same-origin `Origin`/`Referer`.
- **Rate limiting:** failed logins are limited per client address (in-memory,
  per process).
- **Authorization:** protected APIs return `401` without a session;
  `/api/health/detail` requires the `admin` role.
- **Static hardening:** strict same-origin CSP, `X-Frame-Options: DENY`,
  `nosniff`, no-referrer, `Cache-Control: no-store`, GET/HEAD-only static
  serving from an explicit path allowlist, symlink-escape and traversal
  protection, generic error responses.
- **Hermes proxy:** the browser only reaches Hermes via server-side
  endpoints (`/api/hermes/status`, `/api/hermes/agents`), which fetch only
  from a fixed allowlist of upstream paths with timeouts, one retry and a
  1 MiB response cap. It cannot be used as an open network proxy. The
  upstream session token (`HERMES_SESSION_TOKEN`) travels only to the two
  authenticated per-agent paths, never to `/api/status`, never to browsers,
  and never into logs or error messages.
- **Logging:** method + pathname only for access logs; auth events log
  username and address, never passwords, hashes, cookies or request bodies.

## Reporting a vulnerability

Please do not publish exploit details or credentials in a public issue. Use
GitHub's private vulnerability reporting feature for this repository if it is
enabled. If it is unavailable, contact the repository owner privately before
sharing technical details.

## Current limitations

- Sessions and rate-limit state are in-memory (per process); running multiple
  replicas does not share them.
- The server does not terminate TLS — use a reverse proxy; a ready-to-adapt
  nginx TLS snippet ships in `deploy/trizempire-nginx.conf` (see DEPLOYMENT.md).
  The bundle is validated structurally by tests, not executed in CI, so run
  `systemd-analyze verify` and `nginx -t` on the target host.
- The embedded Hermes console iframe is a **local-only** feature
  (`HERMES_PUBLIC_URL`); on remote deployments it must be disabled, which the
  UI enforces with an unavailable panel.
- Per-agent status coloring uses real per-profile session data when
  `HERMES_SESSION_TOKEN` is configured; otherwise (or behind an OAuth-gated
  Hermes dashboard) it falls back to global backend signals and reports the
  per-agent endpoint as `unconfigured`/`unauthorized` rather than guessing.
- The embedded Hermes backend's own security posture is out of scope here:
  this server only consumes its public `/api/status` endpoint.
