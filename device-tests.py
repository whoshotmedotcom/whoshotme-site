"""WhoShotMe - emulated-device interaction smoke test.

Companion to tests.html: that page checks pure logic functions
(parseUKDateTime, getStatus, etc.) in a real browser but at a single
desktop viewport. This script checks real *interaction* - taps, not
clicks, on real emulated device profiles (viewport, touch input, device
pixel ratio, mobile user-agent) - on the things that have broken or
changed recently: the location consent banner, the OS Roads (UK) pan
bounds, the basemap rename/default, and the site-wide text-selection
block. Not a replacement for testing on a real phone occasionally, but
catches real cross-engine gaps (Chromium vs WebKit) that a desktop-only
click-based test can't.

No build step, matching this project's convention - this is a dev-only
tool, never served to visitors, so it's fine for it to depend on
Playwright even though the site itself has zero dependencies.

Prerequisites (one-time):
    pip install playwright
    playwright install chromium webkit

Usage:
    python device-tests.py

Starts its own local static server on port 8802 if one isn't already
running there. Exits non-zero if anything failed, so it's usable as a
gate as well as a manual check.
"""
import base64
import datetime
import http.server
import json
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8802"
ROOT = Path(__file__).parent
results = []

# A 1x1 transparent PNG, served for every tile request instead of hitting
# the real tile servers - this script runs the same handful of checks
# repeatedly across engines/devices, and real map-tile providers (OS Data
# Hub, OpenStreetMap, Esri) have real usage policies that automated test
# traffic shouldn't be adding load to. Content/visual accuracy of tiles
# doesn't matter for anything checked here.
_BLANK_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000a49444154789c6360000002000155327f2a0000000049454e44ae426082"
)
TILE_URL_RE = re.compile(r"(api\.os\.uk|tile\.openstreetmap\.org|server\.arcgisonline\.com)")


def stub_tiles(ctx):
    def handler(route):
        if TILE_URL_RE.search(route.request.url):
            route.fulfill(status=200, content_type="image/png", body=_BLANK_PNG)
        else:
            route.continue_()
    ctx.route("**/*", handler)


# CONFIRMED BUG (26/07/2026): after index.html gained a service worker
# (see sw.js), test_index started intermittently getting a wall of REAL
# 400 responses from api.os.uk on WebKit specifically - the exact
# tile-server-usage-policy risk this file's own docstring already warns
# about, just triggered a new way. Root-caused to a genuine
# Playwright/WebKit interaction: once an active service worker is
# controlling the page, context.route() interception (which is what
# stub_tiles() above relies on) can silently stop catching some
# subresource requests - even ones the service worker's own fetch
# handler doesn't touch at all (os.uk isn't in sw.js's cacheable-origins
# allowlist). Confirmed by reproducing with and without
# service_workers="block" on an otherwise-identical context - blocked,
# zero real network hits; allowed, dozens. Every context in this file
# passes service_workers="block" for exactly this reason - this suite is
# about interaction correctness, not exercising the service worker
# itself (that's covered separately, see the scratch verification used
# when sw.js was built), so there's no downside to blocking it here.


def check(label, condition, detail=""):
    ok = bool(condition)
    results.append((ok, label, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail and not ok else ""))
    return ok


def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) == 0


