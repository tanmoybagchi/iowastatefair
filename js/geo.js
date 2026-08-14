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
  const snapshot = () => Object.assign({}, state, {
    /** True when we have a usable position inside the fairgrounds. */
    usable: state.status === 'ok' && state.lat != null,
    poor: state.accuracyFt != null && state.accuracyFt > POOR_ACCURACY_FT,
  });

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

  // ---------------------------------------------------------------- formatting

  /** Feet under a quarter mile, then miles. Rounded coarsely — false precision reads as fake. */
  function formatDistance(ft) {
    if (ft == null) return '';
    if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
    if (ft < 5280) return `${(ft / 5280).toFixed(2).replace(/0$/, '')} mi`;
    return `${(ft / 5280).toFixed(1)} mi`;
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
    if (state.lat == null) {
      state.status = 'locating';
      emit();
    }

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
    distanceFt, bearing, compassName, formatDistance, formatWalk, inBounds,
    POOR_ACCURACY_FT,

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
