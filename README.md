# TrizEmpire

**TrizEmpire** is an original project by the repository owner. Reference images were used for visual direction; the implementation, project structure, and code are the owner's work.

TrizEmpire is a Node.js operator interface for a local [Hermes](https://github.com/NousResearch) managing backend: a live cockpit, a crew roster, and a 3D "Agent City" where every agent's building glows with its live status (working / ready / idle / offline) — the glow's warmth comes from how recently that agent last touched a session and its pulse rate from how many sessions it is running concurrently, both read from Hermes' own per-profile session rows; a building the backend cannot evidence stays completely flat. It talks to Hermes **through a server-side proxy**, and ships with real server-side authentication for remote use.

The Agent City board is a real 3D view of the district artwork: **scroll to zoom** toward the pointer, **drag to pan**, **shift-drag (or right-drag) to tilt** — sideways motion orbits the board, or use **`Q` / `E`** — and **double-click (or `0`)** to reset. The board also leans a degree or two with the pointer, and its activity light, labels and panels sit on separate planes that separate as you turn it; each plane's depth is divided by the zoom, so every overlay stays locked to the artwork at any zoom or pan. The pose is remembered per browser, so the board reopens the way you left it; every overlay — building label, status chip, legend, agent card — shares the board's transform, and the status chips hold their screen size while the city grows around them.

> **Security notice:** without configured password hashes the server runs in loopback-only local mode with no login. It refuses any non-loopback bind unless `ALLOW_REMOTE_HOST=true` **and** authentication are both configured. See [SECURITY.md](SECURITY.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## Repository layout

- `trizempire/index.html` — operator UI (cockpit, crew, Agent City, console embed, login).
- `trizempire/server.js` — zero-dependency Node.js server: static delivery (allowlisted), auth, Hermes proxy, health endpoints.
- `trizempire/lib/` — `auth.js` (scrypt, sessions, rate limiting, CSRF), `hermes.js` (upstream proxy), `security.js` (headers/CSP).
- `trizempire/vendor/` — vendored Three.js (MIT, pinned; `vendor/THREE-LICENSE.txt`).
- `trizempire/scripts/` — `hash-password.js` (create password hashes), `check-syntax.js` (cross-platform syntax check).
- `trizempire/tests/` — automated test suite (`node:test`, no dependencies).
- `.github/workflows/trizempire-checks.yml` — Gitleaks + syntax + tests on Node 20/22/24.
- `deploy/` — committed deployment bundle for a Linux host: hardened systemd unit (`trizempire.service`), pm2 process file (`ecosystem.config.js`, used by Hostinger VPS-style hosts) and nginx TLS snippet (`trizempire-nginx.conf`).
- `api/index.js` + `vercel.json` — Vercel serverless entry: the same server pipeline dispatched per request, with the static UI bundled via `includeFiles`.
- `DEPLOYMENT.md` — production deployment guide (Linux host, Hostinger, Vercel).

## Requirements

- Node.js 20 or later; Node.js 24 LTS is recommended.
- A Hermes backend (default `http://127.0.0.1:9119`) for live status. The UI loads without it and honestly reports the backend as offline/disconnected.

## Run locally

```sh
cd trizempire
cp .env.example .env    # optional: local defaults; edit as needed
npm start                # http://127.0.0.1:57004
```

No `npm install` is required — the server uses only Node.js built-ins and serves a vendored Three.js.

### Configuration (`.env`)

All configuration is via environment variables; [trizempire/.env.example](trizempire/.env.example) documents every variable the code actually reads. The server loads `trizempire/.env` at startup (plain `npm start`); variables already set in the operating-system environment always win over the file. `.env` is gitignored — copy the template, never commit your copy. The full variable table, validation rules and hosting guidance are in [DEPLOYMENT.md](DEPLOYMENT.md).

The server validates configuration at startup and fails fast with a clear message (variable name, never the value): invalid ports, malformed URLs, unknown `NODE_ENV`, and — in production — missing authentication or `PORT=0` are all rejected before the first request.

### Enable login (required for any remote exposure)

```sh
cd trizempire
node scripts/hash-password.js        # paste password on stdin; prints scrypt hash
# put the printed hash in .env as TRIZ_ADMIN_PASSWORD_HASH='scrypt$…'
npm start
```

Sign in as `admin` with the password you hashed. Optionally set `TRIZ_OPERATOR_PASSWORD_HASH` for a second, non-admin account. There is no default password: without a hash the server runs in loopback-only local mode, and `NODE_ENV=production` refuses to start without one.

## Checks and tests

```sh
cd trizempire
npm run check     # syntax check across the project
npm test          # 119 tests: server, auth, sessions (server-side and
                  # stateless/signed), CSRF, rate limiting, proxy states,
                  # traversal/symlink protection, headers, environment-config
                  # validation and .env hygiene, workspace-mapping store
                  # (file + Upstash REST), deployment bundle (systemd unit,
                  # pm2 file, nginx TLS), the Vercel serverless entry/config,
                  # plus a real-Hermes integration test (skips if Hermes is down)
```

## Configuration

All via environment variables — template in [trizempire/.env.example](trizempire/.env.example), full table in [DEPLOYMENT.md](DEPLOYMENT.md). Highlights:

- `HOST` defaults to `127.0.0.1`; non-loopback binds require `ALLOW_REMOTE_HOST=true` **and** configured auth.
- `NODE_ENV=production` requires `TRIZ_ADMIN_PASSWORD_HASH` and a fixed `PORT` — the server refuses to start otherwise.
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` — optional Supabase Auth sign-in (email + password) alongside the local accounts; the credential exchange happens server-side and the Supabase token never reaches the browser.
- `HERMES_BASE_URL` — server-side upstream (fixed allowlisted paths only; never an open proxy).
- `HERMES_SESSION_TOKEN` — upstream session token that unlocks real per-agent crew states (per-profile sessions from Hermes) and the cockpit workspace panels (each agent's own memory providers and Telegram/channel state); unset = the crew shows global signals and those endpoints report `unconfigured`.
- `HERMES_PUBLIC_URL` — console-embed URL for the operator's own machine; set empty on remote deployments (the UI then shows an unavailable panel).
- `NODE_ENV=production` — `Secure` session cookies.
- `TRIZ_SESSION_SECRET` — stateless HMAC-signed sessions, required on serverless hosts (Vercel) where instances share no memory.
- `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or the `UPSTASH_REDIS_REST_*` pair) — Upstash-compatible store for the workspace→agent mapping on read-only/serverless filesystems.

## Architecture

```
browser ── same-origin HTTP ──▶ TrizEmpire server ──▶ Hermes /api/status
   │                               │
   │ (auth: scrypt + sessions,     │ static UI + vendored Three.js
   │  CSRF, rate limiting)         └── /api/hermes/status proxy
   └── embedded console (local-only, HERMES_PUBLIC_URL)
```

The browser never assumes `127.0.0.1:9119` exists: live data comes from the server-side proxy, and the embedded Hermes console only activates when the server says Hermes is reachable and the embed URL is configured.

## Secrets and security

- Never commit API keys, passwords, session tokens, private keys, or real `.env` files (`.env*` is gitignored; commit `.env.example` placeholders only).
- Passwords exist only as scrypt hashes in environment variables.
- If a secret was committed, revoke or rotate it — deleting it from the latest version does not remove it from Git history.
- Dashboard values are only presented as live telemetry when backed by real measurements; unavailable metrics render as `—`.

## License

Original TrizEmpire project code is licensed under the MIT License; see [LICENSE](LICENSE). The vendored Three.js library is MIT-licensed separately (`trizempire/vendor/THREE-LICENSE.txt`). Web fonts (Google Fonts) and any third-party assets carry their own terms — verify and preserve those separately.