def start_server_if_needed():
    if port_open(8802):
        return None
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(ROOT), **kw)
    httpd = http.server.ThreadingHTTPServer(("localhost", 8802), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    for _ in range(50):
        if port_open(8802):
            break
        time.sleep(0.1)
    return httpd


def test_index(p, device_name, engine):
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(
        **device,
        geolocation={"latitude": 52.9548, "longitude": -1.1581},
        permissions=["geolocation"],
        service_workers="block",
    )
    stub_tiles(ctx)
    # CHANGED 26/07/2026: this test used to implicitly rely on whatever
    # was actually live on Google Sheets at the moment it ran - it never
    # checks specific spot content, so that was never intentional, just
    # how it happened to end up. Mocking it properly (same helper the
    # other tests already use) makes this deterministic and independent
    # of live external services, matching this file's own stated
    # reasoning for stubbing tiles just above.
    route_real_spot(ctx)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))

    print(f"\n--- index.html on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/index.html", timeout=30000)
    page.wait_for_timeout(3000)

    # Location consent banner: shows first, only a real tap on "Yes" should
    # move the map - dismissing must never touch geolocation at all.
    banner_visible = page.eval_on_selector("#locationPromptBanner", "el => !el.classList.contains('hidden')")
    check("location consent banner visible on load", banner_visible)
    if banner_visible:
        page.tap("#useMyLocationBtn")
        page.wait_for_timeout(1200)
        banner_hidden = page.eval_on_selector("#locationPromptBanner", "el => el.classList.contains('hidden')")
        check("banner dismissed after tapping Yes", banner_hidden)

    # Basemap default + rename
    default_layer = page.evaluate("() => map.hasLayer(streetsLayer) ? 'osm' : (map.hasLayer(osRoadLayer) ? 'os' : 'other')")
    check("OpenStreetMap is the default basemap", default_layer == "osm", default_layer)
    labels = page.eval_on_selector_all(".leaflet-control-layers-list label span", "els => els.map(e => e.textContent.trim())")
    check('"OS Roads (UK)" label present in layer switcher', "OS Roads (UK)" in labels, str(labels))

    # OS Roads (UK) pan bounds: unset by default, applied + snaps back on
    # switch, lifted again on switching away
    unset_by_default = page.evaluate("() => !map.options.maxBounds")
    check("no pan bounds while on OpenStreetMap", unset_by_default)

    # OSM/Aerial can zoom out to a true world view (minZoom:0) - OS Roads
    # (UK) can't (its own minZoom is a hard floor, see the big comment
    # above osRoadLayer's definition). Real repeated taps on the zoom-out
    # button on purpose here (not a single programmatic setView) - it
    # fires a rapid burst of 'zoomend' events as it settles, which is
    # what actually exposed the disabled-input bug below in production; a
    # single setView([...], 0) call didn't. (Mouse.wheel isn't supported
    # under mobile WebKit emulation, so taps rather than scroll - real
    # zoomend-burst behaviour either way.)
    zoom_out_btn = page.query_selector(".leaflet-control-zoom-out")
    for _ in range(30):
        if page.evaluate("() => map.getZoom()") <= 0:
            break  # the button correctly disables at the true floor - stop before tapping a disabled button
        zoom_out_btn.tap()
        page.wait_for_timeout(250)  # Leaflet's own zoom animation is ~250ms - faster taps can get dropped
    world_zoom = page.evaluate("() => map.getZoom()")
    check("OpenStreetMap can zoom out to a true world view", world_zoom == 0, str(world_zoom))

    # Leaflet auto-disables ("greys out") a base layer's radio input once
    # the map zooms past that layer's own minZoom/maxZoom - now that OS
    # Roads (UK) has a tighter floor than OSM/Aerial, that meant it became
    # unclickable in the switcher at exactly the zoom levels where you'd
    # need to click it to trigger the auto-correction back into range.
    # keepLayerInputsEnabledObserver (a MutationObserver on the `disabled`
    # attribute itself) should keep it usable regardless of current zoom
    # or how many rapid zoomend events got there.
    os_road_disabled_zoomed_out = page.evaluate("""
        () => {
            const labels = [...document.querySelectorAll('.leaflet-control-layers-list label')];
            const row = labels.find(l => l.textContent.includes('OS Roads'));
            return row.querySelector('input').disabled;
        }
    """)
    check("OS Roads (UK) stays selectable when zoomed out past its floor", not os_road_disabled_zoomed_out)

    page.evaluate("() => map.setView([-25.2744, 133.7751], 3, {animate:false})")
    page.evaluate("() => { map.removeLayer(streetsLayer); osRoadLayer.addTo(map); }")
    page.wait_for_timeout(700)
    bounds_after = page.evaluate("() => map.options.maxBounds ? map.options.maxBounds.toBBoxString() : null")
    check("switching to OS Roads (UK) applies UK pan bounds", bounds_after == "-17.48,46.575,14.04,64.125", str(bounds_after))
    zoom_after = page.evaluate("() => map.getZoom()")
    os_road_floor = page.evaluate("() => osRoadLayer.options.minZoom")
    check("switching to OS Roads (UK) zooms back up to its floor", zoom_after == os_road_floor, f"zoom={zoom_after}, floor={os_road_floor}")
    center_after = page.evaluate("() => map.getCenter()")
    check("switching to OS Roads (UK) snaps view back into the UK", -11 < center_after["lng"] < 15 and 46 < center_after["lat"] < 65, str(center_after))

    page.evaluate("() => { map.removeLayer(osRoadLayer); streetsLayer.addTo(map); }")
    page.wait_for_timeout(300)
    bounds_lifted = page.evaluate("() => !map.options.maxBounds")
    check("switching back to OpenStreetMap lifts the pan bounds", bounds_lifted)
    page.evaluate("() => map.setView([0, 0], 1, {animate:false})")
    page.wait_for_timeout(300)
    zoom_free_again = page.evaluate("() => map.getZoom()")
    check("switching back to OpenStreetMap frees the zoom floor again", zoom_free_again == 1, str(zoom_free_again))

    # Popup Escape-to-close, matching the same convention as the About
    # modal/list view - guarded so it only fires if neither of those two
    # (both full-screen overlays that would already be on top of a popup)
    # is currently open, so Escape closes whatever's actually on top first.
    # Soft-skipped if there's no real marker to click - depends on live
    # production data, which (per this project's own documented history)
    # varies day to day.
    marker = page.query_selector('.leaflet-marker-icon[role="button"]')
    if marker:
        box = marker.bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_timeout(500)
        popup_open = page.evaluate("() => !!map._popup && map._popup.isOpen()")
        if popup_open:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            popup_closed = page.evaluate("() => !(!!map._popup && map._popup.isOpen())")
            check("Escape closes an open map popup", popup_closed)
        else:
            print("  (skipped: marker click didn't open a popup)")
    else:
        print("  (skipped: no real marker available to test against)")

    # Search (real tap + fill)
    page.tap("#searchInput")
    page.fill("#searchInput", "Winnats")
    page.wait_for_timeout(1200)
    result_count = page.eval_on_selector_all("#searchResults > *", "els => els.length")
    check("search returns results for a known place", result_count > 0, str(result_count))

    # Search dropdown must close on ANY outside tap, not just a select/map
    # tap - confirmed via testing it stayed open on top of an unrelated chip
    # otherwise, which isn't how a dropdown behaves anywhere else on the web.
    still_open_before_chip = page.eval_on_selector("#searchResults", "el => el.classList.contains('show')")
    chip_upcoming = page.query_selector('.chip[data-filter="upcoming"]')
    if chip_upcoming and still_open_before_chip:
        chip_upcoming.tap()
        page.wait_for_timeout(300)
        closed_by_outside_tap = page.eval_on_selector("#searchResults", "el => !el.classList.contains('show')")
        check("search dropdown closes on an unrelated outside tap", closed_by_outside_tap)

    # Filter chip tap
    chip = page.query_selector('.chip[data-filter="live"]')
    if chip:
        chip.tap()
        page.wait_for_timeout(300)
        check("filter chip responds to tap", "active" in (chip.get_attribute("class") or ""))

    # About modal keyboard focus trap - confirmed via testing that without
    # it, a single Tab from the modal's own close button landed on the
    # header's "Get listed" link, which the overlay visually covers
    # entirely - a keyboard user tabbing through controls they can't see.
    page.click("#aboutLink")
    page.wait_for_timeout(300)
    focus_on_open = page.evaluate("() => document.activeElement.id")
    check("opening About moves focus to its own close button", focus_on_open == "aboutCloseBtnTop", focus_on_open)
    escaped = False
    for _ in range(15):
        page.keyboard.press("Tab")
        page.wait_for_timeout(20)
        if not page.evaluate("() => document.getElementById('aboutModal').contains(document.activeElement)"):
            escaped = True
            break
    check("About modal's focus trap keeps Tab inside it", not escaped)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    about_closed = page.eval_on_selector("#aboutOverlay", "el => !el.classList.contains('show')")
    focus_after_about = page.evaluate("() => document.activeElement.id")
    check("closing About (Escape) returns focus to its trigger link", focus_after_about == "aboutLink", focus_after_about)
    check("About modal actually closed", about_closed)

    # Accessible list view - the alternative to clustered map markers having
    # no keyboard path at all (see the #listViewPanel CSS comment). Real tap
    # to open, checks it covers the map's own controls (not just the tile
    # layer - z-index needs to beat #searchWrap/Leaflet's own controls,
    # which are all z-index:1000; this panel was originally 950 and got
    # rendered *under* them, a real bug caught only by an actual screenshot,
    # not by checking classList alone), then a real keyboard Escape to close.
    page.tap("#listViewToggleBtn")
    page.wait_for_timeout(300)
    panel_open = page.evaluate("() => !document.getElementById('listViewPanel').classList.contains('hidden')")
    check("list view opens on tap", panel_open)
    covers_controls = page.evaluate("() => getComputedStyle(document.getElementById('listViewPanel')).zIndex > getComputedStyle(document.getElementById('searchWrap')).zIndex")
    check("list view panel z-index is above the search box/map controls", covers_controls)
    focus_on_open = page.evaluate("() => document.activeElement.id")
    check("opening the list view moves focus to its close button", focus_on_open == "listViewCloseBtn", focus_on_open)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    panel_closed = page.evaluate("() => document.getElementById('listViewPanel').classList.contains('hidden')")
    check("Escape closes the list view", panel_closed)
    focus_on_close = page.evaluate("() => document.activeElement.id")
    check("closing the list view returns focus to its toggle button", focus_on_close == "listViewToggleBtn", focus_on_close)

    # The toggle button itself must also close it on a second tap - it was
    # originally wired to always call openListView() regardless of current
    # state, so tapping it again while already open silently re-opened it
    # instead of closing, with no visible sign anything had happened.
    page.tap("#listViewToggleBtn")
    page.wait_for_timeout(300)
    page.tap("#listViewToggleBtn")
    page.wait_for_timeout(300)
    panel_closed_by_toggle = page.evaluate("() => document.getElementById('listViewPanel').classList.contains('hidden')")
    check("tapping the toggle button again closes the list view", panel_closed_by_toggle)

    # Text selection: blocked on chrome, allowed in real inputs. Checked via
    # actual computed style (both prefixed/unprefixed - WebKit's JS doesn't
    # expose the unprefixed accessor reliably, even though the CSS rule
    # itself is applied) rather than trying to simulate a real selection
    # gesture, which is flaky cross-engine in headless mode.
    body_blocked = page.evaluate("() => { const s = getComputedStyle(document.body); return (s.userSelect || s.webkitUserSelect) === 'none'; }")
    check("body text is not selectable", body_blocked)
    input_selectable = page.evaluate("() => { const s = getComputedStyle(document.getElementById('searchInput')); return (s.userSelect || s.webkitUserSelect) === 'text'; }")
    check("search input text remains selectable", input_selectable)

    check("no console/page errors", len(errors) == 0, str(errors))
    ctx.close()
    browser.close()


