# Iowa State Fair 2026 — Find it

A mobile-first, **offline-first** finder for the Iowa State Fair (Aug 13–23, 2026, "Fair Spirit").

Ask for a thing, get it sorted by how far it is from where you're standing, and get walked there.

```
type "curly fries"  →  Curly Fries · Fair Food Fridays · West Side of Riley Stage · 750 ft
                    →  tap  →  live distance, walking time, bearing arrow
```

Plain HTML, CSS and JavaScript. **No framework, no build step, no npm dependencies, no API keys,
no tile server.** Two design constraints drove every decision:

1. **The grounds are ~450 acres and the cell network collapses under 100,000+ people.** So
   everything is baked into static files and precached by a service worker, and the map is
   self-rendered SVG. Load the page once on the way in and it works all day with the radio off.
2. **Nothing moves during the fair.** Vendor and building locations are fixed for 11 days, so
   there is no reason to fetch anything at runtime.

## Try it

```bash
node tools/serve.js 8099          # then open http://localhost:8099/
node tools/serve.js 8099 --prefix /fair    # simulate hosting under a subpath
```

`localhost` counts as a secure context, so geolocation and offline caching both work there.

To see distances without being in Des Moines: **DevTools → ⋮ → Sensors → Location → Other**,
and enter `41.5952, -93.5510` (the Agriculture Building, next to the Butter Cow).

## What's in it

| | |
|---|---|
| **203 stands** | every food and beer vendor location the fair published |
| **2,037 menu items** | searchable, typo-tolerant |
| **78 new-for-2026 foods** | with the official People's Choice finalists #1–3 and semi-finalists #4–11 |
| **22 water points** | the official fountain / bottle-refill list, with in-building detail |
| **18 restrooms** | of about 40 — see *Known gaps*; 5 tagged step-free |
| **Dietary flags** | vegan, vegetarian, gluten-friendly, dairy-free — from the fair's own lists |
| **138 landmarks** | buildings, gates, stages, plazas |
| **117 building footprints** | real geometry, from OpenStreetMap |

Three screens: **Find** (map + search + directions), **New foods** (rankings, filters), **Info**
(hours, gates, water, and where the data came from).

## Where the data comes from

Everything is derived from documents the fair publishes, plus OpenStreetMap for building shapes.
Nothing is invented and nothing is scraped from a private API.

| Source | Used for |
|---|---|
| `2026_IowaStateFair_Food_Vendors_20260804.pdf` | 160 stands, menus, locations, space numbers |
| `2026_IowaStateFair_Beer_Food_Combo_Vendors_20260731.pdf` | 43 alcohol-serving stands |
| `rpt_Mkt_Items_{Vegan,Vegetarian,GlutenFriendly,DairyFree}.pdf` | dietary flags |
| `2026-New-Food-Brochure-Website.pdf` | new foods, People's Choice rankings, prices |
| `2026_WaterRefillStationMap.pdf` | water fountains and refill stations |
| `Maps/2026-Website-Final.pdf` | landmark grid references, amenity legend |
| `iowastatefair.org/visit/fair-hours` | hours and the gate re-entry rule |
| Overpass API / OpenStreetMap | building footprints and paths (© OSM contributors, ODbL) |

**These files are not in this repo.** They are the Iowa State Fair's documents rather than ours,
so they aren't redistributed here — download them from `iowastatefair.org` into `_source/` using
the filenames above if you want to re-run the build. `js/data.js` is committed, so the site itself
runs and deploys without them; only `tools/build-data.js` needs them.

### How locations are worked out

This is the only genuinely tricky part. **The fair describes vendor locations in prose, not
coordinates** — "Outside NE Corner of VI Bldg", "SW of Ag Bldg", "West Side of Riley Stage". So
each pin is *derived*, and its precision varies. Every stand records which method produced it,
and anything imprecise is labelled **approx. location** in the UI.

| Method | How | Typical error | Stands |
|---|---|---|---|
| `edge` | a compass corner/side of a real OSM footprint | 15–40 ft | 43 |
| `inside` | explicitly indoors, or the stand *is* a mapped building → footprint centroid | building level | 31 |
| `offset` | "SW of X" → ~35 m out from the footprint edge | 60–120 ft | 84 |
| `grid` | landmark has no footprint → official map grid via a fitted transform | ~85 ft | 44 |
| `none` | the fair's published location is literally "TBD" | no pin | 1 |

