'use strict';
/*
 * pdftext.js — minimal, dependency-free PDF text extractor.
 *
 * Why this exists: the Iowa State Fair publishes its authoritative vendor, menu and
 * dietary data only as PDFs. Hand-transcribing 35+ pages would be slow, typo-prone and
 * impossible to refresh next year. These particular PDFs are simple generated reports
 * (uncompressed or Flate-compressed content streams, WinAnsi/TrueType simple fonts,
 * no CID encoding), so a small extractor is enough and keeps the pipeline reproducible.
 *
 * It captures each text run WITH its x/y position, which matters: the vendor and dietary
 * reports are multi-column tables, and column membership can only be recovered from x.
 *
 * Scope / limitations (deliberate — this is not a general PDF library):
 *   - handles FlateDecode only (the only filter these files use)
 *   - simple fonts with single-byte codes; no CID/Identity-H
 *   - applies /Differences encoding maps when present
 *   - ignores clipping, forms/XObjects, and rotation
 * If a future PDF breaks these assumptions the caller will see obviously-garbled text
 * rather than silently wrong data, and `--raw` exists to eyeball it.
 *
 * Usage:
 *   node tools/pdftext.js <file.pdf>              # rows grouped into lines, per page
 *   node tools/pdftext.js <file.pdf> --json       # [{page, items:[{x,y,s}]}]
 *   node tools/pdftext.js <file.pdf> --cols 60,340,560   # split lines at x thresholds
 */

const fs = require('fs');
const zlib = require('zlib');


// ---------------------------------------------------------------- object index

/**
 * Index every top-level `N 0 obj ... endobj`, recording its dictionary text and, when it has
 * one, the raw stream bytes.
 */
function indexObjects(buf) {
  const s = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = parseInt(m[1], 10);
    const start = m.index + m[0].length;
    const endObj = s.indexOf('endobj', start);
    const stop = endObj === -1 ? s.length : endObj;
    const body = s.slice(start, stop);
    const sm = body.match(/\bstream\b/);
    let dict = body, stream = null;
    if (sm) {
      dict = body.slice(0, sm.index);
      let b = start + sm.index + 6;
      if (buf[b] === 0x0d) b++;
      if (buf[b] === 0x0a) b++;
      // Prefer /Length when it's a literal; fall back to searching for `endstream`.
      const lm = dict.match(/\/Length\s+(\d+)/);
      let e = lm ? b + parseInt(lm[1], 10) : -1;
      if (e === -1 || buf.slice(e, e + 20).toString('latin1').indexOf('endstream') === -1) {
        e = buf.indexOf(Buffer.from('endstream'), b);
      }
      stream = buf.slice(b, e === -1 ? buf.length : e);
    }
    if (!objs.has(num)) objs.set(num, { dict, stream });
  }
  return objs;
}

/** Decode the object streams (/Type/ObjStm) so objects compressed inside them are visible. */
function expandObjectStreams(objs) {
  for (const [, o] of [...objs]) {
    if (!o.stream || !/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = /FlateDecode/.test(o.dict) ? inflate(o.stream) : o.stream;
    if (!data) continue;
    const text = data.toString('latin1');
    const n = parseInt((o.dict.match(/\/N\s+(\d+)/) || [, '0'])[1], 10);
    const first = parseInt((o.dict.match(/\/First\s+(\d+)/) || [, '0'])[1], 10);
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2], off = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      const nextOff = (i + 1 < n) ? header[i * 2 + 3] : text.length - first;
      const body = text.slice(first + off, first + (Number.isFinite(nextOff) ? nextOff : text.length));
      if (!objs.has(num)) objs.set(num, { dict: body, stream: null });
    }
  }
  return objs;
}

/** Resolve `/Contents 5 0 R` or `/Contents [5 0 R 6 0 R]` to an ordered list of object numbers. */
function contentRefs(dict) {
  const m = dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
  if (!m) return [];
  return [...m[1].matchAll(/(\d+)\s+\d+\s+R/g)].map(x => parseInt(x[1], 10));
}

/** Walk the page tree in order, returning page dictionaries. */
function pageDicts(objs) {
  // Find the catalog's /Pages, then flatten /Kids depth-first. Falling back to "every object
  // that looks like a page" would lose document order, which the vendor report depends on.
  let rootPages = null;
  for (const [, o] of objs) {
    const m = o.dict.match(/\/Type\s*\/Catalog[\s\S]*?\/Pages\s+(\d+)\s+\d+\s+R/);
    if (m) { rootPages = parseInt(m[1], 10); break; }
  }
  const out = [];
  const seen = new Set();
  const walk = (num) => {
    if (num == null || seen.has(num)) return;
    seen.add(num);
    const o = objs.get(num);
    if (!o) return;
    if (/\/Type\s*\/Pages\b/.test(o.dict)) {
      const kids = o.dict.match(/\/Kids\s*\[([\s\S]*?)\]/);
      if (kids) for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(parseInt(k[1], 10));
    } else if (/\/Type\s*\/Page\b/.test(o.dict)) {
      out.push(o);
    }
  };
  walk(rootPages);
  if (!out.length) {                              // no catalog found — best effort
    for (const [, o] of objs) if (/\/Type\s*\/Page[^s]/.test(o.dict)) out.push(o);
  }
  return out;
}

