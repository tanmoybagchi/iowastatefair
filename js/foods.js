'use strict';
/*
 * foods.js — the new-foods browser.
 *
 * Shows the fair's own People's Choice standings (finalists 1–3, semi-finalists 4–11) rather
 * than any invented rating, then every 2026 debut with price where the brochure gave one,
 * dietary flags from the official lists, and distance when we have a fix.
 */
(function () {
  const F = window.FAIR;
  const Geo = window.Geo;
  if (!F) return;

  const $ = id => document.getElementById(id);
  const standById = new Map(F.stands.map(s => [s.id, s]));
  const diets = new Set();

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function titleCase(s) {
    return s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
      .replace(/\b(And|Or|With|Of|The|A|On|In|To)\b/g, w => w.toLowerCase())
      .replace(/^./, c => c.toUpperCase())
      .replace(/\bBbq\b/g, 'BBQ').replace(/\bPb\b/g, 'PB').replace(/\bOz\b/g, 'oz');
  }

  const DIET_LABEL = { V: 'Vegan', VG: 'Vegetarian', GF: 'Gluten-friendly', DF: 'Dairy-free' };

  /** Nearest stand selling an item, so "where" is actionable rather than arbitrary. */
  function whereFor(item) {
    const options = (item.s || []).map(id => standById.get(id)).filter(Boolean);
    if (!options.length) return null;
    const g = Geo.snapshot();
    if (!g.usable) return options[0];
    let best = options[0], bestD = Infinity;
    for (const s of options) {
      if (s.lat == null) continue;
      const d = Geo.distanceFt(g.lat, g.lon, s.lat, s.lon);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  function distanceLine(stand) {
    if (!stand || stand.lat == null) return '';
    const d = Geo.distanceTo(stand);
    if (d == null) return '';
    // Time first, distance in the brackets — matching the Find screen, which leads with the walk.
    return ` · ${Geo.formatWalk(d)} (${Geo.formatDistance(d)})`;
  }

  function dietBadges(item) {
    return (item.d || []).map(d => `<span class="badge diet">${DIET_LABEL[d] || d}</span>`).join('');
  }

  // ------------------------------------------------------------------ ranked

  function renderRanked() {
    $('voting').textContent = F.meta.newFoodVoting || '';
    // Match each ranked entry to its parsed menu item so we can show diet flags and distance.
    const byName = new Map(F.items.map(i => [i.n.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(), i]));
    const html = F.ranked.map(r => {
      const key = r.name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
      const item = byName.get(key) || F.items.find(i => i.rank === r.rank);
      const stand = item ? whereFor(item) : null;
      return `<div class="food">
        <div class="rankno ${r.tier === 'finalist' ? '' : 'semi'}">${r.rank}</div>
        <div class="main" style="flex:1;min-width:0">
          <div><b>${esc(r.name)}</b> <span class="price">${esc(r.price || '')}</span></div>
          <div class="sub">${esc(r.vendor)}${stand ? ` · ${esc(stand.loc)}` : ''}${esc(distanceLine(stand))}</div>
          <div class="desc">${esc(r.desc)}</div>
          <div class="badges">
            <span class="badge rank">${r.tier === 'finalist' ? 'Finalist' : 'Semi-finalist'} #${r.rank}</span>
            ${r.award ? `<span class="badge new">${esc(r.award)}</span>` : ''}
            ${item ? dietBadges(item) : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    $('ranked').innerHTML = html;
  }

  // ------------------------------------------------------------------ all new

  function renderAll() {
    let items = F.items.filter(i => i.new);
    if (diets.size) items = items.filter(i => [...diets].every(d => (i.d || []).includes(d)));

    const g = Geo.snapshot();
    const withStand = items.map(i => ({ item: i, stand: whereFor(i) }));
    if (g.usable) {
      withStand.sort((a, b) => {
        const da = a.stand ? Geo.distanceTo(a.stand) : null;
        const db = b.stand ? Geo.distanceTo(b.stand) : null;
        if (da == null && db == null) return a.item.n.localeCompare(b.item.n);
        if (da == null) return 1;
        if (db == null) return -1;
        return da - db;
      });
    } else {
      withStand.sort((a, b) => a.item.n.localeCompare(b.item.n));
    }

    const header = g.usable
      ? `<p class="provenance">${withStand.length} items, nearest first.</p>`
      : `<p class="provenance">${withStand.length} items, A–Z. ${
          g.status === 'offsite' ? 'You’re away from the fairgrounds, so distances are hidden.'
            : 'Turn on location to sort by how close they are.'}</p>`;

    const rows = withStand.map(({ item, stand }) => `<div class="food">
      <div class="main" style="flex:1;min-width:0">
        <div><b>${esc(titleCase(item.n))}</b> ${item.price ? `<span class="price">${esc(item.price)}</span>` : ''}</div>
        <div class="sub">${stand ? `${esc(stand.name)} · ${esc(stand.loc)}${esc(distanceLine(stand))}` : 'Location not published'}</div>
        <div class="badges">
          ${item.rank ? `<span class="badge rank">${item.tier === 'finalist' ? 'Finalist' : 'Semi'} #${item.rank}</span>` : '<span class="badge new">New 2026</span>'}
          ${dietBadges(item)}
          ${stand && (stand.src === 'grid' || stand.src === 'offset') ? '<span class="badge approx">approx. location</span>' : ''}
        </div>
      </div>
    </div>`).join('');

    $('all').innerHTML = header + (rows || '<p class="empty">No new foods match those filters.</p>');
  }

  document.querySelectorAll('.chip[data-diet]').forEach(c =>
    c.addEventListener('click', () => {
      const d = c.dataset.diet;
      const on = diets.has(d);
      if (on) diets.delete(d); else diets.add(d);
      c.setAttribute('aria-pressed', String(!on));
      renderAll();
    }));

  renderRanked();
  renderAll();

  // Re-render as the fix arrives so distances appear without a reload.
  Geo.subscribe(() => { renderRanked(); renderAll(); });
  Geo.start();
})();
