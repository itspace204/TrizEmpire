/* Embed the Agent City artwork into trizempire/index.html as a data URI.
 * Reads trizempire/.city-tmp/city.webp (produced by city-crop.js) and replaces
 * the content between the CITY-ASSETS markers, keeping the app a single
 * self-contained file that satisfies the strict same-origin CSP
 * (img-src 'self' data:). Idempotent — safe to re-run.
 */
const fs = require('fs');
const path = require('path');

const TMP = path.resolve(__dirname, '..', 'trizempire', '.city-tmp');
const HTML = path.resolve(__dirname, '..', 'trizempire', 'index.html');
const START = '/*CITY-ASSETS:START*/';
const END = '/*CITY-ASSETS:END*/';

const art = 'data:image/webp;base64,' + fs.readFileSync(path.join(TMP, 'city.webp')).toString('base64');
const payload = 'window.CITY_ASSETS={art:' + JSON.stringify(art) + ',w:1708,h:864};';

const html = fs.readFileSync(HTML, 'utf8');
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from < 0 || to < 0) throw new Error('CITY-ASSETS markers not found in index.html');

const out = html.slice(0, from + START.length) + '\n' + payload + '\n' + html.slice(to);
fs.writeFileSync(HTML, out);

const kb = n => (Buffer.byteLength(n) / 1024).toFixed(1) + ' kB';
console.log('injected city artwork — index.html now', kb(out), '(payload', kb(payload) + ')');
