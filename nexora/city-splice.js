/* Replace the old Three.js Agent City module in trizempire/index.html with the
 * artwork view module from nexora/city-view.js. Line-ending aware (the file is
 * CRLF) and idempotent: re-running swaps a previously spliced block as well.
 */
const fs = require('fs');
const path = require('path');

const HTML = path.resolve(__dirname, '..', 'trizempire', 'index.html');
const BODY = fs.readFileSync(path.join(__dirname, 'city-view.js'), 'utf8');

const OLD_MARK = '/* ══════ AGENT CITY — 3D orbital status map ══════';
const NEW_MARK = '/* ══════ AGENT CITY — isometric district (the reference artwork) ══════';

const html = fs.readFileSync(HTML, 'utf8');
const mark = html.includes(OLD_MARK) ? OLD_MARK : (html.includes(NEW_MARK) ? NEW_MARK : null);
if (!mark) throw new Error('no Agent City module marker found in index.html');

const bodyAt = html.indexOf(mark);
const openTag = html.lastIndexOf('<script type="module">', bodyAt);
const closeTag = html.indexOf('</script>', bodyAt);
if (openTag < 0 || closeTag < 0) throw new Error('could not bound the city module block');

const body = BODY.replace(/\r?\n/g, '\r\n').replace(/\r\n$/, '');
const out = html.slice(0, openTag)
  + '<script type="module">\r\n' + body + '\r\n</script>'
  + html.slice(closeTag + '</script>'.length);

fs.writeFileSync(HTML, out);
console.log('spliced city module:', (BODY.length / 1024).toFixed(1) + ' kB of JS, replaced',
  mark === OLD_MARK ? 'the 3D orbital map' : 'the previous artwork module');
