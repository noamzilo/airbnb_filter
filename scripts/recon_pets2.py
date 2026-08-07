# Follow-up to recon_pets.py: what does a PET-FRIENDLY room page look like?
# Finds listings via a pets=1 search, then dumps each room page's house-rules
# items and any amenity whose title mentions pets, with its icon + availability.

import time, json, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIND_ROOMS = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const r = await fetch(arguments[0], {credentials: 'same-origin'});
  const text = await r.text();
  // The search page carries ids as base64 "DemandStayListing:<id>", not /rooms/ links.
  const ids = new Set();
  for (const m of text.matchAll(/"id":"(RGVtYW5kU3RheUxpc3Rpbmc6[A-Za-z0-9+/=]+)"/g)) {
    try { const dec = atob(m[1]); const d = dec.match(/:(\d+)\s*$/); if (d) ids.add(d[1]); } catch (e) {}
  }
  done([...ids].slice(0, 6));
})();
"""

PETS = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const r = await fetch(arguments[0], {credentials: 'same-origin'});
  const text = await r.text();
  const out = {rules: [], petish: [], icons: []};
  const doc = new DOMParser().parseFromString(text, 'text/html');
  for (const s of doc.querySelectorAll('script[id^="data-deferred-state"]')) {
    let j; try { j = JSON.parse(s.textContent); } catch (e) { continue; }
    (function walk(n) {
      if (Array.isArray(n)) { for (const c of n) walk(c); return; }
      if (!n || typeof n !== 'object') return;
      if (n.__typename === 'BasicListItem' && typeof n.title === 'string' && out.rules.length < 40) {
        out.rules.push(n.title + '  [' + (n.icon || '') + ']');
      }
      if (typeof n.icon === 'string' && /PET/i.test(n.icon) && out.icons.length < 20) {
        out.icons.push(JSON.stringify({icon: n.icon, title: n.title, __typename: n.__typename}));
      }
      if (typeof n.title === 'string' && /pet/i.test(n.title) && out.petish.length < 20) {
        out.petish.push(JSON.stringify({__typename: n.__typename, title: n.title, subtitle: n.subtitle,
                                        available: n.available, icon: n.icon}));
      }
      for (const k of Object.keys(n)) walk(n[k]);
    })(j);
  }
  done(out);
})();
"""

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
d.set_script_timeout(120)
try:
    d.get("https://www.airbnb.com/"); time.sleep(2)
    search = ("https://www.airbnb.com/s/Buenos-Aires--Argentina/homes"
              "?refinement_paths%5B%5D=%2Fhomes&adults=1&pets=1")
    ids = d.execute_async_script(FIND_ROOMS, search)
    print("pet-friendly search room ids:", ids)
    for rid in ids[:3]:
        r = d.execute_async_script(PETS, f"https://www.airbnb.com/rooms/{rid}")
        print(f"\n===== room {rid} =====")
        print("  house rules / list items:")
        for t in r["rules"]:
            print("    " + t)
        print("  PET-ish icons:", r["icons"])
        print("  pet-ish titles:", r["petish"])
finally:
    d.quit()
