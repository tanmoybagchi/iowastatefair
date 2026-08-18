'use strict';
/*
 * smoke.js — drive the app in headless Chrome over the DevTools protocol and report what
 * actually happened: console errors, page exceptions, failed requests, and a few DOM assertions.
 *
 *   node tools/serve.js 8099 &
 *   node tools/smoke.js http://localhost:8099/
 *
 * Uses only Node's built-ins and Chrome's own remote-debugging websocket, so there is nothing
 * to install. It is intentionally small: enough to prove the pages boot, the map draws, search
 * returns the right answers and geolocation is wired up — not a full test framework.
 *
 * Geolocation is overridden to a point on the fairgrounds (the Agriculture Building), because
 * that is the only way to exercise distance sorting without standing in Des Moines.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:8099/';
const FAIR_LAT = 41.5952, FAIR_LON = -93.5510;   // Agriculture Building / Butter Cow

const { findChrome } = require('./chrome.js');

const getJson = url => new Promise((resolve, reject) => {
  (url.startsWith('https') ? https : http).get(url, res => {
    let d = '';
    res.on('data', c => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

const waitPort = (port, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(); });
    s.on('error', () => {
      s.destroy();
      if (Date.now() - t0 > ms) reject(new Error('chrome did not open a debug port'));
      else setTimeout(tick, 120);
    });
  };
  tick();
});

/* ------------------------------------------------------------------ minimal websocket client */

/*
 * A tiny RFC6455 client. Only what CDP needs: a masked text frame out, unfragmented text
 * frames in. Avoids adding a dependency to a project that deliberately has none.
 */
class WS {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    this.buf = Buffer.alloc(0);
  }
  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        this.socket = socket;
        socket.on('data', d => this._onData(d));
        socket.on('error', () => {});
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len).toString('utf8');
      this.buf = this.buf.slice(off + len);
      let msg;
      try { msg = JSON.parse(payload); } catch { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.forEach(h => h(msg));
      }
    }
  }
  send(method, params) {
    const id = ++this.seq;
    const body = Buffer.from(JSON.stringify({ id, method, params: params || {} }));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i % 4];
    let header;
    if (body.length < 126) header = Buffer.from([0x81, 0x80 | body.length]);
    else if (body.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.socket.destroy(); } catch {} }
}

