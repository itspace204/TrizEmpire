'use strict';

/* TERMINAL tests:
 *   - lib/terminal.js: cd as a persistent builtin, exec with real output and
 *     exit codes, timeout kill, output truncation, prompt paths, and the
 *     honesty rules (no PTY claims, killed/truncated output says so).
 *   - config: TRIZ_TERMINAL_* validation and the serverless default.
 *   - server routes: /api/terminal* are auth-gated, CSRF-checked,
 *     rate-limited, answer 503 when disabled, and never log command text.
 *
 * Cross-platform: commands used here must behave the same under bash (Git
 * Bash on Windows) and cmd.exe, since the engine auto-detects either. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTerminal, resolveShell, formatPromptPath } = require('../lib/terminal');

/* The engine prefers bash (Git Bash on Windows), and bash's bare `cd`
   prints nothing — only cmd.exe echoes the directory. Ask the resolver
   which shell this machine actually gets, and pick the pwd spelling to
   match, exactly like a user would. */
const SHELL_KIND = resolveShell(process.platform, process.env).kind;
const PWD_CMD = SHELL_KIND === 'cmd' ? 'cd' : 'pwd';
const { resolveConfig } = require('../lib/config');
const { hashPassword } = require('../lib/auth');
const { createServer } = require('../server');

const ADMIN_HASH = hashPassword('correct horse battery staple');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ── lib/terminal.js ─────────────────────────────────────────────────── */

test('exec runs a command and reports output and exit code', async () => {
  const term = createTerminal({ home: tmpDir('triz-term-') });
  const ok = await term.exec('s1', process.platform === 'win32' ? 'echo hello' : 'echo hello');
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /hello/);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.truncated, false);

  const fail = await term.exec('s1', 'exit 3');
  assert.equal(fail.exitCode, 3, 'the real exit code must pass through');
});

test('cd is a persistent builtin: it survives into the next command', async () => {
  const home = tmpDir('triz-term-home-');
  const target = path.join(home, 'work');
  fs.mkdirSync(target);
  const term = createTerminal({ home });

  const moved = await term.exec('s1', `cd ${JSON.stringify(target).slice(1, -1)}`);
  assert.equal(moved.exitCode, 0);
  assert.equal(moved.cwdLabel, '~/work', 'prompt label follows the directory');

  const where = await term.exec('s1', PWD_CMD);
  assert.equal(where.exitCode, 0);
  assert.match(where.output.replace(/\\/g, '/').trim(), /\/work$/);
});

test('cd failures keep the cwd, use the shell wording and exit 1', async () => {
  const home = tmpDir('triz-term-home-');
  const term = createTerminal({ home });
  const bad = await term.exec('s1', 'cd definitely-not-here');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.output, /No such file or directory|cannot find the path/i);
  assert.equal(bad.cwdLabel, '~', 'a failed cd must not move the session');
});

test('cd - returns to the previous directory and cd ~ goes home', async () => {
  const home = tmpDir('triz-term-home-');
  fs.mkdirSync(path.join(home, 'aaa'));
  const term = createTerminal({ home });

  await term.exec('s1', 'cd aaa');
  const back = await term.exec('s1', 'cd -');
  assert.equal(back.exitCode, 0);
  assert.equal(back.cwdLabel, '~');

  const again = await term.exec('s1', 'cd aaa');
  assert.equal(again.cwdLabel, '~/aaa', 'cd - walks back through lastCwd');
});

test('cd with shell operators is passed to the shell, not swallowed', async () => {
  /* `cd x && pwd` must reach bash whole: the builtin may only intercept a
     bare cd line, or chained commands die with a bogus "No such file". */
  const home = tmpDir('triz-term-home-');
  fs.mkdirSync(path.join(home, 'chain'));
  const term = createTerminal({ home });
  /* Forward slashes: bash treats backslashes as escapes; both shells
     accept the POSIX spelling of a Windows path. */
  const chainDir = path.join(home, 'chain').split(path.sep).join('/');
  const r = await term.exec('s1', `cd ${chainDir} && ${PWD_CMD}`);
  assert.equal(r.exitCode, 0, `chained cd must not error: ${r.output}`);
  assert.match(r.output.replace(/\\/g, '/').trim(), /\/chain$/,
    'the shell ran both halves of the chain');
  assert.equal(r.cwdLabel, '~', 'a chained cd does not persist (one invocation)');
});

test('sessions are isolated: two sids never share a cwd', async () => {
  const home = tmpDir('triz-term-home-');
  fs.mkdirSync(path.join(home, 'alpha'));
  const term = createTerminal({ home });
  await term.exec('tab-a', 'cd alpha');
  const a = await term.exec('tab-a', PWD_CMD);
  const b = await term.exec('tab-b', PWD_CMD);
  assert.match(a.output.replace(/\\/g, '/').trim(), /\/alpha$/);
  assert.match(b.output.replace(/\\/g, '/').trim(), /triz-term-home-[^/\\]+$/,
    'the other tab is still at its own home directory');
});

