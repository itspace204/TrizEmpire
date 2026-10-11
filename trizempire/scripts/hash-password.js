'use strict';

/* Generate a scrypt password hash for TRIZ_ADMIN_PASSWORD_HASH or
 * TRIZ_OPERATOR_PASSWORD_HASH. The password is read from stdin (so it never
 * appears in shell history or process listings) and only the hash is printed.
 *
 *   node scripts/hash-password.js
 *   Password: ********
 *   scrypt$16384$8$1$<salt>$<hash>
 */
const readline = require('node:readline');
const { hashPassword } = require('../lib/auth');

function readHidden(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = str => {
      if (!str.includes('\n')) return; // suppress echoed characters
      write(str);
    };
    rl.question(prompt, answer => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const password = await readHidden('Password: ');
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  process.stdout.write(hashPassword(password) + '\n');
})();