**Some vendors *are* a building on the map** — the Iowa Craft Beer Tent, The Depot, Blue Ribbon Bar
& Eatery. Their published location describes where that venue sits ("Iowa Craft Beer Tent, West of
Jacobson Exhibition Center"), and reading only the prose derived an offset from a *different*
building: the Craft Beer Tent landed 193 ft from its own footprint. So when a vendor's name is
exactly a landmark we hold a real outline for, that outline wins, and the stand records
`rel: "self"`. It applies only to the vaguest tiers — a named corner of the right building is more
specific than that building's centre — and only on an exact name match, since
"Cattlemen's Beef Quarters - Express" is a different window somewhere else. Five stands, 108–193 ft
each. Every override is printed in the QA report with the distance it moved.

**Some landmarks are a thing *inside* a building** — the Butter Cow, the Big Boar, the Big Ram, the
Sale Ring, the Milking Parlor. They have no outline of their own and were falling back to the printed
grid, in most cases a square estimated off the artwork rather than read from the index. But we know
something better than a guessed square: *which building they are in*, and we hold that building's real
outline. So each takes its parent's footprint and becomes `inside` (~100 ft, "building level") instead
of `grid` (~150 ft when estimated) — and the pin stops being a guess. `tools/source-manual.js` records
the parent and the evidence for it; the UI says "In the Agriculture Building" rather than implying the
Cow has a surveyed point of its own.

Three candidates were **rejected for lack of evidence**, because a wrong parent is much worse than a
vague grid pin: Soda Fountain (no source names its building), Horse Annex (an annex is *beside* the
Horse Barn — its square lands 274 ft outside it), and Avenue of Breeds, an outdoor livestock avenue
1,245 ft from the Cattle Barn. Those keep their grid fallback.

These landmarks are also **barred from the transform fit below**. Their grid square describes a spot
inside a large building rather than the building itself, so pairing it with that building's centroid
would add a second, conflicting anchor for one building — exactly the mismatch the outlier trim exists
to catch, and better excluded than relied upon to be trimmed. Anchor count and the 82 ft mean error are
unchanged by this rule, which is the check that it worked.

The `grid` tier works by fitting an affine transform from the printed map's grid (rows A–O,
columns 1–25) to GPS, using landmarks that have **both** a printed grid reference and an OSM
footprint. 28 anchors, **mean error 82 ft** — smaller than one grid cell (148 × 213 ft), which is
the inherent precision of a grid reference. Outlier anchors are trimmed and reported.

Two independent cross-checks run on every build:

- **Zone check.** Space numbers encode a zone (`10xxx` Grandstand, `40xxx` Varied Industries,
  `50xxx` Triangle/Riley, `80xxx` Walnut Square…). Each geocoded point is asserted to fall in its
  zone's region — a signal the prose parser can't see. Currently zero mismatches.
- **Bounds check.** The build fails if any stand lands outside the fairgrounds or at `0,0`.

The report also lists any stand named after a landmark that *couldn't* be pinned to it, so the
remainder stays visible instead of looking solved. Today that's JR's SouthPork Ranch: the fair's
own map gives it grid square J13 but OSM has no footprint for it, so there is nothing better to use
than the prose, and its two rows sit 82 ft and 365 ft from that square. Guessing would be worse
than labelling it, so it stays `approx`.

"Front of X" is resolved from data rather than assumption: the bearing from the building's centre
to the nearest *named* road. That gets the Grandstand fronting **south** onto Grand Avenue and the
Varied Industries Building fronting **north** onto the same road, with no special-casing.

### Known gaps, stated plainly

- Pins point to the right building, corner or concourse — **not to an exact serving window.**
- **Lists lead with a walking time, and it is not a route.** It's the straight-line distance divided
  by a deliberately slow pace (`WALK_FT_PER_SEC`, `js/geo.js`), so it ignores buildings, fences and
  crowds — the app draws a straight line and never claims to route you. The slow pace offsets some of
  that, but not reliably, so the distance it was derived from stays on screen underneath it and the
  Info screen states what the number is. Inside the combined uncertainty no time is shown at all.
- **A displayed distance carries both errors, and says so.** Each pin's tier implies a radius
  (`js/geo.js`, `PIN_ERROR_FT`) which is combined in quadrature with the phone's own reported
  accuracy. Once you are closer than the two together, the app stops quoting a figure and says
  "within about 150 ft" plus the fair's own words for where the stand is — because at that range a
  bearing is noise. A fix older than 20 s is labelled as stale rather than shown as current, which
  matters because the GPS watch is dropped while the app is off screen. This came from a field
  report of the app "saying I was there" a block early; that symptom is what a kept-but-stale fix,
  a 150 ft grid pin, or both at once look like from the outside.