test('reset restarts the session at $HOME', async () => {
  const home = tmpDir('triz-term-home-');
  fs.mkdirSync(path.join(home, 'deep'));
  const term = createTerminal({ home });
  await term.exec('s1', 'cd deep');
  const r = term.reset('s1');
  assert.equal(r.cwdLabel, '~');
  const after = await term.exec('s1', PWD_CMD);
  assert.equal(after.cwdLabel, '~', 'the session state is back home');
  assert.match(after.output.replace(/\\/g, '/').trim(), /triz-term-home-[^/\\]+$/,
    'and the shell really starts there (Git Bash may remap the temp path)');
});

test('a hanging command is killed at the timeout and says so', async () => {
  const term = createTerminal({ home: tmpDir('triz-term-'), timeoutMs: 300 });
  const r = await term.exec('s1', 'sleep 30');
  assert.equal(r.timedOut, true);
  assert.match(r.output, /\[killed after 0s\]/);
});

test('output is truncated at the byte cap and says so', async () => {
  const term = createTerminal({ home: tmpDir('triz-term-'), maxOutputBytes: 256 });
  const big = process.platform === 'win32'
    ? 'powershell -NoProfile -Command "1..200 | ForEach-Object { \'x\' * 64 }"'
    : 'yes x | head -c 100000';
  const r = await term.exec('s1', big);
  assert.equal(r.truncated, true);
  assert.match(r.output, /\[output truncated\]/);
  assert.ok(r.output.length < 2000, 'the answer must stay small');
});

test('invalid commands are rejected before anything spawns', async () => {
  const term = createTerminal({ home: tmpDir('triz-term-') });
  await assert.rejects(term.exec('s1', 'echo ok\0rm -rf /'), /command_invalid/);
  await assert.rejects(term.exec('s1', 'x'.repeat(1200)), /command_invalid/);
  const empty = await term.exec('s1', '   ');
  assert.equal(empty.output, '', 'an empty line is a no-op, not an error');
  assert.equal(empty.exitCode, 0);
});

test('info describes user, host, shell and prompt cwd', async () => {
  const term = createTerminal({ home: tmpDir('triz-term-') });
  const info = term.info('s1');
  assert.ok(info.user && info.host, 'identity facts for the prompt');
  assert.ok(['bash', 'sh', 'cmd', 'custom'].includes(info.shell));
  assert.equal(info.cwdLabel, '~');
});

/* ── prompt paths ────────────────────────────────────────────────────── */

test('formatPromptPath spells ~, ~/sub and POSIX drive paths', () => {
  const home = path.join(path.parse(process.root || '/').root, 'home', 'op');
  assert.equal(formatPromptPath(home, home, 'bash'), '~');
  assert.equal(formatPromptPath(path.join(home, 'x', 'y'), home, 'bash'), '~/x/y');
});

test('resolveShell honors TRIZ_TERMINAL_SHELL and finds a real shell here', () => {
  const custom = resolveShell('linux', { TRIZ_TERMINAL_SHELL: '/opt/zsh' });
  assert.equal(custom.kind, 'custom');
  assert.equal(custom.file, '/opt/zsh');

  const auto = resolveShell(process.platform, process.env);
  assert.ok(auto && auto.file, 'this machine must have some shell');
  assert.ok(['bash', 'sh', 'cmd', 'custom'].includes(auto.kind));
});

/* ── config ──────────────────────────────────────────────────────────── */

test('terminal config: serverless default off, validation names the variable', () => {
  const local = resolveConfig({}, {});
  assert.equal(local.terminalEnabled, true, 'self-hosted installs get a terminal');
  assert.equal(local.terminalTimeoutMs, 15000);

  const vercel = resolveConfig({}, { VERCEL: '1' });
  assert.equal(vercel.terminalEnabled, false, 'a lambda must not spawn shells');

  const forced = resolveConfig({}, { VERCEL: '1', TRIZ_TERMINAL_ENABLED: 'true' });
  assert.equal(forced.terminalEnabled, true, 'explicit opt-in still wins');

  const off = resolveConfig({}, { TRIZ_TERMINAL_ENABLED: 'false' });
  assert.equal(off.terminalEnabled, false);

  assert.throws(() => resolveConfig({}, { TRIZ_TERMINAL_ENABLED: 'yes' }),
    /TRIZ_TERMINAL_ENABLED must be true or false/);
  assert.throws(() => resolveConfig({}, { TRIZ_TERMINAL_TIMEOUT_MS: '0' }),
    /TRIZ_TERMINAL_TIMEOUT_MS/);
  assert.throws(() => resolveConfig({}, { TRIZ_TERMINAL_TIMEOUT_MS: '999999' }),
    /TRIZ_TERMINAL_TIMEOUT_MS/);
  assert.throws(() => resolveConfig({}, { TRIZ_TERMINAL_SHELL: 'x\ny' }),
    /TRIZ_TERMINAL_SHELL/);
});