function inflate(body) {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try { return fn(body); } catch { /* try next */ }
  }
  return null;
}

/**
 * Split a PDF content stream into tokens. Strings are returned as
 * {str} / {hex} objects so a literal `[` inside text can't be mistaken for an array.
 */
function tokenize(s) {
  const toks = [];
  let i = 0;
  const isDelim = c => ' \t\r\n\f\0/[]<>(){}'.includes(c);
  while (i < s.length) {
    const c = s[i];
    if (' \t\r\n\f\0'.includes(c)) { i++; continue; }
    if (c === '%') { while (i < s.length && s[i] !== '\n') i++; continue; }

    if (c === '(') {                       // literal string
      let depth = 1, j = i + 1, out = '';
      while (j < s.length && depth > 0) {
        const ch = s[j];
        if (ch === '\\') {
          const n = s[j + 1];
          const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (n in simple) { out += simple[n]; j += 2; }
          else if (n >= '0' && n <= '7') {  // octal escape
            let oct = '';
            let k = j + 1;
            while (k < s.length && oct.length < 3 && s[k] >= '0' && s[k] <= '7') oct += s[k++];
            out += String.fromCharCode(parseInt(oct, 8)); j = k;
          } else if (n === '\n') { j += 2; }        // line continuation
          else { out += n; j += 2; }
        } else if (ch === '(') { depth++; out += ch; j++; }
        else if (ch === ')') { depth--; if (depth > 0) out += ch; j++; }
        else { out += ch; j++; }
      }
      toks.push({ str: out }); i = j; continue;
    }

    if (c === '<' && s[i + 1] !== '<') {   // hex string
      const j = s.indexOf('>', i);
      toks.push({ hex: s.slice(i + 1, j === -1 ? s.length : j).replace(/\s+/g, '') });
      i = (j === -1 ? s.length : j + 1); continue;
    }

    if (c === '<' && s[i + 1] === '<') { toks.push('<<'); i += 2; continue; }
    if (c === '>' && s[i + 1] === '>') { toks.push('>>'); i += 2; continue; }
    if (c === '[' || c === ']' || c === '{' || c === '}') { toks.push(c); i++; continue; }

    if (c === '/') {                       // name
      let j = i + 1;
      while (j < s.length && !isDelim(s[j])) j++;
      toks.push('/' + s.slice(i + 1, j)); i = j; continue;
    }

    let j = i;                             // number or operator
    while (j < s.length && !isDelim(s[j])) j++;
    if (j === i) j++;
    toks.push(s.slice(i, j)); i = j;
  }
  return toks;
}

// ---------------------------------------------------------------- font maps

/**
 * Build code->char overrides from every /Differences array in the file.
 * These reports use a handful of subset fonts; merging all of their differences is
 * safe in practice because the glyph names are standard (quoteright, endash, ...).
 */
function buildGlyphMap(pdf) {
  const map = new Map();
  const named = {
    quotesingle: "'", quoteright: '’', quoteleft: '‘', quotedbl: '"',
    quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—',
    bullet: '•', hyphen: '-', space: ' ', ampersand: '&', registered: '®',
    copyright: '©', trademark: '™', degree: '°', eacute: 'é',
    ntilde: 'ñ', fi: 'fi', fl: 'fl', periodcentered: '·', dollar: '$',
    percent: '%', numbersign: '#', asterisk: '*', plus: '+', comma: ',', period: '.',
    slash: '/', colon: ':', semicolon: ';', question: '?', at: '@', exclam: '!',
    parenleft: '(', parenright: ')', bracketleft: '[', bracketright: ']',
  };
  const re = /\/Differences\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(pdf)) !== null) {
    const toks = m[1].trim().split(/\s+/);
    let code = 0;
    for (const t of toks) {
      if (/^\d+$/.test(t)) { code = parseInt(t, 10); continue; }
      const g = t.replace(/^\//, '');
      let ch = null;
      if (g in named) ch = named[g];
      else if (/^uni([0-9A-Fa-f]{4})$/.test(g)) ch = String.fromCharCode(parseInt(g.slice(3), 16));
      else if (/^g\d+$/.test(g)) ch = null;                    // unmapped subset glyph
      else if (g.length === 1) ch = g;
      if (ch !== null && !map.has(code)) map.set(code, ch);
      code++;
    }
  }
  return map;
}