def test_add_shoot(p, device_name, engine):
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(**device, service_workers="block")
    stub_tiles(ctx)
    page = ctx.new_page()
    print(f"\n--- add-shoot.html on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/add-shoot.html?p=TommyBoyphotography&key=dummy", timeout=30000)
    page.wait_for_timeout(1500)
    # bypass the (expected, key-gated) auth screen to reach the map -
    # dummy key rejection itself isn't what this test is checking
    page.evaluate("""
        () => {
            authGate.classList.add('hidden');
            dashboard.classList.remove('hidden');
            setTimeout(() => map.invalidateSize(), 100);
        }
    """)
    page.wait_for_timeout(600)
    default_layer = page.evaluate("() => map.hasLayer(streetsLayer) ? 'osm' : 'other'")
    check("add-shoot.html defaults to OpenStreetMap too", default_layer == "osm", default_layer)
    labels = page.eval_on_selector_all(".leaflet-control-layers-list label span", "els => els.map(e => e.textContent.trim())")
    check('add-shoot.html layer switcher also says "OS Roads (UK)"', "OS Roads (UK)" in labels, str(labels))
    ctx.close()
    browser.close()


# CHANGED 26/07/2026: index.html/add-shoot.html no longer read the public
# data from two Google Sheets CSV exports - both now try a cache file at
# PUBLIC_SPOTS_JSON_URL (raw.githubusercontent.com) first, falling back
# to the same Apps Script endpoint (action=spots) index.html's own
# writes already went through. Both return JSON shaped {combined,
# photographers, galleries} instead of two separate CSVs. `combined` no
# longer carries a photographer's Name/Logo/Website directly (see
# getPublicSpots()'s own comment in app-script.gs) - callers here still
# define each spot as one flat dict for readability, and this helper
# splits it into the real wire shape: shoot-only fields in `combined`,
# photographer fields deduped by Shoot Tab Name into their own
# `photographers` list, exactly like the real endpoint does.
#
# Mocks the live endpoint AND both cache tiers with the same payload -
# without this, the cache attempts would hit the REAL api.github.com/
# raw.githubusercontent.com over the actual network: at best a real 404
# (which the app's own fallback handles fine functionally, but the
# browser's own "Failed to load resource" console entry trips any test
# checking for zero console errors), at worst api.github.com actually
# succeeding and returning real production data instead of this test's
# fixture. Same reasoning as stub_tiles() above - don't hit live
# external services from this suite if avoidable.
_PHOTOGRAPHER_KEYS = ("Photographer Name", "Logo URL", "Website URL")