- **The restroom list is 18 of about 40, and the app says so on the chip.** The fair's map marks
  every restroom with an icon, but only an icon — there is no list and no coordinates, and reading
  ~40 positions off the artwork by eye would manufacture precision we don't have. So restrooms come
  from the two places that can be sourced: 8 that OpenStreetMap has outlined as their own building
  (a real footprint, so a real point), and 10 buildings the fair's water-refill map states have
  restrooms, pinned at the building like the water points and labelled "at" rather than pointing at
  a door. A silently 45%-complete restroom finder is worse than an openly incomplete one, so the
  chip carries the count and tells you to check inside a nearby building too.
- The fair's vendor list **truncates 49 menus mid-item** at a column break. Those stands are
  flagged in the app and a few of their items may be missing. Truncated text is carried through
  as-is rather than guessed at.
- 27 dietary rows don't match a menu item, mostly because the dietary lists are dated 22 July and
  the vendor list 4 August — one vendor (Brafford's Lemonade) appears only in the earlier one.
- The dietary data is the fair's, and the fair states it is informational only.
- Out of scope: concert lineups, event schedules, ticket prices, parking, competitions.
- Ratings are the fair's **official** People's Choice standings only. There is no personal or
  crowd rating, because a static site has nowhere to store one.

## Rebuilding the data

Needs the source PDFs in `_source/`, which this repo does not carry — see above.

```bash
node tools/build-data.js          # parse every source → js/data.js, print a QA report
node tools/build-data.js --report # QA report only, don't write
bash tools/fetch-osm.sh           # optional: re-download OpenStreetMap geometry
```

The QA report is the point — it prints calibration error, per-tier stand counts, dietary join
rates and every warning, and exits non-zero if a stand lands somewhere impossible. Read it after
any change.

A rebuild also re-stamps the service worker (see [Updates](#updates)), so a new `js/data.js`
actually reaches phones that already have the app installed.

### Tooling

| File | Job |
|---|---|
| `tools/pdftext.js` | dependency-free PDF text extractor (positioned runs, real page mapping, /ObjStm decoding) |
| `tools/parse-reports.js` | the 6 generated report PDFs → stands, menus, dietary rows |
| `tools/source-manual.js` | data hand-encoded from the 3 print-art PDFs, whose text is outlined and unextractable |
| `tools/build-data.js` | geocoding, calibration, assembly, QA report |
| `tools/serve.js` | static dev server, with optional subpath |
| `tools/smoke.js` | headless-Chrome checks over the DevTools protocol |
| `tools/stamp-sw.js` | rewrites the `sw.js` cache name from a hash of the precached assets |
| `tools/make-icons.js` | rasterises `icon.svg` into the install icons, using Chrome as the renderer |
| `tools/chrome.js` | finds a local Chrome or Edge; shared by the two tools above |

Next year, the reports keep the same shape: drop the new PDFs into `_source/`, update the grid
refs and rankings in `source-manual.js`, and rebuild.

## Testing

```bash
node tools/serve.js 8099 &
node tools/smoke.js http://localhost:8099/
node tools/smoke.js http://localhost:8099/ --update-cycle   # + the update path (see below)
```

34 checks: the service-worker stamp and the generated icons match what's on disk, pages boot, the
map draws, geolocation is accepted, the four core flows work ("curly fries", the typo case,
nearest-water, directions), **closing the result list stays closed across a location update**,
**a distance inside its own uncertainty is never quoted as a figure and the walking screen admits a
rough fix**, the other two pages render, the service worker activates, **the app boots, searches
and reports its version with the network switched off**, being away from the fairgrounds suppresses
distances instead of printing nonsense, and the console is clean.

`--update-cycle` adds a 35th check, and it is the only one that exercises an *already installed*
worker being replaced by a new build — everything else does a first install, where `shell.js`
deliberately does not reload. It appends a comment to `css/app.css`, re-stamps, forces an update
check, and asserts the page comes back reporting the new cache name. It restores the original
bytes and re-stamps in a `finally`, but it does write to the working tree, which is why it is
opt-in rather than part of the default run.

It has been checked against a negative control: with the `controllerchange` reload in `shell.js`
disabled, it fails with the page still reporting the old cache, so it is not a vacuous test.

**Not covered:** real-GPS accuracy and the device compass. Those are verified by DevTools
override and explicit fallback handling, not by standing on the fairgrounds. Treat compass
behaviour on a physical phone as untested. One field report exists (16 Aug 2026): the app "said I
was there" when the user was about a block away — see [Known gaps](#known-gaps-stated-plainly),
which is where that led. The reset button on the info page is also untested —
it goes through `confirm()`, which headless Chrome will not surface.

## Updates

Offline-first and "picks up my changes" pull against each other, so this is explicit rather than
incidental. Three parts:

**The cache name is generated, not bumped by hand.** `sw.js` installs with `cache: 'reload'`, so
it re-fetches every asset from the network — but only when the browser runs its install handler,
and it only does that when `sw.js`'s *bytes* change. Editing `css/app.css` or regenerating
`js/data.js` leaves `sw.js` byte-identical. `tools/stamp-sw.js` hashes everything in the `ASSETS`
list into the cache name, so any asset change becomes a `sw.js` change:

```bash
node tools/stamp-sw.js          # after editing any precached file by hand
node tools/stamp-sw.js --check  # exit 1 if stale — run in the smoke suite
```

`build-data.js` calls it automatically. The stamp is a pure function of file contents — no clock,
no counter — so it is idempotent and an unchanged rebuild is a no-op. **Run it before deploying,
or installed phones keep the old copy.**

Without the stamp the app still recovers, because the fetch handler is stale-while-revalidate: it
serves the cache immediately and refreshes that entry in the background. But it does so one file
at a time, which can leave a new `js/data.js` paired with an old `js/fairmap.js` — coupled files,
and that pairing is what misdraws the map. The stamp makes a deploy one atomic swap instead.

**The page reloads when a new worker takes over.** `sw.js` calls `skipWaiting()` and
`clients.claim()`, which would otherwise leave the page running old JavaScript against a new
cache. `js/shell.js` listens for `controllerchange` and reloads, skipping the first install (no
stale page to replace) and guarding against a reload loop.

**There is a manual way out.** Info → *Offline copy* shows the active cache name — asked of the
worker itself, so it's the truth even if the page came from a stale cache — and tapping it
unregisters every worker, deletes every cache and reloads. It refuses when `navigator.onLine` is
false: discarding the offline copy with no signal would leave the app with nothing to fall back
on, which is the exact situation it exists for.

## Screen and battery

The fair runs 8am to midnight. A phone that dies at 4pm has no map and no way of finding the car,
so both of the expensive APIs here are scoped rather than left running.

**The screen is held awake only while directions are open.** `js/wake.js` takes a Screen Wake Lock
when you pick a result and drops it on *Back to list* or on closing the sheet. The tempting
alternative — acquire on interaction, release after an idle timeout — is backwards for this app:
walking across the fairgrounds watching the distance count down means looking at the screen and
touching nothing, so an idle timer would release the lock exactly when it's wanted and hold it
while you read a menu sitting down. Unsupported browsers (anything before iOS 16.4) simply no-op.

**The GPS watch stops when the app isn't on screen.** `watchPosition` runs with
`enableHighAccuracy`, which keeps the radio busy, so `js/geo.js` drops the watch on
`visibilitychange` and re-arms it on return. The last known position is kept rather than cleared,
so coming back to the app shows the distances you last saw while a fresh fix arrives instead of
blanking them — those can be a few minutes stale for a moment, which beats showing nothing.

## Hosting

Built **path-agnostic** — every asset reference is relative, never a leading slash — so the same
files work from `file://`, a Caddy subpath, or a GitHub Pages project subpath.

### GitHub Pages

Doesn't depend on a machine at home being awake, and gets HTTPS free. Settings → Pages → Source:
deploy from a branch → `main` → `/(root)`, then open `https://<user>.github.io/<repo>/`.

The project subpath needs no configuration: every asset reference is relative and `sw.js` is
registered with a relative scope, so the worker's scope is the subpath itself. That also means no
`Service-Worker-Allowed` header is required — which matters, because Pages can't set one.

### Any static host or reverse proxy

Serve the directory as static files. If it sits under a subpath, that works unchanged for the same
reason as above; the only requirement is that `sw.js` is served from the root of the path the app
is under, so its default scope covers the app.

Two headers are worth setting if your host lets you:

| Path | Header | Why |
|---|---|---|
| `sw.js` | `Cache-Control: no-cache` | **Load-bearing.** A stale `sw.js` means the browser never notices a new build — see [Updates](#updates). |
| `*.css`, `*.js`, `*.svg` (not `sw.js`) | `Cache-Control: public, max-age=86400` | Optional. Safe because the worker installs with `cache: 'reload'`, which bypasses the HTTP cache. |

Exclude `sw.js` from the second rule explicitly rather than relying on rule ordering. It is a
`*.js` file, so a naive glob catches it, and whichever `Cache-Control` lands last wins — far too
subtle for the one file the entire update path depends on.

**HTTPS is required, not preferred:** browsers only expose geolocation and service workers in a
secure context, so `http://<lan-ip>` will load the app but can neither locate you nor cache itself
offline. Pages gives you HTTPS; most reverse proxies can provision a certificate automatically.

## Credits

Fair data © Iowa State Fair, from their public documents. Map geometry ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL. This is an
unofficial personal project and is not affiliated with or endorsed by the Iowa State Fair.
