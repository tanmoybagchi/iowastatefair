'use strict';
/*
 * build-data.js — assemble every source into js/data.js, and print a QA report.
 *
 *   node tools/build-data.js            build + report
 *   node tools/build-data.js --report   report only, don't write
 *
 * Inputs
 *   _source/osm/geom.json   OpenStreetMap footprints/paths (see fetch-osm.sh)
 *   tools/parse-reports.js  the 6 generated report PDFs -> stands, menus, dietary rows
 *   tools/source-manual.js  the 3 print-art PDFs -> landmark grid refs, water, rankings
 *
 * Output
 *   js/data.js              `window.FAIR = {...}` — a plain script, not JSON, so the app works
 *                           from file://, a Caddy subpath and GitHub Pages alike.
 *
 * The interesting part is geocoding: the vendor reports describe locations as prose relative to
 * landmarks ("Outside NE Corner of VI Bldg"). Accuracy is tiered and every stand records which
 * tier it came from, so the UI can avoid claiming precision it doesn't have.
 */

const fs = require('fs');
const path = require('path');
const { parseAll } = require('./parse-reports.js');
const M = require('./source-manual.js');

const ROOT = path.join(__dirname, '..');
const REPORT_ONLY = process.argv.includes('--report');

// Fairgrounds bounding box, used to reject stray OSM geometry from the surrounding
// neighbourhood and to detect "user isn't at the fair" at runtime.
const BOUNDS = { minLat: 41.5905, maxLat: 41.5995, minLon: -93.5600, maxLon: -93.5455 };

const FT_PER_DEG_LAT = 364000;
const cosLat = Math.cos(41.595 * Math.PI / 180);
const feet = (dLat, dLon) => Math.hypot(dLat * FT_PER_DEG_LAT, dLon * FT_PER_DEG_LAT * cosLat);
const r5 = n => Math.round(n * 1e5) / 1e5;
const r6 = n => Math.round(n * 1e6) / 1e6;
const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * Tidy a location string for display.
 *
 * Some labels in the vendor report begin with the space number ("50375, South of Service
 * Center") because that's how the vendor wrote it. It's noise to a visitor and it leaked into
 * every screen, so strip it once here rather than in each page.
 */
const cleanLoc = s => (s || '')
  .replace(/^\d{3,6}\s*,?\s*/, '')
  .replace(/\s+/g, ' ')
  .trim();

const warnings = [];
const warn = (cat, msg) => warnings.push({ cat, msg });

// ---------------------------------------------------------------------------
// 1. OpenStreetMap geometry
// ---------------------------------------------------------------------------

function loadOsm() {
  const file = path.join(ROOT, '_source', 'osm', 'geom.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const inBounds = (la, lo) =>
    la >= BOUNDS.minLat && la <= BOUNDS.maxLat && lo >= BOUNDS.minLon && lo <= BOUNDS.maxLon;

  const buildings = [], paths = [], areas = [], toilets = [];
  for (const el of raw.elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const pts = el.geometry.filter(p => p && p.lat != null).map(p => [p.lat, p.lon]);
    if (pts.length < 2) continue;
    // Keep a way if any vertex is inside the fairgrounds box.
    if (!pts.some(p => inBounds(p[0], p[1]))) continue;
    const t = el.tags || {};
    const rec = { name: t.name || null, pts };
    if (t.building) buildings.push(rec);
    else if (t.highway) paths.push({ ...rec, kind: t.highway });
    else if (t.leisure || t.landuse) areas.push({ ...rec, kind: t.leisure || t.landuse });
    /*
     * Restroom blocks are also buildings, so they stay in `buildings` and keep being drawn on the
     * map. This is a second reference to the same way, kept because the restroom list needs the
     * accessibility tags and `buildings` deliberately carries nothing but a name and an outline.
     */
    if (t.amenity === 'toilets') {
      toilets.push({ pts, wheelchair: t.wheelchair === 'yes', changing: t.changing_table === 'yes' });
    }
  }

  /*
   * osm.json is the centres-and-tags companion file (see fetch-osm.sh); the only thing taken from
   * it is restrooms mapped as a bare node rather than an outlined building — currently one, by the
   * MidAmerican Energy Stage. Optional on purpose: geom.json is the file this build genuinely needs,
   * and a missing companion should cost one restroom, not the whole run.
   */
  const nodeFile = path.join(ROOT, '_source', 'osm', 'osm.json');
  if (fs.existsSync(nodeFile)) {
    for (const el of JSON.parse(fs.readFileSync(nodeFile, 'utf8')).elements) {
      if (el.type !== 'node' || !el.tags || el.tags.amenity !== 'toilets') continue;
      if (!inBounds(el.lat, el.lon)) continue;
      toilets.push({
        pts: [[el.lat, el.lon]],
        wheelchair: el.tags.wheelchair === 'yes',
        changing: el.tags.changing_table === 'yes',
      });
    }
  } else {
    warn('osm', 'no _source/osm/osm.json — restrooms mapped as a plain node are missing');
  }

  return { buildings, paths, areas, toilets };
}

/** Area-weighted centroid of a closed ring, falling back to the mean vertex. */
function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [y1, x1] = pts[i], [y2, x2] = pts[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    a += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length,
            pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }
  a *= 0.5;
  return [cy / (6 * a), cx / (6 * a)];
}

/*
 * Distance in feet. Equirectangular rather than haversine: over a 3,000 ft fairground the error is
 * far under a foot, and this is only ever used to pick and describe a nearby landmark.
 */
function distFt(lat1, lon1, lat2, lon2) {
  const R = 20902231;                                     // earth radius in feet
  const p = Math.PI / 180;
  const y = (lat2 - lat1) * p * R;
  const x = (lon2 - lon1) * p * R * Math.cos(((lat1 + lat2) / 2) * p);
  return Math.hypot(x, y);
}

function bbox(pts) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [la, lo] of pts) {
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
  }
  return { minLat, maxLat, minLon, maxLon };
}

