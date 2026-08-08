# Repro: why doesn't the "Your place" pin show? Injects content.js with the
# stub, sets refPlace directly, then dumps every intermediate of syncRefPin.

import time, pathlib, sys, json
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from lib_stub import STUB, INJECT_CSS

FILTER = (ROOT / "extension" / "filter.js").read_text(encoding="utf-8")
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
STYLES = (ROOT / "extension" / "content.css").read_text(encoding="utf-8")
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true")

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1400, 950); d.get(URL)
    for _ in range(45):
        if d.execute_script("return document.querySelectorAll('gmp-advanced-marker').length"): break
        time.sleep(1)
    d.execute_script(INJECT_CSS, STYLES)
    d.execute_script(STUB); d.execute_script(FILTER + "\nwindow.Filter = Filter;")
    d.execute_script(CONTENT); time.sleep(1.5)
    d.execute_script(
        "window.__settings.refPlace={lat:-25.2908,lng:-57.5871,raw:'test place'};"
        "window.__ls.forEach(f=>f({settings:{}}));")
    time.sleep(2.5)
    out = d.execute_script("""
      const map = document.querySelector('[data-testid="map/GoogleMap"]')
        || document.querySelector('[aria-roledescription="map"]')
        || document.querySelector('[aria-label="Map"]');
      const pts=[];
      for (const m of document.querySelectorAll('gmp-advanced-marker')) {
        const s=m.getAttribute('position'); if(!s) continue;
        const [la,ln]=s.split(',').map(parseFloat);
        const r=m.getBoundingClientRect();
        pts.push({lat:la,lng:ln,x:r.left,y:r.top,disp:m.style.display});
      }
      const usable = pts.filter(p=>(p.x||p.y) && p.disp!=='none');
      const fit = Filter.fitMapProjection(usable);
      const p = fit && Filter.projectPoint(fit, -25.2908, -57.5871);
      const pin = document.querySelector('.archiver-refpin');
      return {markers: pts.length, usable: usable.length, sample: usable.slice(0,3),
              fit, p, mapRect: map? map.getBoundingClientRect().toJSON():null,
              pin: pin? {display:pin.style.display, left:pin.style.left, top:pin.style.top}:null};
    """)
    print(json.dumps(out, indent=1)[:3000])
finally:
    d.quit()
