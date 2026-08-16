'use strict';
/*
 * geo.js — where you are, how far things are, and which way to walk.
 *
 * Exposes window.Geo. Deliberately conservative about what it claims: a phone GPS on a crowded
 * fairground is often 30–100 ft off, so accuracy is surfaced rather than hidden, and every
 * failure path has a defined behaviour instead of leaving the UI showing stale numbers.
 */
(function () {
  const FT_PER_DEG_LAT = 364000;

  // A brisk walk is ~3 mph, but nobody moves that fast through fair crowds with a corn dog in
  // hand. 2.1 mph (~3.1 ft/s) matches an unhurried walk with stops and dodging.
  const WALK_FT_PER_SEC = 3.1;

  // Beyond this, treat the fix as too vague to give confident distances.
  const POOR_ACCURACY_FT = 100;

  /*
   * How far a pin might be from the thing it names, by the method that produced it. These are the
   * upper end of each range published in the accuracy table on the info page — the honest number to
   * quote is the one you might actually be out by, not the average.
   *
   * `inside` is a building's footprint centroid, so on something the size of Varied Industries the
   * door is a long way from the middle; 100 ft is generous but not pessimistic.
   */
  const PIN_ERROR_FT = { edge: 40, inside: 100, offset: 120, grid: 150 };

  // A pin the build flagged low-confidence is at least this vague, whatever method produced it.
  const LOW_CONF_FT = 150;

  /*
   * Past this age a fix is called out as stale rather than shown as current.
   *
   * This matters because the GPS watch is dropped while the app is off screen (see the
   * visibilitychange handler below) and the last position is kept on purpose. Pocket the phone,
   * walk a block, reopen: for a moment every distance is measured from where you were standing
   * when you last looked. 20 s is long enough not to nag during a normal glance and short enough
   * to catch that walk.
   */
  const FIX_STALE_MS = 20000;

  const B = (window.FAIR && window.FAIR.meta && window.FAIR.meta.bounds) || null;

  const state = {
    lat: null,
    lon: null,
    accuracyFt: null,
    heading: null,          // degrees from true north, if the device provides it
    status: 'idle',         // idle | locating | ok | denied | unavailable | timeout | offsite
    error: null,
    updatedAt: null,
  };

  const listeners = new Set();
  const emit = () => listeners.forEach(fn => { try { fn(snapshot()); } catch (e) { console.error(e); } });
  const snapshot = () => {
    const ageMs = state.updatedAt ? Math.max(0, Date.now() - state.updatedAt) : null;
    return Object.assign({}, state, {
      /** True when we have a usable position inside the fairgrounds. */
      usable: state.status === 'ok' && state.lat != null,
      poor: state.accuracyFt != null && state.accuracyFt > POOR_ACCURACY_FT,
      ageMs,
      /** The fix is old enough that you may well have walked away from it. */
      stale: ageMs != null && ageMs > FIX_STALE_MS,
    });
  };

  // ---------------------------------------------------------------- maths

  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;

  /**
   * Distance in feet. Uses an equirectangular approximation, which is accurate to well under a
   * foot across a 450-acre site and far cheaper than haversine when re-sorting 200 stands on
   * every GPS tick.
   */
  function distanceFt(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * FT_PER_DEG_LAT;
    const dLon = (lon2 - lon1) * FT_PER_DEG_LAT * Math.cos(toRad((lat1 + lat2) / 2));
    return Math.hypot(dLat, dLon);
  }

  /** Initial bearing in degrees from true north. */
  function bearing(lat1, lon1, lat2, lon2) {
    const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const compassName = deg => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

  function inBounds(lat, lon) {
    if (!B) return true;
    // A small margin so someone standing just outside a perimeter gate still counts as present.
    const pad = 0.0015;   // ~500 ft
    return lat >= B.minLat - pad && lat <= B.maxLat + pad &&
           lon >= B.minLon - pad && lon <= B.maxLon + pad;
  }

  // ---------------------------------------------------------------- uncertainty

  /**
   * How far this pin might be from the real thing, in feet, or null when we can't say.
   *
   * Accepts either a place from the results list (which wraps a stand) or a raw record — stands,
   * landmarks, water points and amenities all carry the same `src`/`conf` pair.
   */
  function pinErrorFt(pt) {
    if (!pt || pt.lat == null) return null;
    const rec = pt.stand || pt;
    const r = PIN_ERROR_FT[rec.src];
    if (r == null) return rec.conf === 'low' ? LOW_CONF_FT : null;
    return rec.conf === 'low' ? Math.max(r, LOW_CONF_FT) : r;
  }

  /**
   * How far a displayed distance to this point could be out, combining both error sources: the
   * phone's own fix and the pin's derivation. Added in quadrature because they're independent.
   *
   * This is the number that makes "30 ft" honest or not. A stand geocoded from the printed map
   * grid, seen from a phone with a 60 ft fix, is 160 ft of combined slop — so "30 ft" and "190 ft"
   * are the same claim, and printing either one as a fact is the thing that gets you sent walking
   * to the wrong place.
   */
  function uncertaintyFt(pt) {
    const s = snapshot();
    const gps = s.accuracyFt || 0;
    const pin = pinErrorFt(pt) || 0;
    const u = Math.hypot(gps, pin);
    return u > 0 ? u : null;
  }

  // ---------------------------------------------------------------- formatting

  /** Feet under a quarter mile, then miles. Rounded coarsely — false precision reads as fake. */
  function formatDistance(ft) {
    if (ft == null) return '';
    if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
    if (ft < 5280) return `${(ft / 5280).toFixed(2).replace(/0$/, '')} mi`;
    return `${(ft / 5280).toFixed(1)} mi`;
  }

  /**
   * A distance you can stand behind. Once the distance is inside the combined uncertainty, the
   * figure means "you're in the area" and nothing more, so that's what it says — quoting "20 ft"
   * when the slop is 160 ft invites someone to look for a stand that's actually behind them.
   */
  function formatDistanceApprox(ft, uncertaintyFtValue) {
    if (ft == null) return '';
    if (uncertaintyFtValue != null && ft <= uncertaintyFtValue) {
      return `within about ${Math.max(25, Math.round(uncertaintyFtValue / 25) * 25)} ft`;
    }
    return formatDistance(ft);
  }

  function formatWalk(ft) {
    if (ft == null) return '';
    const mins = ft / WALK_FT_PER_SEC / 60;
    if (mins < 1) return 'under a minute';
    return `${Math.round(mins)} min walk`;
  }

  // ---------------------------------------------------------------- watching

  let watchId = null;
  let wanted = false;      // the app has asked to be located; survives a background/resume cycle

  function start() {
    wanted = true;
    if (!('geolocation' in navigator)) {
      state.status = 'unavailable';
      state.error = 'This browser has no location support.';
      emit();
      return;
    }
    // A secure context is required by every current browser. Say so plainly rather than
    // letting the request fail with a confusing permission error.
    if (!window.isSecureContext && location.protocol !== 'file:') {
      state.status = 'unavailable';
      state.error = 'Location needs a secure connection (https). Open this page over https.';
      emit();
      return;
    }
    if (watchId != null) return;

    // Only announce "locating" when there is nothing better to show. On a resume from background
    // we already have a fix, and flipping to 'locating' would blank every distance in the list for
    // a second or two on each return to the app.
    //
    // Emit either way. On a resume the kept fix is often minutes old, and without this nothing
    // re-renders until the first callback lands — so the seconds right after reopening the app,
    // which is exactly when someone glances at a distance, were the seconds it couldn't admit its
    // position was stale.
    if (state.lat == null) state.status = 'locating';
    emit();

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        state.accuracyFt = accuracy != null ? accuracy * 3.28084 : null;
        state.updatedAt = pos.timestamp || null;
        if (!inBounds(latitude, longitude)) {
          // Keep the coordinates (the map can still show them) but flag that fairground
          // distances would be meaningless, so callers hide them instead of printing "2.4 mi"
          // next to every single stand.
          state.lat = latitude; state.lon = longitude;
          state.status = 'offsite';
          state.error = null;
          emit();
          return;
        }
        state.lat = latitude;
        state.lon = longitude;
        state.status = 'ok';
        state.error = null;
        emit();
      },
      (err) => {
        state.status = err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
        state.error = {
          1: 'Location permission was denied. You can still browse and search.',
          2: 'Your location is unavailable right now.',
          3: 'Finding your location took too long.',
        }[err.code] || 'Could not get your location.';
        emit();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  }

  /** Drop the watch but stay willing to resume — used when the app goes off screen. */
  function pause() {
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  /** Stop for good. Distinct from pause() so a later visibility change can't quietly restart it. */
  function stop() {
    wanted = false;
    pause();
  }

  /*
   * Drop the GPS watch while the app isn't on screen.
   *
   * watchPosition runs with enableHighAccuracy, which keeps the GPS radio busy. Left running in the
   * background it would drain the battery all day for readings nobody is looking at — and this app
   * is for an eleven-hour day at a fairground where a dead phone means no map and no way home.
   *
   * The last known position is deliberately kept rather than cleared, so returning to the app
   * shows the distances you last saw while a fresh fix arrives, instead of blanking them. Those
   * numbers can be a few minutes stale for a moment; a stale distance beats no distance, and the
   * first callback corrects it.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pause();
    else if (wanted) start();
  });

  // ---------------------------------------------------------------- heading

  /*
   * Device heading drives the rotating arrow. It's genuinely optional: iOS requires an explicit
   * user gesture to grant it, and many Android browsers report nothing useful. Callers must work
   * without it, falling back to a north-up map plus a written direction.
   */
  let headingBound = false;

  function onOrientation(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;   // iOS, true north
    else if (e.absolute === true && typeof e.alpha === 'number') h = 360 - e.alpha;
    if (h != null && !Number.isNaN(h)) {
      state.heading = ((h % 360) + 360) % 360;
      emit();
    }
  }

  function bindHeading() {
    if (headingBound) return;
    headingBound = true;
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
  }

  /** Must be called from a user gesture on iOS. Resolves true if heading became available. */
  async function requestHeading() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') return false;
      } catch { return false; }
    }
    bindHeading();
    return true;
  }

  window.Geo = {
    start, stop, snapshot, requestHeading, bindHeading,
    subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
    distanceFt, bearing, compassName, formatDistance, formatDistanceApprox, formatWalk, inBounds,
    pinErrorFt, uncertaintyFt,
    POOR_ACCURACY_FT, PIN_ERROR_FT, FIX_STALE_MS,

    /** Distance from the user to a point, or null when we can't honestly say. */
    distanceTo(pt) {
      const s = snapshot();
      if (!s.usable || !pt || pt.lat == null) return null;
      return distanceFt(s.lat, s.lon, pt.lat, pt.lon);
    },

    bearingTo(pt) {
      const s = snapshot();
      if (!s.usable || !pt || pt.lat == null) return null;
      return bearing(s.lat, s.lon, pt.lat, pt.lon);
    },

    /** Google Maps walking directions — the honest way to offer real turn-by-turn. */
    mapsUrl(pt) {
      if (!pt || pt.lat == null) return null;
      const s = snapshot();
      const q = new URLSearchParams({
        api: '1',
        destination: `${pt.lat},${pt.lon}`,
        travelmode: 'walking',
      });
      if (s.lat != null) q.set('origin', `${s.lat},${s.lon}`);
      return `https://www.google.com/maps/dir/?${q.toString()}`;
    },
  };
})();