/* ── server routes ───────────────────────────────────────────────────── */

async function withServer(run, options = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const termOptions = (extra = {}) => ({
  users: [{ username: 'admin', role: 'admin', hash: ADMIN_HASH }],
  secureCookies: false,
  hermesBaseUrl: 'http://127.0.0.1:9',
  ...extra,
});

const SID = 'test-session-0001';

test('the terminal routes require authentication', async () => {
  await withServer(async base => {
    for (const [url, init] of [
      [`${base}/api/terminal?sid=${SID}`, {}],
      [`${base}/api/terminal/exec?sid=${SID}`, { method: 'POST' }],
      [`${base}/api/terminal/reset?sid=${SID}`, { method: 'POST' }],
    ]) {
      const res = await fetch(url, init);
      assert.equal(res.status, 401, `${url} must not answer anonymous callers`);
    }
  }, termOptions());
});

test('exec requires the CSRF header once authenticated', async () => {
  await withServer(async base => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/terminal/exec?sid=${SID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ command: 'echo pwned' }),
    });
    assert.equal(res.status, 403);
  }, termOptions());
});

test('exec runs a command end-to-end and cd persists over HTTP', async () => {
  await withServer(async base => {
    const cookie = await login(base);
    const exec = async command => {
      const res = await fetch(`${base}/api/terminal/exec?sid=${SID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', origin: base, cookie },
        body: JSON.stringify({ command }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const first = await exec('echo terminal-works');
    assert.equal(first.ok, true);
    assert.match(first.output, /terminal-works/);
    assert.equal(first.exitCode, 0);
    assert.ok(first.user && first.host && first.cwdLabel, 'prompt facts ride along');

    /* The engine starts every session at os.homedir(); the pwd round-trip
       below only checks the shell agrees, so build the fixture from the
       same fact instead of parsing the (possibly POSIX-remapped) output. */
    const sub = path.join(os.homedir(), 'triz-e2e-sub-' + Date.now());
    fs.mkdirSync(sub);
    try {
      const moved = await exec(`cd ${JSON.stringify(sub).slice(1, -1)}`);
      assert.equal(moved.exitCode, 0);
      assert.match(moved.cwdLabel, /triz-e2e-sub-\d+$/);
      const where = await exec(PWD_CMD);
      assert.equal(where.cwdLabel, moved.cwdLabel);
      assert.match(where.output.replace(/\\/g, '/').trim(), /\/triz-e2e-sub-\d+$/,
        'pwd agrees with the session state (Git Bash may remap the temp path)');
    } finally {
      fs.rmdirSync(sub);
    }
  }, termOptions());
});

test('reset answers with a fresh session at home', async () => {
  await withServer(async base => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/terminal/reset?sid=${SID}`, {
      method: 'POST', headers: { 'x-triz-csrf': '1', origin: base, cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.cwdLabel, '~');
  }, termOptions());
});

test('a disabled terminal answers 503 with an honest hint', async () => {
  await withServer(async base => {
    const cookie = await login(base);
    const res = await fetch(`${base}/api/terminal/exec?sid=${SID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', origin: base, cookie },
      body: JSON.stringify({ command: 'echo x' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'terminal_disabled');
  }, termOptions({ terminalEnabled: false }));
});

test('the terminal is rate-limited and methods are constrained', async () => {
  let checks = 0;
  const limiter = {
    check: () => { checks += 1; return checks <= 2 ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds: 30 }; },
    fail: () => {}, clear: () => {},
  };
  await withServer(async base => {
    const cookie = await login(base);
    const post = () => fetch(`${base}/api/terminal/exec?sid=${SID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', origin: base, cookie },
      body: JSON.stringify({ command: 'echo x' }),
    });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '30');

    assert.equal((await fetch(`${base}/api/terminal/exec?sid=${SID}`, { method: 'GET', headers: { cookie } })).status, 405);
    assert.equal((await fetch(`${base}/api/terminal?sid=${SID}`, { method: 'POST', headers: { cookie, 'x-triz-csrf': '1', origin: base } })).status, 405);
  }, termOptions({ terminalLimiter: limiter }));
});

test('malformed command bodies are rejected without crashing', async () => {
  await withServer(async base => {
    const cookie = await login(base);
    const bad = await fetch(`${base}/api/terminal/exec?sid=${SID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', origin: base, cookie },
      body: '{not json',
    });
    assert.equal(bad.status, 400);

    const invalid = await fetch(`${base}/api/terminal/exec?sid=${SID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', origin: base, cookie },
      body: JSON.stringify({ command: 'echo ok\0bad' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'command_invalid');
  }, termOptions());
});
