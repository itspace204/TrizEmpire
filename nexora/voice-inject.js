/* Embed the voice-mode crops into trizempire/index.html as data URIs.
 * Reads trizempire/.voice-tmp/{hero,v00..v14}.webp (produced by voice-crop.js)
 * and replaces the content between the VOICE-ASSETS markers, so the whole
 * app stays a single self-contained file that satisfies the strict
 * same-origin CSP (img-src 'self' data:). Idempotent — safe to re-run.
 */
const fs = require('fs');
const path = require('path');

const TMP = path.resolve(__dirname, '..', 'trizempire', '.voice-tmp');
const HTML = path.resolve(__dirname, '..', 'trizempire', 'index.html');
const START = '/*VOICE-ASSETS:START*/';
const END = '/*VOICE-ASSETS:END*/';

const b64 = f => 'data:image/webp;base64,' + fs.readFileSync(path.join(TMP, f)).toString('base64');

const assets = { hero: b64('hero.webp'), agents: [] };
for (let i = 0; i < 15; i++) {
  assets.agents.push(b64('v' + String(i).padStart(2, '0') + '.webp'));
}

const html = fs.readFileSync(HTML, 'utf8');
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from < 0 || to < 0) throw new Error('VOICE-ASSETS markers not found in index.html');

const out = html.slice(0, from + START.length)
  + '\nwindow.VOICE_ASSETS=' + JSON.stringify(assets) + ';\n'
  + html.slice(to);
fs.writeFileSync(HTML, out);

const kb = n => (Buffer.byteLength(n) / 1024).toFixed(1) + ' kB';
console.log('injected', assets.agents.length + 1, 'images —',
  'index.html now', kb(out), '(payload', kb(JSON.stringify(assets)) + ')');
