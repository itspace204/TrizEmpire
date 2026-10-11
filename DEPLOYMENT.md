# TrizEmpire — deployment guide

This guide describes how to run TrizEmpire in a controlled production setup.
Everything here reflects the system as implemented in this repository; nothing
is speculative. Items that are **not yet implemented** are called out under
[Known limitations](#known-limitations).

## Supported hosting environment

- Any host with **Node.js 20+** (Node.js **24 LTS** recommended; CI tests 20, 22 and 24).
- Linux or Windows; commands below use POSIX shells (Git Bash works on Windows).
- A reverse proxy that terminates **HTTPS** (nginx, Caddy, Traefik, …). The app
  itself speaks plain HTTP and does not manage certificates.

## Runtime requirements

- No `npm install` step: the server uses only Node.js built-in modules and
  serves a vendored copy of Three.js (MIT, see `trizempire/vendor/THREE-LICENSE.txt`).
- The Hermes backend (optional but required for live telemetry) must be
  reachable **from the TrizEmpire server**, not from visitors' browsers.

## Install, build, start

```sh
git clone https://github.com/itspace204/TrizEmpire.git
cd TrizEmpire/trizempire
npm run check     # syntax check over all project JS
npm test          # automated test suite (node:test)
npm start         # starts server.js on 127.0.0.1:57004 by default
```

There is no build step.

## Environment variables

All configuration is via environment variables. Placeholder values only —
never commit real values.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `57004` | TCP port (`0` = ephemeral). |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback binds require `ALLOW_REMOTE_HOST=true` **and** configured authentication, otherwise the server refuses to start. |
| `ALLOW_REMOTE_HOST` | unset | Explicit opt-in for non-loopback binds. Not authentication. |
| `TRIZ_ADMIN_PASSWORD_HASH` | unset | scrypt hash for the `admin` account (role `admin`). Enabling this turns authentication on. |
| `TRIZ_OPERATOR_PASSWORD_HASH` | unset | scrypt hash for the `operator` account (role `operator`). |
| `TRIZ_SESSION_TTL_MINUTES` | `480` | Session idle timeout. |
| `TRIZ_SESSION_ABS_MINUTES` | `1440` | Session absolute lifetime. |
| `NODE_ENV` | unset | `production` enables `Secure` session cookies. |
| `TRIZ_SECURE_COOKIE` | unset | `true` forces `Secure` cookies without full production mode. |
| `HERMES_BASE_URL` | `http://127.0.0.1:9119` | Server-side upstream for live status. Only the fixed `/api/status` path is ever fetched. |
| `HERMES_PUBLIC_URL` | `http://127.0.0.1:9119` | URL handed to browsers for the **local-only** embedded console. Set to empty (`HERMES_PUBLIC_URL=`) on remote deployments. |
| `HERMES_TIMEOUT_MS` | `3000` | Per-attempt upstream timeout (one retry on network errors). |

### Creating password hashes

```sh
cd trizempire
node scripts/hash-password.js      # reads the password from stdin, prints the hash
# export TRIZ_ADMIN_PASSWORD_HASH='scrypt$16384$8$1$…'
```

No default credentials exist. If no hashes are configured, the server runs in
**loopback-only local mode** without login and says so at startup.

## HTTPS and reverse proxy

Terminate TLS in your reverse proxy and forward to the app on loopback.
The proxy should also set/forward `Host` correctly: CSRF protection compares
the `Origin`/`Referer` header against the request `Host`.

Example (nginx):

```nginx
server {
  listen 443 ssl;
  server_name triz.example.internal;
  # ssl_certificate …; ssl_certificate_key …;
  location / {
    proxy_pass http://127.0.0.1:57004;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Do **not** enable `ALLOW_REMOTE_HOST` on untrusted networks.

## Authentication configuration

1. Generate hashes for `admin` (and optionally `operator`) as shown above.
2. Set the environment variables and restart.
3. Browsers are redirected to the sign-in overlay; every protected API returns
   `401` until a valid session cookie is presented.
4. In production set `NODE_ENV=production` (or `TRIZ_SECURE_COOKIE=true`) so
   session cookies carry `Secure`.

Authorization enforced server-side:

- `/api/hermes/status` — any authenticated user.
- `/api/health/detail` — `admin` role only.
- All state-changing endpoints require the `X-Triz-CSRF` header **and** a
  same-origin `Origin`/`Referer`, in addition to `SameSite=Strict` cookies.

## Hermes connectivity

```
browser ── same-origin ──▶ TrizEmpire server ── HERMES_BASE_URL ──▶ Hermes /api/status
```

- Visitors never contact `127.0.0.1:9119` for data; the server-side proxy is
  the only path, with a fixed upstream path, timeouts, one retry and a 1 MiB cap.
- Proxy states exposed to the UI: `connected`, `disconnected`, `error`
  (timeout / bad response). The UI never pretends Hermes is connected.
- The **embedded console iframe** is a local-only feature: it points at
  `HERMES_PUBLIC_URL`, which normally only resolves on the operator machine.
  Set `HERMES_PUBLIC_URL=` for remote deployments; the UI then shows an honest
  "console unavailable" panel instead of a broken frame.

## Logging and health checks

- Access log: method + pathname + timestamp only (never query strings, bodies,
  cookies or tokens).
- Auth events: `auth login-ok|login-fail user=… ip=…` (no passwords or hashes).
- `GET /healthz` — public, returns exactly `{"status":"ok"}` (for load balancers).
- `GET /api/health/detail` — authenticated, `admin` role: uptime, Node version
  and Hermes reachability state only.

## Backup and recovery

- The app has **no database**. Sessions and rate-limit state are in-memory and
  reset on restart (users simply sign in again).
- Recovery = redeploy the repository at the desired revision and restart.
- Back up your environment configuration (hashed passwords, URLs) in your
  secret manager — it is the only persistent state.

## Rollback

```sh
git revert <bad-commit>   # or check out the previous known-good tag
cd trizempire && npm run check && npm test && npm start
```

## CI

`.github/workflows/trizempire-checks.yml` runs Gitleaks secret scanning plus
syntax checks and the full test suite on Node.js 20, 22 and 24 for every push
to `main` and every pull request.

## Known limitations

- **Implemented and verified:** static delivery with CSP/security headers,
  scrypt+session authentication, CSRF, login rate limiting (in-memory),
  server-side Hermes status proxy with normalized states, health endpoints,
  the full UI (cockpit, crew, 3D Agent City, local console embed), 29 automated
  tests including a real-Hermes integration test that skips when Hermes is not
  running.
- **Partially implemented:** per-agent working/idle coloring derives from
  global backend signals (`gateway_running`, `active_agents`); Hermes'
  per-profile endpoints require upstream credentials that are not configured.
  Rate limiting and sessions are per-process (not shared across replicas).
- **Planned / blocked:** HTTPS termination (reverse proxy required), persistent
  audit storage, multi-user administration UI, real per-agent activity data
  (needs authenticated Hermes access), and the placeholder nav modules
  (Voice, Hand, Chat, Missions, Docs, Schedule, Health, Files, Terminal,
  Integrations, Guide, Settings) which are clearly labeled and inert.
