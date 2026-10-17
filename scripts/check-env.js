'use strict';

/* Pre-deploy environment check for the Vercel deployment.
 *
 * Run by Vercel as the build command (vercel.json → buildCommand), and
 * manually as a local preflight:
 *
 *   node scripts/check-env.js                    # validate the build env
 *   node scripts/check-env.js .env.vercel        # validate a pulled env file
 *       (vercel env pull .env.vercel --environment=production)
 *
 * What it does — and why this shape:
 *   - It boots the REAL serverless entry (api/index.js) in a child process
 *     with the environment under check and probes /healthz through the
 *     actual handler. That is the same code path a deployed request takes,
 *     so "boots clean here" and "works when live" cannot drift apart. A
 *     plain resolveConfig() call could pass while the entry still fails.
 *   - NODE_ENV=production and VERCEL=1 are forced: they model the platform
 *     at runtime regardless of what the build sandbox or a local shell has.
 *   - One rule the server deliberately does not enforce (stateful sessions
 *     are legal config) is enforced HERE because this file exists only for
 *     Vercel: TRIZ_SESSION_SECRET is required — instances share no memory,
 *     so login cookies minted by one instance are rejected by another.
 *   - File mode validates ONLY the file plus a minimal set of OS variables;
 *     ambient TRIZ_* variables in the calling shell can neither rescue nor
 *     break the check.
 *   - Every value from the checked environment (length ≥ 6) is redacted
 *     from all output. Config errors are designed to name variables without
 *     echoing values, but this guarantees it even if a future message slips.
 *
 * Exit codes: 0 = the deployment env boots clean; 1 = the environment is
 * invalid (deploy must not go live); 2 = the check itself could not run
 * (treated as failure — an unvalidatable environment must not ship).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'api', 'index.js');
const { loadEnvFile } = require(path.join(REPO_ROOT, 'trizempire', 'lib', 'config'));

/* Only these OS-level keys cross from the calling environment into file
 * mode; everything else must come from the file itself. */
const SYSTEM_KEYS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG',
];

/* Probe the handler exactly the way the platform test does. The answer is
 * written with fs.writeSync + explicit exit so it can never be truncated
 * or held open by background timers inside the server. */
const BOOT_PROBE = `
  const fs = require('node:fs');
  const finish = payload => {
    fs.writeSync(1, 'RESULT:' + JSON.stringify(payload) + '\\n');
    process.exit(0);
  };
  let handler;
  try { handler = require(${JSON.stringify(ENTRY)}); }
  catch (e) { finish({ threw: String((e && e.message) || e) }); }
  const headers = {};
  const chunks = [];
  const res = {
    statusCode: 0,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return headers[String(k).toLowerCase()]; },
    removeHeader(k) { delete headers[String(k).toLowerCase()]; },
    writeHead(code) { this.statusCode = code; return this; },
    write(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); return true; },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      finish({ status: this.statusCode, body: chunks.join('') });
    },
    on() { return this; }, once() { return this; }, emit() { return false; },
    flushHeaders() {}, setEncoding() {}, cork() {}, uncork() {}, destroy() {},
  };
  try { handler({ url: '/healthz', method: 'GET', headers: {} }, res); }
  catch (e) { finish({ threw: String((e && e.message) || e) }); }
  setTimeout(() => finish({ timeout: true }), 20000);
`;

function fail(message, code = 1) {
  console.error(`check-env: ${message}`);
  process.exit(code);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('usage: node scripts/check-env.js [env-file]\n'
      + '  no argument : validate the current environment (the Vercel build step does this)\n'
      + '  env-file    : validate a `vercel env pull` file (nothing from this shell leaks in)');
    return;
  }
  if (args.length > 1) fail('at most one argument (the env file to check)', 2);

  /* ── build the environment under check ─────────────────────────────── */
  let env;
  if (args.length === 1) {
    const file = path.resolve(args[0]);
    if (!fs.existsSync(file)) fail(`env file not found: ${file}`, 2);
    env = {};
    for (const key of SYSTEM_KEYS) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    try {
      loadEnvFile(file, env);
    } catch (e) {
      fail(`cannot read env file: ${String((e && e.message) || e)}`, 2);
    }
  } else {
    env = {};
    for (const [k, v] of Object.entries(process.env)) env[k] = v;
  }
  /* The platform's own runtime contract, forced. */
  env.NODE_ENV = 'production';
  env.VERCEL = '1';

  /* Redaction set: values the checked environment supplied (never OS
     plumbing, never the forced keys — their names appear in messages). */
  const secrets = new Set();
  for (const [k, v] of Object.entries(env)) {
    if (k === 'NODE_ENV' || k === 'VERCEL' || SYSTEM_KEYS.includes(k)) continue;
    if (typeof v === 'string' && v.length >= 6) secrets.add(v);
  }
  const redact = text => {
    let out = String(text || '');
    for (const secret of secrets) out = out.split(secret).join('***');
    return out;
  };

  /* ── the rule Vercel requires that the server alone does not ───────── */
  if (!env.TRIZ_SESSION_SECRET) {
    fail(redact('TRIZ_SESSION_SECRET is not set. Required on Vercel: instances share no\n'
      + 'memory, so stateful session cookies are rejected by every other instance.\n'
      + 'Generate one with: openssl rand -hex 32'));
  }

  /* ── boot the real entry with this environment ─────────────────────── */
  const run = spawnSync(process.execPath, ['-e', BOOT_PROBE], {
    env,
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  if (run.error) {
    fail(`the boot probe itself failed (${run.error.code || run.error.message}); `
      + 'the environment was NOT validated.', 2);
  }
  const line = (out.split(/\r?\n/).find(l => l.startsWith('RESULT:')) || '').slice(7);
  if (!line) {
    const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
    fail(`the boot probe produced no verdict. Output tail:\n${redact(tail)}\n`
      + 'the environment was NOT validated.', 2);
  }
  let verdict;
  try {
    verdict = JSON.parse(line);
  } catch {
    fail(`unparseable probe verdict: ${redact(line)}`, 2);
  }
  if (verdict.threw) fail(redact(`the serverless entry failed to load: ${verdict.threw}`));
  if (verdict.timeout) fail('the serverless entry did not answer within 20s under NODE_ENV=production.', 2);
  if (verdict.status === 500) {
    /* The entry's in-band boot failure: body names the offending variable. */
    fail(redact(`the deployment would boot into a 500.\n${(verdict.body || '').trim()}`));
  }
  if (verdict.status !== 200) {
    fail(`unexpected answer from /healthz: HTTP ${verdict.status}\n${redact(verdict.body || '')}`, 2);
  }

  const present = ['TRIZ_ADMIN_PASSWORD_HASH', 'TRIZ_SESSION_SECRET']
    .filter(k => env[k]);
  console.log('check-env: preflight ok — the serverless entry boots clean with '
    + 'NODE_ENV=production and answers /healthz.');
  console.log(`check-env: ${Object.keys(env).length} variables checked; `
    + `${present.length}/2 required present (${present.join(', ') || 'none'}).`);
}

main();
