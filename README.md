# TrizEmpire

**TrizEmpire** is an original project by the repository owner. Reference images were used for visual direction; the implementation, project structure, and code are the owner's work.

TrizEmpire is a Node.js operator interface for a local [Hermes](https://github.com/NousResearch) managing backend: a live cockpit, a crew roster, and a 3D "Agent City" where every agent's building glows with its live status (working / ready / idle / offline). It talks to Hermes **through a server-side proxy**, and ships with real server-side authentication for remote use.

> **Security notice:** without configured password hashes the server runs in loopback-only local mode with no login. It refuses any non-loopback bind unless `ALLOW_REMOTE_HOST=true` **and** authentication are both configured. See [SECURITY.md](SECURITY.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## Repository layout

- `nexora/index.html` — operator UI (cockpit, crew, Agent City, console embed, login).
- `nexora/server.js` — zero-dependency Node.js server: static delivery (allowlisted), auth, Hermes proxy, health endpoints.
- `nexora/lib/` — `auth.js` (scrypt, sessions, rate limiting, CSRF), `hermes.js` (upstream proxy), `security.js` (headers/CSP).
- `nexora/vendor/` — vendored Three.js (MIT, pinned; `vendor/THREE-LICENSE.txt`).
- `nexora/scripts/` — `hash-password.js` (create password hashes), `check-syntax.js` (cross-platform syntax check).
- `nexora/tests/` — automated test suite (`node:test`, no dependencies).
- `.github/workflows/nexora-checks.yml` — Gitleaks + syntax + tests on Node 20/22/24.
- `DEPLOYMENT.md` — production deployment guide.

## Requirements

- Node.js 20 or later; Node.js 24 LTS is recommended.
- A Hermes backend (default `http://127.0.0.1:9119`) for live status. The UI loads without it and honestly reports the backend as offline/disconnected.

## Run locally

```sh
cd nexora
cp .env.example .env    # optional: local defaults; edit as needed
npm start                # http://127.0.0.1:57004
```

No `npm install` is required — the server uses only Node.js built-ins and serves a vendored Three.js.

### Configuration (`.env`)

All configuration is via environment variables; [nexora/.env.example](nexora/.env.example) documents every variable the code actually reads. The server loads `nexora/.env` at startup (plain `npm start`); variables already set in the operating-system environment always win over the file. `.env` is gitignored — copy the template, never commit your copy. The full variable table, validation rules and hosting guidance are in [DEPLOYMENT.md](DEPLOYMENT.md).

The server validates configuration at startup and fails fast with a clear message (variable name, never the value): invalid ports, malformed URLs, unknown `NODE_ENV`, and — in production — missing authentication or `PORT=0` are all rejected before the first request.

### Enable login (required for any remote exposure)

```sh
cd nexora
node scripts/hash-password.js        # paste password on stdin; prints scrypt hash
# put the printed hash in .env as TRIZ_ADMIN_PASSWORD_HASH='scrypt$…'
npm start
```

Sign in as `admin` with the password you hashed. Optionally set `TRIZ_OPERATOR_PASSWORD_HASH` for a second, non-admin account. There is no default password: without a hash the server runs in loopback-only local mode, and `NODE_ENV=production` refuses to start without one.

## Checks and tests

```sh
cd nexora
npm run check     # syntax check across the project
npm test          # 53 tests: server, auth, sessions, CSRF, rate limiting,
                  # proxy states, traversal/symlink protection, headers,
                  # environment-config validation and .env hygiene,
                  # plus a real-Hermes integration test (skips if Hermes is down)
```

## Configuration

All via environment variables — template in [nexora/.env.example](nexora/.env.example), full table in [DEPLOYMENT.md](DEPLOYMENT.md). Highlights:

- `HOST` defaults to `127.0.0.1`; non-loopback binds require `ALLOW_REMOTE_HOST=true` **and** configured auth.
- `NODE_ENV=production` requires `TRIZ_ADMIN_PASSWORD_HASH` and a fixed `PORT` — the server refuses to start otherwise.
- `HERMES_BASE_URL` — server-side upstream (fixed `/api/status` path only; never an open proxy).
- `HERMES_PUBLIC_URL` — console-embed URL for the operator's own machine; set empty on remote deployments (the UI then shows an unavailable panel).
- `NODE_ENV=production` — `Secure` session cookies.

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

Original TrizEmpire project code is licensed under the MIT License; see [LICENSE](LICENSE). The vendored Three.js library is MIT-licensed separately (`nexora/vendor/THREE-LICENSE.txt`). Web fonts (Google Fonts) and any third-party assets carry their own terms — verify and preserve those separately.