def route_spots_json(ctx, combined, galleries=None):
    galleries = galleries or []
    shoots = []
    photographers = {}
    for row in combined:
        tab = row.get("Shoot Tab Name")
        if tab not in photographers:
            photographers[tab] = {"Shoot Tab Name": tab, **{k: row.get(k, "") for k in _PHOTOGRAPHER_KEYS}}
        shoots.append({k: v for k, v in row.items() if k not in _PHOTOGRAPHER_KEYS})
    photographers = list(photographers.values())
    # combinedCount/photographersCount/galleriesCount match
    # getPublicSpots()'s real response shape - see loadSpotsFromSheet()'s
    # integrity check in index.html.
    body = json.dumps({
        "combined": shoots, "photographers": photographers, "galleries": galleries,
        "combinedCount": len(shoots), "photographersCount": len(photographers), "galleriesCount": len(galleries),
    })
    # The GitHub Contents API tier (tried first, see GITHUB_API_SPOTS_CACHE_URL)
    # wraps the real file content in a base64-encoded envelope - matches
    # the real response shape closely enough for fetchSpotsJsonViaGithubApi()'s
    # decode step to exercise the same code path a real response would.
    github_api_body = json.dumps({"content": base64.b64encode(body.encode("utf-8")).decode("ascii")})

    def handler(route):
        if route.request.method == "GET" and "action=spots" in route.request.url:
            route.fulfill(status=200, content_type="application/json", body=body)
        else:
            route.continue_()
    ctx.route("**/script.google.com/**", handler)
    ctx.route("**raw.githubusercontent.com/whoshotmedotcom/whoshotme-site/spots-cache/spots-cache.json",
               lambda route: route.fulfill(status=200, content_type="application/json", body=body))
    ctx.route("**api.github.com/repos/whoshotmedotcom/whoshotme-site/contents/spots-cache.json**",
               lambda route: route.fulfill(status=200, content_type="application/json", body=github_api_body))


def route_empty_spots(ctx):
    route_spots_json(ctx, [])


def test_empty_state_no_drift(p, device_name, engine):
    # Regression test for a confirmed bug: the "no shoots" popup shown for
    # an empty day is always re-anchored to map.getCenter() on every
    # render(), not a fixed point. It used to also have autoPan on and no
    # maxWidth (unlike every other popup on the site), which on a narrow
    # mobile viewport didn't fit within the autoPan padding reserved on
    # both sides - so opening it panned the map to compensate, and because
    # it re-anchors to the *already-shifted* centre next time, that pan
    # never converged: repeatedly tapping "Reset view" (or scrubbing the
    # date slider back onto an empty day) walked the map steadily sideways
    # with no bound. Uses a genuinely empty CSV (not live data) so this
    # reliably hits the empty-state path regardless of what's actually
    # listed on the day this happens to run.
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(**device, service_workers="block")
    stub_tiles(ctx)
    route_empty_spots(ctx)
    page = ctx.new_page()
    print(f"\n--- empty-state popup drift on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/index.html", timeout=30000)
    page.wait_for_function("document.getElementById('dataStateOverlay').classList.contains('hidden')", timeout=20000)
    page.wait_for_timeout(500)
    if page.eval_on_selector("#locationPromptBanner", "el => !el.classList.contains('hidden')"):
        page.tap("#dismissLocationPromptBtn")
        page.wait_for_timeout(300)

    start_center = page.evaluate("() => map.getCenter()")
    recenter_btn = page.query_selector(".recenter-btn")
    for _ in range(5):
        recenter_btn.tap()
        page.wait_for_timeout(300)
    end_center = page.evaluate("() => map.getCenter()")
    check(
        "map doesn't drift from repeatedly resetting view on an empty day",
        start_center["lat"] == end_center["lat"] and start_center["lng"] == end_center["lng"],
        f"{start_center} -> {end_center}",
    )
    ctx.close()
    browser.close()


