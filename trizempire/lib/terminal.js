'use strict';

/* TERMINAL — the execution engine behind the operator TERMINAL page.
 *
 * One command per HTTP request (the app is a plain request/response server
 * with no WebSocket layer), but the session state — the working directory —
 * lives on the server keyed by (identity + client session id), so `cd foo`
 * followed by `ls` behaves like a real shell. `cd` itself is handled here,
 * between commands, exactly like a shell builtin.
 *
 * The shell is bash when one can be found (on Windows that is Git Bash or
 * WSL bash, which is what gives the Kali-style experience: GNU coreutils,
 * aliases, ANSI colors — a tiny preamble re-enables color even though pipes
 * are not tty). cmd.exe is the fallback on a Windows box without bash.
 *
 * Honesty constraints, in keeping with the rest of this codebase:
 *   - This is NOT a PTY: stdin is closed, so interactive pagers exit at
 *     once; long-running commands are killed at the timeout; output is
 *     truncated at a byte cap. The UI reports all three plainly.
 *   - cd errors use the invoked shell's wording.
 *   - cd is a builtin BETWEEN commands: a line that is just `cd x` persists
 *     into the next command, while `cd x && ls` changes directory for that
 *     one command only (the shell resolves it internally and then exits).
 *   - Nothing here infers: exit codes and output come from the child.
 *
 * This capability executes arbitrary commands as the server user. The HTTP
 * route in server.js sits behind the same auth + CSRF gate as every other
 * mutation, and config disables the whole engine on serverless hosts
 * (terminalEnabled). See .env.example → TRIZ_TERMINAL_ENABLED.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 512;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;
const MAX_COMMAND_CHARS = 1000;

/* ── shell resolution ────────────────────────────────────────────────── */

const WIN_BASH_CANDIDATES = [
  'Git\\bin\\bash.exe',
  'Git\\usr\\bin\\bash.exe',
  'WindowsApps\\bash.exe',
];

function firstExisting(candidates) {
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* keep looking */ }
  }
  return null;
}

/* Returns { kind, file, args(command), preamble } or null when no shell
 * candidate exists. platform/env are injectable for tests. */
function resolveShell(platform = process.platform, env = process.env) {
  if (env.TRIZ_TERMINAL_SHELL) {
    return { kind: 'custom', file: env.TRIZ_TERMINAL_SHELL, args: c => ['-c', c], preamble: '' };
  }
  if (platform !== 'win32') {
    for (const file of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return {
          kind: file.endsWith('sh') && !file.endsWith('bash') ? 'sh' : 'bash',
          file,
          args: c => ['-c', c],
          preamble: 'export TERM=xterm-256color CLICOLOR_FORCE=1; '
            + 'shopt -s expand_aliases 2>/dev/null; '
            + "alias ls='ls --color=force' 2>/dev/null; "
            + "alias ll='ls -alF --color=force' 2>/dev/null; "
            + "alias grep='grep --color=force' 2>/dev/null; ",
        };
      } catch { /* keep looking */ }
    }
    return null;
  }
  /* Windows: Git Bash first (the Kali-style GNU environment), then WSL's
     bash.exe, then the Program Files locations, then PATH, then cmd. */
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
    .filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    for (const rel of WIN_BASH_CANDIDATES) candidates.push(path.join(root, rel));
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'bash.exe'));
  }
  const bash = firstExisting(candidates);
  if (bash) {
    return {
      kind: 'bash',
      file: bash,
      args: c => ['-c', c],
      preamble: 'export TERM=xterm-256color CLICOLOR_FORCE=1; '
        + 'shopt -s expand_aliases 2>/dev/null; '
        + "alias ls='ls --color=force' 2>/dev/null; "
        + "alias ll='ls -alF --color=force' 2>/dev/null; "
        + "alias grep='grep --color=force' 2>/dev/null; ",
    };
  }
  const comspec = env.ComSpec || 'cmd.exe';
  return { kind: 'cmd', file: comspec, args: c => ['/d', '/s', '/c', c], preamble: '' };
}

/* ── prompt paths ────────────────────────────────────────────────────── */

/* C:\Users\x\lib with home C:\Users\x, bash on Windows → /c/Users/x/lib.
 * Display only: the child process still receives the native path as cwd. */
function toPosixPath(winPath) {
  const slashed = String(winPath).replace(/\\/g, '/');
  const drive = slashed.match(/^([A-Za-z]):(\/|$)/);
  return drive ? `/${drive[1].toLowerCase()}${slashed.slice(2)}` : slashed;
}

/* The label shown in the prompt: ~ for home, ~/sub inside it, and the POSIX
 * spelling when the shell is a Windows bash (what `pwd` would print). */
function formatPromptPath(cwd, home, shellKind) {
  let display = cwd;
  const normalizedHome = home.replace(/[\\/]+$/, '');
  const normalizedCwd = cwd.replace(/[\\/]+$/, '');
  if (normalizedCwd === normalizedHome) display = '~';
  else if (normalizedCwd.startsWith(normalizedHome + path.sep)) {
    display = `~${cwd.slice(normalizedHome.length)}`;
  }
  if (shellKind === 'cmd') return display.split(path.sep).join('\\');
  display = display.split(path.sep).join('/');
  if (shellKind !== 'cmd' && /^[A-Za-z]:\//.test(display)) {
    display = toPosixPath(display);
  }
  return display;
}

/* ── the engine ──────────────────────────────────────────────────────── */

