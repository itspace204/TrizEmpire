'use strict';

/* Environment-configuration tests: startup validation, secret hygiene,
 * .env loading semantics, and Git ignore rules. All credentials here are
 * fake test values generated on the fly — never real secrets. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadEnvFile, resolveConfig } = require('../lib/config');
const { hashPassword } = require('../lib/auth');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENV_EXAMPLE = path.resolve(__dirname, '..', '.env.example');

/* ── required production configuration ────────────────────────────────── */

test('production configuration without authentication is rejected', () => {
  assert.throws(
    () => resolveConfig({}, { NODE_ENV: 'production', PORT: '57004' }),
    err => {
      assert.match(err.message, /TRIZ_ADMIN_PASSWORD_HASH/);
      assert.match(err.message, /no default password/i);
      return true;
    },
  );
});

test('production configuration with a valid hash and fixed port is accepted', () => {
  const fakeHash = hashPassword('test-only password for config tests');
  const cfg = resolveConfig({}, {
    NODE_ENV: 'production',
    PORT: '57004',
    TRIZ_ADMIN_PASSWORD_HASH: fakeHash,
  });
  assert.equal(cfg.authRequired, true);
  assert.equal(cfg.secureCookies, true);
  assert.equal(cfg.port, 57004);
  assert.equal(cfg.users.length, 1);
  assert.equal(cfg.users[0].username, 'admin');
});

/* ── invalid configuration is rejected safely ─────────────────────────── */

test('invalid values are rejected with messages that name the variable', () => {
  const cases = [
    [{ PORT: 'not-a-port' }, /PORT/],
    [{ PORT: '70000' }, /PORT/],
    [{ PORT: '0.5' }, /PORT/],
    [{ NODE_ENV: 'staging' }, /NODE_ENV/],
    [{ TRIZ_SESSION_TTL_MINUTES: 'abc' }, /TRIZ_SESSION_TTL_MINUTES/],
    [{ TRIZ_SESSION_ABS_MINUTES: '-5' }, /TRIZ_SESSION_ABS_MINUTES/],
    [{ HERMES_BASE_URL: 'not a url' }, /HERMES_BASE_URL/],
    [{ HERMES_BASE_URL: 'ftp://example.com' }, /HERMES_BASE_URL/],
    [{ HERMES_PUBLIC_URL: 'javascript:alert(1)' }, /HERMES_PUBLIC_URL/],
    [{ HERMES_TIMEOUT_MS: 'soon' }, /HERMES_TIMEOUT_MS/],
    [{ HERMES_TIMEOUT_MS: '0' }, /HERMES_TIMEOUT_MS/],
    [{ HERMES_SESSION_TOKEN: 'line\nbreak' }, /HERMES_SESSION_TOKEN/],
    [{ HERMES_SESSION_TOKEN: 'x'.repeat(513) }, /HERMES_SESSION_TOKEN/],
    [{ TRIZ_ADMIN_PASSWORD_HASH: 'plainly-not-scrypt' }, /TRIZ_ADMIN_PASSWORD_HASH/],
  ];
  for (const [env, pattern] of cases) {
    assert.throws(() => resolveConfig({}, env), pattern,
      `expected rejection for ${Object.keys(env)[0]}`);
  }
});

test('HERMES_SESSION_TOKEN is accepted when clean and never echoed in errors', () => {
  const secret = 'test-only-upstream-token-value';
  // Unconfigured by default: the endpoint reports "unconfigured", not a guess.
  assert.equal(resolveConfig({}, {}).hermesSessionToken, '');
  assert.equal(resolveConfig({}, { HERMES_SESSION_TOKEN: secret }).hermesSessionToken, secret);
  assert.equal(resolveConfig({ hermesSessionToken: secret }, {}).hermesSessionToken, secret);
  // A header-injection attempt names the variable and leaks nothing of the value.
  assert.throws(
    () => resolveConfig({}, { HERMES_SESSION_TOKEN: `${secret}\r\nX-Injected: 1` }),
    err => {
      assert.match(err.message, /HERMES_SESSION_TOKEN/);
      assert.ok(!err.message.includes(secret), 'the error must not echo the token');
      assert.ok(!err.message.includes('X-Injected'), 'the error must not echo the payload');
      return true;
    },
  );
});

test('PORT=0 (ephemeral) is rejected in production but allowed locally', () => {
  const fakeHash = hashPassword('test-only password for config tests');
  assert.throws(
    () => resolveConfig({}, { NODE_ENV: 'production', PORT: '0', TRIZ_ADMIN_PASSWORD_HASH: fakeHash }),
    /PORT=0/,
  );
  // Local/test behavior preserved: ephemeral port stays available.
  const cfg = resolveConfig({}, { PORT: '0' });
  assert.equal(cfg.port, 0);
  assert.equal(cfg.authRequired, false);
});

test('non-loopback binds still require the explicit opt-in and authentication', () => {
  assert.throws(() => resolveConfig({}, { HOST: '0.0.0.0' }), /ALLOW_REMOTE_HOST/);
  assert.throws(
    () => resolveConfig({}, { HOST: '0.0.0.0', ALLOW_REMOTE_HOST: 'true' }),
    /authentication/i,
  );
  const fakeHash = hashPassword('test-only password for config tests');
  const cfg = resolveConfig({}, { HOST: '0.0.0.0', ALLOW_REMOTE_HOST: 'true', TRIZ_ADMIN_PASSWORD_HASH: fakeHash });
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.authRequired, true);
});

/* ── secrets never appear in error messages ───────────────────────────── */

