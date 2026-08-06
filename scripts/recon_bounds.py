# Recon: can the content script know the map's CURRENT viewport bounds?
# Loads the live search, records the URL + marker spread, pans/zooms the map,
# and reports whether ne_lat/ne_lng/sw_lat/sw_lng track the map. Text-only.

import time, pathlib, json, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains

URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true")

SNAP = """
const u = new URL(location.href);
const g = (k) => u.searchParams.get(k);
const pins = [...document.querySelectorAll('gmp-advanced-marker')]
  .map(m => m.getAttribute('position')).filter(Boolean)
  .map(p => p.split(',').map(Number)).filter(a => a.length===2 && isFinite(a[0]));
let bb = null;
if (pins.length) {
  bb = {minLat: Math.min(...pins.map(p=>p[0])), maxLat: Math.max(...pins.map(p=>p[0])),
        minLng: Math.min(...pins.map(p=>p[1])), maxLng: Math.max(...pins.map(p=>p[1]))};
}
return {
  href: location.pathname + location.search.slice(0, 200),
  ne_lat: g('ne_lat'), ne_lng: g('ne_lng'), sw_lat: g('sw_lat'), sw_lng: g('sw_lng'),
  zoom: g('zoom'), search_by_map: g('search_by_map'),
  nPins: pins.length, pinBBox: bb,
};
"""

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1400, 950); d.get(URL)
    for _ in range(45):
        if d.execute_script("return document.querySelectorAll('gmp-advanced-marker').length"): break
        time.sleep(1)
    time.sleep(3)
    print("INITIAL  ", json.dumps(d.execute_script(SNAP)))

    mp = d.execute_script("""
      const m = document.querySelector('[data-testid="map/GoogleMap"]')
        || document.querySelector('[aria-roledescription="map"]');
      if (!m) return null; const r = m.getBoundingClientRect();
      return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height};
    """)
    print("MAP BOX  ", json.dumps(mp))

    if mp:
        m = d.find_element("css selector", '[data-testid="map/GoogleMap"], [aria-roledescription="map"]')
        # Drag the map a long way west/north.
        ActionChains(d).move_to_element(m).click_and_hold() \
            .move_by_offset(-200, -120).pause(0.6).release().perform()
        time.sleep(7)
        print("AFTER PAN", json.dumps(d.execute_script(SNAP)))

        # Zoom in via double click.
        ActionChains(d).move_to_element(m).double_click().perform()
        time.sleep(7)
        print("AFTER ZOOM", json.dumps(d.execute_script(SNAP)))
finally:
    d.quit()