/* ------------------------------------------------------------------ harness */

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function run() {
  // Browser-free, and first because it is the cheapest way to catch the one failure that a
  // passing browser run would still hide: a deploy that silently doesn't reach installed phones.
  const stamped = spawnSync(process.execPath, [path.join(__dirname, 'stamp-sw.js'), '--check'],
    { encoding: 'utf8' });
  check('build: service-worker cache stamp matches the assets on disk', stamped.status === 0,
    `${stamped.stdout || ''}${stamped.stderr || ''}`.trim().split('\n')[0]);

  // Same idea for the icons: they are generated, so they can silently fall out of step with
  // icon.svg. A wrong-sized apple-touch-icon is invisible until someone installs the app.
  const icons = spawnSync(process.execPath, [path.join(__dirname, 'make-icons.js'), '--check'],
    { encoding: 'utf8' });
  check('build: generated icons present and correctly sized', icons.status === 0,
    `${icons.stdout || ''}${icons.stderr || ''}`.trim().split('\n')[0]);

  const chrome = findChrome();
  if (!chrome) { console.error('No Chrome/Edge found; cannot smoke test.'); process.exit(2); }

  const port = 9222 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'isf-smoke-'));
  const proc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=414,896',                      // a phone-ish viewport
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitPort(port, 20000);
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WS(version.webSocketDebuggerUrl);
    await ws.connect();

    // Attach to a fresh tab so we get page-scoped events.
    const { targetId } = await ws.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await ws.send('Target.attachToTarget', { targetId, flatten: true });
    const sess = {
      seq: 0,
      send: async (method, params) => {
        const id = ++ws.seq;
        const body = Buffer.from(JSON.stringify({ id, method, params: params || {}, sessionId }));
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(body.length);
        for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i % 4];
        let header;
        if (body.length < 126) header = Buffer.from([0x81, 0x80 | body.length]);
        else if (body.length < 65536) {
          header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(body.length, 2);
        } else {
          header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(body.length), 2);
        }
        ws.socket.write(Buffer.concat([header, mask, masked]));
        return new Promise((resolve, reject) => ws.pending.set(id, { resolve, reject }));
      },
    };

    const errors = [], failed = [];
    ws.on(msg => {
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        const text = (msg.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
        if (msg.params.type === 'error') errors.push(text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(`${d.text} ${d.exception ? d.exception.description || '' : ''}`.trim());
      }
      if (msg.method === 'Network.loadingFailed') failed.push(msg.params.errorText);
    });

    await sess.send('Runtime.enable');
    await sess.send('Network.enable');
    await sess.send('Page.enable');
    // Headless Chrome reports a dark colour-scheme preference by default. The fair runs in
    // August daylight, so light is the case to verify unless --dark is passed.
    await sess.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: process.argv.includes('--dark') ? 'dark' : 'light' }],
    }).catch(() => {});
    await sess.send('Emulation.setGeolocationOverride', { latitude: FAIR_LAT, longitude: FAIR_LON, accuracy: 12 });
    await sess.send('Browser.grantPermissions', {
      origin: new URL(BASE).origin,
      permissions: ['geolocation'],
    }).catch(() => {});

    const evaluate = async (expr) => {
      const r = await sess.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.result && r.result.value));
      return r.result.value;
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Screenshots are opt-in (--shots DIR): handy for eyeballing layout, but the checks below
    // are what actually gate the run.
    const shotDir = process.argv.includes('--shots')
      ? process.argv[process.argv.indexOf('--shots') + 1] : null;
    if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
    const shot = async (name) => {
      if (!shotDir) return;
      const { data } = await sess.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
    };

    // ---------------------------------------------------------------- index
    await sess.send('Page.navigate', { url: BASE + 'index.html' });
    await sleep(2200);

    check('index: data loaded', await evaluate('!!(window.FAIR && window.FAIR.stands.length)'),
      `${await evaluate('window.FAIR ? window.FAIR.stands.length : 0')} stands`);
    check('index: map drew buildings',
      (await evaluate('document.querySelectorAll("#map .bldg").length')) > 50,
      `${await evaluate('document.querySelectorAll("#map .bldg").length')} footprints`);
    check('index: geolocation fix accepted',
      (await evaluate('window.Geo.snapshot().status')) === 'ok',
      `status=${await evaluate('window.Geo.snapshot().status')}`);
    check('index: you-are-here drawn',
      (await evaluate('document.querySelectorAll("#map .me-dot").length')) === 1);

    // Flow 1 — search for curly fries
    await evaluate(`(() => { const q=document.getElementById('q'); q.value='curly fries';
      q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(450);
    const first = await evaluate(`(() => {
      const r = document.querySelector('#sheet-body .result');
      return r ? { name: r.querySelector('.name').textContent.trim(),
                   sub: r.querySelector('.sub').textContent.trim(),
                   dist: (r.querySelector('.dist b')||{}).textContent || null } : null; })()`);
    check('flow: "curly fries" finds Fair Food Fridays',
      !!first && /curly fries/i.test(first.name) && /Fair Food Fridays/i.test(first.sub),
      first ? `${first.name} — ${first.sub} — ${first.dist}` : 'no result');
    check('flow: distance shown when located', !!(first && first.dist), first && first.dist);
    await shot('01-search-curly-fries');

    // Flow 2 — typo tolerance
    await evaluate(`(() => { const q=document.getElementById('q'); q.value='fired rice';
      q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(450);
    const typo = await evaluate(`(() => {
      const n=document.querySelector('#sheet-body .result .name');
      const note=document.querySelector('#sheet-body .note');
      return { top: n?n.textContent.trim():null, note: note?note.textContent.trim():null }; })()`);
    check('flow: "fired rice" degrades to a rice dish', !!typo.top && /rice/i.test(typo.top),
      `${typo.top} / ${typo.note || 'no note'}`);

    // Flow 3 — water chip, nearest first
    await evaluate(`document.querySelector('.chip[data-chip="water"]').click()`);
    await sleep(400);
    /*
     * Ordering is asserted against the real distances, not the rendered labels. A row close enough
     * to be inside its uncertainty reads "within about 100 ft" rather than a figure, and that text
     * is deliberately not monotonic with distance — parsing digits out of it would make this check
     * fail on correct output.
     */
    const water = await evaluate(`(() => {
      return [...document.querySelectorAll('#sheet-body .result')].slice(0, 3).map(r => {
        const name = r.querySelector('.name').textContent.trim();
        const rec = window.FAIR.water.find(w => w.at === name.replace(/^Water booth — |^Water at /, ''));
        return { name,
                 dist: (r.querySelector('.dist b') || {}).textContent || null,
                 ft: rec ? Math.round(window.Geo.distanceTo(rec)) : null }; }); })()`);
    check('flow: water chip lists nearest first',
      water.length >= 2 && water.every(w => w.ft != null) && water[0].ft <= water[1].ft,
      water.map(w => `${w.name} "${w.dist}" (${w.ft} ft)`).join(' | '));

    // Flow 3a — restroom chip. Same distance-not-labels rule as the water check above.
    await evaluate(`document.querySelector('.chip[data-chip="restroom"]').click()`);
    await sleep(400);
    const loos = await evaluate(`(() => {
      const label = r => r.kind === 'indoor' ? 'Restrooms at ' + r.at : 'Restrooms near ' + r.near;
      const byLabel = new Map(window.FAIR.restrooms.map(r => [label(r), r]));
      return {
        note: (document.querySelector('#sheet-body .note') || {}).textContent || null,
        rows: [...document.querySelectorAll('#sheet-body .result')].slice(0, 3).map(el => {
          const name = el.querySelector('.name').textContent.trim();
          const rec = byLabel.get(name);
          return { name, ft: rec ? Math.round(window.Geo.distanceTo(rec)) : null }; }),
      }; })()`);
    check('flow: restroom chip lists nearest first',
      loos.rows.length >= 2 && loos.rows.every(r => r.ft != null) && loos.rows[0].ft <= loos.rows[1].ft,
      loos.rows.map(r => `${r.name} (${r.ft} ft)`).join(' | '));
    /*
     * The coverage caveat is a check rather than a comment because it is the feature. We can place 18
     * of ~40 restrooms, and a list that shows 18 without saying so will walk someone past an unlisted
     * indoor one. If this note ever stops rendering, the chip becomes quietly misleading.
     */
    check('flow: restroom chip discloses that it is incomplete',
      !!loos.note && /not every restroom/i.test(loos.note) && /about 40/.test(loos.note),
      loos.note);
    await shot('03-restrooms');

    /*
     * The list leads with a walking time and carries the distance underneath. Asserted because the
     * two live in the same <div> and a refactor could swap them back without anything else noticing
     * — and the pair reads plausibly either way round, which is exactly why a human wouldn't catch
     * it. Reads the first row far enough down the list to be outside its own uncertainty; rows
     * inside it deliberately show "within about n ft" and no time at all.
     */
    const pair = await evaluate(`(() => {
      const el = [...document.querySelectorAll('#sheet-body .result')]
        .map(r => r.querySelector('.dist')).find(d => d && !d.classList.contains('rough'));
      if (!el) return null;
      return { big: el.querySelector('b').textContent.trim(),
               small: (el.querySelector('b + span') || {}).textContent || null }; })()`);
    check('list: leads with a walk time and shows the distance under it',
      !!pair && /^(<1|\d+) min walk$/.test(pair.big) && /^\d+(\.\d+)? (ft|mi)$/.test(pair.small),
      pair ? `"${pair.big}" over "${pair.small}"` : 'no non-rough row found');

    // Flow 3a2 — "bathroom" reaches restrooms through the fuzzy synonym group.
    await evaluate(`(() => { const q=document.getElementById('q'); q.value='bathroom';
      q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(450);
    const bath = await evaluate(`(() => {
      const r = document.querySelector('#sheet-body .result');
      return r ? r.querySelector('.name').textContent.trim() : null; })()`);
    check('flow: "bathroom" finds a restroom via the synonym group',
      !!bath && /^Restrooms /.test(bath), bath || 'no result');

    // Back to the water chip: the two checks below document their starting state as "a chip is
    // active and its list is open", so hand them that rather than a search.
    await evaluate(`document.querySelector('.chip[data-chip="water"]').click()`);
    await sleep(400);

    // Flow 3b — the close button actually closes, and stays closed across a GPS tick.
    //
    // Regression: renderList() used to end in openSheet(), and the geolocation subscriber calls
    // renderList() on every fix, so dismissing the panel lasted only until the next tick. Moving
    // the geolocation override is the whole point of this check — asserting "closed" immediately
    // after the click passed even with the bug present.
    const closed = await evaluate(`(() => {
      document.getElementById('sheet-close').click();
      return document.getElementById('sheet').classList.contains('open'); })()`);
    check('flow: close button closes the list', closed === false);

    await sess.send('Emulation.setGeolocationOverride',
      { latitude: FAIR_LAT + 0.0004, longitude: FAIR_LON + 0.0004, accuracy: 12 });
    await sleep(1400);
    const afterTick = await evaluate(`({
      open: document.getElementById('sheet').classList.contains('open'),
      pins: document.querySelectorAll('#map .pin').length })`);
    check('flow: list stays closed after a location update', afterTick.open === false);
    // Closing the panel is how you look at the map, so the pins it put there must survive.
    check('flow: closing the list keeps its map pins', afterTick.pins > 0, `${afterTick.pins} pins`);

    await sess.send('Emulation.setGeolocationOverride',
      { latitude: FAIR_LAT, longitude: FAIR_LON, accuracy: 12 });
    await sleep(600);

    // Flow 3c — the screen wake lock follows the directions panel, not activity.
    //
    // Asserts Wake.wanted, the intent, rather than Wake.held: headless Chrome has no screen to
    // keep awake and may refuse the request outright, which would make a check on the real lock
    // fail for reasons that say nothing about this app.
    // A search rather than the water chip: closing the sheet above deliberately leaves the chip
    // active, so clicking it again would toggle it off and empty the list.
    await evaluate(`(() => { const q = document.getElementById('q');
      q.value = 'corn dog'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(500);
    const wakeIdle = await evaluate(`!!(window.Wake && window.Wake.wanted)`);
    check('wake: screen not held while only browsing a list', wakeIdle === false);

    await evaluate(`document.querySelector('#sheet-body .result').click()`);
    await sleep(300);
    check('wake: screen held once directions are open',
      (await evaluate(`!!(window.Wake && window.Wake.wanted)`)) === true);

    await evaluate(`document.getElementById('back').click()`);
    await sleep(300);
    check('wake: screen released on going back to the list',
      (await evaluate(`!!(window.Wake && window.Wake.wanted)`)) === false);

    // Flow 4 — open directions
    await evaluate(`document.querySelector('#sheet-body .result').click()`);
    await sleep(400);
    const dir = await evaluate(`(() => {
      const big=document.querySelector('#sheet-body .dir-live .big');
      const small=document.querySelector('#sheet-body .dir-live .small');
      const maps=document.querySelector('#sheet-body a.btn.primary');
      const line=document.querySelectorAll('#map .route-line').length;
      return { big: big?big.textContent.trim():null, small: small?small.textContent.trim():null,
               maps: maps?maps.getAttribute('href'):null, line }; })()`);
    check('flow: directions show live distance + heading', !!dir.big && !!dir.small,
      `${dir.big} — ${dir.small}`);
    check('flow: straight line drawn to target', dir.line === 1);
    await shot('02-directions');
    check('flow: Google Maps walking hand-off',
      !!dir.maps && /travelmode=walking/.test(dir.maps) && /origin=41\.59/.test(dir.maps));

    /*
     * Flow 5 — the app doesn't claim more precision than it has.
     *
     * Exists because of the first real field report (2026-08-16): "it said I was there but I was
     * probably a block away". A pin derived from the printed map grid can be 150 ft out, a phone
     * fix another 100, and the walking screen used to print the sum of that slop as a bold figure
     * with no caveat at all.
     */
    const maths = await evaluate(`({
      near: window.Geo.formatDistanceApprox(30, 150),
      far: window.Geo.formatDistanceApprox(400, 150),
      grid: window.Geo.pinErrorFt({ lat: 41.594, lon: -93.552, src: 'grid' }),
      edge: window.Geo.pinErrorFt({ lat: 41.594, lon: -93.552, src: 'edge' }),
      low: window.Geo.pinErrorFt({ lat: 41.594, lon: -93.552, src: 'edge', conf: 'low' }),
    })`);
    check('honesty: a distance inside the uncertainty is not quoted as a figure',
      /within about \d+ ft/.test(maths.near) && !/within/.test(maths.far),
      `30 ft → "${maths.near}" · 400 ft → "${maths.far}"`);
    check('honesty: pin vagueness follows how the pin was derived',
      maths.grid > maths.edge && maths.low >= 150,
      `grid ${maths.grid} > edge ${maths.edge}, low-confidence ${maths.low}`);

    // A coarse fix must be admitted on the walking screen, not just on the list. The directions
    // panel is still open from Flow 4, and the geolocation subscriber re-renders it in place.
    await sess.send('Emulation.setGeolocationOverride',
      { latitude: FAIR_LAT, longitude: FAIR_LON, accuracy: 60 });
    await sleep(1500);
    const rough = await evaluate(`(() => {
      const notes = [...document.querySelectorAll('#sheet-body .dir .note')].map(n => n.textContent.trim());
      const big = document.querySelector('#sheet-body .dir-live .big');
      return { notes, big: big ? big.textContent.trim() : null }; })()`);
    check('honesty: the walking screen admits a rough fix',
      rough.notes.some(t => /accurate to about/.test(t)),
      rough.notes.join(' | ') || `(no notes; big="${rough.big}")`);
    await shot('03-rough-fix');

    // Standing on top of an offset-derived pin: a bearing across 40 ft is noise, so the app should
    // hand over to the fair's own words for where the stand is.
    const onPin = await evaluate(`(() => {
      const s = window.FAIR.stands.find(x => x.src === 'offset' && x.lat != null);
      return { name: s.name, lat: s.lat, lon: s.lon }; })()`);
    await sess.send('Emulation.setGeolocationOverride',
      { latitude: onPin.lat, longitude: onPin.lon, accuracy: 12 });
    await sleep(900);
    await evaluate(`(() => { const q = document.getElementById('q');
      q.value = ${JSON.stringify(onPin.name)}; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(600);
    await evaluate(`document.querySelector('#sheet-body .result').click()`);
    await sleep(400);
    const here = await evaluate(`(() => {
      const live = document.querySelector('#sheet-body .dir-live');
      const small = document.querySelector('#sheet-body .dir-live .small');
      const big = document.querySelector('#sheet-body .dir-live .big');
      return { isHere: !!(live && live.classList.contains('is-here')),
               small: small ? small.textContent.trim() : null,
               big: big ? big.textContent.trim() : null }; })()`);
    check('honesty: standing on a pin swaps the bearing for the fair’s own words',
      here.isHere && /look for/i.test(here.small || '') && /within about/.test(here.big || ''),
      `${here.big} — ${here.small}`);
    await shot('04-in-the-area');

    // Back to a clean, precise fix at the centre of the grounds for the checks that follow.
    await sess.send('Emulation.setGeolocationOverride',
      { latitude: FAIR_LAT, longitude: FAIR_LON, accuracy: 12 });
    await sleep(600);

    // ---------------------------------------------------------------- other pages
    await sess.send('Page.navigate', { url: BASE + 'foods.html' });
    await sleep(1500);
    check('foods: ranked list rendered',
      (await evaluate('document.querySelectorAll("#ranked .food").length')) === 11,
      `${await evaluate('document.querySelectorAll("#ranked .food").length')} ranked`);
    check('foods: all-new list rendered',
      (await evaluate('document.querySelectorAll("#all .food").length')) > 40,
      `${await evaluate('document.querySelectorAll("#all .food").length')} items`);
    await shot('03-foods');

    await sess.send('Page.navigate', { url: BASE + 'info.html' });
    await sleep(1500);
    check('info: water table rendered',
      (await evaluate('document.querySelectorAll("#water tr").length')) > 20);
    check('info: accuracy table rendered',
      (await evaluate('document.querySelectorAll("#accuracy tr").length')) === 6);
    await shot('04-info');

    // ---------------------------------------------------------------- offline
    await sess.send('Page.navigate', { url: BASE + 'index.html' });
    await sleep(2500);                                    // let the service worker install
    const swReady = await evaluate(`navigator.serviceWorker.ready.then(r=>!!r.active).catch(()=>false)`);
    check('offline: service worker active', swReady === true);

    await sess.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await sess.send('Page.navigate', { url: BASE + 'index.html' });
    await sleep(2200);
    const offline = await evaluate(`({
      stands: (window.FAIR && window.FAIR.stands.length) || 0,
      bldgs: document.querySelectorAll('#map .bldg').length })`);
    check('offline: app boots with no network',
      offline.stands > 200 && offline.bldgs > 50,
      `${offline.stands} stands, ${offline.bldgs} footprints`);

    const offlineSearch = await evaluate(`(() => { const q=document.getElementById('q');
      q.value='corn dog'; q.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(r=>setTimeout(()=>r(document.querySelectorAll('#sheet-body .result').length),400)); })()`);
    check('offline: search still works', offlineSearch > 0, `${offlineSearch} results`);

    // The readout asks the active worker for its cache name over a MessageChannel, so this also
    // proves that round-trip works — and it is done with the network off on purpose, since a
    // version you can only read when online is no use for working out what a phone is running.
    await sess.send('Page.navigate', { url: BASE + 'info.html' });
    await sleep(1800);
    const shownVer = await evaluate(`(document.getElementById('appver')||{}).textContent || ''`);
    check('offline: version readout names the active cache',
      /^isf-2026-[0-9a-f]{8}$/.test(shownVer), shownVer || '(empty)');

    await sess.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    // ---------------------------------------------------------------- off-site behaviour
    await sess.send('Emulation.setGeolocationOverride', { latitude: 40.7128, longitude: -74.0060, accuracy: 12 });
    await sess.send('Page.navigate', { url: BASE + 'index.html' });
    await sleep(2200);
    await evaluate(`(() => { const q=document.getElementById('q'); q.value='corn dog';
      q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(500);
    const off = await evaluate(`({
      status: window.Geo.snapshot().status,
      hasDist: !!document.querySelector('#sheet-body .result .dist'),
      note: (document.querySelector('#sheet-body .note')||{}).textContent || null })`);
    check('offsite: detected as away from the fairgrounds', off.status === 'offsite', off.status);
    check('offsite: distances suppressed rather than absurd', off.hasDist === false, off.note);

    // ---------------------------------------------------------------- update cycle (opt-in)
    //
    // The only check that exercises what the stamp exists for: an *already installed* worker being
    // replaced by a new build, with the page ending up on it and no manual refresh. Everything
    // above only ever does a first install, where shell.js deliberately does not reload.
    //
    // Opt-in via --update-cycle because it has to mutate a precached file on disk to produce a
    // genuinely different build. The original bytes are restored and re-stamped either way.
    if (process.argv.includes('--update-cycle')) {
      const asset = path.join(__dirname, '..', 'css', 'app.css');
      const swFile = path.join(__dirname, '..', 'sw.js');
      const original = fs.readFileSync(asset);
      const restamp = () => spawnSync(process.execPath, [path.join(__dirname, 'stamp-sw.js')],
        { encoding: 'utf8' });
      const cacheName = () =>
        (fs.readFileSync(swFile, 'utf8').match(/const CACHE = '([^']*)'/) || [])[1];

      try {
        await sess.send('Page.navigate', { url: BASE + 'info.html' });
        await sleep(1800);
        const before = await evaluate(`(document.getElementById('appver')||{}).textContent||''`);

        fs.writeFileSync(asset, Buffer.concat([original, Buffer.from('\n/* update-cycle */\n')]));
        restamp();
        const wanted = cacheName();

        // Force the update check rather than relying on navigation heuristics, then let
        // shell.js's controllerchange handler reload the page onto the new worker.
        await evaluate(`navigator.serviceWorker.getRegistration()
          .then(r => r && r.update()).then(() => 1).catch(() => 0)`);
        await sleep(4000);
        const after = await evaluate(`(document.getElementById('appver')||{}).textContent||''`);

        check('update: an installed build is replaced and the page reloads onto it',
          !!wanted && after === wanted && after !== before,
          `${before || '(empty)'} -> ${after || '(empty)'}, expected ${wanted}`);
      } finally {
        fs.writeFileSync(asset, original);
        restamp();
      }
    }

    // ---------------------------------------------------------------- console health
    // Favicon 404s used to be filtered out here. They aren't any more: the pages now declare a
    // real icon, so a favicon error means that wiring is broken and should fail the run.
    check('no console errors or exceptions', errors.length === 0,
      errors.slice(0, 4).join(' || ') || 'clean');

    ws.close();
  } finally {
    proc.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  const failedCount = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failedCount}/${results.length} checks passed`);
  process.exit(failedCount ? 1 : 0);
}

run().catch(e => { console.error('smoke test error:', e); process.exit(2); });
