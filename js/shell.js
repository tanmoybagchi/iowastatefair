'use strict';
/*
 * shell.js — service-worker registration, update handling and the offline-copy reset.
 * Shared across all pages.
 *
 * Wrapped defensively because the app is expected to run in three quite different places:
 *   - https (Caddy / GitHub Pages) — full offline support
 *   - localhost — full support, for development
 *   - file:// (double-clicked) — service workers are unavailable; the app still works, since
 *     data.js is a plain script rather than a fetched JSON file
 *
 * The version readout and reset button live on info.html. Both are wired from here rather than
 * from info.js, so every piece of service-worker handling stays in one file; the wiring is a
 * no-op on pages that don't have those elements.
 */
(function () {
  const el = (id) => document.getElementById(id);
  const onReady = (fn) => {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  };

  const unsupported = !('serviceWorker' in navigator) || location.protocol === 'file:';
  if (unsupported) {
    // No offline copy exists, so say so plainly instead of leaving the readout saying "checking".
    onReady(() => {
      const out = el('appver');
      if (!out) return;
      out.textContent = 'not installed';
      out.disabled = true;
      out.title = location.protocol === 'file:'
        ? 'Opened as a local file, so there is no offline copy to manage.'
        : 'This browser does not support offline copies.';
    });
    return;
  }

  /*
   * Reload when a new worker takes over.
   *
   * sw.js calls skipWaiting() and clients.claim(), so a new worker starts serving a new cache
   * while this page is still running the JavaScript it loaded from the old one. That mismatch is
   * the "why won't it refresh" symptom: js/data.js and js/fairmap.js are coupled, and a page
   * holding one version against the other misdraws the map. Reloading on handover closes it.
   *
   * Two guards. `hadController` skips the very first install, where there is no stale page to
   * replace and a reload would just be a visible flicker on a first visit. `reloading` makes sure
   * a controller change that arrives twice can't put the page in a reload loop.
   */
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    // Relative scope keeps this working under a subpath such as /fair/.
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[shell] offline support unavailable:', err && err.message);
    });
  });

  /* Ask the active worker for its cache name — see the message handler in sw.js. */
  function askVersion(worker) {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 2000);   // never hang the readout
      ch.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data && event.data.version);
      };
      try { worker.postMessage({ type: 'version' }, [ch.port2]); }
      catch { clearTimeout(timer); resolve(null); }
    });
  }

  async function showVersion(out) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const worker = reg.active || navigator.serviceWorker.controller;
      if (!worker) { out.textContent = 'installing…'; return; }
      out.textContent = (await askVersion(worker)) || 'unknown';
    } catch {
      out.textContent = 'unknown';
    }
  }

  /*
   * Escape hatch for a cache that has gone bad in a way a reload won't fix.
   *
   * Deliberately gated on being online, which is the one real difference from doing this on a
   * desktop app: throwing away the offline copy while standing on the fairgrounds with no usable
   * signal would leave the app with nothing to fall back on, which is precisely the situation it
   * was built for.
   */
  async function resetOfflineCopy(out) {
    if (!navigator.onLine) {
      alert('You appear to be offline.\n\n' +
        'Clearing the offline copy now would leave the app with nothing to fall back on until ' +
        'you have a connection again. Try this once you are back on wifi or a usable signal.');
      return;
    }
    const ok = confirm('Delete this device\'s offline copy and download a fresh one?\n\n' +
      'You need a working connection for the next few seconds. Only worth doing if the app is ' +
      'showing something obviously wrong or out of date.');
    if (!ok) return;

    const label = out.textContent;
    out.textContent = 'clearing…';
    out.disabled = true;
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) {
      console.warn('[shell] reset failed:', e && e.message);
      out.textContent = label;
      out.disabled = false;
      alert('Could not clear the offline copy. Clearing this site\'s data in your browser ' +
        'settings will do the same thing.');
      return;
    }
    // reloading guards the controllerchange handler that unregistering can also fire.
    reloading = true;
    location.reload();
  }

  onReady(() => {
    const out = el('appver');
    if (!out) return;
    showVersion(out);
    out.addEventListener('click', () => resetOfflineCopy(out));
  });
})();