function createTerminal(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const shell = options.shell || resolveShell(platform, env);
  if (!shell) {
    throw new Error('no shell found: set TRIZ_TERMINAL_SHELL to a shell binary');
  }
  const home = options.home || os.homedir();
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT;

  /* key → { cwd, lastCwd, usedAt } */
  const sessions = new Map();

  function prune() {
    const cutoff = now() - SESSION_IDLE_MS;
    for (const [key, state] of sessions) {
      if (state.usedAt < cutoff) sessions.delete(key);
    }
    if (sessions.size >= MAX_SESSIONS) {
      /* Evict the least-recently-used beyond the cap. */
      const ordered = [...sessions.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
      for (const [key] of ordered.slice(0, sessions.size - MAX_SESSIONS + 1)) {
        sessions.delete(key);
      }
    }
  }

  function stateFor(key) {
    prune();
    let state = sessions.get(key);
    if (!state) {
      state = { cwd: home, lastCwd: null, usedAt: now() };
      sessions.set(key, state);
    }
    state.usedAt = now();
    return state;
  }

  function describe(state) {
    return {
      user: env.USER || env.USERNAME || 'operator',
      host: env.HOSTNAME || env.COMPUTERNAME || 'localhost',
      shell: shell.kind,
      cwdLabel: formatPromptPath(state.cwd, home, shell.kind),
    };
  }

  function info(key) {
    return describe(stateFor(key));
  }

  function reset(key) {
    sessions.delete(key);
    return describe(stateFor(key));
  }

  /* ── the cd builtin (between commands, like a real shell) ──
     Only a BARE `cd` line is intercepted. A line with shell operators
     (`cd x && ls`, pipes, redirection, subshells) is passed to the shell
     whole: there cd runs inside that one invocation — it changes directory
     for the command but not for the next request, exactly as documented. */
  function tryCd(state, command) {
    if (/[;&|<>$`()\n]/.test(command)) return null;
    const m = command.match(/^\s*cd(?:\s+(.+))?$/);
    if (!m) return null;
    const cdError = shell.kind === 'cmd'
      ? arg => `The system cannot find the path specified. (${arg})\n`
      : arg => `bash: cd: ${arg}: No such file or directory\n`;
    let target = (m[1] || '').trim().replace(/^(['"])(.*)\1$/, '$2');
    let resolved;
    if (!target) resolved = home;
    else if (target === '-') {
      if (!state.lastCwd) {
        return { output: shell.kind === 'cmd'
          ? 'ERROR: no previous directory\n'
          : 'bash: cd: OLDPWD not set\n', exitCode: 1, timedOut: false, truncated: false };
      }
      resolved = state.lastCwd;
    } else if (target.startsWith('~')) {
      resolved = path.resolve(home, target.slice(1));
    } else {
      resolved = path.resolve(state.cwd, target);
    }
    let stat = null;
    try { stat = fs.statSync(resolved); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) {
      return { output: cdError(m[1] ? target : home), exitCode: 1, timedOut: false, truncated: false };
    }
    if (state.cwd !== resolved) {
      state.lastCwd = state.cwd;
      state.cwd = resolved;
    }
    return { output: '', exitCode: 0, timedOut: false, truncated: false };
  }

  /* ── run one command ── */
  function exec(key, rawCommand) {
    const command = typeof rawCommand === 'string' ? rawCommand : '';
    if (!command.trim()) {
      return Promise.resolve({ ...describe(stateFor(key)), output: '', exitCode: 0, timedOut: false, truncated: false });
    }
    if (command.length > MAX_COMMAND_CHARS || /[\0]/.test(command)) {
      return Promise.reject(new Error('command_invalid'));
    }
    const state = stateFor(key);

    const builtin = tryCd(state, command);
    if (builtin) {
      return Promise.resolve({ ...describe(state), ...builtin, cwdLabel: formatPromptPath(state.cwd, home, shell.kind) });
    }

    return new Promise(resolve => {
      let output = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const child = spawn(shell.file, shell.args(shell.preamble + command), {
        cwd: state.cwd,
        env: { ...env, TERM: env.TERM || 'xterm-256color' },
        stdio: ['ignore', 'pipe', 'pipe'],
        /* Own process group on POSIX so the timeout kills the whole tree,
           not just the shell wrapper. */
        detached: platform !== 'win32',
        windowsHide: true,
      });

      const take = chunk => {
        if (settled) return;
        const remaining = maxOutputBytes - output.length;
        if (remaining <= 0) { truncated = true; return; }
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        if (slice.length < chunk.length) truncated = true;
        output = Buffer.concat([output, slice]);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);

      const finish = exitCode => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        /* Keep SGR color sequences (the UI renders them); strip every other
           control sequence and stray control character. The ESC of a kept
           SGR must survive the control-character pass. */
        const text = output.toString('utf8')
          .replace(/\r\n/g, '\n')
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, m2 => (m2.endsWith('m') ? m2 : ''))
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '')
          .replace(/\x1b(?!\[[0-9;]*m)/g, '');
        resolve({
          ...describe(state),
          output: text + (truncated ? '\n[output truncated]' : '')
            + (timedOut ? `\n[killed after ${Math.round(timeoutMs / 1000)}s]` : ''),
          exitCode,
          timedOut,
          truncated,
        });
      };

      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ...describe(state),
          output: `terminal: cannot start ${shell.file} (${err.code || err.message})\n`,
          exitCode: 127,
          timedOut: false,
          truncated: false,
        });
      });
      child.on('close', code => finish(code === null ? 137 : code));
    });
  }

  return { exec, info, reset, shell: shell.kind, home };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* the child may already be gone */ }
}

module.exports = { createTerminal, resolveShell, formatPromptPath, toPosixPath };