# Relative to "today" (not a hardcoded date) - a stale past date here
# would make the default "Upcoming" view show zero results, potentially
# triggering an unrelated banner (e.g. defaultModeBanner) that changes
# what these tests actually observe. Confirmed the hard way: a
# previously-hardcoded date here caused exactly that confusion once it
# aged into the past.
_TODAY = datetime.date.today().isoformat()

EMOJI_NAME_SPOT = {
    "Photographer Name": "🏍️ Emoji Photog", "Logo URL": "", "Website URL": "",
    "Location Name": "Test Spot", "Description": "", "Lat": "53.1", "Lng": "-1.6",
    "Start": f"{_TODAY} 00:00", "End": f"{_TODAY} 23:59",
    "Shoot ID": "S1", "Shoot Tab Name": "emojiphotog",
}


def route_emoji_name_spots(ctx):
    route_spots_json(ctx, [EMOJI_NAME_SPOT])


def test_emoji_name_no_crash(p, device_name, engine):
    # Regression test for a confirmed bug: a photographer name starting
    # with an emoji (stored as a UTF-16 surrogate pair) crashed the ENTIRE
    # public map for every visitor, not just that one row. getInitials()
    # used w[0], which grabs the first UTF-16 code UNIT rather than the
    # first code POINT, splitting the surrogate pair in half; that lone
    # surrogate then hit avatarFor()'s encodeURIComponent() and threw
    # "URI malformed" inside buildSpots()'s per-row .map(), so the
    # exception propagated all the way up and killed the whole data load.
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(**device, service_workers="block")
    stub_tiles(ctx)
    route_emoji_name_spots(ctx)
    page = ctx.new_page()
    print(f"\n--- emoji-name no-crash on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/index.html", timeout=30000)
    page.wait_for_function("document.getElementById('dataStateOverlay').classList.contains('hidden')", timeout=20000)
    page.wait_for_timeout(500)
    check(
        "map loads successfully with an emoji-first photographer name (doesn't crash the whole page)",
        page.eval_on_selector("#dataStateOverlay", "el => el.classList.contains('hidden')"),
    )
    ctx.close()
    browser.close()


REAL_SPOT = {
    "Photographer Name": "Real Photog", "Logo URL": "", "Website URL": "https://example.com",
    "Location Name": "Winnats Pass - top of the climb",
    "Description": "Shooting bikes coming up the hill all afternoon - wave if you see me!",
    "Lat": "53.1", "Lng": "-1.6", "Start": f"{_TODAY} 00:00", "End": f"{_TODAY} 23:59",
    "Shoot ID": "S1", "Shoot Tab Name": "realphotog",
}


def route_real_spot(ctx):
    route_spots_json(ctx, [REAL_SPOT])


def test_popup_clears_bottom_controls(p, device_name, engine):
    # Regression test for a confirmed bug: on a real phone-sized map
    # viewport (~372px of actual map height on an iPhone 14, once the
    # header/search/filters/date bar above it are accounted for), a
    # popup with real content (logo, description, directions buttons)
    # rendered underneath the bottom-left "Reset view" control - both
    # when opening a marker's popup directly and when selecting a search
    # result. Two compounding root causes, both fixed: (1) Leaflet's
    # cached map size was stale (measured before the page's real layout
    # had settled, ~50px taller than the map's true height), feeding
    # wrong numbers into every size-dependent calculation including
    # autoPan - fixed with an explicit map.invalidateSize() once initial
    # load settles; (2) the bottom-left control stack itself was tall
    # enough that even correct autoPan math left barely any room for a
    # popup on a short viewport - fixed at the time by combining Reset
    # view + My location into one row (My location has since moved to
    # its own control at top-right instead, 26/07/2026, by request - see
    # test_locate_button_top_right below - which achieves the same
    # height saving a different way). .locate-btn is still checked here
    # too since nothing about ITS position should ever overlap a popup
    # either, wherever it currently lives.
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(**device, service_workers="block")
    stub_tiles(ctx)
    route_real_spot(ctx)
    page = ctx.new_page()
    print(f"\n--- popup clears bottom controls on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/index.html", timeout=30000)
    page.wait_for_function("document.getElementById('dataStateOverlay').classList.contains('hidden')", timeout=20000)
    page.wait_for_timeout(500)
    if page.eval_on_selector("#locationPromptBanner", "el => !el.classList.contains('hidden')"):
        page.tap("#dismissLocationPromptBtn")
        page.wait_for_timeout(300)

    def rects_overlap(a, b):
        return not (
            a["x"] + a["width"] < b["x"] or a["x"] > b["x"] + b["width"]
            or a["y"] + a["height"] < b["y"] or a["y"] > b["y"] + b["height"]
        )

    # Path 1: opening a marker's popup directly.
    page.evaluate(
        "() => { const spot = spots[0]; "
        "['live','soon','past'].forEach(s => clusterGroups[s].eachLayer(m => { "
        "if (m._spotRef === spot) m.openPopup(); })); }"
    )
    page.wait_for_timeout(400)
    popup_box = page.eval_on_selector(".leaflet-popup-content-wrapper", "el => el.getBoundingClientRect()")
    reset_box = page.eval_on_selector(".recenter-btn", "el => el.getBoundingClientRect()")
    locate_box = page.eval_on_selector(".locate-btn", "el => el.getBoundingClientRect()")
    check(
        "marker popup doesn't overlap Reset view / My location",
        not rects_overlap(popup_box, reset_box) and not rects_overlap(popup_box, locate_box),
        f"popup={popup_box} reset={reset_box} locate={locate_box}",
    )
    page.evaluate("() => map.closePopup()")
    page.wait_for_timeout(200)

    # Path 2: opening the same popup via a search result selection.
    page.fill("#searchInput", "Real")
    page.wait_for_timeout(500)
    page.tap("#searchResults .resultItem")
    page.wait_for_timeout(700)
    popup_box2 = page.eval_on_selector(".leaflet-popup-content-wrapper", "el => el.getBoundingClientRect()")
    check(
        "search-result popup doesn't overlap Reset view / My location",
        not rects_overlap(popup_box2, reset_box) and not rects_overlap(popup_box2, locate_box),
        f"popup={popup_box2}",
    )
    ctx.close()
    browser.close()