// ---------------------------------------------------------------------------
// 2. Landmark registry: canonical name -> {grid?, polygon?, centre}
// ---------------------------------------------------------------------------

/*
 * OSM names are the formal/donor names ("William C. Knapp Varied Industries Building") while
 * the map index and vendor reports use short ones ("Varied Industries Building"). This maps
 * canonical landmark -> the OSM name to match, where they differ.
 */
const OSM_NAME = {
  'Varied Industries Building': 'William C. Knapp Varied Industries Building',
  'Agriculture Building': 'John Deere Agriculture Building',
  'Animal Learning Center': 'Paul R. Knapp Animal Learning Center',
  'Cultural Center': 'Patty & Jim Cownie Cultural Center',
  '4-H Exhibits Building': 'Bruce L. Rastetter 4-H Exhibits Building',
  'Youth Inn': 'Oman Family Youth Inn',
  'Cattle Barn': 'John & Emily Putney Family Cattle Barn',
  'Jacobson Exhibition Center': 'Richard O. Jacobson Exhibition Center',
  'Service Center': 'Robert G. Horner & Sheri Avis Horner Service Center',
  'Food Center': 'Elwell Family Food Center',
  'First Aid Center': 'Hy-Vee Health & First Aid Center',
  'Pioneer Hall': 'Farm Bureau Pioneer Hall',
  'Museum Complex': 'Ralph H. Deets Historical Museum',
  'Poultry and Rabbit Building': 'Pigeon-Poultry-Rabbit Building',
  'Grandfather’s Barn': 'Vermeer Grandfather’s Barn',
  'Livestock Pavilion': 'Livestock Pavillion',      // OSM spelling
  'Outdoor Arena': 'Bob & Deb Pulver Outdoor Arena',
  'Wind Turbine & Education Center': 'MidAmerican Energy Education Center',
  'Maytag Family Theaters': 'Maytag Family Theater',
  'Iowa State Fair Police': 'ISF Police',
  'Old West BBQ': 'Old West Bar-B-Q',
  'Cattlemen’s Beef Quarters': "Cattlemen's Beef Quarters",
  'Jalapeño Pete’s': 'Jalapeño Pete\'s',
  'The Bud Tent': 'Bud Tent',
  'Anne & Bill Riley Stage': 'Anne & Bill Riley Stage',
  'Sheep Barn': 'Sheep Barn',
  'Swine Barn': 'Swine Barn',
  'Horse Barn': 'Horse Barn',
  'Stalling Barn': 'Stalling Barn',
  'Gammon Barn': 'Gammon Barn',
  'Walnut Center': 'Walnut Center',
  'Administration Building': 'Administration Building',
  'Grandstand': 'Grandstand',
  'DNR Building': 'DNR Building',
  'First Church': 'First Church',
  'Fun Forest Stage': 'Fun Forest Stage',
  'Iowa Craft Beer Tent': 'Iowa Craft Beer Tent',
  'Blue Ribbon Bar & Eatery': 'Blue Ribbon Bar & Eatery',
  'Iowa Pork Tent': 'Iowa Pork Tent',
  'Susan Knapp Amphitheater': 'Susan Knapp Amphitheater',
  'Hillcrest Dorm': 'Hillcrest Dorm',
  'Ice & Feed': 'Ice and Feed',
  'Print Shop': 'Print Shop',
  'Fire Station': 'Fire Station',
  'Maintenance Building': 'Maintenance Building',
  'FFA': 'FFA Headquarters',
  'Elwell Family Park': 'Elwell Family Park',
  'The Depot': 'The Depot',
  'WHO Crystal Studio': 'WHO Crystal Radio',
};

function gridOf(entry) {
  if (!entry) return null;
  return typeof entry === 'string' ? { grid: entry, est: false } : { grid: entry.grid, est: !!entry.est };
}
const gridCol = g => parseInt(g.match(/\d+/)[0], 10);
const gridRow = g => g.match(/[A-O]/)[0].charCodeAt(0) - 64;

function buildLandmarks(osm) {
  const byOsmName = new Map();
  for (const b of osm.buildings) if (b.name) byOsmName.set(b.name, b);

  const marks = new Map();
  const allNames = new Set([...Object.keys(M.LANDMARK_GRID), ...Object.values(M.ALIASES)]);

  for (const name of allNames) {
    const g = gridOf(M.LANDMARK_GRID[name]);
    const osmName = OSM_NAME[name] || name;
    const poly = byOsmName.get(osmName) || null;
    marks.set(name, {
      name,
      grid: g ? g.grid : null,
      gridEst: g ? g.est : false,
      poly: poly ? poly.pts : null,
      osmCentre: poly ? centroid(poly.pts) : null,
    });
  }

  // Any named OSM building not already covered becomes a landmark too — useful for the map
  // and for "near X" lookups even if no vendor references it.
  for (const [osmName, b] of byOsmName) {
    const known = [...marks.values()].some(m => (OSM_NAME[m.name] || m.name) === osmName);
    if (known) continue;
    marks.set(osmName, { name: osmName, grid: null, gridEst: false, poly: b.pts, osmCentre: centroid(b.pts) });
  }
  return marks;
}

// ---------------------------------------------------------------------------
// 3. Grid -> lat/lng affine fit
// ---------------------------------------------------------------------------

/*
 * Least squares on   value = p0 + p1*col + p2*row   using every landmark that has BOTH a
 * printed grid ref and an OSM footprint. Landmarks whose grid cell was estimated off the
 * artwork are excluded from the fit so they can't drag it.
 */
