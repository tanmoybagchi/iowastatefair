'use strict';
/*
 * fuzzy.js — forgiving search over ~2,000 menu items, 203 stands and 138 landmarks.
 *
 * Exposes window.Fuzzy. Built for one-handed typing on a phone while walking, so it has to
 * tolerate typos ("fired rice"), singular/plural drift ("curly fry"), and the fact that the
 * official data is ALL CAPS and often verbose ("REFILL BUCKET OF FRIES- SM").
 *
 * No index-building library: a linear scan over a few thousand short strings is well under a
 * frame on a phone, and keeping it simple means it works offline with zero dependencies.
 */
(function () {
  // Words that add nothing to a search and would otherwise let junk match.
  const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'in', 'on', 'or', 'to', 'for', 'up']);

  /*
   * Synonyms map what people type to what the data says. Bidirectional: each group's members
   * all expand to the whole group, so "pop" finds SODA and "soda" finds POP.
   */
  const SYNONYM_GROUPS = [
    ['fries', 'fry', 'chips'],
    ['soda', 'pop', 'coke', 'soft drink'],
    ['beer', 'brew', 'draft', 'lager'],
    ['restroom', 'bathroom', 'toilet', 'washroom'],
    ['water', 'refill', 'fountain'],
    ['icecream', 'ice cream', 'gelato', 'soft serve'],
    ['corndog', 'corn dog'],
    ['lemonade', 'lemon shake'],
    ['sandwich', 'sammich', 'sub', 'hoagie', 'grinder'],
    ['gyro', 'gyros'],
    ['bbq', 'barbecue', 'barbeque'],
    ['veggie', 'vegetarian', 'vegetable'],
    ['pork chop', 'porkchop'],
    ['funnel cake', 'funnelcake'],
    ['cheese curd', 'cheesecurd'],
    ['turkey leg', 'turkeyleg'],
  ];

  const SYN = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const w of group) {
      const set = SYN.get(w) || new Set();
      group.forEach(g => set.add(g));
      SYN.set(w, set);
    }
  }

  /** Lowercase, strip punctuation, collapse whitespace. */
  function normalize(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[®™©]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Crude singularizer — enough for food words, and never touches short tokens. */
  function stem(w) {
    if (w.length <= 3) return w;
    if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
    if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }

  const tokens = s => normalize(s).split(' ').filter(w => w && !STOP.has(w));

  /**
   * Damerau-Levenshtein distance, abandoned early once it exceeds `max`.
   *
   * Transpositions count as ONE edit, not two. That matters more than it sounds: swapped
   * adjacent letters are the single most common phone-typing error, and "fired rice" ->
   * "fried rice" is exactly that. Plain Levenshtein scores it 2 and so rejects it for a
   * five-letter word, which made a very reasonable query miss.
   *
   * The cap is what keeps this cheap enough to run against every candidate: most comparisons
   * bail after a row or two instead of filling the whole matrix.
   */
  function editDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = null;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, prev2[j - 2] + 1);      // adjacent transposition
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
      cur = new Array(b.length + 1);
    }
    return prev[b.length];
  }

  /** Typo tolerance scales with word length: short words must be exact-ish. */
  const allowedEdits = w => (w.length <= 4 ? 0 : w.length <= 7 ? 1 : 2);

  /**
   * Score one query token against a candidate's tokens. 0 means no match.
   *
   * Ordering of the cases is the ranking: exact word beats prefix beats stem beats synonym
   * beats typo. That keeps "corn dog" from ranking a fuzzy "corn dough" above the real thing.
   */
  function scoreToken(q, cand, candStems) {
    if (cand.includes(q)) return 10;

    for (const c of cand) {
      if (c.startsWith(q)) return q.length >= 3 ? 8 : 6;
    }

    const qs = stem(q);
    if (candStems.has(qs)) return 7;

    const syns = SYN.get(q);
    if (syns) {
      for (const c of cand) if (syns.has(c)) return 6;
      for (const s of syns) {
        const parts = s.split(' ');
        if (parts.length > 1 && parts.every(p => cand.includes(p))) return 6;
      }
    }

    const max = allowedEdits(q);
    if (max > 0) {
      let best = Infinity;
      for (const c of cand) {
        // Only compare against words of a plausible length.
        if (Math.abs(c.length - q.length) > max) continue;
        const d = editDistance(q, c, max);
        if (d < best) best = d;
        if (best === 0) break;
      }
      if (best <= max) return Math.max(1, 5 - best);
    }
    return 0;
  }

  /**
   * Build a searchable record.
   * `text` is what we match against; `weight` biases whole categories (a stand name should beat
   * an obscure menu modifier); `boost` biases individual records.
   */
  function makeEntry(obj, text, weight) {
    const t = tokens(text);
    return { obj, tokens: t, stems: new Set(t.map(stem)), weight: weight || 1, len: t.length };
  }

  /**
   * Search a prepared entry list.
   *
   * Two passes. The strict pass requires every query token to match, so "fried rice" can't
   * return everything containing "fried". If that finds nothing, a relaxed pass requires only
   * one token and ranks by how many matched — because a query like "fried rice" is meaningful
   * even though no single item is named that; the answer is the Hawaiian stand selling fried
   * saimin and rice. Results carry `partial` so the UI can say "closest matches" instead of
   * silently pretending it was an exact hit.
   */
  function search(entries, query, limit) {
    const qs = tokens(query);
    if (!qs.length) return [];

    const rank = (requireAll) => {
      const out = [];
      for (const e of entries) {
        let total = 0, matched = 0;
        for (const q of qs) {
          const s = scoreToken(q, e.tokens, e.stems);
          if (s > 0) { total += s; matched++; }
        }
        if (matched === 0 || (requireAll && matched < qs.length)) continue;
        // Shorter fields matching the same words are more likely to be the thing you meant:
        // "CURLY FRIES" should beat "BUCKET OF FRIES- ADD CHILI OR CHEESE - ADD".
        const brevity = 1 + 2 / (1 + e.len);
        const coverage = matched / qs.length;
        // Category weight is intentionally ignored in the relaxed pass. Boosting a vendor name
        // makes sense when it fully matches, but on a partial match it just lets an incidental
        // word win: "fired rice" was returning the stand "Brad & Harry's Deep Fried Cheese
        // Curds" ahead of the actual rice dish.
        const weight = requireAll ? e.weight : 1;
        out.push({
          obj: e.obj,
          matched,
          partial: matched < qs.length,
          score: total * weight * brevity * coverage + (e.obj.boost || 0),
        });
      }
      out.sort((a, b) => (b.matched - a.matched) || (b.score - a.score));
      return out;
    };

    let out = rank(true);
    if (!out.length && qs.length > 1) out = rank(false);
    return limit ? out.slice(0, limit) : out;
  }

  /**
   * Nearest suggestion for a query that found nothing — powers "did you mean …?".
   * Compares against single words only, which is where typos actually happen.
   */
  function suggest(entries, query) {
    const qs = tokens(query);
    if (!qs.length) return null;
    const vocab = new Map();
    for (const e of entries) for (const t of e.tokens) vocab.set(t, (vocab.get(t) || 0) + 1);

    const fixed = [];
    let changed = false;
    for (const q of qs) {
      if (vocab.has(q)) { fixed.push(q); continue; }
      let best = null, bestD = Infinity, bestFreq = 0;
      const max = Math.max(1, allowedEdits(q));
      for (const [w, freq] of vocab) {
        if (Math.abs(w.length - q.length) > max) continue;
        const d = editDistance(q, w, max);
        if (d < bestD || (d === bestD && freq > bestFreq)) { bestD = d; best = w; bestFreq = freq; }
      }
      if (best && bestD <= max) { fixed.push(best); changed = true; }
      else fixed.push(q);
    }
    return changed ? fixed.join(' ') : null;
  }

  window.Fuzzy = { normalize, tokens, stem, editDistance, makeEntry, search, suggest };
})();
