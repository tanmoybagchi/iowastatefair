'use strict';
/*
 * chrome.js — locate an installed Chrome or Edge.
 *
 * Shared by tools/smoke.js (drives it over the DevTools protocol) and tools/make-icons.js (uses it
 * as an SVG rasteriser). Kept in one place so the platform-specific path list can't drift between
 * the two — a stale copy would fail as "no Chrome found" on someone else's machine and be
 * thoroughly confusing.
 */

const fs = require('fs');

const CHROME_CANDIDATES = [
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* unreadable path, keep looking */ }
  }
  return null;
}

module.exports = { findChrome, CHROME_CANDIDATES };
