'use strict';
/*
 * find.js — the app's main screen: ask for something, get it sorted by distance, walk there.
 *
 * The core loop is deliberately short: type or tap a chip -> distance-sorted list -> tap a
 * result -> live directions. Everything is computed from the baked dataset, so it behaves the
 * same with or without a network.
 *
 * Honesty rules enforced here, because they're the difference between useful and misleading:
 *   - No distance is shown unless we actually have a usable fix inside the fairgrounds.
 *   - Pins derived from the map grid or an offset are labelled "approx.".
 *   - The on-map line is called a straight line, never a route.
 */
(function () {
  const F = window.FAIR;
  const G = window.FAIR_GEOM;
  const Geo = window.Geo;
  const Fz = window.Fuzzy;

  if (!F || !G) { document.body.innerHTML = '<p class="empty">Data failed to load. Rebuild with <code>node tools/build-data.js</code>.</p>'; return; }

  const $ = id => document.getElementById(id);
  const mapEl = $('map'), qEl = $('q'), clearEl = $('clear');
  const sheet = $('sheet'), sheetBody = $('sheet-body'), sheetTitle = $('sheet-title');
  const statusEl = $('status');

  const standById = new Map(F.stands.map(s => [s.id, s]));

  // ------------------------------------------------------------------ search corpus
  /*
   * Three kinds of thing are searchable, weighted so that typing a vendor's name finds the
   * vendor rather than one of its 40 menu lines, while typing a food still finds the food.
   */
  const entries = [];
  for (const it of F.items) {
    entries.push(Fz.makeEntry({ type: 'item', item: it }, it.n, 1));
  }
  for (const s of F.stands) {
    entries.push(Fz.makeEntry({ type: 'stand', stand: s }, s.name, 1.6));
  }
  for (const l of F.landmarks) {
    entries.push(Fz.makeEntry({ type: 'landmark', landmark: l }, l.name, 1.3));
  }
  for (const w of F.water) {
    entries.push(Fz.makeEntry({ type: 'water', water: w }, `water refill fountain bottle ${w.at}`, 1.2));
  }
  for (const a of F.amenities) {
    entries.push(Fz.makeEntry({ type: 'amenity', amenity: a }, `${a.name} ${a.kind}`, 1.2));
  }

  // ------------------------------------------------------------------ view model

  const state = {
    mode: 'idle',        // idle | search | chip
    query: '',
    chip: null,
    diets: new Set(),
    results: [],
    partial: false,
    selected: null,      // {kind, label, sub, lat, lon, approx, stand?, item?}
  };

  /** Every searchable thing reduced to one shape the list and map both understand. */
  function toPlace(obj) {
    if (obj.type === 'item') {
      const it = obj.item;
      // An item can be sold at several stands; the nearest one is the useful answer.
      const options = it.s.map(id => standById.get(id)).filter(s => s && s.lat != null);
      const stand = nearestOf(options) || standById.get(it.s[0]);
      return {
        kind: 'stand',
        label: titleCase(it.n),
        sub: stand ? `${stand.name} · ${locLabel(stand)}` : 'Location unknown',
        lat: stand ? stand.lat : null,
        lon: stand ? stand.lon : null,
        approx: stand ? isApprox(stand) : true,
        item: it,
        stand,
        alsoAt: options.length > 1 ? options.length : 0,
      };
    }
    if (obj.type === 'stand') {
      const s = obj.stand;
      return { kind: 'stand', label: s.name, sub: locLabel(s), lat: s.lat, lon: s.lon, approx: isApprox(s), stand: s };
    }
    if (obj.type === 'landmark') {
      const l = obj.landmark;
      return { kind: 'landmark', label: l.name, sub: l.grid ? `Map grid ${l.grid}` : 'Fairgrounds', lat: l.lat, lon: l.lon, approx: l.conf !== 'high' };
    }
    if (obj.type === 'water') {
      const w = obj.water;
      const paid = w.kind === 'booth';
      return {
        kind: 'water',
        label: paid ? `Water booth — ${w.at}` : `Water at ${w.at}`,
        sub: w.detail,
        lat: w.lat, lon: w.lon,
        approx: w.conf !== 'high',
        tag: paid ? 'for sale' : (w.kind === 'both' ? 'bottle refill' : 'fountain'),
      };
    }
    const a = obj.amenity;
    return { kind: 'amenity', label: a.name, sub: a.detail || `At ${a.at}`, lat: a.lat, lon: a.lon, approx: a.conf !== 'high' };
  }

  const isApprox = s => s.src === 'grid' || s.src === 'offset' || s.conf === 'low';

  const normKey = s => (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

  /**
   * A readable location line for a stand.
   *
   * Some stands have no separate location label in the fair's report, so their own name lands in
   * the location field — printing it verbatim gave rows like
   * "Old West Roadhouse BBQ · OLD WEST ROADHOUSE BBQ". Fall back to the landmark we matched, and
   * sentence-case any SHOUTING location text.
   */
  function locLabel(stand) {
    if (!stand) return '';
    const loc = stand.loc || '';
    const redundant = normKey(loc) === normKey(stand.name) ||
      normKey(loc).includes(normKey(stand.name)) && normKey(loc).length - normKey(stand.name).length < 6;
    if (redundant) return stand.landmark ? `At ${stand.landmark}` : 'Location as published';
    // Locations are normally mixed case; all-caps means it came from the raw space description.
    return loc === loc.toUpperCase() && /[A-Z]{4}/.test(loc) ? titleCase(loc) : loc;
  }

  function nearestOf(list) {
    const g = Geo.snapshot();
    if (!list.length) return null;
    if (!g.usable) return list[0];
    let best = null, bestD = Infinity;
    for (const s of list) {
      const d = Geo.distanceFt(g.lat, g.lon, s.lat, s.lon);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** The reports are ALL CAPS; sentence-case reads far better on a phone. */
  function titleCase(s) {
    return s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
      .replace(/\b(And|Or|With|Of|The|A|On|In|To)\b/g, w => w.toLowerCase())
      .replace(/^./, c => c.toUpperCase())
      .replace(/\bBbq\b/g, 'BBQ').replace(/\bPb\b/g, 'PB').replace(/\bOz\b/g, 'oz')
      .replace(/\bAw\b/g, 'A&W').replace(/\bJr\b/g, 'JR');
  }

  // ------------------------------------------------------------------ chips

  const CHIPS = {
    new: {
      title: 'New for 2026',
      build: () => F.items.filter(i => i.new).map(i => toPlace({ type: 'item', item: i })),
    },
    water: {
      title: 'Water',
      build: () => F.water.map(w => toPlace({ type: 'water', water: w })),
    },
    stick: {
      title: 'Food on a stick',
      build: () => F.items.filter(i => /\bON A STICK\b/i.test(i.n)).map(i => toPlace({ type: 'item', item: i })),
    },
    firstaid: {
      title: 'First aid & help',
      build: () => F.amenities.filter(a => ['first-aid', 'info', 'police'].includes(a.kind))
        .map(a => toPlace({ type: 'amenity', amenity: a })),
    },
    beer: {
      title: 'Beer & bars',
      build: () => F.stands.filter(s => s.group === 'beer')
        .map(s => toPlace({ type: 'stand', stand: s })),
    },
    gates: {
      title: 'Gates',
      build: () => F.landmarks.filter(l => /^Gate /.test(l.name))
        .map(l => toPlace({ type: 'landmark', landmark: l })),
    },
  };

  // ------------------------------------------------------------------ rendering

  function distanceBits(place) {
    const d = Geo.distanceTo(place);
    if (d == null) return '';
    return `<div class="dist"><b>${Geo.formatDistance(d)}</b><span>${Geo.formatWalk(d)}</span></div>`;
  }

  function badgesFor(place) {
    const b = [];
    const it = place.item;
    if (it) {
      if (it.rank) b.push(`<span class="badge rank">${it.tier === 'finalist' ? 'Finalist' : 'Semi'} #${it.rank}</span>`);
      else if (it.new) b.push('<span class="badge new">New 2026</span>');
      for (const d of it.d || []) {
        b.push(`<span class="badge diet">${{ V: 'Vegan', VG: 'Vegetarian', GF: 'Gluten-friendly', DF: 'Dairy-free' }[d] || d}</span>`);
      }
    }
    if (place.tag) b.push(`<span class="badge">${place.tag}</span>`);
    if (place.stand && place.stand.group === 'beer') b.push('<span class="badge beer">Serves alcohol</span>');
    if (place.approx) b.push('<span class="badge approx">approx. location</span>');
    if (place.alsoAt) b.push(`<span class="badge">at ${place.alsoAt} stands</span>`);
    return b.length ? `<div class="badges">${b.join('')}</div>` : '';
  }

  function renderList() {
    const g = Geo.snapshot();
    let places = state.results;

    if (state.diets.size) {
      places = places.filter(p => p.item && [...state.diets].every(d => (p.item.d || []).includes(d)));
    }

    /*
     * Ordering. Distance is the point of this app, but it can't be the only key for a search:
     * sorting purely by distance let a nearby weak match ("Candy Bar - Fried") outrank the thing
     * actually asked for. So search results tier by how many query words matched, and distance
     * decides within a tier. Chip categories have no relevance signal, so they sort purely by
     * distance. With no fix, everything falls back to A–Z rather than inventing an order.
     */
    const byDistance = (a, b) => {
      const da = Geo.distanceTo(a), db = Geo.distanceTo(b);
      if (da == null && db == null) return a.label.localeCompare(b.label);
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    };

    if (!g.usable) {
      places = places.slice().sort((a, b) =>
        (b.matched || 0) - (a.matched || 0) || (b.score || 0) - (a.score || 0) ||
        a.label.localeCompare(b.label));
    } else if (state.mode === 'search') {
      // Relevance tier, then distance inside the tier. The tier is relative to the best score
      // rather than an absolute cut, because scores aren't comparable between queries: a strong
      // one-word hit and a weak one can both be "the best there is" depending on what was typed.
      const best = places.reduce((m, p) => Math.max(m, p.score || 0), 0) || 1;
      const tier = p => ((p.matched || 0) >= 2 ? 0 : 1) * 10 + ((p.score || 0) >= best * 0.5 ? 0 : 1);
      places = places.slice().sort((a, b) =>
        tier(a) - tier(b) || byDistance(a, b) || (b.score || 0) - (a.score || 0));
    } else {
      places = places.slice().sort(byDistance);
    }

    const shown = places.slice(0, 60);
    sheetTitle.textContent = state.mode === 'chip'
      ? `${CHIPS[state.chip].title} · ${places.length}`
      : `${places.length} result${places.length === 1 ? '' : 's'}`;

    let html = '';
    if (state.partial) {
      html += `<p class="note">No exact match — showing the closest things we could find.</p>`;
    }
    if (!g.usable && places.length) {
      html += `<p class="note">${
        g.status === 'offsite'
          ? 'You’re not at the fairgrounds, so distances are hidden. Sorted A–Z.'
          : 'Waiting on your location, so distances are hidden. Sorted A–Z.'
      }</p>`;
    } else if (g.poor && places.length) {
      html += `<p class="note">Your location is only accurate to about ${Geo.formatDistance(g.accuracyFt)}, so distances are rough.</p>`;
    }

    if (!shown.length) {
      const sug = state.query ? Fz.suggest(entries, state.query) : null;
      html += `<div class="empty">
        <p>Nothing matched <b>${escapeHtml(state.query || '')}</b>.</p>
        ${sug ? `<p><button class="btn ghost" data-suggest="${escapeHtml(sug)}">Try “${escapeHtml(sug)}”</button></p>` : ''}
        <p class="hint">This app only knows what the fair published: ${F.items.length.toLocaleString()} menu items across ${F.stands.length} stands.</p>
      </div>`;
    } else {
      for (let i = 0; i < shown.length; i++) {
        const p = shown[i];
        html += `<button class="result" data-i="${i}">
          <div class="main">
            <div class="name">${escapeHtml(p.label)}</div>
            <div class="sub">${escapeHtml(p.sub || '')}</div>
            ${badgesFor(p)}
          </div>
          ${distanceBits(p)}
        </button>`;
      }
      if (places.length > shown.length) {
        html += `<p class="note">Showing the ${shown.length} nearest of ${places.length}. Narrow your search to see more.</p>`;
      }
    }

    sheetBody.innerHTML = html;
    sheetBody.querySelectorAll('.result').forEach(btn => {
      btn.addEventListener('click', () => select(shown[+btn.dataset.i]));
    });
    const sBtn = sheetBody.querySelector('[data-suggest]');
    if (sBtn) sBtn.addEventListener('click', () => { qEl.value = sBtn.dataset.suggest; runSearch(); });

    /*
     * Deliberately does NOT open the sheet.
     *
     * This runs on every geolocation tick to keep distances honest as you walk, and watchPosition
     * fires constantly. If rendering also forced the panel open, dismissing it would last until
     * the next GPS fix — which looked exactly like the close button being broken. Callers that
     * mean "show me this list" call openSheet() themselves; refreshing content is a separate act
     * from presenting it.
     *
     * Pins are still updated while the panel is closed, on purpose: closing it is how you get a
     * look at the pins on the map.
     */
    updatePins(places);
  }

  function updatePins(places) {
    const pins = places.slice(0, 120)
      .filter(p => p.lat != null)
      .map((p, i) => ({ id: `p${i}`, lat: p.lat, lon: p.lon, kind: p.kind, approx: p.approx, label: p.label, place: p }));
    window.FairMap.setPins(pins);
  }

  // ------------------------------------------------------------------ directions

  function select(place) {
    if (!place) return;
    state.selected = place;
    window.FairMap.setTarget(place.lat != null ? place : null);

    const g = Geo.snapshot();
    if (place.lat != null) {
      if (g.usable) window.FairMap.frame(g, place);
      else window.FairMap.focus(place, 900);
    }
    // You're about to walk somewhere while watching the distance — don't let the screen sleep.
    // Released again by closeSheet() and by "Back to list".
    if (window.Wake) window.Wake.hold();
    renderDirections();
  }

  function renderDirections() {
    const p = state.selected;
    if (!p) return;
    const g = Geo.snapshot();
    const d = Geo.distanceTo(p);
    const brg = Geo.bearingTo(p);

    sheetTitle.textContent = 'Walking there';

    let live;
    if (p.lat == null) {
      live = `<p class="note">The fair lists no location for this one, so we can’t point you to it.</p>`;
    } else if (d != null) {
      // If we know the phone's heading, rotate the arrow into a relative direction. Otherwise
      // give the compass bearing in words, which is still actionable.
      const rel = g.heading != null ? (brg - g.heading + 360) % 360 : null;
      live = `<div class="dir-live">
        <div class="arrow" id="arrow" style="transform:rotate(${(rel != null ? rel : 0).toFixed(0)}deg)" aria-hidden="true">↑</div>
        <div>
          <div class="big">${Geo.formatDistance(d)}</div>
          <div class="small">${Geo.formatWalk(d)} · head ${Geo.compassName(brg)}${rel != null ? '' : ' (compass off)'}</div>
        </div>
      </div>`;
    } else {
      live = `<p class="note">${g.status === 'offsite'
        ? 'You’re away from the fairgrounds, so live distance is off.'
        : 'Turn on location to get live distance and direction.'}</p>`;
    }

    const maps = p.lat != null ? Geo.mapsUrl(p) : null;
    const menu = p.stand && p.stand.id != null ? menuFor(p.stand) : '';

    sheetBody.innerHTML = `<div class="dir">
      <div class="where">${escapeHtml(p.label)}</div>
      <div class="at">${escapeHtml(p.sub || '')}</div>
      ${badgesFor(p)}
      ${live}
      <div class="btnrow">
        ${maps ? `<a class="btn primary" href="${maps}" target="_blank" rel="noopener">Open in Google Maps</a>` : ''}
        ${g.heading == null && p.lat != null ? '<button class="btn" id="compass" type="button">Use compass</button>' : ''}
        <button class="btn ghost" id="back" type="button">Back to list</button>
      </div>
      ${p.lat != null ? `<p class="hint">
        The green line is a straight line to the target, not a walking route — buildings and
        fences are in the way. ${p.approx ? 'This pin is approximate: it points at the right building or corner, not an exact stand.' : ''}
      </p>` : ''}
      ${menu}
    </div>`;

    const back = document.getElementById('back');
    if (back) back.addEventListener('click', () => {
      state.selected = null;
      window.FairMap.setTarget(null);
      if (window.Wake) window.Wake.release();   // browsing a list again, not walking a route
      renderList();
      openSheet();
    });
    const comp = document.getElementById('compass');
    if (comp) comp.addEventListener('click', async () => {
      const ok = await Geo.requestHeading();
      if (!ok) comp.textContent = 'Compass unavailable';
      else renderDirections();
    });
    openSheet();
  }

  function menuFor(stand) {
    const items = F.items.filter(i => i.s.includes(stand.id));
    if (!items.length) return '';
    const list = items.slice(0, 30).map(i => `<li>${escapeHtml(titleCase(i.n))}${i.new ? ' ✨' : ''}</li>`).join('');
    return `<h3 style="margin-top:14px">Also at ${escapeHtml(stand.name)}</h3>
      <ul class="menu-list">${list}</ul>
      ${items.length > 30 ? `<p class="hint">+ ${items.length - 30} more items.</p>` : ''}
      ${stand.trunc ? '<p class="hint">The fair’s own list is cut off mid-item for this stand, so a few items may be missing.</p>' : ''}`;
  }

  // ------------------------------------------------------------------ interactions

  function runSearch() {
    const q = qEl.value.trim();
    state.query = q;
    clearEl.hidden = !q;
    if (!q) { state.mode = 'idle'; state.results = []; state.partial = false; closeSheet(); window.FairMap.setPins([]); return; }
    state.mode = 'search';
    state.chip = null;
    document.querySelectorAll('.chip[data-chip]').forEach(c => c.setAttribute('aria-pressed', 'false'));
    const hits = Fz.search(entries, q, 120);
    state.partial = hits.length > 0 && hits[0].partial;
    // De-duplicate: the same stand can surface via its name and several of its items.
    const seen = new Set();
    state.results = [];
    for (const h of hits) {
      const p = toPlace(h.obj);
      const key = `${p.kind}|${p.label}|${p.lat}|${p.lon}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Carry relevance through so renderList can tier by it before applying distance.
      p.matched = h.matched;
      p.score = h.score;
      state.results.push(p);
    }
    state.selected = null;
    window.FairMap.setTarget(null);
    renderList();
    openSheet();
  }

  function runChip(name) {
    const chip = CHIPS[name];
    if (!chip) return;
    const already = state.mode === 'chip' && state.chip === name;
    document.querySelectorAll('.chip[data-chip]').forEach(c => {
      c.setAttribute('aria-pressed', String(!already && c.dataset.chip === name));
    });
    if (already) { state.mode = 'idle'; state.results = []; closeSheet(); window.FairMap.setPins([]); return; }
    qEl.value = '';
    clearEl.hidden = true;
    state.mode = 'chip';
    state.chip = name;
    state.query = '';
    state.partial = false;
    state.selected = null;
    window.FairMap.setTarget(null);
    state.results = chip.build();
    renderList();
    openSheet();
  }

  const openSheet = () => sheet.classList.add('open');
  const closeSheet = () => {
    sheet.classList.remove('open');
    state.selected = null;
    window.FairMap.setTarget(null);
    if (window.Wake) window.Wake.release();
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------------ status strip

  function renderStatus(g) {
    const msgs = {
      denied: ['warn', 'Location is off, so we can’t sort by distance. You can still search everything.'],
      unavailable: ['warn', g.error || 'Location unavailable.'],
      timeout: ['warn', 'Still looking for your location…'],
      offsite: ['', 'You’re not at the fairgrounds — showing everything, distances off.'],
      locating: ['', 'Finding your location…'],
    };
    const m = msgs[g.status];
    if (!m) { statusEl.hidden = true; return; }
    statusEl.hidden = false;
    statusEl.className = `status ${m[0]}`;
    statusEl.innerHTML = `<span>${escapeHtml(m[1])}</span>`;
    if (g.status === 'denied' || g.status === 'unavailable') {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Retry';
      b.addEventListener('click', () => Geo.start());
      statusEl.appendChild(b);
    }
  }

  // ------------------------------------------------------------------ boot

  window.FairMap.init(mapEl, G, F.meta.bounds, {
    onSelect: pin => select(pin.place),
    onBackgroundClick: () => { /* keep the sheet — closing on every tap fights with panning */ },
  });

  qEl.addEventListener('input', debounce(runSearch, 130));
  qEl.addEventListener('search', runSearch);
  clearEl.addEventListener('click', () => { qEl.value = ''; runSearch(); qEl.focus(); });
  $('sheet-close').addEventListener('click', closeSheet);

  document.querySelectorAll('.chip[data-chip]').forEach(c =>
    c.addEventListener('click', () => runChip(c.dataset.chip)));

  document.querySelectorAll('.chip[data-diet]').forEach(c =>
    c.addEventListener('click', () => {
      const d = c.dataset.diet;
      const on = state.diets.has(d);
      if (on) state.diets.delete(d); else state.diets.add(d);
      c.setAttribute('aria-pressed', String(!on));
      // A diet filter on its own is a useful query: show everything that qualifies.
      if (state.mode === 'idle' && state.diets.size) {
        state.mode = 'chip';
        state.chip = 'new';
        state.results = F.items.filter(i => (i.d || []).length).map(i => toPlace({ type: 'item', item: i }));
        sheetTitle.textContent = 'Dietary';
      }
      if (state.mode !== 'idle') { renderList(); openSheet(); }
    }));

  $('zin').addEventListener('click', () => window.FairMap.zoomIn());
  $('zout').addEventListener('click', () => window.FairMap.zoomOut());
  $('zreset').addEventListener('click', () => window.FairMap.reset());
  $('locate').addEventListener('click', () => {
    const g = Geo.snapshot();
    if (g.lat != null) window.FairMap.focus(g, 1200);
    else Geo.start();
  });

  Geo.subscribe(g => {
    window.FairMap.setUser(g.lat != null ? { lat: g.lat, lon: g.lon, accuracyFt: g.accuracyFt, heading: g.heading } : null);
    renderStatus(g);
    // Keep the open panel truthful as the fix improves or the user walks.
    if (state.selected) renderDirections();
    else if (state.mode !== 'idle') renderList();
  });
  Geo.start();
  Geo.bindHeading();

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
})();
