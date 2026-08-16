'use strict';
/*
 * info.js — hours, gates, the full water-station list, and data provenance.
 *
 * The provenance section is not decoration. Every pin in this app is derived from prose
 * descriptions rather than surveyed coordinates, and a visitor deciding whether to trust
 * "340 ft that way" deserves to see how the number was produced and where it's weakest.
 */
(function () {
  const F = window.FAIR;
  const Geo = window.Geo;
  if (!F) return;

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------- hours

  $('hours').innerHTML = F.meta.hours.map(h => `
    <table class="tbl" style="margin-bottom:10px">
      <tr><th colspan="2">${esc(h.days)}</th></tr>
      <tr><td>Grounds</td><td>${esc(h.grounds)}</td></tr>
      <tr><td>Buildings</td><td>${esc(h.buildings)}</td></tr>
      ${h.thrill.map(([n, t]) => `<tr><td>${esc(n)}</td><td>${esc(t)}</td></tr>`).join('')}
    </table>
    <p class="provenance"><strong>${esc(h.note)}</strong></p>
  `).join('');

  // ---------------------------------------------------------------- water

  function waterRows() {
    const g = Geo.snapshot();
    const rows = F.water.slice();
    if (g.usable) {
      rows.sort((a, b) => {
        const da = Geo.distanceTo(a), db = Geo.distanceTo(b);
        if (da == null) return 1;
        if (db == null) return -1;
        return da - db;
      });
    } else {
      rows.sort((a, b) => a.at.localeCompare(b.at));
    }
    const kindLabel = { both: 'Fountain + bottle refill', fountain: 'Fountain', booth: 'Bottled water for sale' };
    $('water').innerHTML = `
      ${g.usable ? '<p class="provenance">Nearest first.</p>' : ''}
      <table class="tbl">
        <tr><th>Where</th><th>Type</th><th>Detail</th>${g.usable ? '<th>Distance</th>' : ''}</tr>
        ${rows.map(w => {
          const d = Geo.distanceTo(w);
          return `<tr>
            <td><strong>${esc(w.at)}</strong></td>
            <td>${esc(kindLabel[w.kind] || w.kind)}</td>
            <td>${esc(w.detail || '')}</td>
            ${g.usable ? `<td>${d != null ? esc(Geo.formatDistanceApprox(d, Geo.uncertaintyFt(w))) : '—'}</td>` : ''}
          </tr>`;
        }).join('')}
      </table>`;
  }

  // ---------------------------------------------------------------- gates

  function gateRows() {
    const g = Geo.snapshot();
    const gates = F.landmarks.filter(l => /^Gate /.test(l.name));
    // Natural order: Gate 2A before Gate 10.
    gates.sort((a, b) => {
      const na = parseInt(a.name.replace(/\D+/g, ''), 10);
      const nb = parseInt(b.name.replace(/\D+/g, ''), 10);
      return na - nb || a.name.localeCompare(b.name);
    });
    $('gatenote').textContent = F.meta.hours[0].note;
    $('gates').innerHTML = `<table class="tbl">
      <tr><th>Gate</th><th>Map grid</th>${g.usable ? '<th>Distance</th>' : ''}</tr>
      ${gates.map(x => {
        const d = Geo.distanceTo(x);
        return `<tr><td>${esc(x.name)}</td><td>${esc(x.grid || '—')}</td>${
          g.usable ? `<td>${d != null ? esc(Geo.formatDistanceApprox(d, Geo.uncertaintyFt(x))) : '—'}</td>` : ''}</tr>`;
      }).join('')}
    </table>`;
  }

  // ---------------------------------------------------------------- provenance

  $('addr').textContent = F.meta.address;
  $('phone').textContent = F.meta.phone;
  $('sources').innerHTML = F.meta.sources.map(s => `<li>${esc(s)}</li>`).join('');

  /*
   * The "typical error" column is rendered from Geo.PIN_ERROR_FT rather than written out here,
   * because the app now *uses* those same numbers to decide when a distance is too rough to state
   * as a figure. A table that quoted its own separate numbers would eventually contradict the
   * screen it's meant to explain.
   */
  const tiers = [
    ['edge', 'Corner or side of a mapped building'],
    ['inside', 'Inside or at a mapped building'],
    ['offset', 'Offset out from a mapped building'],
    ['grid', 'From the official printed map grid'],
    ['none', 'No location published'],
  ];
  const tierError = k => {
    const ft = (Geo.PIN_ERROR_FT || {})[k];
    return ft == null ? 'no pin shown' : `up to about ${ft} ft`;
  };
  const counts = {};
  for (const s of F.stands) counts[s.src] = (counts[s.src] || 0) + 1;
  $('accuracy').innerHTML = `
    <tr><th>Method</th><th>What it means</th><th>Typical error</th><th>Stands</th></tr>
    ${tiers.map(([k, what]) =>
      `<tr><td>${esc(k)}</td><td>${esc(what)}</td><td>${esc(tierError(k))}</td><td>${counts[k] || 0}</td></tr>`).join('')}`;

  $('counts').textContent =
    `${F.stands.length} stands · ${F.items.length.toLocaleString()} menu items · ` +
    `${F.items.filter(i => i.new).length} new for 2026 · ${F.water.length} water points · ` +
    `${F.landmarks.length} landmarks. The map grid was matched to GPS with a mean error of about 82 ft, ` +
    `which is smaller than one grid cell (${'148 × 213 ft'}).`;

  waterRows();
  gateRows();
  Geo.subscribe(() => { waterRows(); gateRows(); });
  Geo.start();
})();
