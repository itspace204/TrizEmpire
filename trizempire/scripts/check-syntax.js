'use strict';

/* Cross-platform syntax check (npm run check). Runs `node --check` over every
 * project JavaScript file so CI and Windows shells behave identically. */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const targets = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // node_modules: nothing to check. vendor/: pinned third-party ES modules
      // (checked by CI as part of the vendored build, not our CommonJS code).
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
      walk(full);
    } else if (entry.name.endsWith('.js')) {
      targets.push(full);
    }
  }
}

walk(root);
let failed = 0;
for (const file of targets) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const rel = path.relative(root, file);
  if (result.status === 0) {
    console.log(`ok   ${rel}`);
  } else {
    failed += 1;
    console.error(`FAIL ${rel}\n${result.stderr}`);
  }
}
/* Inline <script> blocks of index.html are compiled the way the browser
 * scopes them: classic blocks share ONE global lexical scope, so they are
 * compiled together in document order (a duplicate top-level `const` across
 * two classic blocks is a real page-killing SyntaxError — it once bricked
 * every view — and must fail HERE, not production), while type="module"
 * blocks get an isolated scope each and are checked separately via
 * `node --check` on a temporary .mjs. Compile only; nothing executes. */
let inlineChecked = 0;
try {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const classic = [];
  const modules = [];
  for (const [, attrs, code] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(attrs) || !code.trim()) continue;
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (/^module$/i.test(type)) modules.push(code);
    else if (!type || /^(text|application)\/javascript$/i.test(type)) classic.push(code);
    // any other type (application/json, importmap, …) is data, not code
  }
  inlineChecked = classic.length + modules.length;
  new vm.Script(classic.join('\n;\n'), { filename: 'index.html (classic scripts)' });
  const os = require('node:os');
  modules.forEach((code, i) => {
    const tmp = path.join(os.tmpdir(), `triz-inline-module-${i}.mjs`);
    fs.writeFileSync(tmp, code);
    const result = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    fs.rmSync(tmp, { force: true });
    if (result.status !== 0) throw new Error(`module script #${i + 1}: ${result.stderr}`);
  });
  console.log(`ok   index.html (${classic.length} classic compiled as one, ${modules.length} module checked alone)`);
} catch (error) {
  failed += 1;
  console.error(`FAIL index.html inline scripts\n${error && error.message}`);
}

console.log(`${targets.length + 1} files checked, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
