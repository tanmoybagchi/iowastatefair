'use strict';
/*
 * wake.js — hold the screen on while you're actually walking somewhere.
 *
 * Exposes window.Wake with hold() / release(). find.js holds the lock while the directions panel
 * is open and releases it the moment you go back to the list or close the sheet.
 *
 * That scope is deliberate. The obvious alternative — acquire on interaction, release after an
 * idle timeout — is exactly backwards here. Walking across the fairgrounds watching the distance
 * count down means looking at the screen and touching nothing, so an idle timer would drop the
 * lock precisely when it's needed, then hold it while you read a menu sitting on a bench. Tying
 * it to "directions are open" tracks the real intent.
 *
 * Bounding it also matters for battery: the screen is the largest draw on a phone, and this app is
 * meant to survive an eleven-hour day. Keeping it lit only while navigating is the difference
 * between a useful feature and a dead phone at 4pm.
 *
 * Not supported everywhere — Chromium and Android have it, Safari since iOS 16.4, and anything
 * older simply has no navigator.wakeLock, in which case every call here is a no-op.
 */
(function () {
  const supported = 'wakeLock' in navigator;

  let sentinel = null;      // the active WakeLockSentinel, if we hold one
  let want = false;         // whether we *should* be holding it
  let pending = false;      // a request is in flight; don't start a second

  async function acquire() {
    if (!supported || !want || sentinel || pending) return;
    // The request rejects outright unless the document is visible, so don't waste it.
    if (document.visibilityState !== 'visible') return;

    pending = true;
    try {
      const s = await navigator.wakeLock.request('screen');
      if (!want) {
        // Released while the request was in flight — let it go rather than leaking a lock.
        try { await s.release(); } catch { /* already gone */ }
      } else {
        sentinel = s;
        // The browser releases the lock itself when the page is hidden. Clearing our handle here
        // means the visibilitychange handler below can tell it needs to ask again.
        s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
      }
    } catch {
      // Denied, unsupported in this context, or the page lost visibility mid-request. Not worth
      // reporting: the walking directions work fine, the screen just dims as usual.
    } finally {
      pending = false;
    }
  }

  async function drop() {
    const s = sentinel;
    sentinel = null;
    if (s) { try { await s.release(); } catch { /* already released */ } }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquire();   // no-ops unless want is still true
    else drop();
  });

  // Belt and braces for iOS, where a page can be torn down without a visibilitychange.
  window.addEventListener('pagehide', drop);

  window.Wake = {
    supported,
    hold() { want = true; acquire(); },
    release() { want = false; drop(); },
    /** Whether the screen is meant to be held on. Used by the smoke test. */
    get wanted() { return want; },
    /** Whether a lock is actually held right now — false if the browser refused or revoked it. */
    get held() { return sentinel != null; },
  };
})();
