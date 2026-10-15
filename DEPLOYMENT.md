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

## Deployment bundle (systemd + nginx + pm2)

`deploy/` carries a committed deployment bundle for a Linux host:

- [`deploy/trizempire.service`](deploy/trizempire.service) — hardened systemd
  unit: dedicated unprivileged `trizempire` user, direct `node` invocation (no npm
  wrapper), loopback bind on `HOST=127.0.0.1`/`PORT=57004`,
  `NODE_ENV=production`, journal logging, and sandboxing that is safe for V8's
  JIT (deliberately **no** `MemoryDenyWriteExecute=`, which would stop Node
  from starting).
- [`deploy/ecosystem.config.js`](deploy/ecosystem.config.js) — pm2 process file,
  the counterpart for hosts where pm2 is the house style (Hostinger VPS
  tutorials, for example). Same HOST/PORT pins as the unit and the nginx
  snippet. **Pick one** process manager — pm2 and systemd must not both run
  the server.
- [`deploy/trizempire-nginx.conf`](deploy/trizempire-nginx.conf) — nginx
  server blocks for ports 80 and 443: Let's Encrypt webroot, HTTP→HTTPS
  redirect, the Mozilla "intermediate" TLS policy (TLS 1.2 + 1.3, AEAD
  ciphers), HSTS, and the `Host`/`X-Forwarded-Proto` headers the app's CSRF
  origin check depends on.

