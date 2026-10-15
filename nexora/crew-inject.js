/* Embed the crew-grid portraits into trizempire/index.html as data URIs.
 * Reads trizempire/.crew-tmp/{c00..c13}.webp (produced by crew-crop.js) plus
 * the voice-dock Travel thumb (trizempire/.voice-tmp/v14.webp — the mock's
 * third grid row carries only four cards, so the 15th agent keeps its voice
 * portrait) and replaces the content between the CREW-ASSETS markers, keeping
 * the app a single self-contained file that satisfies the strict same-origin
 * CSP (img-src 'self' data:). Idempotent — safe to re-run.
 */
const fs = require('fs');
const path = require('path');

const TMP = path.resolve(__dirname, '..', 'trizempire', '.crew-tmp');
const VOICE = path.resolve(__dirname, '..', 'trizempire', '.voice-tmp');
const HTML = path.resolve(__dirname, '..', 'trizempire', 'index.html');
const START = '/*CREW-ASSETS:START*/';
const END = '/*CREW-ASSETS:END*/';

const b64 = f => 'data:image/webp;base64,' + fs.readFileSync(f).toString('base64');

const agents = [];
for (let i = 0; i < 14; i++) {
  agents.push(b64(path.join(TMP, 'c' + String(i).padStart(2, '0') + '.webp')));
}
agents.push(b64(path.join(VOICE, 'v14.webp')));   // Travel — the 15th agent

const payload = 'window.CREW_ASSETS=' + JSON.stringify({ agents }) + ';';

const html = fs.readFileSync(HTML, 'utf8');
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from < 0 || to < 0) throw new Error('CREW-ASSETS markers not found in index.html');

const out = html.slice(0, from + START.length) + '\n' + payload + '\n' + html.slice(to);
fs.writeFileSync(HTML, out);

const kb = n => (Buffer.byteLength(n) / 1024).toFixed(1) + ' kB';
console.log('injected', agents.length, 'portraits — index.html now', kb(out), '(payload', kb(payload) + ')');
