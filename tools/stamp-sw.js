'use strict';
/*
 * stamp-sw.js — derive the service-worker cache name from a hash of the precached assets.
 *
 *   node tools/stamp-sw.js           rewrite sw.js if the assets changed
 *   node tools/stamp-sw.js --check   exit 1 if the stamp is stale; write nothing
 *
 * Why this exists. sw.js installs with `cache: 'reload'`, so it re-fetches every asset from the
 * network whenever the browser runs its install handler — and the browser only does that when
 * sw.js's *bytes* change. Editing css/app.css or regenerating js/data.js leaves sw.js
 * byte-identical, so install never re-runs and installed phones fall back on the fetch handler's
 * lazy per-asset revalidation. That does eventually catch up, but it updates one file at a time,
 * so there is a window where a new js/data.js is paired with an old js/fairmap.js. Those two are
 * coupled, and that pairing is what breaks.
 *
 * Folding an asset hash into the cache name makes any asset change a sw.js change, which turns
 * every deploy into one atomic swap: install fills a new cache from the network, activate deletes
 * the old one, and shell.js reloads the page onto it.
 *
 * The stamp is a pure function of asset contents — no clock, no counter. Rebuilding unchanged
 * sources is a no-op, and re-running this is idempotent, so it is safe to call from a build step.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SW = path.join(ROOT, 'sw.js');
const PREFIX = 'isf-2026';

const CACHE_RE = /(const CACHE = ')([^']*)(';)/;
const ASSETS_RE = /const ASSETS = \[([\s\S]*?)\n\];/;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/*
 * The asset list is read back out of sw.js rather than duplicated here, so the two can't drift.
 * A second copy of that list is exactly the kind of thing that goes stale silently.
 */
function assetPaths(src) {
  const block = src.match(ASSETS_RE);
  if (!block) throw new Error('could not find the ASSETS array in sw.js');
  const urls = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (!urls.length) throw new Error('ASSETS in sw.js is empty');

  // './' is the directory index; everything else is already a file path relative to the root.
  return urls.map((url) => {
    const rel = url.replace(/^\.\//, '');
    return { url, rel: rel === '' ? 'index.html' : rel };
  });
}

function computeStamp(src) {
  const missing = [];
  const lines = assetPaths(src).map(({ url, rel }) => {
    const file = path.join(ROOT, rel);
    let digest;
    try {
      digest = sha(fs.readFileSync(file));
    } catch {
      // Not fatal: sw.js tolerates an asset it can't cache. But it is worth saying out loud,
      // and it still has to hash deterministically or the stamp would flap.
      missing.push(rel);
      digest = 'MISSING';
    }
    return `${url} ${digest}`;
  });
  return { stamp: sha(lines.join('\n')).slice(0, 8), missing, count: lines.length };
}

function read() {
  const src = fs.readFileSync(SW, 'utf8');
  if (!CACHE_RE.test(src)) throw new Error("could not find `const CACHE = '...'` in sw.js");
  const current = src.match(CACHE_RE)[2];
  const { stamp, missing, count } = computeStamp(src);
  return { src, current, wanted: `${PREFIX}-${stamp}`, missing, count };
}

/* Returns true when sw.js is already current. In check mode, never writes. */
function stamp({ check = false, quiet = false } = {}) {
  const { src, current, wanted, missing, count } = read();
  const say = (msg) => { if (!quiet) console.log(msg); };

  for (const m of missing) console.warn(`stamp-sw: warning — precached asset not on disk: ${m}`);

  if (current === wanted) {
    say(`stamp-sw: sw.js cache is current  (${wanted}, ${count} assets)`);
    return true;
  }
  if (check) {
    console.error(`stamp-sw: sw.js cache is stale — is '${current}', should be '${wanted}'.`);
    console.error('stamp-sw: run `node tools/stamp-sw.js` before deploying, or phones keep the old copy.');
    return false;
  }

  fs.writeFileSync(SW, src.replace(CACHE_RE, `$1${wanted}$3`));
  say(`stamp-sw: sw.js cache ${current} -> ${wanted}  (${count} assets)`);
  return true;
}

module.exports = { stamp, computeStamp };

if (require.main === module) {
  try {
    const ok = stamp({ check: process.argv.includes('--check') });
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`stamp-sw: ${e.message}`);
    process.exit(2);
  }
}