The unit's `HOST`/`PORT` and the snippet's `proxy_pass` target are pinned to
match each other (and to the app's defaults) by `trizempire/tests/deploy.test.js`,
which also checks the TLS policy, the proxy headers and the sandbox directives.
Adjust both files together if you change the port or hostname.

### Install the service

```sh
# 1. App and runtime (adjust the paths if your node or clone live elsewhere)
sudo useradd --system --home /opt/trizempire --shell /usr/sbin/nologin trizempire
sudo git clone https://github.com/itspace204/TrizEmpire.git /opt/trizempire
command -v node                    # must be /usr/bin/node, or edit ExecStart

# 2. Secrets: systemd EnvironmentFile syntax — KEY=value, no `export`.
#    Values are literal, so the $ characters in a scrypt hash are safe.
cd /opt/trizempire/trizempire
node scripts/hash-password.js      # type the admin password; prints scrypt$…
sudo install -d -m 0755 /etc/trizempire
sudoedit /etc/trizempire/trizempire.env    # TRIZ_ADMIN_PASSWORD_HASH='scrypt$…'
sudo chmod 0600 /etc/trizempire/trizempire.env

# 3. Writable data dir for the workspace mapping (unit's ReadWritePaths=)
sudo install -d -o trizempire -g trizempire -m 0700 /opt/trizempire/trizempire/data

# 4. Unit
sudo install -m 0644 deploy/trizempire.service /etc/systemd/system/trizempire.service
sudo systemd-analyze verify /etc/systemd/system/trizempire.service
sudo systemctl daemon-reload
sudo systemctl enable --now trizempire

# 5. Verify
systemctl status trizempire --no-pager
curl -fsS http://127.0.0.1:57004/healthz      # {"status":"ok"}
journalctl -u trizempire -n 50 --no-pager     # startup banner + config errors
```

The unit expects Node at `/usr/bin/node`; if yours is elsewhere (nvm), edit
`ExecStart` — and note that nvm installs live under `/home`, so you must also
drop `ProtectHome=true` or systemd will hide the binary from the service.
Because `Environment=` sets `NODE_ENV=production`, the service will refuse to
start until `TRIZ_ADMIN_PASSWORD_HASH` is in the env file; the journal names
the missing variable (never a value). On a server, also set
`HERMES_PUBLIC_URL=` (already the unit's default) unless the Hermes dashboard
is genuinely reachable from visitors' browsers.

### Install the TLS proxy

nginx cannot start before the certificate exists, so the snippet is enabled in
two passes:

```sh
# 1. Copy the config and, for now, comment out the whole "port 443: TLS"
#    server block — its ssl_certificate files do not exist yet.
sudo cp deploy/trizempire-nginx.conf /etc/nginx/sites-available/trizempire.conf
sudo ln -s /etc/nginx/sites-available/trizempire.conf /etc/nginx/sites-enabled/
sudo mkdir -p /var/www/certbot/.well-known/acme-challenge
sudo nginx -t && sudo systemctl reload nginx

# 2. Issue the certificate (webroot matches the config's ACME location).
sudo certbot certonly --webroot -w /var/www/certbot -d triz.example.internal

# 3. Uncomment the "port 443: TLS" server block again, then:
sudo nginx -t && sudo systemctl reload nginx
curl -fsSI https://triz.example.internal/healthz   # 200 + HSTS header
certbot renew --dry-run                           # renewal is automated
```

Replace `triz.example.internal` (four occurrences in the snippet) with your
hostname first. `certbot --nginx` is a workable alternative, but it rewrites
the config itself — keep the `Host` and `X-Forwarded-Proto` proxy headers if
you merge. HSTS is included with a two-year `max-age`; leave it commented out
on a first rollout until HTTPS is verified, and do not add `preload`.

## Vercel (serverless)

The repo deploys to Vercel as a **single serverless function**: the same
`createServer()` pipeline (headers, auth, CSRF, proxy, static delivery) that
`npm start` runs, dispatched per request by [`api/index.js`](api/index.js)
instead of listening on a port. [`vercel.json`](vercel.json) rewrites every
path to that function and bundles the runtime-read static files
(`trizempire/index.html`, `crew/`, `vendor/`) into it with `includeFiles` —
without that, Node File Trace cannot see dynamically assembled paths and the
UI would 404.

```sh
# one-time, from your machine:
node trizempire/scripts/hash-password.js   # prints scrypt$…
openssl rand -hex 32                       # stateless session secret
vercel link                                # attach the repo to a Vercel project
vercel env add TRIZ_ADMIN_PASSWORD_HASH production
vercel env add TRIZ_SESSION_SECRET production
vercel --prod
```

Environment the platform expects (Project → Settings → Environment
Variables):

| Variable | Value |
| --- | --- |
| `TRIZ_ADMIN_PASSWORD_HASH` | **Required.** `NODE_ENV=production` is set by Vercel, so the server refuses to start without it — there is no default password. |
| `TRIZ_SESSION_SECRET` | **Required.** Instances share no memory, so sessions must be stateless (HMAC-signed cookies). Generate with `openssl rand -hex 32`. Read the trade-offs in the variable table: no idle timeout, no revocation before the absolute expiry. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | **Recommended.** Install "Upstash Redis" from the Vercel Marketplace (has a free tier) so the workspace→agent mapping survives deploys. Without it the mapping falls back to `/tmp`, which is wiped on every deploy. |
| `HERMES_BASE_URL` | Your Hermes dashboard's **publicly reachable** URL — see the honest limitation below. |
| `HERMES_PUBLIC_URL` | Leave **unset**: visitors' browsers cannot reach your machine's loopback, so the embedded console stays off (the UI says so). |

Honest limitations of the serverless target — the UI reports all of them
rather than pretending:

- **Hermes telemetry depends on reaching your machine.** The proxy fetches
  server-side; `127.0.0.1:9119` does not exist on Vercel. Either accept that
  the cockpit shows the gateway as offline, or expose Hermes over HTTPS
  yourself (an authenticated reverse proxy, or a tunnel such as Cloudflare
  Tunnel) and set `HERMES_BASE_URL` to it. The upstream path allowlist still
  applies — only `/api/status` and the token-gated `/api/profiles*` are ever
  requested.
- **Sessions and rate limits are per-instance.** Stateful sessions are
  impossible (hence `TRIZ_SESSION_SECRET`); the login limiter buckets by
  forwarded IP (`VERCEL=1` enables trust-proxy automatically) but is not
  shared between instances — a determined attacker can get more than five
  attempts by hitting different instances. Treat Vercel's own WAF/rate
  limits as the outer layer.
- **Workspace mapping needs KV to be durable** (`/tmp` is per-deploy).
- **Node 20 is disabled for new Vercel functions** (since October 2026);
  the root `package.json` pins `>=22`, and the app itself still runs on 20+
  for self-hosted deployments.

Local verification of the serverless entry (no Vercel account needed):

```sh
node -e "const h=require('./api/index.js'),s=require('node:http').createServer(h);s.listen(57099,'127.0.0.1',()=>console.log('http://127.0.0.1:57099'))"
```

## Hostinger

Hostinger does not run bare `node server.js` for you; pick the target that
matches your plan.

### VPS (KVM, full root — the recommended path)

Same bundle as any Linux host, with pm2 instead of systemd if you prefer
Hostinger's house style:

```sh
# 1. Create the app user and clone (as root, then work unprivileged)
useradd --system --home /opt/trizempire --shell /usr/sbin/nologin trizempire
git clone https://github.com/itspace204/TrizEmpire.git /opt/trizempire

# 2. Node.js 20+ (Nodesource or nvm), then verify: node -v

# 3. Secrets — the server loads trizempire/.env itself (chmod 0600)
cd /opt/trizempire/trizempire
node scripts/hash-password.js > /tmp/h.txt   # type the admin password
# create .env with TRIZ_ADMIN_PASSWORD_HASH from /tmp/h.txt
rm /tmp/h.txt

# 4. Process manager — pick ONE:
#    pm2 (Hostinger tutorials use this):
npm install -g pm2
pm2 start /opt/trizempire/deploy/ecosystem.config.js
pm2 save && pm2 startup      # auto-start on boot
#    …or the systemd unit: see "Install the service" above.

# 5. Writable data dir (systemd sandbox only)
install -d -o trizempire -g trizempire -m 0700 /opt/trizempire/trizempire/data

# 6. TLS reverse proxy: deploy/trizempire-nginx.conf unchanged
#    (nginx + certbot: `apt install nginx certbot python3-certbot-nginx`)

# 7. hPanel → VPS → Security → Firewall: if a firewall policy group is
#    active it defaults to DROP — allow your SSH port, 80 and 443.
```

The cheapest KVM plan (1 vCPU / 4 GB RAM) runs this comfortably; it is a
single zero-dependency process with no database.

### Managed Node.js Web Apps (eligible shared/cloud plans)

Hostinger's dashboard flow (Websites → Create Website → Web App) deploys
from GitHub or ZIP. Point it at this repo with:

- **Project root:** `trizempire/`
- **Start command:** `node server.js`
- **Node version:** 20 or later

Set the same environment variables as any production host
(`TRIZ_ADMIN_PASSWORD_HASH` is mandatory). Their managed proxy terminates
TLS; make sure it forwards `Host` (the CSRF check compares `Origin` against
it) — their Node.js proxy presets do.

### What does NOT work

- **Legacy cPanel shared hosting**: it cannot run a long-lived Node process;
  static-only output would lose the API, auth and proxy entirely.
- **Hostinger Horizons / AI Builder sites**: exported as static websites —
  same problem.

## Environment variables

All configuration is via environment variables. The canonical template is
[`trizempire/.env.example`](trizempire/.env.example) — copy it to `trizempire/.env` and
edit the copy. Placeholder values only — never commit real values.

Loading semantics:

- The server loads `trizempire/.env` at startup (plain `npm start`).
- Variables already set in the operating-system environment **always take
  precedence** over the file — process managers and hosting platforms win.
- `.env` is gitignored; `.env.example` is tracked. Verify with
  `git check-ignore trizempire/.env`.
- There is no `.env` loading during tests: test configuration is injected
  explicitly, so suites stay hermetic.

Startup validation (in `trizempire/lib/config.js`) fails fast with the variable
name — never the value — when:

- `PORT` is not an integer 0–65535, or is `0` while `NODE_ENV=production`
  (ephemeral ports are for tests/CI only; deployments need a fixed port).
- `NODE_ENV` is set to anything other than `development`, `test`, `production`.
- `HOST` is non-loopback without `ALLOW_REMOTE_HOST=true` **and** configured
  authentication (unchanged from earlier releases).
- `NODE_ENV=production` without `TRIZ_ADMIN_PASSWORD_HASH` — **production
  can never start without authentication; there is no default password.**
  (Configuring `SUPABASE_URL` + `SUPABASE_ANON_KEY` also satisfies the
  production authentication requirement.)
- A `TRIZ_*_PASSWORD_HASH` value is not a valid scrypt hash.
- `SUPABASE_URL` without `SUPABASE_ANON_KEY` (or the reverse), or an
  invalid `TRIZ_SUPABASE_ROLE`.
- `HERMES_BASE_URL` / `HERMES_PUBLIC_URL` are not valid http(s) URLs, or
  contain embedded credentials (`user:pass@`) — the proxy has no
  upstream-auth support and URLs are handed to browsers, so secrets must not
  travel in them.
- `TRIZ_SESSION_TTL_MINUTES`, `TRIZ_SESSION_ABS_MINUTES` or
  `HERMES_TIMEOUT_MS` are non-integer or non-positive.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | unset | `production` enables `Secure` session cookies **and requires authentication**. `development`/`test` are recognized; any other value is rejected. |
| `PORT` | `57004` | TCP port (`0` = ephemeral, local/test only; rejected in production). |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback binds require `ALLOW_REMOTE_HOST=true` **and** configured authentication, otherwise the server refuses to start. |
| `ALLOW_REMOTE_HOST` | unset | Explicit opt-in for non-loopback binds. Not authentication. |
| `TRIZ_ADMIN_PASSWORD_HASH` | unset | scrypt hash for the `admin` account (role `admin`). Enabling this turns authentication on; **required in production**. |
| `TRIZ_OPERATOR_PASSWORD_HASH` | unset | scrypt hash for the `operator` account (role `operator`). |
| `SUPABASE_URL` | unset | Supabase **Project URL**. Enables sign-in with a Supabase project user's email + password **alongside** the local scrypt accounts (local credentials always win and are never sent upstream). Must be set together with `SUPABASE_ANON_KEY`; the exchange happens server-side and the Supabase access token never reaches the browser. |
| `SUPABASE_ANON_KEY` | unset | The project's **publishable/anon** key — never the secret/service_role key. Secret: keep it in your private env file. |
| `TRIZ_SUPABASE_ROLE` | `admin` | Role granted to a Supabase sign-in: `admin` or `operator`. |
| `TRIZ_SESSION_TTL_MINUTES` | `480` | Session idle timeout. |
| `TRIZ_SESSION_ABS_MINUTES` | `1440` | Session absolute lifetime. |
| `TRIZ_SESSION_SECRET` | unset | Enables **stateless HMAC-signed sessions** (required on serverless hosts such as Vercel, where function instances share no memory). Sessions then live inside the cookie: the idle timeout is **not** tracked (only the absolute lifetime — keep it short), and a cookie cannot be revoked before expiry (rotating the secret signs everyone out). Generate with `openssl rand -hex 32`. |
| `TRIZ_SECURE_COOKIE` | unset | `true` forces `Secure` cookies without full production mode. |
| `HERMES_BASE_URL` | `http://127.0.0.1:9119` | Server-side upstream for live status. Only the fixed `/api/status` path is ever fetched — it can never become an open proxy. No credentials in the URL. |
| `HERMES_PUBLIC_URL` | `http://127.0.0.1:9119` | URL handed to browsers for the **local-only** embedded console. Set to empty (`HERMES_PUBLIC_URL=`) on remote deployments. No credentials in the URL. |
| `HERMES_TIMEOUT_MS` | `8000` | Per-attempt upstream timeout (one retry on network errors). Sized for the per-profile aggregation endpoints, which take seconds while the messaging gateway is running. |
| `HERMES_SESSION_TOKEN` | unset | Upstream session token for the authenticated per-agent endpoints (`/api/profiles*`). Sent as `X-Hermes-Session-Token`, only to the fixed allowlisted upstream paths, never to browsers. Empty = per-agent crew data disabled (the endpoint reports `unconfigured` and the UI keeps global signals). |
| `TRIZ_WORKSPACES_FILE` | `data/workspaces.json` (under the app directory; `/tmp` on Vercel) | Where the operator's workspace→agent mapping (saved from the cockpit's ＋ ASSIGN panel) is persisted. Relative paths resolve against the app directory. On systemd the app tree is read-only (`ProtectSystem=strict`); the unit's `ReadWritePaths=` opens the default `data/` directory — create it owned by the service user before first start. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | unset | Upstash-compatible Redis REST store for the workspace mapping — **required for durable mapping on serverless hosts** (the lambda filesystem is read-only). The `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` pair works too. Both halves must be set together; when configured, KV takes precedence over the file store. |
| `TRIZ_TRUST_PROXY` | unset (`true` automatically when `VERCEL=1`) | Trust `X-Real-IP`/`X-Forwarded-For` for rate-limit bucketing. Enable only behind a reverse proxy **you** control — on a directly-exposed server it lets clients spoof their IP. |

### Creating password hashes

```sh
cd trizempire
node scripts/hash-password.js      # reads the password from stdin, prints the hash
# put the printed value in trizempire/.env:
#   TRIZ_ADMIN_PASSWORD_HASH='scrypt$16384$8$1$…'
```

Keep the hash out of Git: it lives only in your private `.env` (gitignored)
or your hosting platform's secret store. Never paste it into a chat, issue,
or log.

No default credentials exist. If no hashes are configured, the server runs in
**loopback-only local mode** without login and says so at startup — but
`NODE_ENV=production` refuses to start in that state.

### Configuring variables on a hosting platform

The app reads the operating-system environment, so any platform works:

- **systemd**: put values in an `EnvironmentFile=` path pointing at a root-
  owned copy of your `.env` (mode `0600`), or individual `Environment=` lines.
- **Docker**: pass `-e`/`--env-file` flags or orchestrator secrets; do not
  bake `.env` into images (it is gitignored, keep it that way in build
  contexts too).
- **PaaS (Render, Railway, Fly.io, …)**: set the variables in the dashboard's
  secrets/env UI; do not upload `.env` as a file.
- In every case set `NODE_ENV=production`, a fixed `PORT` (match the
  platform's expected port), and `TRIZ_ADMIN_PASSWORD_HASH`.

### Starting and stopping

```sh
cd trizempire
npm start        # foreground; Ctrl+C stops the server

# on a Linux host with the deployment bundle installed:
sudo systemctl {start|stop|restart|status} trizempire
journalctl -u trizempire -f
```

There is no database and no background daemon: stopping the process is a
clean stop, and sessions/rate-limit state reset on restart. For unattended
runs use your platform's process manager — [`deploy/trizempire.service`](deploy/trizempire.service)
for systemd, or a container restart policy — rather than a shell background
job.

## HTTPS and reverse proxy

Terminate TLS in your reverse proxy and forward to the app on loopback.
The proxy should also set/forward `Host` correctly: CSRF protection compares
the `Origin`/`Referer` header against the request `Host`.

A complete, tested-by-CI nginx configuration ships as
[`deploy/trizempire-nginx.conf`](deploy/trizempire-nginx.conf) (install steps
above). The minimal shape any other proxy (Caddy, Traefik, …) must match:

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

### Per-agent crew states (authenticated upstream)

`GET /api/hermes/agents` returns **facts** for every Hermes profile — session
count, active-session count, and the age of the most recent activity — and the
Crew view derives working/idle/ready from those numbers instead of the global
`active_agents` counter:

```
browser ── same-origin ──▶ TrizEmpire /api/hermes/agents
                              │  X-Hermes-Session-Token (server-side only)
                              ├──▶ Hermes /api/profiles          (per-profile facts)
                              └──▶ Hermes /api/profiles/sessions (is_active, 300s window)
```

Hermes keeps `/api/profiles*` off its public path list (only `/api/status` and
`/api/health` are credential-free), so both sides need the same token:

```sh
# 1. On the Hermes machine, pin the dashboard session token:
HERMES_DASHBOARD_SESSION_TOKEN='generate-a-long-random-value' hermes dashboard
# 2. Repeat that exact value in trizempire/.env:
#    HERMES_SESSION_TOKEN=generate-a-long-random-value
# 3. Restart TrizEmpire and reload the Crew view.
```

Notes and limits — all reported honestly by the endpoint rather than hidden:

- The `active` flag is **Hermes' own** 300-second `is_active` stamp on each
  session; TrizEmpire does not re-invent the window (`activeWindowSec` is
  returned so the UI can label it).
- `state: 'unconfigured'` (HTTP 503) — `HERMES_SESSION_TOKEN` is empty; the
  server does not probe the upstream at all.
- `state: 'unauthorized'` (HTTP 502) — the upstream rejected the token
  (wrong/expired value, or an **OAuth-gated** dashboard, which only accepts
  cookie logins this server does not perform). This is reported separately
  from `disconnected`: it is a credential problem, not a connectivity one.
- Without per-agent data the Crew view keeps the global derivation from
  `/api/status` — no per-agent activity is ever fabricated.
- The token is validated at startup (no line breaks, ≤ 512 chars) and errors
  name the variable without echoing the value.

### Per-profile memory and messaging channels (cockpit workspaces)

The cockpit's ISOLATED WORKSPACES cards drill into a per-agent view driven by
two more authenticated, profile-scoped proxies — same token, same gates and
same fixed-path discipline as `/api/hermes/agents`:

```
GET /api/hermes/memory?profile=NAME     → Hermes /api/memory?profile=NAME
                                           (active provider, MEMORY.md / USER.md sizes)
GET /api/hermes/messaging?profile=NAME  → Hermes /api/messaging/platforms?profile=NAME
                                           (per-channel state — backs "own telegram bot")
```

- `NAME` is validated (`[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`) and only ever sent
  as a query parameter on those fixed paths — a bad or missing profile is a
  local HTTP 400 and the upstream is never probed.
- Every failure mode matches the agents route: `503 unconfigured` without the
  token, `502 unauthorized` when Hermes rejects it, `504` for timeout/bad
  responses, authentication and rate limiting in front.
- The proxy stays **read-only**: starting or stopping a profile's messaging
  gateway happens inside the Hermes console, never through TrizEmpire.
- Workspace→profile membership ships as defaults in `trizempire/crew/crew-model.js`
  (`WORKSPACES` — Client starts empty) and is **operator-overridable**: the
  cockpit's ＋ ASSIGN panel PUTs the mapping to `/api/workspaces`, which
  validates it (known workspace ids, one home per profile) and persists it to
  `TRIZ_WORKSPACES_FILE`. A corrupt or invalid stored file is reported by
  `GET /api/workspaces` and the shipped defaults apply instead. A profile in
  no workspace simply has no card and stays reachable through the Crew view.

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
- The only file the server writes is the workspace→agent mapping
  (`TRIZ_WORKSPACES_FILE`, default `data/workspaces.json` — profile names
  only, no secrets). Include it in backups if you want to keep an operator's
  assignment across rebuilds; losing it just restores the shipped defaults.
- Recovery = redeploy the repository at the desired revision and restart.
- Back up your environment configuration (hashed passwords, URLs) in your
  secret manager — it is the only other persistent state.

## Rollback

```sh
git revert <bad-commit>   # or check out the previous known-good tag
cd trizempire && npm run check && npm test && npm start
```

## Credential rotation and configuration mistakes

- **Rotate a password**: run `node scripts/hash-password.js`, replace the
  hash in `.env` (or the platform secret store), restart. In-flight sessions
  survive until idle/absolute expiry; to cut them off immediately, restart the
  process (session state is in-memory) — or temporarily set
  `TRIZ_SESSION_TTL_MINUTES=1` and restart twice.
- **A secret was committed**: rotate it first (a scrypt hash in Git still
  shouldn't stay there — generate a new password). Then remove it from
  history with `git filter-repo` and force-push only if you accept the
  history rewrite; otherwise treat it as burned. GitHub-secret scanning and
  the repo's Gitleaks CI help catch the next one.
- **A secret leaked in a log or screenshot**: rotate the corresponding
  credential. The server's own logs never contain hashes, passwords, cookies
  or query strings — startup errors name the *variable*, never the value —
  so leaks come from the surrounding tooling, not the app.
- **Bad configuration at startup**: the server exits non-zero with a message
  naming the offending variable (for example a typo'd `NODE_ENV` or a
  malformed URL). Fix the variable and restart; nothing was written to disk.
- **Test a production config locally** without exposing anything:
  `NODE_ENV=production TRIZ_ADMIN_PASSWORD_HASH='scrypt$…' npm start` still
  binds loopback unless `ALLOW_REMOTE_HOST=true` is also set.

## CI

`.github/workflows/trizempire-checks.yml` runs Gitleaks secret scanning plus
syntax checks and the full test suite on Node.js 20, 22 and 24 for every push
to `main` and every pull request.

## Known limitations

- **Implemented and verified:** static delivery with CSP/security headers,
  scrypt+session authentication, CSRF, login rate limiting (in-memory),
  server-side Hermes status proxy with normalized states, health endpoints,
  startup environment validation with secret-safe errors, the full UI
  (cockpit, crew command center, 3D Agent City, local console embed), 119
  automated tests including the deployment-bundle checks (systemd, nginx,
  pm2), the Vercel serverless entry/config checks and a real-Hermes
  integration test that skips when Hermes is not running.
- **Partially implemented:** per-agent working/idle coloring uses real
  per-profile session data **when** `HERMES_SESSION_TOKEN` is configured (see
  [Per-agent crew states](#per-agent-crew-states-authenticated-upstream));
  without it — or behind an OAuth-gated Hermes dashboard, which only accepts
  cookie logins — the UI falls back to the global backend signals
  (`gateway_running`, `active_agents`) and says so. Rate limiting and
  sessions are per-process (not shared across replicas).
  The systemd unit, pm2 file and nginx snippet are committed as a bundle but
  are validated structurally by tests, not by `systemd-analyze
  verify`/`nginx -t` in CI — run both on the target host as shown above.
  On Vercel, login rate limiting and sessions are per-instance (see
  [Vercel (serverless)](#vercel-serverless)); Hermes telemetry needs a
  publicly reachable `HERMES_BASE_URL`.
- **Planned / blocked:** persistent
  audit storage, multi-user administration UI, real per-agent activity data
  (needs authenticated Hermes access), and the placeholder nav modules
  (Voice, Hand, Chat, Missions, Docs, Schedule, Health, Files, Terminal,
  Integrations, Guide, Settings) which are clearly labeled and inert.
