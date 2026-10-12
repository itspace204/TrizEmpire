'use strict';

/* Deployment-bundle tests: the committed systemd unit and nginx TLS snippet
 * are checked structurally here, because CI (and this repo's own machine)
 * has no systemd or nginx to execute them with. These tests pin the
 * invariants that would silently break a deployment if they drifted:
 * ports and bind addresses shared with the app's config, TLS policy,
 * proxy headers the CSRF check depends on, sandbox directives, and the
 * documentation that points at the bundle. They are not a substitute for
 * `systemd-analyze verify` and `nginx -t` on the target host. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveConfig } = require('../lib/config');

const repoRoot = path.resolve(__dirname, '..', '..');
const unitPath = path.join(repoRoot, 'deploy', 'trizempire.service');
const nginxPath = path.join(repoRoot, 'deploy', 'trizempire-nginx.conf');
const ecosystemPath = path.join(repoRoot, 'deploy', 'ecosystem.config.js');
const deploymentDocPath = path.join(repoRoot, 'DEPLOYMENT.md');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/* systemd unit: `[Section]` blocks of `Key=Value`; '#' or ';' start a
 * comment line. Values are taken literally (last assignment wins). */
function parseUnit(text) {
  const unit = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1];
      unit[section] = unit[section] || {};
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/);
    if (pair && section) {
      // systemd aggregates repeated assignments (e.g. several Environment=
      // lines); keep every one, newline-joined, instead of overwriting.
      const [, key, value] = pair;
      unit[section][key] = unit[section][key] === undefined
        ? value
        : `${unit[section][key]}\n${value}`;
    }
    else if (pair) assert.fail(`key outside any section: ${line}`);
    else assert.fail(`unparseable unit line: ${line}`);
  }
  return unit;
}

const unit = parseUnit(read(unitPath));

/* nginx: comment-stripped, non-empty lines. The block/statements test
 * below requires each of them to close a statement (';') or open/close
 * a block ('{' / '}'). */
const nginxStatements = (() => {
  const text = read(nginxPath);
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const hash = raw.indexOf('#');
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (line) out.push(line);
  }
  return out;
})();

test('bundle files exist, are not empty, and are free of CR characters', () => {
  for (const file of [unitPath, nginxPath]) {
    const body = read(file);
    assert.ok(body.length > 100, `${file} looks empty`);
    assert.ok(!body.includes('\r'), `${file} must use LF line endings`);
  }
});

test('unit declares the expected sections and enable target', () => {
  assert.deepEqual(Object.keys(unit), ['Unit', 'Service', 'Install']);
  assert.equal(unit.Install.WantedBy, 'multi-user.target');
  assert.ok(unit.Unit.After.includes('network-online.target'));
  assert.equal(unit.Service.Type, 'exec');
});

test('unit runs node directly as a non-root user from absolute paths', () => {
  const svc = unit.Service;
  assert.notEqual(svc.User, 'root');
  assert.ok(svc.Group, 'a dedicated group is required');
  assert.ok(path.posix.isAbsolute(svc.WorkingDirectory));
  assert.ok(path.posix.isAbsolute(svc.EnvironmentFile));

  const exec = svc.ExecStart.split(/\s+/);
  assert.ok(path.posix.isAbsolute(exec[0]), 'ExecStart binary must be absolute');
  assert.match(exec[0], /node$/, 'call node directly, not through npm');
  assert.ok(!/\bnpm\b/.test(svc.ExecStart), 'no npm wrapper under systemd');
  assert.ok(
    exec[1].startsWith(svc.WorkingDirectory + '/'),
    'script path must live inside WorkingDirectory'
  );
  assert.match(exec[1], /server\.js$/);
});

test('unit pins production on loopback with a fixed port and an env file', () => {
  const svc = unit.Service;
  assert.equal(svc.EnvironmentFile.startsWith('/'), true);
  assert.match(svc.Environment, /(^|\n)NODE_ENV=production(\n|$)/);
  assert.match(svc.Environment, /(^|\n)HOST=127\.0\.0\.1(\n|$)/);
  const port = Number(svc.Environment.match(/(^|\n)PORT=(\d+)(\n|$)/)[2]);
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);

  // The bundle must agree with the application's own defaults.
  const defaults = resolveConfig({}, {});
  assert.equal(port, defaults.port, 'unit PORT differs from the app default');
  assert.equal(svc.Environment.match(/(^|\n)HOST=([^ \n]+)/)[2], defaults.host);
  // An empty HERMES_PUBLIC_URL (console embed off) must stay valid config.
  assert.equal(resolveConfig({}, { HERMES_PUBLIC_URL: '' }).hermesPublicUrl, '');
  assert.equal(svc.Restart, 'on-failure');
});

test('unit hardens the sandbox and omits directives that would break node', () => {
  const svc = unit.Service;
  for (const required of [
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    'RestrictRealtime=true',
    'LockPersonality=true',
    'UMask=0077',
  ]) {
    assert.equal(svc[required.split('=')[0]], required.split('=')[1], required);
  }
  assert.equal(svc.MemoryDenyWriteExecute, undefined, 'breaks V8 JIT');
  assert.equal(svc.PrivateNetwork, undefined, 'would remove the listening socket');
});
test('unit opens exactly the data dir the app writes (workspace mapping)', () => {
  const svc = unit.Service;
  // The server's only disk write is TRIZ_WORKSPACES_FILE (default
  // <root>/data/workspaces.json). ProtectSystem=strict makes the app tree
  // read-only, so that directory must be carved out explicitly — and only
  // that directory, never the whole app tree.
  assert.equal(svc.ProtectSystem, 'strict');
  assert.equal(svc.ReadWritePaths,
    '/opt/trizempire/trizempire/data',
    'ReadWritePaths must match the unit WorkingDirectory + /data');
  assert.ok(
    svc.ReadWritePaths.startsWith(svc.WorkingDirectory),
    'the writable path must live inside WorkingDirectory'
  );
});

