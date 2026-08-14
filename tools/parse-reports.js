'use strict';
/*
 * parse-reports.js — turn the Iowa State Fair's machine-generated report PDFs into JSON.
 *
 * Covers the six reports that carry the bulk of the data:
 *   food-vendors.pdf        "Stand Names", Food-only Vendors (No beer)   — 160 stands
 *   beer-food-vendors.pdf   "Stand Names", Food & Beer Joint Vendors     —  43 stands
 *   diet-Vegan.pdf          item / location / stand triples
 *   diet-Vegetarian.pdf     "
 *   diet-GlutenFriendly.pdf "
 *   diet-DairyFree.pdf      "
 *
 * The three *designed* PDFs (fairgrounds map, water refill map, new-food brochure) have their
 * text converted to outlines for print, so nothing is extractable from them. Their data is
 * hand-encoded in source-manual.js instead — it is small and stable, unlike these reports.
 *
 * Run standalone to see a summary:  node tools/parse-reports.js
 */

const path = require('path');
const { extract, extractFlat, toLines, toFlowLines, lineText, lineCols } = require('./pdftext.js');

const SRC = path.join(__dirname, '..', '_source');

// ------------------------------------------------------------------ helpers

const clean = s => s.replace(/\s+/g, ' ').trim();

/** Read a report PDF as one ordered array of text lines across all pages. */
function lines(file) {
  return toFlowLines(extractFlat(path.join(SRC, file))).map(lineText).filter(Boolean);
}

/**
 * Split a semicolon-separated "Items Include:" blob into item names.
 * The reports wrap mid-item across lines, so the blob is joined first and split only on ';'.
 * Trailing fragments with no ';' are kept — several stands are genuinely truncated in the
 * source PDF (e.g. Buni's Cinnamon Rolls) and inventing an ending would be worse than
 * carrying the fragment through with a flag.
 */
function splitItems(blob) {
  const parts = blob.split(';').map(clean).filter(Boolean);
  return parts.filter(p => p !== '-' && p.length > 1);
}

// ------------------------------------------------------------------ vendors

/*
 * Vendor report shape, per stand:
 *
 *   Best Concessions                                  <- stand name (bold, own line)
 *   SMITH, KEVIN AND JANIE -- B.E.S.T. CATERING ...   <- contact "LAST, FIRST -- COMPANY"
 *   203 SE 34th St; Des Moines, IA 50317;             <- address line
 *   Jacobson Exhibition Center                        <- human location label
 *   SPACE: 4002 -- 4002, SMITH K1 INSIDE ARENA ...    <- official space number + location
 *   Items Include: 12 OZ CRAFT BOTTLE; ...            <- menu, wraps over many lines
 *
 * A stand may list several locations, each with its own SPACE + Items block; those become
 * separate stands sharing a vendor name (that is what they are on the ground). The location
 * label directly above a SPACE line is preferred over the SPACE line's own text because it
 * is written for humans ("West Side of Riley Stage" vs "50325, WEST SIDE OF RILEY STAGE").
 */
/**
 * Two-pass vendor parser.
 *
 * Pass 1 classifies every line; pass 2 walks the classified stream. Doing it in two passes
 * removes the ambiguity in "is this bare line a stand name or a location label?" — a stand
 * name is the line immediately preceding a contact line, and a location label is a bare line
 * appearing after the address and before a SPACE line.
 */
function parseVendors(file, group) {
  const ls = lines(file);

  const isContact = l => / -- /.test(l) && l === l.toUpperCase() && /[A-Z]{3}/.test(l);
  const isAddress = l => /;/.test(l) && /\b[A-Z]{2}\s+\d{5}\b|\bPO Box\b|\bP\.O\. Box\b|\d{3}-\d{3}-\d{4}|\(\d{3}\)\d{3}-\d{4}/.test(l);
  const isHeader = l => /^2026 Iowa State Fair - Stand Names$/.test(l) || /^Vendor Group:/.test(l);

  const kind = ls.map(l => {
    if (isHeader(l)) return 'header';
    if (/^SPACE:/.test(l)) return 'space';
    if (/^Items Include:/.test(l)) return 'items';
    if (isContact(l)) return 'contact';
    if (isAddress(l)) return 'address';
    return 'bare';
  });

  const stands = [];
  let vendor = null, contact = null, locLabel = null, cur = null, inItems = false;

  const flush = () => {
    if (!cur) return;
    const blob = cur._blob.trim();
    cur.items = splitItems(blob);
    cur.itemsTruncated = cur.items.length > 0 && !/;$/.test(blob);
    delete cur._blob;
    stands.push(cur);
    cur = null;
    inItems = false;
  };

  for (let i = 0; i < ls.length; i++) {
    const l = ls[i], k = kind[i];

    if (k === 'header') { flush(); continue; }

    if (k === 'bare') {
      // Stand name if a contact line follows (allowing a blank-ish bare line between).
      if (kind[i + 1] === 'contact') { flush(); vendor = l; locLabel = null; continue; }
      if (inItems) { cur._blob += ' ' + l; continue; }
      locLabel = l;                       // otherwise it labels the upcoming SPACE
      continue;
    }

    if (k === 'contact') { contact = l; continue; }
    if (k === 'address') { if (inItems) flush(); continue; }

    if (k === 'space') {
      flush();
      const m = l.match(/^SPACE:\s*(\S+)\s*--\s*(.*)$/) || [, '', ''];
      cur = {
        group,
        vendor,
        contact,
        space: m[1].replace(/,$/, ''),
        spaceText: clean(m[2]),
        locationRaw: locLabel || clean(m[2].replace(/^\d+\s*,?\s*/, '')),
        _blob: '',
      };
      // Consume the label. A vendor with several stands lists a fresh label before each
      // SPACE, but not always — leaving it set made later stands inherit an earlier stand's
      // location, which geocoded them to the wrong end of the fairgrounds.
      locLabel = null;
      continue;
    }

    if (k === 'items') {
      if (!cur) continue;                 // menu with no preceding SPACE — skip defensively
      cur._blob = l.replace(/^Items Include:\s*/, '');
      inItems = true;
      continue;
    }
  }
  flush();
  return stands;
}