def test_popup_clears_search_bar_during_banner(p, device_name, engine):
    # Regression test for a confirmed bug: with the location-consent
    # banner showing (which pushes #searchWrap further down via
    # --bannerHeight), a popup could still open using a fixed top-left
    # autoPan padding sized for #searchWrap's NORMAL position, landing
    # underneath the search box. Fixed by measuring #searchWrap's actual
    # current bottom edge in getPopupAutoPanOptions() instead of a fixed
    # guess. A second, separate bug surfaced while fixing this: opening a
    # popup once, closing it, then quickly selecting a search result
    # could re-open the search dropdown out from under the just-opened
    # popup - runSearch()'s debounced place-geocode lookup (500ms) could
    # resolve and re-render (re-showing) the dropdown after a result had
    # already been selected, if the two landed in the same window. Fixed
    # by invalidating the debounce's request ID on selection, reusing the
    # exact staleness guard already built for "a newer search superseded
    # this one".
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(**device, service_workers="block")
    stub_tiles(ctx)
    route_real_spot(ctx)
    page = ctx.new_page()
    print(f"\n--- popup clears search bar during banner on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/index.html", timeout=30000)
    page.wait_for_function("document.getElementById('dataStateOverlay').classList.contains('hidden')", timeout=20000)
    page.wait_for_timeout(500)
    # Deliberately leave the location-consent banner showing this time.
    banner_showing = page.eval_on_selector("#locationPromptBanner", "el => !el.classList.contains('hidden')")
    check("location banner is showing for this test", banner_showing)

    def rects_overlap(a, b):
        return not (
            a["x"] + a["width"] < b["x"] or a["x"] > b["x"] + b["width"]
            or a["y"] + a["height"] < b["y"] or a["y"] > b["y"] + b["height"]
        )

    search_box = page.eval_on_selector("#searchWrap", "el => el.getBoundingClientRect()")
    page.evaluate(
        "() => { const spot = spots[0]; "
        "['live','soon','past'].forEach(s => clusterGroups[s].eachLayer(m => { "
        "if (m._spotRef === spot) m.openPopup(); })); }"
    )
    page.wait_for_timeout(400)
    popup_box = page.eval_on_selector(".leaflet-popup-content-wrapper", "el => el.getBoundingClientRect()")
    check(
        "popup doesn't overlap the search bar while the location banner is showing",
        not rects_overlap(popup_box, search_box),
        f"popup={popup_box} search={search_box}",
    )
    page.evaluate("() => map.closePopup()")
    page.wait_for_timeout(200)

    # The debounced-geocode-race scenario: open+close a popup, then
    # quickly search and select a result within the 500ms debounce window.
    page.fill("#searchInput", "Real")
    page.wait_for_timeout(500)
    page.tap("#searchResults .resultItem")
    page.wait_for_timeout(700)
    check(
        "search dropdown doesn't silently reappear after selecting a result",
        page.eval_on_selector("#searchResults", "el => !el.classList.contains('show')"),
    )
    ctx.close()
    browser.close()