test('nginx terminates TLS with the modern protocol policy', () => {
  const body = nginxStatements.join('\n');
  assert.match(body, /ssl_protocols\s+TLSv1\.2\s+TLSv1\.3;/);
  assert.ok(!/TLSv1(\.0|\.1)\b/.test(body), 'obsolete protocols must not be offered');
  assert.match(body, /ssl_prefer_server_ciphers\s+off;/);
  assert.match(body, /listen\s+443\s+ssl;/);
  assert.match(body, /(?:http2 on;|listen\s+443\s+ssl\s+http2;)/);
  assert.match(body, /ssl_certificate\s+\/etc\/letsencrypt\/live\/[^;]+\/fullchain\.pem;/);
  assert.match(body, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/[^;]+\/privkey\.pem;/);
  assert.match(body, /Strict-Transport-Security\s+"max-age=\d{7,}[^"]*"\s+always;/);
  assert.ok(!/\bssl\s+on;/.test(body), 'deprecated ssl on;');
});

test('nginx forwards the headers the app CSRF check depends on', () => {
  const body = nginxStatements.join('\n');
  const port = unit.Service.Environment.match(/(^|\n)PORT=(\d+)(\n|$)/)[2];
  assert.match(body, new RegExp(`proxy_pass\\s+http://127\\.0\\.0\\.1:${port};`));
  assert.match(body, /proxy_set_header\s+Host\s+\$host;/);
  assert.match(body, /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/);
  assert.match(body, /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/);
  // Origin/Referer must pass through untouched for isSameOrigin() to work.
  assert.ok(!/proxy_set_header\s+Origin\b/.test(body));
  assert.ok(!/proxy_set_header\s+Referer\b/.test(body));
});

test('nginx serves ACME challenges and redirects plain HTTP to HTTPS', () => {
  const body = nginxStatements.join('\n');
  assert.equal((body.match(/\bserver\s*{/g) || []).length, 2, 'ports 80 and 443');
  assert.match(body, /location\s+\^~\s*\/\s*\.well-known\/acme-challenge\//);
  assert.match(body, /return\s+301\s+https:\/\//);
  // The challenge location must live in the port-80 block, ahead of the redirect.
  const httpBlock = body.slice(body.indexOf('server {'), body.indexOf('server {', body.indexOf('server {') + 1));
  assert.ok(
    httpBlock.indexOf('acme-challenge') !== -1,
    'ACME location belongs to the port-80 server block'
  );
  assert.ok(
    httpBlock.indexOf('acme-challenge') < httpBlock.indexOf('return 301'),
    'ACME location must precede the redirect'
  );
});

test('nginx file parses: balanced blocks and terminated statements', () => {
  let depth = 0;
  for (const line of nginxStatements) {
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
    assert.ok(depth >= 0, `unbalanced closing brace: ${line}`);
  }
  assert.equal(depth, 0, 'unclosed block');
  for (const line of nginxStatements) {
    assert.match(line, /[;{}]$/, `nginx line is not terminated: ${line}`);
  }
});

test('DEPLOYMENT.md documents the bundle and its host-side verification', () => {
  const doc = read(deploymentDocPath);
  assert.ok(doc.includes('deploy/trizempire.service'));
  assert.ok(doc.includes('deploy/trizempire-nginx.conf'));
  assert.ok(doc.includes('deploy/ecosystem.config.js'));
  assert.ok(doc.includes('systemd-analyze verify'));
  assert.ok(doc.includes('nginx -t'));
  // The two managed targets this guide covers must stay documented.
  assert.ok(doc.includes('## Vercel (serverless)'));
  assert.ok(doc.includes('## Hostinger'));
});
test('pm2 file pins the same app shape as the unit and the app defaults', () => {
  // Hostinger's VPS tutorials run Node under pm2; ecosystem.config.js is
  // the committed counterpart of the systemd unit. It must agree with the
  // app's own defaults and the nginx proxy target, or a pm2 deployment
  // silently drifts from the documented bundle.
  const ecosystem = require(ecosystemPath);
  assert.ok(Array.isArray(ecosystem.apps) && ecosystem.apps.length === 1,
    'exactly one app — two managers fighting one port is a misconfiguration');
  const app = ecosystem.apps[0];
  assert.equal(app.name, 'trizempire');
  assert.equal(app.script, 'server.js', 'run node directly, not through npm');
  assert.ok(!/\bnpm\b/.test(app.script));
  assert.ok(path.posix.isAbsolute(app.cwd));
  assert.equal(app.env.NODE_ENV, 'production');
  assert.equal(app.env.HOST, '127.0.0.1');
  const defaults = resolveConfig({}, {});
  assert.equal(Number(app.env.PORT), defaults.port, 'pm2 PORT differs from the app default');
  assert.equal(app.instances, 1, 'sessions are in-memory — multiple instances would break login affinity');
  // Same pins as the nginx proxy target.
  const port = unit.Service.Environment.match(/(^|\n)PORT=(\d+)(\n|$)/)[2];
  assert.equal(String(app.env.PORT), port);
});