function decodeHex(hex, glyphs) {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    out += glyphs.has(code) ? glyphs.get(code) : String.fromCharCode(code);
  }
  return out;
}

function applyGlyphs(str, glyphs) {
  if (!glyphs.size) return str;
  let out = '';
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    out += (code < 256 && glyphs.has(code)) ? glyphs.get(code) : ch;
  }
  return out;
}

// ---------------------------------------------------------------- extraction

/** Walk a content stream's tokens, tracking the text matrix, and emit positioned runs. */
function runsFromStream(text, glyphs) {
  const toks = tokenize(text);
  const runs = [];
  // Text matrix / line matrix, as [a b c d e f]; we only need e,f (translation) and d (scale).
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = tm.slice();
  let leading = 0;
  const num = t => (typeof t === 'string' ? parseFloat(t) : NaN);

  const push = (s) => {
    if (!s) return;
    runs.push({ x: round(tm[4]), y: round(tm[5]), s });
  };
  const mul = (m, n) => [                            // m x n for 3x2 affine
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const round = v => Math.round(v * 10) / 10;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (typeof t === 'object') continue;             // strings handled at their operator

    if (t === 'BT') { tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); continue; }

    if (t === 'Tm') {
      const a = toks.slice(i - 6, i).map(num);
      if (a.every(Number.isFinite)) { tm = a; tlm = a.slice(); }
      continue;
    }
    if (t === 'Td' || t === 'TD') {
      const tx = num(toks[i - 2]), ty = num(toks[i - 1]);
      if (Number.isFinite(tx) && Number.isFinite(ty)) {
        if (t === 'TD') leading = -ty;
        tlm = mul([1, 0, 0, 1, tx, ty], tlm);
        tm = tlm.slice();
      }
      continue;
    }
    if (t === 'TL') { const v = num(toks[i - 1]); if (Number.isFinite(v)) leading = v; continue; }
    if (t === 'T*') { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); continue; }

    if (t === 'Tj' || t === "'" || t === '"') {
      if (t !== 'Tj') { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); }
      const p = toks[i - 1];
      if (p && typeof p === 'object') {
        push(p.str !== undefined ? applyGlyphs(p.str, glyphs) : decodeHex(p.hex, glyphs));
      }
      continue;
    }

    if (t === 'TJ') {
      // Gather the preceding [ ... ] array; kerning numbers become spaces when large.
      let j = i - 1;
      if (toks[j] !== ']') continue;
      let depth = 0, start = -1;
      for (let k = j; k >= 0; k--) {
        if (toks[k] === ']') depth++;
        else if (toks[k] === '[') { depth--; if (depth === 0) { start = k; break; } }
      }
      if (start === -1) continue;
      let s = '';
      for (let k = start + 1; k < j; k++) {
        const e = toks[k];
        if (typeof e === 'object') {
          s += e.str !== undefined ? applyGlyphs(e.str, glyphs) : decodeHex(e.hex, glyphs);
        } else {
          const n = num(e);
          if (Number.isFinite(n) && n <= -120 && !s.endsWith(' ')) s += ' ';
        }
      }
      push(s);
      continue;
    }
  }
  return runs;
}

/**
 * Extract positioned text runs, one array per page, in document order.
 *
 * Pages are resolved properly — catalog → /Pages → /Kids → /Contents — rather than guessed
 * from stream order. Two independent problems forced this:
 *
 *   1. A page's /Contents may be an *array* of streams which the spec says are concatenated
 *      and parsed as one. Parsing them separately mangles operators whose operands straddle
 *      the boundary, silently dropping whole runs of menu items.
 *   2. Page boundaries must still be known, because y coordinates restart on every page.
 *      Concatenating the entire document instead merges the last row of one page into the
 *      first row of the next whenever their y values coincide.
 *
 * Injecting a sentinel between streams looked simpler but is unsafe: a stream can end in the
 * middle of a string literal, so the sentinel's own characters land inside the text and throw
 * off paren matching. Real page mapping avoids that; it needs /ObjStm decoding because these
 * files keep their page objects compressed inside object streams.
 */
function extract(file) {
  const buf = fs.readFileSync(file);
  const glyphs = buildGlyphMap(buf.toString('latin1'));
  const objs = expandObjectStreams(indexObjects(buf));

  const pages = [];
  for (const page of pageDicts(objs)) {
    const parts = [];
    for (const ref of contentRefs(page.dict)) {
      const o = objs.get(ref);
      if (!o || !o.stream) continue;
      const data = /FlateDecode/.test(o.dict) ? inflate(o.stream) : o.stream;
      if (data) parts.push(data.toString('latin1'));
    }
    if (!parts.length) continue;
    // A page's /Contents streams are concatenated and parsed as one, per spec — operands
    // legitimately straddle the boundary, so they must be joined before tokenizing.
    const runs = runsFromStream(parts.join('\n'), glyphs);
    if (runs.length) pages.push(runs);
  }
  return pages;
}

