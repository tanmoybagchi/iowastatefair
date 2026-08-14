'use strict';
/*
 * make-icons.js — rasterise icon.svg into the PNGs that installed apps actually need.
 *
 *   node tools/make-icons.js           regenerate the PNGs
 *   node tools/make-icons.js --check   exit 1 if any is missing or the wrong size
 *
 * Why PNGs exist at all when there is a perfectly good SVG: iOS ignores the web manifest's icons
 * for "Add to Home Screen" and reads <link rel="apple-touch-icon"> instead, which does not accept
 * SVG. Without a PNG, an installed iPhone shortcut gets a screenshot of the page or a grey tile.
 * Android is happy with the SVG, but 192 and 512 PNGs are what install prompts and splash screens
 * expect, so they are cheap insurance.
 *
 * Chrome does the rasterising. That sounds heavy, but tools/smoke.js already requires a local
 * Chrome, so this adds no new dependency to a project that deliberately has none — and it means
 * the PNGs are rendered by the same engine that will display the SVG.
 *
 * The SVG stays the source of truth: edit icon.svg, re-run this, and re-run tools/stamp-sw.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findChrome } = require('./chrome.js');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'icon.svg');

/*
 * 180 is the size iOS asks for on modern devices; 192 and 512 are the manifest pair Chrome wants
 * for install prompts and the Android splash screen.
 *
 * The maskable variants exist because the artwork does not fit Android's safe zone. A maskable
 * icon may be cropped to any shape inside a circle of 80% diameter, and the corn dog's stick
 * reaches about 216px from the centre of the 512 artboard against a 204.8px safe radius — so a
 * circular mask would clip the end off it. Rather than redraw, these render the same SVG inset by
 * 10% on a full-bleed brand-red field: every mask shape then lands on red, and nothing is lost.
 *
 * Keep this in step with the `icons` array in manifest.webmanifest and ASSETS in sw.js.
 */
const SIZES = [180, 192, 512];
const MASKABLE_SIZES = [192, 512];
const nameFor = (size) => `icon-${size}.png`;
const maskableNameFor = (size) => `icon-maskable-${size}.png`;

/** Every PNG this tool is responsible for, as [filename, pixel size]. */
const outputs = () => [
  ...SIZES.map(s => [nameFor(s), s]),
  ...MASKABLE_SIZES.map(s => [maskableNameFor(s), s]),
];

/** Width and height out of a PNG's IHDR chunk — bytes 16..23, big-endian. */
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24) return null;
    if (head.toString('binary', 1, 4) !== 'PNG') return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function check() {
  let ok = true;
  const all = outputs();
  for (const [name, size] of all) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) {
      console.error(`make-icons: missing ${name}`);
      ok = false;
      continue;
    }
    const dim = pngSize(file);
    if (!dim || dim.width !== size || dim.height !== size) {
      console.error(`make-icons: ${name} is ${dim ? `${dim.width}x${dim.height}` : 'not a PNG'}, expected ${size}x${size}`);
      ok = false;
    }
  }
  if (ok) console.log(`make-icons: all ${all.length} PNGs present and correctly sized`);
  return ok;
}

function render() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('make-icons: no Chrome or Edge found — cannot rasterise. See tools/chrome.js.');
    return false;
  }
  const svg = fs.readFileSync(SVG, 'utf8');

  // Taken from the artwork rather than hardcoded, so the maskable field can't drift out of step
  // with the tile if the brand colour ever changes.
  const bg = (svg.match(/<rect[^>]*fill="(#[0-9a-fA-F]{3,6})"/) || [])[1];
  if (!bg) {
    console.error('make-icons: could not read the background colour from icon.svg — expected a ' +
      '<rect ... fill="#rrggbb">. Add one, or the maskable icons would have transparent corners.');
    return false;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isf-icons-'));

  try {
    for (const [name, size] of outputs()) {
      const maskable = name.includes('maskable');
      /*
       * The SVG is inlined rather than referenced with <img src>, which sidesteps every file://
       * path and loading-order question — by the time Chrome paints, the artwork is already there.
       * It carries a viewBox and no intrinsic width, so CSS sizing scales it cleanly.
       *
       * Maskable variants inset the artwork by 10% and paint the page the brand colour, which is
       * what puts every drawn pixel inside the 80% safe circle.
       */
      const inset = maskable ? Math.round(size * 0.1) : 0;
      const page = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: ${maskable ? bg : 'transparent'}; }
  svg { display: block; width: ${size - inset * 2}px; height: ${size - inset * 2}px;
        margin: ${inset}px; }
</style>${svg}`;
      const wrapper = path.join(tmp, `${name}.html`);
      fs.writeFileSync(wrapper, page);

      const out = path.join(ROOT, name);
      const res = spawnSync(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run', '--no-default-browser-check',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',      // 1 CSS px == 1 image px, whatever the display
        '--virtual-time-budget=2000',         // let it finish painting before the capture
        `--window-size=${size},${size}`,
        `--screenshot=${out.replace(/\\/g, '/')}`,
        `file://${wrapper.replace(/\\/g, '/')}`,
      ], { encoding: 'utf8', timeout: 60000 });

      const dim = fs.existsSync(out) ? pngSize(out) : null;
      if (!dim || dim.width !== size || dim.height !== size) {
        console.error(`make-icons: failed to render ${name}` +
          `${dim ? ` — got ${dim.width}x${dim.height}` : ''}`);
        if (res.stderr) console.error(res.stderr.trim().split('\n').slice(-3).join('\n'));
        return false;
      }
      console.log(`make-icons: wrote ${name.padEnd(24)} ${dim.width}x${dim.height}` +
        `${maskable ? '  (10% inset, maskable)' : ''}  ` +
        `${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
    }
    return true;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir, let it go */ }
  }
}

module.exports = { SIZES, MASKABLE_SIZES, nameFor, maskableNameFor, outputs, check, render, pngSize };

if (require.main === module) {
  const ok = process.argv.includes('--check') ? check() : render();
  process.exit(ok ? 0 : 1);
}
