/* Crop the crew-grid portraits out of the reference design (Hemes/mater.png)
 * with sharp — same technique and output shape as voice-crop.js.
 *
 * Coordinates verified against a coordinate-grid overlay rendered from the
 * source itself (1181x667):
 *   columns x = 392 + i * 155   (i = 0..4, card width 145)
 *   rows    y = 87 / 263 / 438  (row pitch ≈ 175.5)
 *   portrait band = card minus the name strip: height 122 (the strip's top
 *   edge sits at ≈216 / ≈398 / ≈585, so every crop ends clear of baked
 *   label pixels; the HTML strip covers the rest).
 *
 * Row 3 of the mock carries only four cards (VIDEO, FINANCE, SALES,
 * SUPPORT) — the 15th agent (TRAVEL) reuses its voice-dock portrait
 * (v14.webp), appended by crew-inject.js.
 *
 * Output: trizempire/.crew-tmp/c00..c13.webp (WebP keeps the embedded data
 * URIs small: dark photographic content compresses well).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = 'C:/Users/USER/Documents/New folder/Hemes/Hemes/mater.png';
const TMP = path.resolve(__dirname, '..', 'trizempire', '.crew-tmp');
fs.mkdirSync(TMP, { recursive: true });

const NAMES = ['Orchestrator', 'Research', 'Writer', 'Developer', 'Data',
               'Email', 'Marketing', 'SEO', 'Social', 'Design',
               'Video', 'Finance', 'Sales', 'Support'];
const COL_X = [392, 547, 702, 857, 1012];
const ROW_Y = [87, 263, 438];
const W = 145, H = 122;

(async () => {
  for (let i = 0; i < NAMES.length; i++) {
    const col = i % 5, row = Math.floor(i / 5);
    let left = COL_X[col], top = ROW_Y[row], w = W, h = H;
    if (i === 0) {
      /* ORCHESTRATOR is the selected card in the mock: its orange border +
         glow are baked into the crop's edges — inset far enough to lose them. */
      left += 5; top += 6; w -= 16; h -= 10;
    }
    const file = 'c' + String(i).padStart(2, '0') + '.webp';
    let img = sharp(SRC).clone().extract({ left, top, width: w, height: h });
    if (i === 13) {
      /* SUPPORT is mid-fade in the video frame — lift it back to the
         brightness of its neighbours so the grid reads uniformly. */
      img = img.modulate({ brightness: 1.45 }).gamma(1.25);
    }
    await img.webp({ quality: 82 }).toFile(path.join(TMP, file));
    console.log(file, NAMES[i], `(${left},${top}) ${w}x${h}`);
  }
  console.log('cropped', NAMES.length, 'portraits into', TMP);
})().catch(err => { console.error(err); process.exit(1); });
