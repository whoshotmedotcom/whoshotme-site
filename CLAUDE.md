# WhoShotMe.com

A community site connecting motorcycle riders in the Peak District/Derbyshire
with photographers shooting them on the road. Two pages:

- **`index.html`** — public map. Riders browse/search for photographers
  currently shooting (live/upcoming/past), filter by date, view a photographer's
  info via popups.
- **`add-shoot.html`** — private photographer dashboard, accessed via a personal
  link (`?p=<shootTabName>&key=<KEY>`). Photographers add/edit/delete their own
  shoot listings, manage gallery links, and see basic stats.

No build step. Plain HTML/CSS/JS, single `<script>` blocks per page, no
framework, no bundler. Edit the files directly and refresh the browser.

## Tech stack / external services

- **Data storage**: Google Sheets, read via published CSV export
  (`COMBINED_CSV_URL`, `GALLERIES_CSV_URL`), written via a Google Apps Script
  web app (`APPS_SCRIPT_URL`) called from `add-shoot.html`. Two separate
  Google Sheets workbooks:
  - **Main workbook** (public, link-shared for the CSV feeds to work): a
    shared `Shoots` tab (all photographers' shoots, one row per shoot,
    distinguished by a `Shoot Tab Name` column) and a shared `Galleries`
    tab (same idea). `Combined`/`Combined Galleries` are formula-driven
    views over those two tabs for the public site to read; `PhotographersImport`
    is a one-way `IMPORTRANGE` mirror of the other workbook's non-secret
    columns. Redesigned 16/07/2026 from an earlier one-tab-per-photographer
    layout specifically so **adding a photographer is just one row** in the
    Photographers workbook below — no tabs to create, no formulas to edit.
    `app-script.gs`'s own header comment has the full column layout and an
    "ADDING A NEW PHOTOGRAPHER" walkthrough.
  - **Photographers workbook** (private, kept Restricted): one row per
    photographer — name, logo, website, contact email, `Shoot Tab Name`
    (their stable ID, used in URLs and as the join key back to `Shoots`/
    `Galleries`), and `Secret Key` (their dashboard login, effectively a
    password — never imported into the main workbook).
  - Since everyone's shoots/galleries now share one sheet each rather than
    being isolated by tab, `app-script.gs` explicitly re-checks that any
    shoot/gallery being updated or deleted actually belongs to the
    authenticated photographer before touching it (search the file for
    "ownership check") — this used to be implicit via tab isolation and
    isn't anymore. Don't remove those checks.
- **Hosting**: GitHub Pages (migrated from Netlify on 16/07/2026 after
  running out of free-tier build credits — see `whoshotmedotcom/whoshotme-site`
  on GitHub, public repo, no build step so a push is the whole deploy).
- **Map**: Leaflet 1.9.4 + Leaflet.markercluster.
- **Basemaps**: OS Maps API (OS Data Hub, free OpenData plan — default), Esri
  World Imagery (aerial, keyless legacy endpoint), OpenStreetMap. OS Light and
  OS Outdoor are currently **disabled** (commented out in the layer definitions
  and the layer-switcher config) — OS Road is the only OS layer live. Easy to
  re-enable by uncommenting.
- **Geocoding/search**: postcodes.io (UK postcodes) falling back to Nominatim
  (OpenStreetMap) for general place names, on both pages.
- **Geolocation**: browser-native `getCurrentPosition`, one-shot (not
  `watchPosition`), entirely client-side. Never sent to any server.

## Conventions established in this project