// ------------------------------------------------------------------ dietary

/*
 * Dietary reports are three-column tables: Item Name | Location | Stand Name.
 * Column x positions vary slightly per file (Location sits at x 217–236) but all fall
 * cleanly between the thresholds below.
 *
 * These are grouped by POSITION, not emission order. The generator writes a row's entire
 * item cell — including every wrapped line — before writing that row's location and stand
 * cells, so following emission order puts the location on a line of its own with an empty
 * item column. That silently glued each row's item onto the previous row and dropped the
 * row's real location. Sorting by y reassembles the visual rows correctly.
 */
function parseDiet(file, tag) {
  const rows = [];
  const boilerplate = /^(Item Name|Location|Stand Name|Text9:|This list is intended|own food safety|strongly encouraged|and preparation|consumption of vendor|2026 Iowa State Fair|Wednesday,|Page \d+ of \d+)/;

  // Deliberately per page: a wrapped value continues onto the next line, but never across a
  // page break, so continuations must not be allowed to attach across pages.
  // Rows are ~22pt apart; lines wrapped *within* a row are ~13.5pt apart. The vertical gap is
  // therefore a reliable row separator, and unlike "does this line have a location?" it stays
  // correct when a row wraps its item AND its location on the same line — which otherwise
  // split one row into two, orphaning fragments like "CASHEW" @ "Slide".
  const ROW_GAP = 17;

  for (const runs of extract(path.join(SRC, file))) {
    let last = null, lastY = null;
    for (const line of toLines(runs)) {
      const [item, loc, stand] = lineCols(line, [200, 420]);
      if (!item && !loc && !stand) continue;
      if (boilerplate.test(item) || boilerplate.test(loc) || boilerplate.test(stand)) continue;

      const isNewRow = last === null || lastY === null || (lastY - line.y) > ROW_GAP;
      if (isNewRow && loc) {
        last = { item: clean(item), location: clean(loc), stand: clean(stand), tag };
        rows.push(last);
      } else if (last) {
        if (item) last.item = clean(last.item + ' ' + item);
        if (loc) last.location = clean(last.location + ' ' + loc);
        if (stand) last.stand = clean(last.stand + ' ' + stand);
      }
      lastY = line.y;
    }
  }
  // A row needs at least an item and a location to be usable.
  return rows.filter(r => r.item && r.location);
}

// ------------------------------------------------------------------ public

function parseAll() {
  const foodStands = parseVendors('food-vendors.pdf', 'food');
  const beerStands = parseVendors('beer-food-vendors.pdf', 'beer');
  const diets = {
    vegan: parseDiet('diet-Vegan.pdf', 'vegan'),
    vegetarian: parseDiet('diet-Vegetarian.pdf', 'vegetarian'),
    glutenFriendly: parseDiet('diet-GlutenFriendly.pdf', 'glutenFriendly'),
    dairyFree: parseDiet('diet-DairyFree.pdf', 'dairyFree'),
  };
  return { stands: foodStands.concat(beerStands), diets };
}

module.exports = { parseAll, parseVendors, parseDiet };

if (require.main === module) {
  const { stands, diets } = parseAll();
  const items = stands.reduce((n, s) => n + s.items.length, 0);
  console.log(`stands            ${stands.length}  (food ${stands.filter(s => s.group === 'food').length}, beer ${stands.filter(s => s.group === 'beer').length})`);
  console.log(`menu items        ${items}`);
  console.log(`distinct vendors  ${new Set(stands.map(s => s.vendor)).size}`);
  console.log(`truncated menus   ${stands.filter(s => s.itemsTruncated).length}`);
  console.log(`no vendor name    ${stands.filter(s => !s.vendor).length}`);
  console.log(`no location       ${stands.filter(s => !s.locationRaw).length}`);
  for (const [k, v] of Object.entries(diets)) console.log(`diet ${k.padEnd(15)} ${v.length} rows`);

  console.log('\n--- sample stands ---');
  for (const s of stands.slice(0, 3)) {
    console.log(`  ${s.vendor}  [space ${s.space}]  @ ${s.locationRaw}`);
    console.log(`     ${s.items.length} items: ${s.items.slice(0, 4).join(' / ')}`);
  }
  const cf = stands.find(s => s.items.some(i => /CURLY FRIES/i.test(i)));
  console.log(`\n--- curly fries check ---\n  ${cf ? `${cf.vendor} @ ${cf.locationRaw} (space ${cf.space})` : 'NOT FOUND'}`);
}
