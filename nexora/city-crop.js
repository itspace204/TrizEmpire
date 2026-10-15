/* Crop the Agent City artwork out of the reference screenshot (4.png).
 *
 * Measured geometry in the 1920x1080 source:
 *   interior  x 106..1813, y 99..1014   (inside the white app frame)
 *   caption   x 642..1278, y ~966..1039 (video caption pill — excluded)
 *   right card 1595,718 .. 1814,962  (baked "Executor HQ" agent card)
 *   left card   106,847 .. 302,962   (baked, text-clipped card)
 *   building label pills (white rounded rects, detected as bright components
 *   containing dark text) and the orange "Executor HQ" pill at 906..1016 /
 *   332..368.
 *
 * The crop stops at y=962 so the caption pill never enters the artwork; the
 * two baked cards are covered by the view's own live panels, which are
 * positioned with these same source coordinates.
 *
 * Output: trizempire/.city-tmp/city.webp (+ a PNG preview for eyeballing).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = 'C:/Users/USER/Downloads/4.png';
const OUT = path.resolve(__dirname, '..', 'trizempire', '.city-tmp');
fs.mkdirSync(OUT, { recursive: true });

const CROP = { left: 106, top: 99, width: 1708, height: 864 };

/* Every building label pill in the artwork, as source-space rects (x0, y0, w, h).
 * Ten were detected as bright components containing dark text, the orange
 * "Executor HQ" pill and the two pills sitting on bright buildings (Design
 * Loft, Studio Stage) were measured off a coordinate-grid render. The city
 * view anchors one station per pill — see the BUILDINGS table in
 * nexora/city-view.js, which stores each rect relative to the crop (x-106,
 * y-99). */
const PILLS = [
  { x0: 906,  y0: 332, w: 110, h: 36, name: 'Executor HQ' },
  { x0: 258,  y0: 536, w: 104, h: 32, name: 'Care Center' },
  { x0: 310,  y0: 638, w: 92,  h: 33, name: 'Deal Desk' },
  { x0: 542,  y0: 225, w: 118, h: 33, name: 'Code Foundry' },
  { x0: 1468, y0: 317, w: 109, h: 33, name: 'Signal Tower' },
  { x0: 634,  y0: 344, w: 150, h: 32, name: 'Research Institute' },
  { x0: 783,  y0: 215, w: 113, h: 33, name: 'Travel Studio' },
  { x0: 1224, y0: 594, w: 127, h: 32, name: 'Content Atelier' },
  { x0: 1023, y0: 156, w: 122, h: 32, name: 'Growth Studio' },
  { x0: 1488, y0: 718, w: 99,  h: 34, name: 'Design Loft' },
  { x0: 1152, y0: 823, w: 113, h: 33, name: 'Studio Stage' },
  { x0: 569,  y0: 545, w: 109, h: 32, name: 'Data Citadel' },
  { x0: 660,  y0: 850, w: 117, h: 33, name: 'Ledger House' },
];
/* Baked dark panels the view must cover with its own live ones. */
const PANELS = {
  right: { x: 1595, y: 718, w: 219, h: 244 },
  left: { x: 106, y: 847, w: 196, h: 115 },
};

(async () => {
  await sharp(SRC).extract(CROP).webp({ quality: 82 }).toFile(path.join(OUT, 'city.webp'));
  await sharp(SRC).extract(CROP).png().toFile(path.join(OUT, 'preview.png'));
  const size = fs.statSync(path.join(OUT, 'city.webp')).size;
  console.log('crop', CROP, '->', (size / 1024).toFixed(1) + ' kB webp');
  console.log('pills', Object.keys(PILLS).join(', '));
  console.log('panels', JSON.stringify(PANELS));
})().catch(e => { console.error(e); process.exit(1); });
