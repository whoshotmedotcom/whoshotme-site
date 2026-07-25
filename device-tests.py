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
import http.server
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
    )
    stub_tiles(ctx)
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

    # Search (real tap + fill)
    page.tap("#searchInput")
    page.fill("#searchInput", "Winnats")
    page.wait_for_timeout(1200)
    result_count = page.eval_on_selector_all("#searchResults > *", "els => els.length")
    check("search returns results for a known place", result_count > 0, str(result_count))

    # Filter chip tap
    chip = page.query_selector('.chip[data-filter="live"]')
    if chip:
        chip.tap()
        page.wait_for_timeout(300)
        check("filter chip responds to tap", "active" in (chip.get_attribute("class") or ""))

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
    ctx = browser.new_context(**device)
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


def main():
    httpd = start_server_if_needed()
    try:
        with sync_playwright() as p:
            for device_name, engine in [("iPhone 14", "webkit"), ("Pixel 7", "chromium")]:
                test_index(p, device_name, engine)
                test_add_shoot(p, device_name, engine)
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
