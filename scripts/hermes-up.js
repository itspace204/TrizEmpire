'use strict';

/* One command that brings the whole remote-Hermes chain online:
 *
 *   hermes dashboard                 loopback 127.0.0.1:9119
 *   scripts/hermes-public-proxy.js   loopback 127.0.0.1:9219 (token required)
 *   cloudflared quick tunnel         https://<random>.trycloudflare.com
 *   Vercel HERMES_BASE_URL           rewritten to the live tunnel URL + redeploy
 *
 * Usage:
 *   node scripts/hermes-up.js [--no-vercel] [--no-deploy] [--help]
 *
 * Flags:
 *   --no-vercel   local chain only; never touch the Vercel environment.
 *   --no-deploy   rewrite HERMES_BASE_URL but skip `vercel --prod`
 *                 (Vercel applies environment changes only to new deployments).
 *
 * Each hop is verified before the next starts: the dashboard must answer
 * /api/status, the proxy must 401 without the token and 200 with it, the
 * public tunnel must do the same, and Vercel's stored HERMES_BASE_URL is
 * compared with the live tunnel URL (pulled to an ignored temp file, parsed,
 * deleted). Only a real difference triggers a rewrite plus redeploy, so a
 * rerun with everything healthy is a no-op.
 *
 * The session token is read from the environment or trizempire/.env and is
 * never printed and never written to disk. State/logs live under data/
 * (gitignored): data/hermes-gateway.json, data/hermes-gateway.log.
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(REPO_ROOT, 'data');
const STATE_FILE = path.join(STATE_DIR, 'hermes-gateway.json');
const LOG_FILE = path.join(STATE_DIR, 'hermes-gateway.log');
const ENV_FILE = path.join(REPO_ROOT, 'trizempire', '.env');
const PROXY_SCRIPT = path.join(__dirname, 'hermes-public-proxy.js');
const DASHBOARD = { host: '127.0.0.1', port: 9119 };
const PROXY = { host: '127.0.0.1', port: 9219 };
const ENV_KEY = 'HERMES_BASE_URL';
/* Quick-tunnel hostnames are always hyphenated (eva-alternatives-machines-memo…);
 * a bare api.trycloudflare.com appearing inside a cloudflared ERROR line must
 * never be mistaken for our tunnel URL. The 401/200 check is the real gate. */
const TUNNEL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;

const say = msg => console.log(`[hermes-up] ${msg}`);
function fail(msg) {
  console.error(`[hermes-up] ${msg}`);
  process.exit(1);
}

/* ── flags ─────────────────────────────────────────────────────────────── */
const flags = { vercel: true, deploy: true };
function printHelp() {
  console.log(`Usage: node scripts/hermes-up.js [--no-vercel] [--no-deploy]

Starts (or reuses) the Hermes dashboard on loopback :9119, the authenticated
public proxy on loopback :9219 and a Cloudflare quick tunnel, verifies the
public chain (401 without the session token, 200 with it), then points
Vercel's ${ENV_KEY} at the live tunnel URL and redeploys so it applies.

  --no-vercel   skip everything Vercel (local chain only)
  --no-deploy   update ${ENV_KEY} but do not run \`vercel --prod\`
  --help        this text`);
}
for (const arg of process.argv.slice(2)) {
  if (arg === '--no-vercel') flags.vercel = false;
  else if (arg === '--no-deploy') flags.deploy = false;
  else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  else { printHelp(); fail(`unknown flag: ${arg}`); }
}

/* ── token (never printed) ─────────────────────────────────────────────── */
function readToken() {
  let token = (process.env.HERMES_SESSION_TOKEN || '').trim();
  if (!token && fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^HERMES_SESSION_TOKEN=(.*)$/.exec(line.trim());
      if (m) {
        token = m[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
        break;
      }
    }
  }
  if (!token) {
    fail('HERMES_SESSION_TOKEN is missing — set it in trizempire/.env (the same value the dashboard was started with).');
  }
  if (/[\r\n]/.test(token) || token.length > 512) {
    fail('HERMES_SESSION_TOKEN is malformed (line breaks or > 512 chars) — fix it in trizempire/.env.');
  }
  return token;
}

