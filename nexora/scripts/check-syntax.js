'use strict';

/* Cross-platform syntax check (npm run check). Runs `node --check` over every
 * project JavaScript file so CI and Windows shells behave identically. */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
console.log(`${targets.length} files checked, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