- **No em-dashes in user-visible text.** Code comments still use them freely
  (that's fine, deliberate) but anything a visitor actually reads — labels,
  messages, popups, meta tags, page titles — uses a plain hyphen `-` instead.
  If you add new user-facing text, follow this.
- **Rounded/pill button language.** Buttons are either full circles
  (`.stepBtn`, the Leaflet zoom control, "My location") or pill shapes
  (`border-radius: 14-24px`). Nothing square-cornered by design.
- **`--rust` is `#d97a53`, not the "obvious" `#c4572b`.** It was deliberately
  lightened for WCAG AA contrast (see Accessibility below) — don't "correct"
  it back. If you ever add a new UI element using rust, check whether it's
  text-on-dark (fine as-is) or a background with text on it (needs dark
  `--asphalt` text on top, not light `--paper` — see `.status-soon` for the
  pattern).
- **Toast component** (`#toast`) exists on both pages now, for one-off
  transient messages (geolocation errors, save confirmations). Use it rather
  than repurposing `#defaultModeBanner`/`#photographerFilterBanner`, which are
  for longer-lived, more prominent states.

## Known fragile areas — read before touching these

- **Map layer zoom ranges must stay matched across all basemaps.** All layers
  (OSM, OS, Esri) are deliberately set to identical `minZoom`/`maxZoom` (5 and
  19). A past attempt at letting OS Maps API "underzoom" past its real data
  floor (z7) using `minNativeZoom` with no hard `minZoom` floor caused the map
  to lock up completely when zoomed out near world-wrap territory. If you
  change zoom ranges, keep them matched or you risk reintroducing this.
- **Esri's aerial layer uses a keyless legacy endpoint** Esri has asked
  developers to migrate off (since ~2022). It still works but could stop
  without warning. If it ever breaks, that's expected, not a regression to
  chase — the fallback plan discussed was defaulting to OS Outdoor.
- **`map.invalidateSize()` must be called after anything that changes the
  map's on-screen size** — Leaflet caches container size at init and doesn't
  auto-detect layout reflows (e.g. a banner appearing above the map). Every
  banner show/hide already does this; keep the pattern if you add new ones.
- **Popups opened via animated `setView()` must wait for `moveend` before
  `popup.openOn(map)`** — opening in the same tick as an animated pan starts
  causes Leaflet's autoPan to calculate against the pre-animation view,
  visibly misplacing the popup. See `flyToSpot()` for the pattern.
- **`#searchWrap` and `#map` are siblings with a stacking-context quirk**: any
  positive `z-index` beats an unset one regardless of value, so popups inside
  `#map` couldn't render above the search box no matter how low its z-index
  went — the fix was toggling `#searchWrap` to exactly `z-index: 0` (not
  "auto", not a smaller positive number) on `popupopen`/`popupclose`. See the
  CSS comment on `.yield-to-popup` if this needs revisiting.
- **The OS Maps API key is embedded client-side in both files.** This is by
  design (that's how this API tier works — see the getting-started docs), not
  a bug. It's rate-limited server-side, not meant to be secret.
- **Multi-day shoot filtering** compares whole date *ranges*, not just start
  dates — `spotDayKeys()` and the render() filters all check whether a
  selected day falls anywhere within `[start, end]`, not just an exact match.
  If you touch date filtering, keep this — the original bug (shoots vanishing
  from the slider on any day after their start) is exactly what this fixes.

## Recent significant features

- **Camera flash animation on live pins** — small white star badge, randomly
  cycles between single/double/triple flash patterns with randomized
  timing per marker, so multiple live pins don't flash in sync. Uses a dark
  star sitting behind a smaller white star (not a solid disc — that looked
  like a black blob) for contrast on both pale and dark basemaps.
- **Proximity/conflict awareness in `add-shoot.html`** — photographers enter
  their shoot's date/time *before* the map becomes interactive (a full
  overlay blocks pin placement until both times are set). Once set, other
  photographers' overlapping-time shoots show as markers on the map, and
  dropping a pin within 150m of one shows a private warning naming the other
  photographer. Deliberately informational only — nothing is written back to
  anyone else's listing, nothing is shown publicly. This was a deliberate
  scope decision after discussion: the original idea included a public
  "conflict flag" visible to all visitors, which was dropped in favour of
  this private, non-authoritative version.
- **Accessibility pass** (see the 10 ideas list below, #6) — contrast fixes,
  aria-live regions on dynamic content, aria-valuetext on the date slider.
  One known gap deliberately left unfixed: **individual map markers have no
  keyboard navigation path** — only the search box does. Fixing this properly
  is a real feature decision (roving tabindex vs. a list-view alternative),
  not a quick patch.

## 10 suggested improvements (given 15/07/2026, status below)

1. **Rotate the OS Maps API key** — not done. Low urgency (key is designed to
   be public), but it's been pasted in chat multiple times, worth doing via
   the OS Data Hub project page when convenient.
2. **Contingency plan for the Esri legacy endpoint disappearing** — not done.
   Decided fallback is OS Outdoor if/when it breaks; not pre-emptively built.
3. **Check OS Data Hub usage against the 600 tx/min cap** — not done, just a
   periodic manual check recommended if traffic grows.
4. **Automated tests for the trickiest pure-logic functions** — **done**.
   `tests.html` covers all six candidates (`parseUKDateTime`, `getStatus`,
   `spotDayKeys`, `haversineMeters`, `timeRangesOverlap`, `ordinalSuffix`),
   28 assertions total, currently all passing. No test runner/build step
   added — consistent with this project's conventions, it's a plain HTML
   page that loads the real `index.html`/`add-shoot.html` in hidden
   iframes and calls their actual global functions directly (no
   copy-pasted logic to drift out of sync). Open it via Live Server and
   read the page, or check `#summary`'s `data-failed` attribute for
   automation. Both files' `parseUKDateTime` and `getStatus` are tested
   separately since each keeps its own copy.
   While building these, testing surfaced a duplicate of the
   `creator-photo.jpg` eager-load bug (see item 7) that had only been
   fixed in `index.html` — `add-shoot.html`'s own About section had the
   same issue, now fixed the same way.
5. **Validate submitted coordinates are within the UK before saving** —
   **done**. `saveShootBtn`'s click handler in `add-shoot.html` now rejects
   a pin outside `UK_BOUNDS` before submitting, and `validateShoot()` in
   `app-script.gs` enforces the same box server-side (the actual
   authoritative check, since the client-side one can be bypassed). Keep
   the two bounds in sync if they ever change.
6. **Accessibility pass** — **done**, see above.
7. **Check real-world page weight/load time on mobile** — **done** (audit +
   two fixes, 15/07/2026). Measured actual transfer sizes of everything
   `index.html` loads on first paint (gzip/brotli where applicable, tile
   images excluded since those load lazily per-viewport on any map site):
   `index.html` itself ~40KB gzipped, Leaflet + markercluster JS ~45KB,
   their CSS ~3KB, Poppins woff2 ~7.5KB. Two disproportionate assets found
   and fixed:
   - `favicon.png` was a 512x512, 119KB PNG — bigger than the entire
     Leaflet+markercluster JS payload combined, for something browsers only
     ever render at ~16-32px. Resized to 128x128 (~18KB, an 85% cut) with
     no visible quality loss at favicon sizes.
   - `creator-photo.jpg` (79KB) was an eager `<img src>` inside the About
     modal, which sits behind `display:none` until opened — CSS visibility
     doesn't stop the browser fetching it, so every visitor downloaded it
     whether or not they ever opened About. Now loaded via `data-src`,
     swapped onto `src` only on first click of the About link.
   Combined, this cuts the typical first-load payload by roughly 180KB
   (~60%) for visitors who never open About. Not independently verified
   with a real mobile device/throttled network profile — worth a spot
   check if this becomes a priority again.
8. **Add usage analytics beyond visit/click counts** — **done**. Extended
   the existing privacy-first counter pattern (no third-party tool, no
   visitor identifier, just aggregate daily counts you check by opening a
   sheet tab) rather than bolting on something new: a `SiteEvents` tab
   (Date | EventType | Count), written via a new `trackSiteEvent` action
   in `app-script.gs`, called from `index.html`'s `sendSiteEvent()`.
   Tracks exactly the three gaps named above:
   - `basemap_<name>` — fires on Leaflet's `baselayerchange`, slugified
     from the layer's own display name so re-enabling OS Light/OS Outdoor
     (currently commented out) doesn't need a matching code change here.
   - `search_photographer_selected` / `search_place_selected` — fires
     when a search result is actually clicked/activated, not on every
     keystroke. Compare against total page views for a rough
     searched-vs-just-scrolled split.
   - `my_location_used` — fires only on a successful geolocation lookup,
     and only that the feature was used - never the coordinates
     themselves, consistent with the existing privacy notes on that
     feature.
   **Requires one manual setup step before it'll record anything**: add a
   `SiteEvents` tab to the live Google Sheet with columns `Date`,
   `EventType`, `Count` (same as the `SiteVisits` tab already there,
   plus the type column) - see the updated setup notes at the top of
   `app-script.gs`. Verified the event payloads fire correctly end-to-end
   locally (basemap switch, search select, simulated geolocation) without
   writing test data into the real sheet.
9. **Keep Esri's non-commercial ToU restriction in mind if monetisation is
   ever considered** — not applicable yet (site isn't monetised).
10. **Confirm Google Sheets version history is accessible** — not verified as
    part of this work; worth confirming directly with the account owner.
11. **Sheets architecture: shared Shoots/Galleries tabs** — **done**
    16/07/2026, see the Data storage section above and `app-script.gs`'s
    header comment for the full picture. Adding a photographer no longer
    needs new tabs or formula edits, just one row in the Photographers
    workbook.
12. **Self-service "become a photographer" signup form** — not done, a
    stated future direction. A web form would append a row to the
    Photographers workbook (via a new Apps Script action) and notify the
    site owner, who reviews and sends the personal link — same trust
    model as today, just removing the manual row-adding step. The #11
    redesign was specifically done with this in mind: the Photographers
    workbook is already the single source of truth for onboarding, so
    this needs no further schema changes when it's picked up.