/* ── tiny HTTP probe ───────────────────────────────────────────────────── */
function probe(url, token) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const mod = url.startsWith('https:') ? https : http;
    let req;
    try {
      req = mod.get(url, { headers: token ? { 'x-hermes-session-token': token } : {} }, res => {
        res.resume();
        done({ ok: true, status: res.statusCode });
      });
    } catch (err) {
      done({ ok: false, error: err.message });
      return;
    }
    req.setTimeout(5000, () => req.destroy(new Error('probe timeout')));
    req.on('error', err => done({ ok: false, error: err.message }));
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeoutMs, intervalMs = 750) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/* ── process plumbing ──────────────────────────────────────────────────── */
let logFd = null;
function openLog() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  logFd = fs.openSync(LOG_FILE, 'a');
}
const logOffset = () => fs.fstatSync(logFd).size;
function logTail(offset) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8').slice(offset).trim();
    return text ? text.split(/\r?\n/).slice(-15).join('\n') : '(log is empty)';
  } catch {
    return '(log unavailable)';
  }
}
const cmdQuote = arg => `"${String(arg).replace(/"/g, '')}"`;

function spawnDetached(file, args, extraEnv) {
  const opts = {
    cwd: REPO_ROOT,
    env: { ...process.env, ...(extraEnv || {}) },
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  };
  let child;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    // .cmd/.bat shims need a shell; quote every token for cmd.exe.
    child = spawn([file, ...args].map(cmdQuote).join(' '), { ...opts, shell: true });
  } else {
    child = spawn(file, args, opts);
  }
  child.on('error', err => console.error(`[hermes-up] failed to start ${file}: ${err.message}`));
  child.unref();
  return child;
}

function findOnPath(name) {
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
}
function findHermes() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const local = path.join(process.env.LOCALAPPDATA, 'hermes', 'bin', 'hermes.exe');
    if (fs.existsSync(local)) return local;
  }
  return findOnPath('hermes');
}
function findCloudflared() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const local = path.join(process.env.LOCALAPPDATA, 'cloudflared', 'cloudflared.exe');
    if (fs.existsSync(local)) return local;
  }
  return findOnPath('cloudflared');
}

/* ── hop 1: the dashboard ──────────────────────────────────────────────── */
async function ensureDashboard() {
  const statusUrl = `http://${DASHBOARD.host}:${DASHBOARD.port}/api/status`;
  const running = await probe(statusUrl);
  if (running.ok && running.status === 200) {
    say(`dashboard already running on ${DASHBOARD.host}:${DASHBOARD.port}`);
    return 'reused';
  }
  const bin = findHermes();
  if (!bin) {
    fail('the `hermes` executable is not on PATH (expected e.g. %LOCALAPPDATA%\\hermes\\bin\\hermes.exe).');
  }
  say('starting `hermes dashboard` …');
  const offset = logOffset();
  spawnDetached(bin, ['dashboard']);
  const up = await until(async () => {
    const p = await probe(statusUrl);
    return p.ok && p.status === 200;
  }, 60000, 1000);
  if (!up) {
    fail(`dashboard did not answer on ${DASHBOARD.host}:${DASHBOARD.port} within 60s — recent log:\n${logTail(offset)}`);
  }
  say(`dashboard up on ${DASHBOARD.host}:${DASHBOARD.port}`);
  return 'started';
}

/* ── hop 2: the authenticated public proxy ─────────────────────────────── */
async function ensureProxy(token) {
  const base = `http://${PROXY.host}:${PROXY.port}`;
  const open = await probe(`${base}/api/status`);
  if (open.ok && open.status === 200) {
    fail(`port ${PROXY.port} is serving something that answered WITHOUT a token — it is not this proxy. Free the port and rerun.`);
  }
  if (open.ok && open.status !== 401) {
    fail(`port ${PROXY.port} answered HTTP ${open.status} without a token — refusing to treat it as the Hermes proxy.`);
  }
  const started = !open.ok;
  if (started) {
    say('starting scripts/hermes-public-proxy.js …');
    spawnDetached(process.execPath, [PROXY_SCRIPT], { HERMES_SESSION_TOKEN: token });
  } else {
    say(`proxy already listening on ${PROXY.host}:${PROXY.port}`);
  }
  const ready = await until(async () => {
    const p = await probe(`${base}/api/status`, token);
    return p.ok && p.status === 200;
  }, 20000, 750);
  if (!ready) {
    const last = await probe(`${base}/api/status`, token);
    if (last.ok && last.status === 401) {
      fail('the proxy rejected HERMES_SESSION_TOKEN — the value in trizempire/.env does not match the token the running proxy/dashboard pair expects. Stop the stale proxy and rerun.');
    }
    fail(`proxy did not become ready within 20s (${last.ok ? `HTTP ${last.status}` : last.error}).`);
  }
  say('proxy verified: 401 without the token, 200 with it');
  return started ? 'started' : 'reused';
}