def test_locate_button_top_right(p, device_name, engine):
    # Regression test for a confirmed bug found while moving "My location"
    # from the bottom-left row to its own control at top-right (26/07/2026,
    # by request): the location-consent/photographer-filter banners push
    # #searchWrap down (via --bannerHeight) but never touched a native
    # Leaflet control's position, and the banner's z-index (900) is LOWER
    # than Leaflet's controls (1000) - so the button rendered visually on
    # top of the banner's own "Yes, use it"/dismiss buttons, physically
    # blocking taps on them. Fixed with a matching margin-top push on
    # .locateBtnWrap while a banner is active.
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(**device, service_workers="block")
    stub_tiles(ctx)
    route_real_spot(ctx)
    page = ctx.new_page()
    print(f"\n--- locate button top-right on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/index.html", timeout=30000)
    page.wait_for_function("document.getElementById('dataStateOverlay').classList.contains('hidden')", timeout=20000)
    page.wait_for_timeout(500)

    def rects_overlap(a, b):
        return not (
            a["x"] + a["width"] < b["x"] or a["x"] > b["x"] + b["width"]
            or a["y"] + a["height"] < b["y"] or a["y"] > b["y"] + b["height"]
        )

    banner_showing = page.eval_on_selector("#locationPromptBanner", "el => !el.classList.contains('hidden')")
    check("location banner is showing for this test", banner_showing)
    banner_box = page.eval_on_selector("#locationPromptBanner", "el => el.getBoundingClientRect()")
    locate_box_during_banner = page.eval_on_selector(".locate-btn", "el => el.getBoundingClientRect()")
    check(
        "locate button doesn't overlap the banner's own buttons while it's showing",
        not rects_overlap(banner_box, locate_box_during_banner),
        f"banner={banner_box} locate={locate_box_during_banner}",
    )
    check("locate button is a real 44x44px touch target", locate_box_during_banner["width"] >= 44 and locate_box_during_banner["height"] >= 44)

    page.tap("#dismissLocationPromptBtn")
    page.wait_for_timeout(300)
    locate_box = page.eval_on_selector(".locate-btn", "el => el.getBoundingClientRect()")
    search_box = page.eval_on_selector("#searchWrap", "el => el.getBoundingClientRect()")
    check(
        "locate button moves back up once the banner is dismissed",
        locate_box["top"] < locate_box_during_banner["top"],
        f"during={locate_box_during_banner['top']} after={locate_box['top']}",
    )
    check(
        "locate button doesn't overlap the search bar",
        not rects_overlap(locate_box, search_box),
        f"locate={locate_box} search={search_box}",
    )
    ctx.close()
    browser.close()


def test_aerial_attribution_no_overlap(p, device_name, engine):
    # Regression test for a confirmed bug: Aerial's basemap is really 3
    # stacked layers (imagery + 2 label/road overlays), each of which had
    # its own attribution string - Leaflet concatenates every active
    # layer's attribution together, so switching to Aerial produced one
    # very long line that wrapped to 2 lines wide enough to reach over
    # into the bottom-left zoom control on a narrow mobile viewport,
    # despite the attribution box being anchored bottom-right. Fixed by
    # only attributing the group once (on the base imagery layer) and
    # capping the attribution box's width so it wraps into more, narrower
    # lines confined to the right side instead of growing wide enough to
    # reach the other corner.
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(**device, service_workers="block")
    stub_tiles(ctx)
    route_real_spot(ctx)
    page = ctx.new_page()
    print(f"\n--- Aerial attribution doesn't overlap zoom control on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/index.html", timeout=30000)
    page.wait_for_function("document.getElementById('dataStateOverlay').classList.contains('hidden')", timeout=20000)
    page.wait_for_timeout(500)
    if page.eval_on_selector("#locationPromptBanner", "el => !el.classList.contains('hidden')"):
        page.tap("#dismissLocationPromptBtn")
        page.wait_for_timeout(300)
    page.evaluate(
        "() => { const labels = document.querySelectorAll('.leaflet-control-layers-list label'); "
        "for (const l of labels) { if (l.textContent.includes('Aerial')) { l.querySelector('input').click(); break; } } }"
    )
    page.wait_for_timeout(500)
    attribution_box = page.eval_on_selector(".leaflet-control-attribution", "el => el.getBoundingClientRect()")
    zoomout_box = page.eval_on_selector(".leaflet-control-zoom-out", "el => el.getBoundingClientRect()")

    def rects_overlap(a, b):
        return not (
            a["x"] + a["width"] < b["x"] or a["x"] > b["x"] + b["width"]
            or a["y"] + a["height"] < b["y"] or a["y"] > b["y"] + b["height"]
        )

    check(
        "Aerial's attribution doesn't overlap the zoom-out button",
        not rects_overlap(attribution_box, zoomout_box),
        f"attribution={attribution_box} zoomout={zoomout_box}",
    )

    # Regression test for a second, deeper bug found the same day: the
    # attribution control and the layers-switcher toggle stack in the same
    # bottom-right Leaflet corner, so any change in the attribution's
    # rendered HEIGHT (switching basemap from OpenStreetMap's 1-line
    # credit to a longer one) pushed the toggle button above it up or
    # down - confirmed by measuring its screen position across basemaps.
    # Fixed with a fixed min-height (not the previously-used percentage
    # width, which turned out to silently resolve against an unsized
    # shrink-to-fit ancestor rather than the map, at any viewport size).
    # Checks the toggle's Y position is identical across all three real
    # basemaps, and that the attribution box never overlaps "Reset view"
    # (the specific overlap a previous, narrower fix attempt reintroduced
    # on small phones).
    def switch_basemap(layer_label):
        page.evaluate(
            "(label) => { const labels = document.querySelectorAll('.leaflet-control-layers-list label'); "
            "for (const l of labels) { if (l.textContent.includes(label)) { l.querySelector('input').click(); break; } } }",
            layer_label,
        )
        page.wait_for_timeout(400)

    reset_view_box = page.evaluate(
        "() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reset view'); "
        "return btn ? btn.getBoundingClientRect() : null; }"
    )
    toggle_ys = []
    reset_overlaps = []
    for label in ["OpenStreetMap", "Aerial", "OS Roads"]:
        switch_basemap(label)
        toggle_box = page.eval_on_selector(".leaflet-control-layers-toggle", "el => el.getBoundingClientRect()")
        attr_box = page.eval_on_selector(".leaflet-control-attribution", "el => el.getBoundingClientRect()")
        toggle_ys.append(round(toggle_box["y"], 1))
        reset_overlaps.append(rects_overlap(attr_box, reset_view_box) if reset_view_box else False)
    check(
        "layers toggle doesn't shift position when switching basemaps",
        len(set(toggle_ys)) == 1,
        f"toggle Y positions across basemaps: {toggle_ys}",
    )
    check(
        "attribution never overlaps the Reset view button",
        not any(reset_overlaps),
        f"overlap per basemap: {list(zip(['OpenStreetMap', 'Aerial', 'OS Roads'], reset_overlaps))}",
    )
    ctx.close()
    browser.close()


