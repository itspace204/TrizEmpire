/* Crop the voice-mode portraits out of the reference screenshot (2.png) with sharp.
 * v4 — verified coordinates:
 *   hero: (813,295) 470x470 frames the glowing circle exactly — no caption band,
 *         no Talk button, symmetric margins (checked by rendering the crop).
 *   thumbs: pitch ≈81.4px starting at x=510, vertical center y=925, D=62.
 *   v06 (center x=997): the screenshot's mouse cursor covers its left third, so
 *         the right half is mirrored over the left half after extraction.
 * Output: trizempire/.voice-tmp/hero.webp + v00..v14.webp (WebP keeps the
 * embedded data URIs small: dark photographic content compresses well).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = 'C:/Users/USER/Downloads/2.png';
const TMP = path.resolve(__dirname, '..', 'trizempire', '.voice-tmp');
fs.mkdirSync(TMP, { recursive: true });

const HERO = { left: 813, top: 295, size: 470 };
const NAMES = ['Executor', 'Research', 'Data', 'Content', 'Email', 'Marketing', 'SEO',
               'Social', 'Design', 'Video', 'Finance', 'Sales', 'Support', 'Developer', 'Travel'];
const CENTERS = [510, 591, 672, 753, 835, 916, 997, 1078, 1159, 1240, 1321, 1402, 1484, 1565, 1646];
const CY = 925, D = 62;
const CURSOR_INDEX = 6; // SEO — cursor artifact sits on this thumb

(async () => {
  await sharp(SRC).clone()
    .extract({ left: HERO.left, top: HERO.top, width: HERO.size, height: HERO.size })
    .webp({ quality: 88 })
    .toFile(path.join(TMP, 'hero.webp'));
  console.log('hero saved', HERO.size + 'x' + HERO.size);

  for (let i = 0; i < NAMES.length; i++) {
    const left = Math.round(Math.max(0, Math.min(CENTERS[i] - D / 2, 1920 - D)));
    const buf = await sharp(SRC).clone()
      .extract({ left, top: CY - Math.round(D / 2), width: D, height: D })
      .resize({ width: 124, height: 124 })
      .png().toBuffer();

    let out = sharp(buf);
    if (i === CURSOR_INDEX) {
      /* Mirror the clean right half over the cursor-covered left half. */
      const half = Math.floor(124 / 2);
      const right = await sharp(buf).extract({ left: 124 - half, top: 0, width: half, height: 124 })
        .flop().raw().toBuffer();
      out = sharp(buf).composite([{
        input: right, raw: { width: half, height: 124, channels: 4 },
        left: 0, top: 0,
      }]);
    }
    await out.webp({ quality: 82 })
      .toFile(path.join(TMP, 'v' + String(i).padStart(2, '0') + '.webp'));
  }
  console.log('thumbs saved:', NAMES.length);
})().catch(e => { console.error(e); process.exit(1); });