/* ── hop 3: the public tunnel ──────────────────────────────────────────── */
async function verifyTunnel(url, token) {
  const without = await probe(`${url}/api/status`);
  if (!without.ok || without.status !== 401) return false;
  const withToken = await probe(`${url}/api/status`, token);
  return withToken.ok && withToken.status === 200;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function ensureTunnel(token) {
  const state = readState();
  if (state.tunnelUrl) {
    say(`checking the previous tunnel ${state.tunnelUrl} …`);
    // Retried: one failed probe must not condemn a healthy tunnel (DNS hiccups
    // happen; a lone transient failure would spawn needless duplicate tunnels).
    const alive = await until(() => verifyTunnel(state.tunnelUrl, token), 15000, 2500);
    if (alive) {
      say(`reusing live tunnel ${state.tunnelUrl}`);
      return { url: state.tunnelUrl, started: false };
    }
    say('previous tunnel is no longer answering — starting a fresh one');
  }
  const cloudflared = findCloudflared();
  if (!cloudflared) {
    fail('cloudflared was not found — install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or add it to PATH.');
  }
  say('starting a Cloudflare quick tunnel …');
  const offset = logOffset();
  const cf = spawnDetached(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://${PROXY.host}:${PROXY.port}`]);
  let dead = false;
  cf.on('exit', () => { dead = true; });
  cf.on('error', () => { dead = true; });
  const url = await until(() => {
    if (dead) return 'exited';
    const text = fs.readFileSync(LOG_FILE, 'utf8').slice(offset);
    const m = TUNNEL_RE.exec(text);
    return m ? m[0] : null;
  }, 60000, 750);
  if (url === 'exited') {
    fail(`cloudflared exited before printing a URL (often a DNS failure — check the network and rerun) — recent log:\n${logTail(offset)}`);
  }
  if (!url) {
    fail(`cloudflared printed no URL within 60s — recent log:\n${logTail(offset)}`);
  }
  say(`tunnel up: ${url}`);
  const verified = await until(() => verifyTunnel(url, token), 30000, 1500);
  if (!verified) {
    fail(`the public chain never passed its security check (401 without token / 200 with it) — recent log:\n${logTail(offset)}`);
  }
  say('public chain verified: 401 without the token, 200 with it');
  return { url, started: true };
}

/* ── hop 4: publish the URL to Vercel ──────────────────────────────────── */
function vercelOnce(argv) {
  const opts = {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    input: '', // EOF on stdin: an unexpected prompt must fail, not hang
    timeout: 10 * 60 * 1000,
  };
  if (process.platform === 'win32') {
    // The Windows shim is vercel.cmd, which spawn() may not run directly.
    const line = ['vercel', ...argv].map(cmdQuote).join(' ');
    return spawnSync(line, { ...opts, shell: true });
  }
  return spawnSync('vercel', argv, opts);
}

/* Vercel's API occasionally answers `fetch failed`. pull/add are idempotent
 * and safe to retry; the deploy is not retried here (a second attempt would
 * just create another deployment) — it is left to the operator's rerun. */
const RETRYABLE = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|rate limit|too many requests/i;
function vercelRun(argv, retries = 0) {
  let res = vercelOnce(argv);
  for (let attempt = 1; attempt <= retries && res.status !== 0; attempt += 1) {
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!RETRYABLE.test(out)) break;
    say(`vercel ${argv.slice(0, 2).join(' ')} hit a transient error — retry ${attempt}/${retries} …`);
    res = vercelOnce(argv);
  }
  return res;
}
function vercelLastLines(res, n = 8) {
  const text = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  return text ? text.split(/\r?\n/).slice(-n).join('\n') : '(no output)';
}

function pullVercelUrl() {
  const tmp = path.join(STATE_DIR, `.env-pull-${process.pid}`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    fs.rmSync(tmp, { force: true });
    const res = vercelRun(['env', 'pull', tmp, '--environment=production', '--yes'], 2);
    if (res.status !== 0) return { error: vercelLastLines(res) };
    const body = fs.readFileSync(tmp, 'utf8');
    const m = new RegExp(`^${ENV_KEY}=(.*)$`, 'm').exec(body);
    if (!m) return { url: '' };
    const value = m[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    return { url: value };
  } catch (err) {
    return { error: err.message };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function ensureVercel(tunnelUrl) {
  if (!flags.vercel) {
    say('--no-vercel: skipping the Vercel environment');
    return 'skipped';
  }
  say('comparing Vercel’s HERMES_BASE_URL with the live tunnel URL …');
  const current = pullVercelUrl();
  if (current.error) {
    fail(`could not pull the Vercel environment (${current.error}) — run inside the linked repo (vercel link) or use --no-vercel.`);
  }
  if (current.url === tunnelUrl) {
    say('Vercel already points at this tunnel URL');
    saveState({ publishedUrl: tunnelUrl });
    return 'up-to-date';
  }
  say(current.url
    ? `publishing new URL: ${current.url} → ${tunnelUrl}`
    : `HERMES_BASE_URL is unset or unreadable — publishing ${tunnelUrl}`);
  /* --type config on purpose: a quick-tunnel URL is a public random hostname,
   * not a secret, and the verification above REQUIRES reading the value back
   * (`vercel env pull` refuses Secret-typed variables — it would return a
   * placeholder and every publish would look like a failure). */
  const add = vercelRun(['env', 'add', ENV_KEY, 'production', '--value', tunnelUrl, '--type', 'config', '--force', '--yes'], 2);
  if (add.status !== 0) {
    fail(`vercel env add failed:\n${vercelLastLines(add)}`);
  }
  const after = pullVercelUrl();
  if (after.url !== tunnelUrl) {
    fail(`Vercel did not store the new ${ENV_KEY} (re-pull says ${after.url || 'unset'}).`);
  }
  say(`${ENV_KEY} updated in production`);
  if (!flags.deploy) {
    say('--no-deploy: run `vercel --prod` to apply it (environment changes affect new deployments only)');
    saveState({ publishedUrl: tunnelUrl });
    return 'updated';
  }
  say('redeploying production so the new URL applies (the preflight runs again) …');
  const deploy = vercelRun(['--prod', '--yes']);
  if (deploy.status !== 0) {
    fail(`vercel --prod failed (the environment is already updated — rerun \`vercel --prod\`):\n${vercelLastLines(deploy)}`);
  }
  say('production deployment succeeded');
  saveState({ publishedUrl: tunnelUrl });
  return 'updated+deployed';
}

/* ── main ──────────────────────────────────────────────────────────────── */
(async () => {
  const token = readToken();
  openLog();
  const dashboard = await ensureDashboard();
  const proxy = await ensureProxy(token);
  const tunnel = await ensureTunnel(token);
  saveState({ tunnelUrl: tunnel.url });
  const vercel = await ensureVercel(tunnel.url);
  say('done.');
  console.log(`  dashboard  ${dashboard}  (${DASHBOARD.host}:${DASHBOARD.port})`);
  console.log(`  proxy      ${proxy}  (${PROXY.host}:${PROXY.port}, session token required on every request)`);
  console.log(`  tunnel     ${tunnel.started ? 'started' : 'reused'}  ${tunnel.url}`);
  console.log(`  vercel     ${vercel}${flags.vercel && vercel !== 'skipped' && vercel !== 'up-to-date' && !flags.deploy ? ' (redeploy pending: `vercel --prod`)' : ''}`);
  console.log(`  log/state  data/hermes-gateway.log · data/hermes-gateway.json`);
  console.log('  After a reboot the tunnel URL changes: run this command again and it republishes automatically.');
})().catch(err => fail(err && err.stack ? err.stack : String(err)));
