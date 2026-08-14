'use strict';
/*
 * fairmap.js — the fairgrounds drawn as inline SVG from real OpenStreetMap footprints.
 *
 * Exposes window.FairMap. There is no tile server and no mapping library, which is the point:
 * the app has to work when 100k+ people have flattened the cell network, and a clean schematic
 * of 117 buildings reads better on a phone than satellite imagery anyway.
 *
 * Coordinates are projected to a flat FEET grid (equirectangular, fine over 450 acres). Working
 * in feet means stroke widths, label offsets and zoom limits are all expressed in real-world
 * distances, which keeps the drawing code readable.
 */
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FT_PER_DEG_LAT = 364000;

  const MIN_SPAN_FT = 300;      // deepest zoom: about a city block across
  const MAX_SPAN_PAD = 1.15;    // widest zoom: whole grounds plus a margin

  let svg, layers, opts = {};
  let proj = null;              // {lat0, lon0, ftPerDegLon, width, height}
  let view = null;              // current viewBox {x, y, w, h}
  let pins = [];
  let user = null;
  let target = null;
  let selectedId = null;

  const el = (name, attrs, parent) => {
    const n = document.createElementNS(SVG_NS, name);
    if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };

  // ------------------------------------------------------------------ projection

  function makeProjection(bounds) {
    const midLat = (bounds.minLat + bounds.maxLat) / 2;
    const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
    const p = {
      lat0: bounds.maxLat,           // y grows downward from the north edge
      lon0: bounds.minLon,
      ftPerDegLon,
      width: (bounds.maxLon - bounds.minLon) * ftPerDegLon,
      height: (bounds.maxLat - bounds.minLat) * FT_PER_DEG_LAT,
    };
    return p;
  }

  const px = lon => (lon - proj.lon0) * proj.ftPerDegLon;
  const py = lat => (proj.lat0 - lat) * FT_PER_DEG_LAT;

  /** World feet per screen pixel at the current zoom. */
  function scale() {
    const r = svg.getBoundingClientRect();
    return r.width ? view.w / r.width : 1;
  }

  // ------------------------------------------------------------------ static layers

  function pathFor(pts, close) {
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      d += (i ? 'L' : 'M') + px(pts[i][1]).toFixed(1) + ' ' + py(pts[i][0]).toFixed(1);
    }
    return d + (close ? 'Z' : '');
  }

  function drawBase(geom) {
    // Order matters: ground cover, then ways, then buildings on top.
    for (const a of geom.areas || []) {
      el('path', { d: pathFor(a.p, true), class: `area area-${a.k || 'other'}` }, layers.areas);
    }
    for (const w of geom.paths || []) {
      const major = /residential|tertiary|unclassified|pedestrian/.test(w.k || '');
      el('path', {
        d: pathFor(w.p, false),
        class: `way ${major ? 'way-major' : 'way-minor'}`,
      }, layers.ways);
    }
    for (const b of geom.buildings || []) {
      const node = el('path', { d: pathFor(b.p, true), class: 'bldg' }, layers.bldgs);
      if (b.n) node.setAttribute('data-name', b.n);
    }
  }

  /*
   * Building labels are only worth drawing for the larger structures, and only when zoomed in
   * far enough that they don't collide. Each label stores the building's on-screen size so the
   * zoom handler can decide cheaply, without re-measuring geometry every frame.
   */
  function drawLabels(geom) {
    for (const b of geom.buildings || []) {
      if (!b.n) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [la, lo] of b.p) {
        const x = px(lo), y = py(la);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const w = maxX - minX, h = maxY - minY;
      const t = el('text', {
        x: ((minX + maxX) / 2).toFixed(1),
        y: ((minY + maxY) / 2).toFixed(1),
        class: 'bldg-label',
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      }, layers.labels);
      t.textContent = b.n;
      t.__extent = Math.max(w, h);
    }
  }

  // ------------------------------------------------------------------ dynamic layers

  const PIN_R = 26;      // feet — tuned so pins stay tappable when zoomed out

  function drawPins() {
    layers.pins.textContent = '';
    for (const p of pins) {
      if (p.lat == null) continue;
      const g = el('g', {
        class: `pin pin-${p.kind || 'stand'}${p.id === selectedId ? ' is-selected' : ''}`,
        transform: `translate(${px(p.lon).toFixed(1)} ${py(p.lat).toFixed(1)})`,
        tabindex: '0',
        role: 'button',
        'aria-label': p.label || 'Map pin',
      }, layers.pins);
      // Generous invisible hit area — fingers are bigger than pins.
      el('circle', { r: PIN_R * 2.2, class: 'pin-hit' }, g);
      el('circle', { r: PIN_R, class: 'pin-dot' }, g);
      if (p.approx) el('circle', { r: PIN_R * 1.9, class: 'pin-approx' }, g);
      const activate = (ev) => {
        ev.stopPropagation();
        if (opts.onSelect) opts.onSelect(p);
      };
      g.addEventListener('click', activate);
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(ev); }
      });
    }
  }

  function drawUser() {
    layers.user.textContent = '';
    if (!user || user.lat == null) return;
    const x = px(user.lon), y = py(user.lat);
    const g = el('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, class: 'me' }, layers.user);

    // The accuracy circle is drawn to true scale. Showing it is the honest thing to do — a
    // 100 ft radius looks alarming precisely because it *is* the uncertainty you're navigating with.
    if (user.accuracyFt > 0) el('circle', { r: user.accuracyFt.toFixed(0), class: 'me-acc' }, g);
    el('circle', { r: 22, class: 'me-dot' }, g);

    if (user.heading != null) {
      // A cone pointing where the phone is facing, rotated into map space (north is -y).
      el('path', { d: 'M0,-90 L34,-30 L-34,-30 Z', class: 'me-heading', transform: `rotate(${user.heading.toFixed(0)})` }, g);
    }
  }

  function drawTarget() {
    layers.route.textContent = '';
    if (!target || target.lat == null) return;
    const tx = px(target.lon), ty = py(target.lat);

    if (user && user.lat != null) {
      // A straight line, and labelled as such in the UI. Drawing a fake road-following route
      // would imply routing we haven't done.
      el('line', {
        x1: px(user.lon).toFixed(1), y1: py(user.lat).toFixed(1),
        x2: tx.toFixed(1), y2: ty.toFixed(1),
        class: 'route-line',
      }, layers.route);
    }
    const g = el('g', { transform: `translate(${tx.toFixed(1)} ${ty.toFixed(1)})`, class: 'target' }, layers.route);
    el('circle', { r: 46, class: 'target-ring' }, g);
    el('circle', { r: 18, class: 'target-dot' }, g);
  }

  // ------------------------------------------------------------------ view control

  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const s = scale();
    // Keep text and hairlines at a constant on-screen size by expressing them in world units.
    const fs = Math.max(7 * s, 20);
    for (const t of layers.labels.children) {
      const visible = t.__extent / s > 46;   // hide labels for buildings smaller than ~46px
      t.style.display = visible ? '' : 'none';
      if (visible) t.setAttribute('font-size', fs.toFixed(1));
    }
    layers.pins.setAttribute('stroke-width', (1.5 * s).toFixed(2));
    svg.style.setProperty('--s', s.toFixed(3));
  }

  function clampView() {
    const maxW = proj.width * MAX_SPAN_PAD;
    const maxH = proj.height * MAX_SPAN_PAD;
    view.w = Math.min(Math.max(view.w, MIN_SPAN_FT), maxW);
    view.h = Math.min(Math.max(view.h, MIN_SPAN_FT * (view.h / view.w || 1)), maxH);
    // Allow half a screen of overscroll so edge features can be centred.
    view.x = Math.min(Math.max(view.x, -view.w / 2), proj.width - view.w / 2);
    view.y = Math.min(Math.max(view.y, -view.h / 2), proj.height - view.h / 2);
  }

  function fitAll() {
    const r = svg.getBoundingClientRect();
    const aspect = r.height && r.width ? r.height / r.width : 1;
    let w = proj.width, h = w * aspect;
    if (h < proj.height) { h = proj.height; w = h / aspect; }
    view = { x: (proj.width - w) / 2, y: (proj.height - h) / 2, w, h };
    applyView();
  }

  function zoomAt(factor, cx, cy) {
    const before = clientToWorld(cx, cy);
    view.w *= factor;
    view.h *= factor;
    clampView();
    const after = clientToWorld(cx, cy);
    view.x += before.x - after.x;
    view.y += before.y - after.y;
    clampView();
    applyView();
  }

  function clientToWorld(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return {
      x: view.x + ((clientX - r.left) / r.width) * view.w,
      y: view.y + ((clientY - r.top) / r.height) * view.h,
    };
  }

  // ------------------------------------------------------------------ gestures

  function bindGestures() {
    const active = new Map();
    let panStart = null, pinchStart = null;

    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (active.size === 1) {
        panStart = { world: clientToWorld(e.clientX, e.clientY), view: { ...view } };
      } else if (active.size === 2) {
        const [a, b] = [...active.values()];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), w: view.w, h: view.h };
        panStart = null;
      }
    });

    svg.addEventListener('pointermove', (e) => {
      if (!active.has(e.pointerId)) return;
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (active.size === 2 && pinchStart) {
        const [a, b] = [...active.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > 0 && pinchStart.dist > 0) {
          const f = pinchStart.dist / dist;
          const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
          const before = clientToWorld(midX, midY);
          view.w = pinchStart.w * f;
          view.h = pinchStart.h * f;
          clampView();
          const after = clientToWorld(midX, midY);
          view.x += before.x - after.x;
          view.y += before.y - after.y;
          clampView();
          applyView();
        }
        return;
      }

      if (active.size === 1 && panStart) {
        const r = svg.getBoundingClientRect();
        const start = panStart;
        // Recompute against the pan-start viewBox so dragging doesn't compound rounding.
        const wx = start.view.x + ((e.clientX - r.left) / r.width) * start.view.w;
        const wy = start.view.y + ((e.clientY - r.top) / r.height) * start.view.h;
        view.x = start.view.x + (start.world.x - wx);
        view.y = start.view.y + (start.world.y - wy);
        clampView();
        applyView();
      }
    });

    const end = (e) => {
      active.delete(e.pointerId);
      if (active.size < 2) pinchStart = null;
      if (active.size === 0) panStart = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    }, { passive: false });

    // Keyboard panning/zooming, so the map isn't mouse-or-nothing.
    svg.addEventListener('keydown', (e) => {
      const step = view.w * 0.15;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        e.preventDefault();
        view.x += moves[e.key][0];
        view.y += moves[e.key][1];
        clampView(); applyView();
      } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCentre(1 / 1.3); }
      else if (e.key === '-') { e.preventDefault(); zoomCentre(1.3); }
      else if (e.key === '0') { e.preventDefault(); fitAll(); }
    });
  }

  function zoomCentre(factor) {
    const r = svg.getBoundingClientRect();
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  // ------------------------------------------------------------------ public

  window.FairMap = {
    init(svgEl, geom, bounds, options) {
      svg = svgEl;
      opts = options || {};
      proj = makeProjection(bounds);
      svg.setAttribute('tabindex', '0');
      svg.setAttribute('role', 'application');
      svg.setAttribute('aria-label', 'Iowa State Fairgrounds map');
      svg.textContent = '';

      layers = {};
      for (const name of ['areas', 'ways', 'bldgs', 'labels', 'pins', 'route', 'user']) {
        layers[name] = el('g', { class: `layer layer-${name}` }, svg);
      }
      drawBase(geom);
      drawLabels(geom);
      fitAll();
      bindGestures();

      svg.addEventListener('click', () => { if (opts.onBackgroundClick) opts.onBackgroundClick(); });
      window.addEventListener('resize', () => { clampView(); applyView(); });
      return this;
    },

    setPins(list) { pins = list || []; drawPins(); return this; },
    setSelected(id) { selectedId = id; drawPins(); return this; },
    setUser(u) { user = u; drawUser(); drawTarget(); return this; },
    setTarget(pt) { target = pt; drawTarget(); return this; },

    /**
     * Centre on a point, optionally zooming to a given span in feet.
     *
     * Biased upward because the results/directions sheet covers the lower part of the screen —
     * true centring put the thing you just selected underneath the sheet.
     */
    focus(pt, spanFt, biasY) {
      if (!pt || pt.lat == null || !view) return this;
      if (spanFt) {
        const aspect = view.h / view.w;
        view.w = spanFt;
        view.h = spanFt * aspect;
      }
      view.x = px(pt.lon) - view.w / 2;
      view.y = py(pt.lat) - view.h / 2 + view.h * (biasY == null ? 0.18 : biasY);
      clampView();
      applyView();
      return this;
    },

    /** Frame two points together — used to show you and your destination at once. */
    frame(a, b, padFt) {
      if (!a || !b || a.lat == null || b.lat == null) return this;
      const pad = padFt || 220;
      const x1 = Math.min(px(a.lon), px(b.lon)) - pad, x2 = Math.max(px(a.lon), px(b.lon)) + pad;
      const y1 = Math.min(py(a.lat), py(b.lat)) - pad, y2 = Math.max(py(a.lat), py(b.lat)) + pad;
      const aspect = view.h / view.w;
      let w = Math.max(x2 - x1, MIN_SPAN_FT), h = w * aspect;
      if (h < y2 - y1) { h = y2 - y1; w = h / aspect; }
      // Same upward bias as focus(): keep both points clear of the sheet.
      view = { x: (x1 + x2) / 2 - w / 2, y: (y1 + y2) / 2 - h / 2 + h * 0.18, w, h };
      clampView();
      applyView();
      return this;
    },

    reset() { fitAll(); return this; },
    zoomIn() { zoomCentre(1 / 1.4); return this; },
    zoomOut() { zoomCentre(1.4); return this; },
  };
})();