function fitTransform(marks) {
  const all = [...marks.values()].filter(m => m.grid && m.osmCentre && !m.gridEst);
  let anchors = all;
  let X = anchors.map(m => [1, gridCol(m.grid), gridRow(m.grid)]);

  const solve = (vals) => {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) S[i][j] = X.reduce((s, x) => s + x[i] * x[j], 0);
      b[i] = X.reduce((s, x, k) => s + x[i] * vals[k], 0);
    }
    const A = S.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < 3; i++) {
      let p = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
      [A[i], A[p]] = [A[p], A[i]];
      for (let k = i + 1; k < 3; k++) {
        const f = A[k][i] / A[i][i];
        for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let s = A[i][3];
      for (let j = i + 1; j < 3; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  };

  const residuals = (PLA, PLO) => anchors.map(m => {
    const c = gridCol(m.grid), r = gridRow(m.grid);
    const la = PLA[0] + PLA[1] * c + PLA[2] * r;
    const lo = PLO[0] + PLO[1] * c + PLO[2] * r;
    return { name: m.name, ft: feet(la - m.osmCentre[0], lo - m.osmCentre[1]) };
  });

  /*
   * Fit, then discard anchors more than 2.5x the median error and refit — twice.
   *
   * A handful of anchors are genuinely mismatched rather than merely imprecise: the printed
   * index sometimes cites the grid cell of an entrance or a sign rather than the building whose
   * OSM footprint we paired it with. Left in, those outliers drag the whole transform, which
   * then degrades every grid-derived pin. Trimming is reported, not silent.
   */
  let PLA = solve(anchors.map(m => m.osmCentre[0]));
  let PLO = solve(anchors.map(m => m.osmCentre[1]));
  const trimmed = [];
  for (let pass = 0; pass < 2; pass++) {
    const res = residuals(PLA, PLO);
    const sorted = res.map(r => r.ft).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const cutoff = Math.max(median * 2.5, 120);
    const keep = [], drop = [];
    res.forEach((r, i) => {
      if (r.ft > cutoff) { drop.push(anchors[i]); trimmed.push(r); }
      else keep.push(anchors[i]);
    });
    if (!drop.length || keep.length < 12) break;
    anchors = keep;
    X = anchors.map(m => [1, gridCol(m.grid), gridRow(m.grid)]);
    PLA = solve(anchors.map(m => m.osmCentre[0]));
    PLO = solve(anchors.map(m => m.osmCentre[1]));
  }

  const at = (col, row) => [PLA[0] + PLA[1] * col + PLA[2] * row, PLO[0] + PLO[1] * col + PLO[2] * row];
  const errs = residuals(PLA, PLO).sort((a, b) => b.ft - a.ft);
  const mean = errs.reduce((s, e) => s + e.ft, 0) / (errs.length || 1);
  const cell = {
    col: feet(PLA[1], PLO[1]),
    row: feet(PLA[2], PLO[2]),
  };
  return { at, anchors: anchors.length, considered: all.length, trimmed, errs, mean, cell, PLA, PLO };
}

// ---------------------------------------------------------------------------
// 4. Geocoding stand locations
// ---------------------------------------------------------------------------

const DIRS = {
  n: [1, 0], s: [-1, 0], e: [0, 1], w: [0, -1],
  ne: [1, 1], nw: [1, -1], se: [-1, 1], sw: [-1, -1],
};

/* Word forms that appear in the reports, longest first so "north east" beats "north". */
const DIR_WORDS = [
  ['north east', 'ne'], ['north west', 'nw'], ['south east', 'se'], ['south west', 'sw'],
  ['northeast', 'ne'], ['northwest', 'nw'], ['southeast', 'se'], ['southwest', 'sw'],
  ['ne', 'ne'], ['nw', 'nw'], ['se', 'se'], ['sw', 'sw'],
  ['north', 'n'], ['south', 's'], ['east', 'e'], ['west', 'w'],
  ['n.', 'n'], ['s.', 's'], ['e.', 'e'], ['w.', 'w'],
  ['n', 'n'], ['s', 's'], ['e', 'e'], ['w', 'w'],
];

/** Alias keys sorted longest-first so "grand concourse" wins over "grand ave". */
const ALIAS_KEYS = Object.keys(M.ALIASES).sort((a, b) => b.length - a.length);
const STREETS = new Set(['Grand Concourse', 'Rock Island Avenue']);

/**
 * Bearing (degrees) from a building's centre toward the nearest path or road.
 *
 * Used for "front of X", which is genuinely ambiguous otherwise: the Grandstand's front faces
 * south onto the Grand Concourse while the Varied Industries Building's front faces north onto
 * the same road. Deriving it from the nearest way handles both without special-casing.
 */
function frontBearing(poly, osmPaths) {
  const c = centroid(poly);
  // Only NAMED ways count: those are the concourses and avenues a stand can front onto.
  // Using any way at all picked unnamed service roads and alleys running behind buildings,
  // which put "In front of Grandstand" on the wrong side of the Grandstand.
  const named = osmPaths.filter(p => p.name);
  const pool = named.length ? named : osmPaths;
  let best = null, bestD = Infinity;
  for (const p of pool) {
    for (const pt of p.pts) {
      const d = feet(pt[0] - c[0], pt[1] - c[1]);
      if (d < bestD && d > 5) { bestD = d; best = pt; }
    }
  }
  if (!best) return null;
  // Snap to the dominant axis so the result is one of the eight compass directions.
  const dLatFt = (best[0] - c[0]) * FT_PER_DEG_LAT;
  const dLonFt = (best[1] - c[1]) * FT_PER_DEG_LAT * cosLat;
  return Math.abs(dLatFt) >= Math.abs(dLonFt)
    ? { dLat: Math.sign(dLatFt), dLon: 0 }
    : { dLat: 0, dLon: Math.sign(dLonFt) };
}

/**
 * Resolve a stand's prose location to a coordinate.
 *
 * Tiers (recorded on each stand as `src`):
 *   edge    a compass corner/side of a landmark we have a real OSM footprint for
 *   inside  explicitly indoors ("Main Floor of Ag Bldg") -> footprint centroid
 *   offset  "SW of Ag Bldg" -> ~35 m out from the footprint edge along that bearing
 *   grid    landmark has no footprint -> official grid ref through the affine transform
 *   none    no landmark recognised
 */
function geocode(locationRaw, marks, tf, osmPaths) {
  const raw = (locationRaw || '').trim();
  if (!raw || /^tbd$/i.test(raw)) return { src: 'none', reason: 'no location given' };

  // Strip leading space numbers ("30130,N Side of Grand...") and normalise punctuation.
  let s = raw.toLowerCase()
    .replace(/^\d{3,6}\s*,?\s*/, '')
    .replace(/[’']/g, '’')
    .replace(/\s+/g, ' ');

  // Find every landmark mention with its position in the string.
  const hits = [];
  for (const key of ALIAS_KEYS) {
    let from = 0, idx;
    while ((idx = s.indexOf(key, from)) !== -1) {
      const before = s[idx - 1], after = s[idx + key.length];
      const wordish = c => c && /[a-z0-9]/.test(c);
      if (!wordish(before) && !wordish(after)) {
        hits.push({ key, name: M.ALIASES[key], idx });
      }
      from = idx + key.length;
    }
  }
  if (!hits.length) return { src: 'none', reason: `unrecognised location: "${raw}"` };

  // Drop mentions contained inside a longer mention at the same place.
  const kept = hits.filter(h => !hits.some(o => o !== h && o.idx <= h.idx && o.idx + o.key.length >= h.idx + h.key.length));

  // Choose the anchor: prefer a real place over a street name, then the last mention —
  // these strings put the general area first and the specific anchor last
  // ("North Side of Grand Ave., Front of Grandstand").
  const nonStreet = kept.filter(h => !STREETS.has(h.name));
  const pool = nonStreet.length ? nonStreet : kept;
  const withGeom = pool.filter(h => marks.get(h.name) && marks.get(h.name).poly);
  const anchor = (withGeom.length ? withGeom : pool).reduce((a, b) => (b.idx > a.idx ? b : a));

  const mark = marks.get(anchor.name);
  if (!mark) return { src: 'none', reason: `no landmark record for ${anchor.name}` };

  /*
   * Relation + direction come from the text between the PREVIOUS landmark mention and the
   * anchor — not from a fixed-width window, which would steal a direction word belonging to a
   * different landmark. "N. side of Grand, Front of Grandstand" is the case that matters: the
   * "N." qualifies Grand Avenue, and applying it to the Grandstand put the stand on the far
   * side of the building from the street it actually fronts.
   */
  const prevEnd = kept
    .filter(h => h.idx + h.key.length <= anchor.idx)
    .reduce((max, h) => Math.max(max, h.idx + h.key.length), 0);
  const ctx = s.slice(Math.max(prevEnd, Math.max(0, anchor.idx - 44)), anchor.idx);
  let relation = 'offset';
  if (/\b(main floor|balcony|inside|in the|in$|in $|courtyard|under .* stairs)\b/.test(ctx) ||
      /^(in|inside)\b/.test(s) || /\bin (the )?$/.test(ctx)) relation = 'inside';
  // "front" is checked before "side" so "Front Side of Grandstand" resolves to the front,
  // rather than becoming a side with no direction and collapsing to the building centre.
  if (/\bcorner\b/.test(ctx)) relation = 'corner';
  else if (/\bfront\b/.test(ctx)) relation = 'front';
  else if (/\b(side|canopy|end)\b/.test(ctx)) relation = 'side';
  else if (/\b(outer perimeter|perimeter)\b/.test(ctx)) relation = 'side';

  let dir = null;
  for (const [word, code] of DIR_WORDS) {
    const re = new RegExp(`(^|[^a-z])${word.replace('.', '\\.')}([^a-z]|$)`);
    if (re.test(ctx)) { dir = code; break; }
  }

  // --- no footprint: fall back to the grid ---
  if (!mark.poly) {
    if (!mark.grid) return { src: 'none', reason: `${anchor.name} has neither footprint nor grid ref` };
    const [la, lo] = tf.at(gridCol(mark.grid), gridRow(mark.grid));
    return {
      lat: la, lon: lo, src: 'grid', conf: mark.gridEst ? 'low' : 'medium',
      landmark: anchor.name, relation, dir,
    };
  }

  const box = bbox(mark.poly);
  const c = centroid(mark.poly);

  if (relation === 'inside' || (!dir && relation === 'offset' && /^(in|at)\b/.test(s))) {
    return { lat: c[0], lon: c[1], src: 'inside', conf: 'high', landmark: anchor.name, relation: 'inside', dir: null };
  }

  let vec = dir ? DIRS[dir] : null;
  if (!vec && relation === 'front') {
    const fb = frontBearing(mark.poly, osmPaths);
    if (fb) vec = [fb.dLat, fb.dLon];
  }
  if (!vec) {
    // Landmark named with no usable direction — the building itself is the best answer.
    return { lat: c[0], lon: c[1], src: 'inside', conf: 'medium', landmark: anchor.name, relation: 'at', dir: null };
  }

  // Corner/side points come off the real footprint box; "of" pushes further out.
  const [dLat, dLon] = vec;
  const halfLat = (box.maxLat - box.minLat) / 2;
  const halfLon = (box.maxLon - box.minLon) / 2;
  const pad = relation === 'offset' ? 35 : 8;                 // metres beyond the edge
  const padLat = (pad / 0.3048) / FT_PER_DEG_LAT;
  const padLon = (pad / 0.3048) / (FT_PER_DEG_LAT * cosLat);

  const lat = c[0] + dLat * (halfLat + padLat);
  const lon = c[1] + dLon * (halfLon + padLon);
  return {
    lat, lon,
    src: relation === 'offset' ? 'offset' : 'edge',
    conf: relation === 'offset' ? 'medium' : 'high',
    landmark: anchor.name, relation, dir,
  };
}

// ---------------------------------------------------------------------------
// 5. Zone cross-check from official space numbers
// ---------------------------------------------------------------------------

/*
 * Space numbers encode a zone. This is an INDEPENDENT signal from the prose location, so it
 * catches geocoding mistakes the prose parser can't see. Each entry gives a landmark the zone
 * should sit near, and a generous radius (zones are large).
 */
/*
 * Only 5-digit spaces carry the zone prefix. Six-digit ones (100525, 100530) are a separate
 * overflow series — reading their first two digits as a zone put "Camp 3, Heritage Area" in the
 * Grandstand zone and produced a false warning.
 */
const ZONES = [
  { test: n => /^10\d{3}$/.test(n), near: 'Grandstand', ft: 1400 },
  { test: n => /^20\d{3}$/.test(n), near: 'Ye Old Mill', ft: 2000 },
  { test: n => /^30\d{3}$/.test(n), near: 'Susan Knapp Amphitheater', ft: 1800 },
  { test: n => /^40\d{3}$/.test(n), near: 'Varied Industries Building', ft: 1600 },
  { test: n => /^50\d{3}$/.test(n), near: 'Administration Building', ft: 2200 },
  { test: n => /^70\d{3}$/.test(n), near: 'Jacobson Exhibition Center', ft: 1800 },
  { test: n => /^80\d{3}$/.test(n), near: 'Walnut Square', ft: 2600 },
  { test: n => /^35\d\d$/.test(n), near: 'Agriculture Building', ft: 700 },
];

function zoneCheck(stand, marks, tf) {
  if (stand.lat == null) return null;
  const z = ZONES.find(z => z.test(String(stand.space)));
  if (!z) return null;
  const m = marks.get(z.near);
  if (!m) return null;
  const c = m.osmCentre || (m.grid ? tf.at(gridCol(m.grid), gridRow(m.grid)) : null);
  if (!c) return null;
  const d = feet(stand.lat - c[0], stand.lon - c[1]);
  return d > z.ft ? { zone: z.near, ft: Math.round(d), limit: z.ft } : null;
}

// ---------------------------------------------------------------------------
// 6. Build
// ---------------------------------------------------------------------------

function build() {
  const osm = loadOsm();
  const marks = buildLandmarks(osm);
  const tf = fitTransform(marks);
  const { stands: rawStands, diets } = parseAll();

  /*
   * Some vendors ARE a building on this map: the Iowa Craft Beer Tent, The Depot, Blue Ribbon Bar &
   * Eatery. Their published location describes where that venue sits — "Iowa Craft Beer Tent, West
   * of Jacobson Exhibition Center" — and geocode() only ever reads the prose, so it derived an
   * offset from a *different* building and put the tent 193 ft from its own footprint. That's a
   * block, and it's the shape of the one field report we have.
   *
   * Where the vendor's name is exactly a landmark we hold a real outline for, that outline wins.
   * Restricted to marks with a polygon: a grid-only landmark is no better evidence than the prose.
   */
  /*
   * Word spacing is collapsed as well as punctuation, because the vendor report and the printed map
   * index disagree about it: "JR's SouthPork Ranch" against the landmark "JR’s South Pork Ranch".
   * norm() keeps the space, so those two are different strings and the match was silently missed.
   */
  const venueKey = s => norm(s).replace(/ /g, '');
  const selfVenues = new Map();
  for (const m of marks.values()) if (m.poly) selfVenues.set(venueKey(m.name), m);

  // --- stands ---
  const selfFixed = [];
  const stands = rawStands.map((s, i) => {
    let g = geocode(s.locationRaw, marks, tf, osm.paths);
    if (g.src === 'none') warn('geocode', `${s.vendor} [${s.space}] — ${g.reason}`);

    /*
     * Only the vaguest tiers are replaced. A named corner of the right building ("West Side of X")
     * is more specific than that building's centre, so `edge` and an existing `inside` are left
     * alone — no stand hits that guard today, but a future rebuild shouldn't be able to regress
     * through it. Matching is on the exact name: "Cattlemen's Beef Quarters - Express" is a
     * separate window somewhere else and must keep its own pin.
     */
    const venue = selfVenues.get(venueKey(s.vendor));
    if (venue && ['offset', 'grid', 'none'].includes(g.src)) {
      const c = centroid(venue.poly);
      selfFixed.push({
        name: s.vendor,
        space: s.space,
        from: `${g.src}/${g.conf || '—'}`,
        movedFt: g.lat != null ? Math.round(feet(g.lat - c[0], g.lon - c[1])) : null,
        wasFrom: cleanLoc(s.locationRaw),
      });
      g = { lat: c[0], lon: c[1], src: 'inside', conf: 'high', landmark: venue.name, relation: 'self', dir: null };
    }
    return {
      id: i,
      name: s.vendor,
      space: s.space,
      group: s.group,
      loc: cleanLoc(s.locationRaw),
      landmark: g.landmark || null,
      lat: g.lat != null ? r6(g.lat) : null,
      lon: g.lon != null ? r6(g.lon) : null,
      src: g.src,
      conf: g.conf || null,
      rel: g.relation || null,
      trunc: !!s.itemsTruncated,
      _items: s.items,
    };
  });

  for (const s of stands) {
    const z = zoneCheck(s, marks, tf);
    if (z) warn('zone', `${s.name} [${s.space}] geocoded ${z.ft} ft from ${z.zone} zone centre (limit ${z.limit}) via ${s.src}/${s.landmark}`);
  }

  /*
   * The remainder: stands named after a landmark we could NOT use, because that landmark is itself
   * only a grid reference. Reported rather than quietly dropped — JR's SouthPork Ranch is 364 ft
   * from its own grid square and there is no footprint, road match or photo that would place it
   * honestly, so it stays approximate and stays visible here.
   */
  const selfUnfixable = [];
  const marksByNorm = new Map();
  for (const m of marks.values()) marksByNorm.set(venueKey(m.name), m);
  for (const s of stands) {
    if (s.lat == null || s.rel === 'self') continue;
    const m = marksByNorm.get(venueKey(s.name));
    if (!m || m.poly || !m.grid) continue;
    const [la, lo] = tf.at(gridCol(m.grid), gridRow(m.grid));
    const ft = Math.round(feet(s.lat - la, s.lon - lo));
    if (ft > 60) selfUnfixable.push({ name: s.name, space: s.space, ft, src: s.src, loc: s.loc });
  }

  // --- items, deduped by name, each pointing at the stands that sell it ---
  const itemsByName = new Map();
  for (const s of stands) {
    for (const raw of s._items) {
      const key = norm(raw);
      if (!key) continue;
      let it = itemsByName.get(key);
      if (!it) { it = { n: raw, s: [], d: [] }; itemsByName.set(key, it); }
      if (!it.s.includes(s.id)) it.s.push(s.id);
      // Prefer a Title-ish name if we later meet a nicer casing; reports are ALL CAPS so keep first.
    }
    delete s._items;
  }

  // --- dietary flags ---
  const DIET_CODE = { vegan: 'V', vegetarian: 'VG', glutenFriendly: 'GF', dairyFree: 'DF' };
  let dietExact = 0, dietItemOnly = 0, dietMiss = 0;
  const standByLocItem = new Map();
  for (const s of stands) {
    for (const [key, it] of itemsByName) if (it.s.includes(s.id)) standByLocItem.set(norm(s.loc) + '|' + key, it);
  }
  for (const [tag, rows] of Object.entries(diets)) {
    const code = DIET_CODE[tag];
    for (const r of rows) {
      const key = norm(r.item);
      const viaLoc = standByLocItem.get(norm(r.location) + '|' + key);
      const it = viaLoc || itemsByName.get(key);
      if (viaLoc) dietExact++;
      else if (it) dietItemOnly++;
      else {
        dietMiss++;
        warn('diet', `${tag}: "${r.item}" @ ${r.location} — no matching menu item`);
        continue;
      }
      if (!it.d.includes(code)) it.d.push(code);
    }
  }

  // --- new-food flags and rankings ---
  const rankByName = new Map(M.RANKED.map(r => [norm(r.name), r]));
  let newMatched = 0;
  const newMissing = [];
  /*
   * The brochure prints marketing names; the vendor menus print till names, and they often
   * differ in detail — brochure "Tanghulu" vs menu "TANGHULU- CANDIED FRUIT ON A STICK", or
   * "Massive Mix" vs "MASSIVE MIX (HULI CHICKEN, TERI BEEF, BBQ PORK, & KALUA PORK)".
   * So: exact match first, then a prefix match, then containment — but only against items sold
   * by that same vendor, so a generic word can't attach the "new for 2026" flag to the wrong
   * stand's item.
   */
  const standIdsByVendor = new Map();
  for (const s of stands) {
    const k = norm(s.name);
    if (!standIdsByVendor.has(k)) standIdsByVendor.set(k, []);
    standIdsByVendor.get(k).push(s.id);
  }
  const findNewItem = (vendor, nm) => {
    const key = norm(nm);
    const exact = itemsByName.get(key);
    if (exact) return exact;
    const ids = standIdsByVendor.get(norm(vendor)) || [];
    if (!ids.length) return null;
    const candidates = [...itemsByName.entries()].filter(([, it]) => it.s.some(id => ids.includes(id)));
    const prefix = candidates.find(([k]) => k.startsWith(key));
    if (prefix) return prefix[1];
    const contains = candidates.find(([k]) => k.includes(key) || key.includes(k));
    return contains ? contains[1] : null;
  };

  for (const [vendor, names] of Object.entries(M.NEW_ITEMS)) {
    for (const nm of names) {
      const it = findNewItem(vendor, nm);
      if (!it) { newMissing.push(`${vendor}: ${nm}`); continue; }
      it.new = 1;
      newMatched++;
      const rk = rankByName.get(norm(nm));
      if (rk) { it.rank = rk.rank; it.tier = rk.tier; it.price = rk.price; }
    }
  }
  for (const m of newMissing) warn('newfood', `not found in any menu: ${m}`);

  // --- water + amenities positioned via their landmark ---
  const place = (landmarkName) => {
    const m = marks.get(landmarkName);
    if (!m) return null;
    if (m.osmCentre) return { lat: r6(m.osmCentre[0]), lon: r6(m.osmCentre[1]), src: 'inside', conf: 'high' };
    if (m.grid) {
      const [la, lo] = tf.at(gridCol(m.grid), gridRow(m.grid));
      return { lat: r6(la), lon: r6(lo), src: 'grid', conf: m.gridEst ? 'low' : 'medium' };
    }
    return null;
  };

  const water = M.WATER.map(w => {
    const p = place(w.landmark);
    if (!p) warn('water', `cannot place water station at ${w.landmark}`);
    return { at: w.landmark, kind: w.kind, detail: w.detail, ...(p || { lat: null, lon: null, src: 'none' }) };
  });

  const amenities = M.AMENITIES.map(a => {
    const p = place(a.landmark);
    if (!p) warn('amenity', `cannot place ${a.name} at ${a.landmark}`);
    return { kind: a.kind, name: a.name, at: a.landmark, detail: a.detail || null, ...(p || { lat: null, lon: null, src: 'none' }) };
  });

  // --- landmarks for display/search ---
  const landmarks = [...marks.values()].map(m => {
    const p = m.osmCentre ? { lat: r6(m.osmCentre[0]), lon: r6(m.osmCentre[1]), src: 'inside' }
      : m.grid ? (([la, lo]) => ({ lat: r6(la), lon: r6(lo), src: 'grid' }))(tf.at(gridCol(m.grid), gridRow(m.grid)))
      : { lat: null, lon: null, src: 'none' };
    return { name: m.name, grid: m.grid || null, ...p, conf: m.osmCentre ? 'high' : m.gridEst ? 'low' : 'medium' };
  }).filter(l => l.lat != null);

  /*
   * --- restrooms, from two sources with different shapes of evidence ---
   *
   * `building`  a standalone block OSM has an outlined footprint for. Small enough that its
   *             centroid is a real point, so this is the best tier here.
   * `indoor`    the fair's water map says this building has restrooms, but not where in it. Pinned
   *             at the footprint centroid exactly like the water points, and labelled "in the X"
   *             rather than pointing at a door we can't see.
   *
   * 18 between them against ~40 on the fair's map, which the chip discloses rather than papering
   * over. See the RESTROOMS comment in source-manual.js for why the map icons stay untranscribed.
   */
  const restrooms = [];
  for (const t of osm.toilets) {
    const [la, lo] = centroid(t.pts);
    /*
     * Describe it by the nearest landmark, plainly. A grid-derived landmark is a perfectly good
     * *name* even though it's a poor pin — nothing here derives a coordinate from it, the restroom's
     * own footprint does that. Preferring high-confidence marks instead pushed one restroom's label
     * from "near the MidAmerican Energy Stage" (39 ft) to "near the Wind Turbine & Education Center"
     * (276 ft), which is worse writing about an equally exact point. Confidence only breaks ties.
     */
    const near = landmarks
      .map(l => ({ name: l.name, ft: distFt(la, lo, l.lat, l.lon), high: l.conf === 'high' }))
      .sort((a, b) => (a.ft - b.ft) || (b.high - a.high))[0] || null;
    restrooms.push({
      kind: 'building',
      near: near ? near.name : null,
      nearFt: near ? Math.round(near.ft) : null,
      wheelchair: t.wheelchair || undefined,
      changing: t.changing || undefined,
      lat: r6(la), lon: r6(lo), src: 'inside', conf: 'high',
    });
  }
  for (const r of M.RESTROOMS) {
    const p = place(r.landmark);
    if (!p) warn('restroom', `cannot place restrooms at ${r.landmark}`);
    restrooms.push({ kind: 'indoor', at: r.landmark, detail: r.detail, ...(p || { lat: null, lon: null, src: 'none' }) });
  }

  // --- geometry, thinned for the SVG map ---
  const geom = {
    buildings: osm.buildings.map(b => ({ n: b.name || undefined, p: b.pts.map(([a, o]) => [r5(a), r5(o)]) })),
    paths: osm.paths.map(p => ({ k: p.kind, p: p.pts.map(([a, o]) => [r5(a), r5(o)]) })),
    areas: osm.areas.map(a => ({ k: a.kind, p: a.pts.map(([x, o]) => [r5(x), r5(o)]) })),
  };

  const data = {
    meta: {
      ...M.FAIR,
      bounds: BOUNDS,
      transform: { lat: tf.PLA, lon: tf.PLO },
      sources: [
        '2026_IowaStateFair_Food_Vendors_20260804.pdf',
        '2026_IowaStateFair_Beer_Food_Combo_Vendors_20260731.pdf',
        'rpt_Mkt_Items_{Vegan,Vegetarian,GlutenFriendly,DairyFree}.pdf',
        '2026-New-Food-Brochure-Website.pdf',
        '2026_WaterRefillStationMap.pdf',
        'Maps/2026-Website-Final.pdf',
        'OpenStreetMap via Overpass API (© OpenStreetMap contributors, ODbL)',
      ],
      accuracy: {
        edge: 'corner/side of a mapped building — about 15–40 ft',
        inside: 'inside or at a mapped building — building level',
        offset: 'offset from a mapped building — about 60–120 ft',
        grid: 'from the official map grid — about 85 ft',
      },
    },
    stands,
    items: [...itemsByName.values()],
    landmarks,
    water,
    restrooms,
    amenities,
    ranked: M.RANKED,
  };

  return {
    data, tf, geom,
    stats: { dietExact, dietItemOnly, dietMiss, newMatched, newMissing, selfFixed, selfUnfixable },
  };
}

// ---------------------------------------------------------------------------
// 7. Emit + report
// ---------------------------------------------------------------------------

function report({ data, tf, stats }) {
  const S = data.stands;
  const by = k => S.filter(s => s.src === k).length;
  const pct = n => `${((100 * n) / S.length).toFixed(1)}%`;

  console.log('\n=== calibration (grid -> GPS) ===');
  console.log(`  anchors used        ${tf.anchors} of ${tf.considered} (printed grid refs with an OSM footprint)`);
  if (tf.trimmed.length) console.log(`  trimmed as outliers ${tf.trimmed.map(t => `${t.name} ${t.ft.toFixed(0)}ft`).join(", ")}`);
  console.log(`  mean error          ${tf.mean.toFixed(0)} ft`);
  console.log(`  worst              ${tf.errs.slice(0, 3).map(e => `${e.name} ${e.ft.toFixed(0)}ft`).join(', ')}`);
  console.log(`  grid cell           ${tf.cell.col.toFixed(0)} x ${tf.cell.row.toFixed(0)} ft`);

  console.log('\n=== stands ===');
  console.log(`  total               ${S.length}`);
  for (const k of ['edge', 'inside', 'offset', 'grid', 'none']) {
    console.log(`  ${k.padEnd(19)} ${String(by(k)).padStart(4)}  ${pct(by(k))}`);
  }
  console.log(`  menus truncated in source  ${S.filter(s => s.trunc).length}`);

  /*
   * Every self-venue override, with how far it moved the pin. This is the audit trail: the rule
   * silently relocating a stand is exactly the kind of change that should have to justify itself in
   * the report rather than only in a diff of generated coordinates.
   */
  console.log('\n=== stands pinned to their own footprint ===');
  if (!stats.selfFixed.length) console.log('  none');
  for (const f of stats.selfFixed) {
    console.log(`  ${f.name} [${f.space}]  moved ${f.movedFt == null ? '(unplaced)' : `${f.movedFt} ft`}` +
      `  ${f.from} -> inside/high   <- "${f.wasFrom}"`);
  }
  if (stats.selfUnfixable.length) {
    console.log('  still approximate — named after a grid-only landmark, so no footprint to use:');
    for (const u of stats.selfUnfixable) {
      console.log(`    ${u.name} [${u.space}]  ${u.ft} ft from its grid square via ${u.src}   <- "${u.loc}"`);
    }
  }

  console.log('\n=== items ===');
  console.log(`  unique item names   ${data.items.length}`);
  console.log(`  flagged new for 2026 ${data.items.filter(i => i.new).length} (${stats.newMatched} matched, ${stats.newMissing.length} unmatched)`);
  for (const c of ['V', 'VG', 'GF', 'DF']) {
    console.log(`  diet ${c.padEnd(15)} ${data.items.filter(i => i.d.includes(c)).length} items`);
  }
  console.log(`  dietary rows joined  ${stats.dietExact} exact + ${stats.dietItemOnly} by name, ${stats.dietMiss} unmatched`);

  console.log('\n=== other ===');
  console.log(`  landmarks           ${data.landmarks.length}`);
  const R = data.restrooms;
  const rBy = k => R.filter(r => r.kind === k && r.lat != null).length;
  console.log(`  restrooms           ${R.filter(r => r.lat != null).length}/${R.length}` +
    ` (${rBy('building')} standalone OSM buildings, ${rBy('indoor')} in-building from the water map)`);
  console.log(`    of ~40 on the fair's map — the rest are icon positions we won't guess at`);
  console.log(`    step-free                ${R.filter(r => r.wheelchair).length} tagged wheelchair-accessible in OSM`);
  /*
   * A standalone restroom is described by the nearest landmark, so a far one is a weak label — the
   * point is right, the words for it are vague. Printed rather than fixed: there is nothing nearer
   * to name, and hiding it would make the list look better than it is.
   */
  const far = R.filter(r => r.kind === 'building' && r.nearFt != null && r.nearFt > 300);
  if (far.length) {
    console.log(`    loosely described        ${far.length} standalone restroom(s) with no landmark inside 300 ft:`);
    for (const r of far) console.log(`      near ${r.near} — ${r.nearFt} ft away`);
  }

  const cats = {};
  for (const w of warnings) cats[w.cat] = (cats[w.cat] || 0) + 1;
  console.log('\n=== warnings ===');
  if (!warnings.length) console.log('  none');
  for (const [c, n] of Object.entries(cats)) console.log(`  ${c.padEnd(10)} ${n}`);
  const show = process.argv.includes('--verbose') ? warnings : warnings.slice(0, 25);
  for (const w of show) console.log(`   [${w.cat}] ${w.msg}`);
  if (show.length < warnings.length) console.log(`   ... ${warnings.length - show.length} more (--verbose)`);

  // Hard assertions — these are bugs, not data quirks.
  const bad = S.filter(s => s.lat != null && (s.lat === 0 || s.lon === 0));
  if (bad.length) { console.error(`\nFAIL: ${bad.length} stands at 0,0`); process.exitCode = 1; }
  const out = S.filter(s => s.lat != null &&
    (s.lat < BOUNDS.minLat - 0.002 || s.lat > BOUNDS.maxLat + 0.002 ||
     s.lon < BOUNDS.minLon - 0.002 || s.lon > BOUNDS.maxLon + 0.002));
  if (out.length) {
    console.error(`\nFAIL: ${out.length} stands outside the fairgrounds:`);
    out.slice(0, 8).forEach(s => console.error(`   ${s.name} [${s.space}] ${s.lat},${s.lon} via ${s.src}/${s.landmark} <- "${s.loc}"`));
    process.exitCode = 1;
  }
}

function emit({ data, geom }) {
  const jsDir = path.join(ROOT, 'js');
  fs.mkdirSync(jsDir, { recursive: true });
  const header = `/* GENERATED by tools/build-data.js — do not edit by hand.\n` +
    ` * Sources: official Iowa State Fair PDFs + OpenStreetMap (ODbL).\n` +
    ` * Rebuild: node tools/build-data.js\n */\n`;
  const body =
    `window.FAIR = ${JSON.stringify(data)};\n` +
    `window.FAIR_GEOM = ${JSON.stringify(geom)};\n`;
  const file = path.join(jsDir, 'data.js');
  fs.writeFileSync(file, header + body);
  const kb = n => `${(n / 1024).toFixed(0)} KB`;
  console.log(`\nwrote js/data.js  ${kb(header.length + body.length)}` +
    `  (data ${kb(JSON.stringify(data).length)}, geometry ${kb(JSON.stringify(geom).length)})`);
}

const built = build();
report(built);
if (!REPORT_ONLY) {
  emit(built);
  // A new js/data.js that isn't stamped into sw.js will not reach installed phones as one piece.
  // Doing it here means a rebuild can't ship half-updated by forgetting a manual step.
  require('./stamp-sw.js').stamp();
}
