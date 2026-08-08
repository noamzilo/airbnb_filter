# Where does "pets allowed" live?
#   1. On a /rooms/<id> page - we already fetch that page for the host name, so
#      if the answer is in there it is free.
#   2. In a /s/ search response - is there anything per-listing we could read
#      without a second fetch?
# Prints every pet-ish string with JSON context, plus amenity-ish blocks.

import time, json, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOM = sys.argv[1] if len(sys.argv) > 1 else "1239210296375530793"

FETCH = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const r = await fetch(arguments[0], {credentials: 'same-origin'});
  const text = await r.text();
  const out = {bytes: text.length, hits: [], blocks: [], titles: []};

  const re = /[Pp]et[s]?\b/g;
  let m;
  while ((m = re.exec(text)) && out.hits.length < 40) {
    out.hits.push(text.slice(Math.max(0, m.index - 180), m.index + 120));
  }

  const doc = new DOMParser().parseFromString(text, 'text/html');
  for (const s of doc.querySelectorAll('script[id^="data-deferred-state"], script[type="application/json"]')) {
    let j; try { j = JSON.parse(s.textContent); } catch (e) { continue; }
    (function walk(n) {
      if (Array.isArray(n)) { for (const c of n) walk(c); return; }
      if (!n || typeof n !== 'object') return;
      const blob = JSON.stringify(n);
      if (/pet/i.test(blob) && blob.length < 1200 && out.blocks.length < 25) out.blocks.push(blob);
      if (typeof n.title === 'string' && /pet/i.test(n.title) && out.titles.length < 25) {
        out.titles.push(JSON.stringify({__typename: n.__typename, title: n.title, subtitle: n.subtitle, available: n.available, id: n.id}));
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
    d.get("https://www.airbnb.com/")
    time.sleep(2)
    for label, url in [
        ("ROOM PAGE", f"https://www.airbnb.com/rooms/{ROOM}"),
        ("SEARCH PAGE", "https://www.airbnb.com/s/Buenos-Aires--Argentina/homes?refinement_paths%5B%5D=%2Fhomes"),
    ]:
        r = d.execute_async_script(FETCH, url)
        print(f"\n================ {label} ({r['bytes']} bytes) ================")
        print("--- pet-ish titles ---")
        for t in r["titles"]:
            print("  " + t)
        print("--- small JSON blocks mentioning 'pet' ---")
        for b in r["blocks"]:
            print("  " + b[:600])
        print("--- raw string hits ---")
        for h in r["hits"][:20]:
            print("  ..." + h.replace("\n", " ") + "...")
finally:
    d.quit()