/** Every page's runs in document order, with page boundaries marked by `{brk:true}`. */
function extractFlat(file) {
  const out = [];
  for (const runs of extract(file)) {
    if (out.length) out.push({ x: 0, y: 0, s: '', brk: true });
    out.push(...runs);
  }
  return out;
}

/**
 * Group runs into lines by EMISSION order, starting a new line whenever y moves.
 *
 * Use this for linear documents (the vendor report). Sorting by y instead — see toLines —
 * requires knowing which page a run belongs to, and in these files the page objects live
 * inside compressed object streams, so page association would mean writing a real PDF
 * parser. Word emits text in reading order, so following that order is both simpler and
 * more faithful; it also survives a page's content being split across several streams.
 */
function toFlowLines(runs, yTol = 2) {
  const lines = [];
  let cur = null;
  for (const r of runs) {
    if (r.brk) { cur = null; continue; }                 // stream/page boundary
    if (isGarbled(r.s)) continue;                        // bold-shadow duplicate layer
    if (!cur || Math.abs(cur.y - r.y) > yTol) { cur = { y: r.y, items: [r] }; lines.push(cur); }
    else cur.items.push(r);
  }
  return lines;
}

/**
 * True for runs drawn with a subset font whose encoding we can't resolve.
 *
 * The dietary reports paint their disclaimer paragraph twice — once in a normal font and
 * once in a bold subset whose glyph names are unmapped (`g17`, `g42`, …), which decodes to
 * mojibake like "2 X ô î ô2e\Ù2Ù}". Left in, that text gets appended to real item names as a
 * wrapped continuation and corrupts the search corpus, so it is dropped at the source.
 * Detected by character profile rather than by position, which stays correct regardless of
 * where the layer is drawn.
 */
function isGarbled(s) {
  if (!s || s.length < 4) return false;
  let odd = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    // Control characters never appear in real extracted text and are the clearest tell;
    // high bytes count too, except the punctuation these documents legitimately use.
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) odd += 2;
    else if (c > 126 && !'’‘“”–—®©™°éñ·½¼¾'.includes(ch)) odd++;
  }
  return odd / s.length > 0.12;
}

/** Group runs into visual lines by y, then order left-to-right. */
function toLines(runs, yTol = 3) {
  const sorted = runs.filter(r => !r.brk && !isGarbled(r.s))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) <= yTol) { last.items.push(r); last.y = (last.y + r.y) / 2; }
    else lines.push({ y: r.y, items: [r] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

/**
 * Join a line's runs by simple concatenation.
 *
 * Deliberately does NOT synthesize spaces from x gaps. These PDFs already contain real
 * space characters, and an advance-width estimate (without parsing font metrics) guessed
 * wrong often enough to corrupt the data — turning "APPLE-PLAIN" into "APPLE -PLAIN" and
 * "Food-only" into "Food- only". Item names are the search corpus, so a wrong space is
 * worse than a missing one.
 */
function lineText(line) {
  return line.items.map(it => it.s).join('').replace(/[ \t]+/g, ' ').trim();
}

/** Split a line into columns at the given x thresholds. */
function lineCols(line, bounds) {
  const cols = new Array(bounds.length + 1).fill('');
  for (const it of line.items) {
    let c = 0;
    while (c < bounds.length && it.x >= bounds[c]) c++;
    cols[c] += (cols[c] && !cols[c].endsWith(' ') ? ' ' : '') + it.s;
  }
  return cols.map(s => s.replace(/\s+/g, ' ').trim());
}

module.exports = { extract, extractFlat, toLines, toFlowLines, lineText, lineCols };

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) { console.error('usage: node tools/pdftext.js <file.pdf> [--json|--raw|--cols a,b,c]'); process.exit(1); }
  const pages = extract(file);
  const colsArg = args.includes('--cols') ? args[args.indexOf('--cols') + 1].split(',').map(Number) : null;

  if (args.includes('--json')) {
    console.log(JSON.stringify(pages.map((runs, i) => ({ page: i + 1, items: runs })), null, 1));
  } else if (args.includes('--raw')) {
    pages.forEach((runs, i) => {
      console.log(`\n=== page ${i + 1} (${runs.length} runs) ===`);
      for (const r of runs) console.log(`${String(r.x).padStart(7)} ${String(r.y).padStart(7)}  ${r.s}`);
    });
  } else {
    pages.forEach((runs, i) => {
      console.log(`\n=== page ${i + 1} ===`);
      for (const l of toLines(runs)) {
        console.log(colsArg ? lineCols(l, colsArg).join(' | ') : lineText(l));
      }
    });
  }
}