test('error messages never echo secret values', () => {
  const secretHash = 'scrypt$bad$format$SECRETPART1234567890';
  try {
    resolveConfig({}, { TRIZ_ADMIN_PASSWORD_HASH: secretHash });
    assert.fail('expected rejection');
  } catch (err) {
    assert.ok(!err.message.includes('SECRETPART'), 'hash value leaked into error');
  }
  try {
    resolveConfig({}, { HERMES_BASE_URL: 'http://user:SECRETPW@127.0.0.1:9119' });
    assert.fail('expected rejection');
  } catch (err) {
    assert.ok(!err.message.includes('SECRETPW'), 'URL credential leaked into error');
    assert.match(err.message, /HERMES_BASE_URL/);
  }
});

/* ── authentication never starts with an insecure default ─────────────── */

test('no default users exist in a bare environment', () => {
  const cfg = resolveConfig({}, {});
  assert.equal(cfg.authRequired, false);
  assert.deepEqual(cfg.users, []);
  // Secure cookies only in production or with the explicit flag.
  assert.equal(cfg.secureCookies, false);
  assert.equal(resolveConfig({}, { TRIZ_SECURE_COOKIE: 'true' }).secureCookies, true);
});

/* ── .env loading semantics ───────────────────────────────────────────── */

test('loadEnvFile parses a template without overriding real env vars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triz-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    '# comment line',
    'export EXPORTED_KEY=exported-value',
    'QUOTED_KEY="quoted value"',
    "SINGLE_QUOTED='single value'",
    'MALFORMED LINE WITHOUT EQUALS',
    '1INVALID=negative-name',
    'EXISTING_KEY=from-file',
    '',
  ].join('\n'));
  try {
    const env = { EXISTING_KEY: 'from-os' };
    const loaded = loadEnvFile(file, env);
    assert.equal(env.EXPORTED_KEY, 'exported-value');
    assert.equal(env.QUOTED_KEY, 'quoted value');
    assert.equal(env.SINGLE_QUOTED, 'single value');
    assert.equal(env.EXISTING_KEY, 'from-os'); // OS environment wins
    assert.equal(env['1INVALID'], undefined);  // malformed name skipped
    assert.ok(loaded.includes('EXPORTED_KEY'));
    assert.ok(!loaded.includes('EXISTING_KEY'), 'overridden keys are not "loaded"');
    // The return value carries names only — never values.
    for (const name of loaded) assert.ok(!name.includes('='), 'loader must not return values');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEnvFile on a missing file is a safe no-op', () => {
  const env = {};
  const loaded = loadEnvFile(path.join(os.tmpdir(), 'triz-definitely-missing.env'), env);
  assert.deepEqual(loaded, []);
  assert.deepEqual(env, {});
});

/* ── Git ignore rules ─────────────────────────────────────────────────── */

test('.env is ignored by Git and .env.example is tracked', { skip: !fs.existsSync(path.join(REPO_ROOT, '.git')) }, () => {
  const check = args => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const envIgnored = check(['check-ignore', 'trizempire/.env']);
  assert.equal(envIgnored.status, 0, 'trizempire/.env must be ignored');
  const localIgnored = check(['check-ignore', 'trizempire/.env.local']);
  assert.equal(localIgnored.status, 0, 'trizempire/.env.local must be ignored');
  const exampleIgnored = check(['check-ignore', 'trizempire/.env.example']);
  assert.notEqual(exampleIgnored.status, 0, 'trizempire/.env.example must NOT be ignored');
});

/* ── .env.example hygiene ─────────────────────────────────────────────── */

test('.env.example exists, documents every variable, and holds no credentials', () => {
  const raw = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  // Every variable the code actually reads must be documented.
  for (const name of [
    'NODE_ENV', 'PORT', 'HOST', 'ALLOW_REMOTE_HOST',
    'TRIZ_ADMIN_PASSWORD_HASH', 'TRIZ_OPERATOR_PASSWORD_HASH',
    'TRIZ_SESSION_TTL_MINUTES', 'TRIZ_SESSION_ABS_MINUTES', 'TRIZ_SECURE_COOKIE',
    'HERMES_BASE_URL', 'HERMES_PUBLIC_URL', 'HERMES_TIMEOUT_MS',
    'HERMES_SESSION_TOKEN',
  ]) {
    assert.ok(raw.includes(name), `.env.example must document ${name}`);
  }
  // No real-looking credentials: scrypt hashes, private keys, tokens.
  assert.ok(!/scrypt\$\d/.test(raw), 'no real scrypt hashes in .env.example');
  assert.ok(!raw.includes('BEGIN PRIVATE KEY'), 'no private keys in .env.example');
  // Every uncommented assignment is empty or a safe placeholder/default.
  const assignments = raw.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.includes('='));
  const safeValues = new Set(['', '57004', '127.0.0.1', 'http://127.0.0.1:9119']);
  for (const line of assignments) {
    const value = line.slice(line.indexOf('=') + 1).trim();
    assert.ok(safeValues.has(value), `.env.example contains a non-placeholder value: ${line.split('=')[0]}`);
  }
});

/* ── real startup path enforces the same rules ────────────────────────── */

test('server startup fails safely on invalid production config without leaking secrets', { skip: fs.existsSync(path.resolve(__dirname, '..', '.env')) }, () => {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const result = spawnSync(process.execPath, [serverPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '57004',
      TRIZ_ADMIN_PASSWORD_HASH: '',   // force the missing-auth path
      TRIZ_OPERATOR_PASSWORD_HASH: '',
    },
  });
  assert.notEqual(result.status, 0, 'startup must fail without authentication in production');
  assert.match(result.stderr, /TRIZ_ADMIN_PASSWORD_HASH/);
});