def test_no_stuck_hover_or_tap_highlight(p, device_name, engine):
    # Regression test for two confirmed bugs, both reported on real mobile
    # use (26/07/2026): (1) tapping the date steppers or "Today" left a
    # green outline stuck on until tapping something else entirely - plain
    # :hover rules aren't scoped to real pointer devices, so a touch tap
    # leaves them "stuck" with no mouse-leave event to ever clear them.
    # Found the exact same unscoped pattern on ~15 other buttons/links
    # sitewide and fixed all of them the same way (@media (hover: hover)).
    # (2) a visible blue tap-highlight flash on click - the sitewide
    # `*{-webkit-tap-highlight-color:transparent}` rule doesn't actually
    # win against Leaflet's own default stylesheet, which sets its OWN
    # higher-specificity blue tap-highlight specifically for links inside
    # the map (popup Directions/gallery links) - confirmed via computed
    # style that they were still getting Leaflet's blue flash regardless
    # of the sitewide rule.
    device = p.devices[device_name]
    browser = getattr(p, engine).launch()
    ctx = browser.new_context(**device, service_workers="block")
    stub_tiles(ctx)
    route_real_spot(ctx)
    page = ctx.new_page()
    print(f"\n--- no stuck hover / tap highlight on {device_name} ({engine}) ---")
    page.goto(f"{BASE}/index.html", timeout=30000)
    page.wait_for_function("document.getElementById('dataStateOverlay').classList.contains('hidden')", timeout=20000)
    page.wait_for_timeout(500)
    if page.eval_on_selector("#locationPromptBanner", "el => !el.classList.contains('hidden')"):
        page.tap("#dismissLocationPromptBtn")
        page.wait_for_timeout(300)

    normal_border = page.eval_on_selector("#nextDay", "el => getComputedStyle(el).borderColor")
    page.tap("#nextDay")
    page.wait_for_timeout(200)
    check(
        "date stepper border isn't stuck on hi-vis after a real tap",
        page.eval_on_selector("#nextDay", "el => getComputedStyle(el).borderColor") == normal_border,
    )
    page.tap("#todayBtn")
    page.wait_for_timeout(200)
    check(
        "Today button border isn't stuck on hi-vis after a real tap",
        page.eval_on_selector("#todayBtn", "el => getComputedStyle(el).borderColor") == normal_border,
    )

    page.evaluate(
        "() => { const spot = spots[0]; "
        "['live','soon','past'].forEach(s => clusterGroups[s].eachLayer(m => { "
        "if (m._spotRef === spot) m.openPopup(); })); }"
    )
    page.wait_for_timeout(400)
    # -webkit-tap-highlight-color is primarily a Chromium/Android thing -
    # Safari/WebKit doesn't show this kind of tap highlight at all and
    # doesn't expose the property via getComputedStyle (returns null/""),
    # so there's nothing meaningful to check on that engine specifically.
    tap_highlight = page.eval_on_selector(".popup-btn", "el => getComputedStyle(el).webkitTapHighlightColor")
    if tap_highlight:
        check(
            "popup link has no visible tap-highlight flash (Leaflet's own default doesn't override the sitewide rule)",
            tap_highlight in ("rgba(0, 0, 0, 0)", "transparent"),
            tap_highlight,
        )
    else:
        print("  (skipped tap-highlight check: not exposed on this engine)")
    ctx.close()
    browser.close()


def main():
    httpd = start_server_if_needed()
    try:
        with sync_playwright() as p:
            for device_name, engine in [("iPhone 14", "webkit"), ("Pixel 7", "chromium")]:
                test_index(p, device_name, engine)
                test_add_shoot(p, device_name, engine)
                test_empty_state_no_drift(p, device_name, engine)
                test_emoji_name_no_crash(p, device_name, engine)
                test_popup_clears_bottom_controls(p, device_name, engine)
                test_popup_clears_search_bar_during_banner(p, device_name, engine)
                test_locate_button_top_right(p, device_name, engine)
                test_aerial_attribution_no_overlap(p, device_name, engine)
                test_no_stuck_hover_or_tap_highlight(p, device_name, engine)
    finally:
        if httpd:
            httpd.shutdown()

    failed = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    if failed:
        print("\nFAILURES:")
        for _, label, detail in failed:
            print(f"  - {label}" + (f"  ({detail})" if detail else ""))
        sys.exit(1)


if __name__ == "__main__":
    main()
