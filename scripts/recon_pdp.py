# Recon: can we probe a listing's CURRENT price by fetching its /rooms/<id> page
# from inside an airbnb.com page (same-origin fetch, session cookies apply)?
# Dumps candidate price locations in the room page's deferred state. Text-only.

import time, json, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

SEARCH = ("https://www.airbnb.com/s/Jerusalem--Israel/homes?adults=1"
          "&refinement_paths%5B%5D=%2Fhomes"
          "&flexible_trip_lengths%5B%5D=one_month"
          "&monthly_start_date=2026-09-01&monthly_length=3&monthly_end_date=2026-12-01"
          "&price_filter_input_type=2&search_type=filter_change"
          "&ne_lat=31.85&ne_lng=35.30&sw_lat=31.72&sw_lng=35.15&zoom=12&search_by_map=true")

PROBE = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const a = document.querySelector('a[href*="/rooms/"]');
  if (!a) return done({error: 'no room link on the search page'});
  const id = a.getAttribute('href').match(/\/rooms\/(\d+)/)[1];

  // Carry the search's own params so the probed price matches the search context.
  const src = new URLSearchParams(location.search);
  const keep = ['adults','children','infants','pets','check_in','check_out',
                'monthly_start_date','monthly_end_date','monthly_length',
                'price_filter_input_type','flexible_trip_lengths','currency'];
  const q = new URLSearchParams();
  for (const k of keep) { const v = src.get(k); if (v != null) q.set(k, v); }
  const url = `${location.origin}/rooms/${id}?${q.toString()}`;

  const t0 = performance.now();
  let res, text;
  try { res = await fetch(url, {credentials: 'same-origin'}); text = await res.text(); }
  catch (e) { return done({error: 'fetch failed: ' + e.message, url}); }
  const ms = Math.round(performance.now() - t0);

  const out = {id, url, status: res.status, ms, bytes: text.length, blobs: 0, hits: [], titles: []};

  const doc = new DOMParser().parseFromString(text, 'text/html');
  out.pageTitle = (doc.querySelector('title') || {}).textContent;
  for (const s of doc.querySelectorAll('script[id^="data-deferred-state"]')) {
    out.blobs++;
    let j; try { j = JSON.parse(s.textContent); } catch (e) { continue; }
    const path = [];
    (function walk(n, p) {
      if (Array.isArray(n)) { n.forEach((c, i) => walk(c, p + '[' + i + ']')); return; }
      if (!n || typeof n !== 'object') return;
      for (const k in n) {
        const v = n[k];
        if (/^(structuredDisplayPrice|displayPrice|priceBreakdown|price)$/i.test(k) && v && typeof v === 'object') {
          if (out.hits.length < 8) out.hits.push({path: p + '.' + k, keys: Object.keys(v).slice(0, 14), sample: JSON.stringify(v).slice(0, 600)});
        }
        if (k === '__typename' && typeof v === 'string' && /Price/i.test(v)) {
          if (out.titles.length < 25 && !out.titles.includes(v)) out.titles.push(v);
        }
        walk(v, p + '.' + k);
      }
    })(j, '');
  }
  // Fallback: is the price at least visible as text anywhere?
  const txt = doc.body ? doc.body.innerText || '' : '';
  const m = text.match(/"(?:accessibilityLabel|priceString|discountedPrice)"\s*:\s*"[^"]{0,60}"/g);
  out.rawPriceStrings = m ? [...new Set(m)].slice(0, 12) : [];
  // Does the room page at least carry a coordinate? (A coordinate is enough to
  // probe the price via a scoped search - see recon_probe.py.)
  const lat = text.match(/"lat(?:itude)?"\s*:\s*(-?\d+\.\d+)/g);
  const lng = text.match(/"l(?:ng|ongitude)"\s*:\s*(-?\d+\.\d+)/g);
  out.coordHits = { lat: lat ? [...new Set(lat)].slice(0, 5) : [], lng: lng ? [...new Set(lng)].slice(0, 5) : [] };
  done(out);
})();
"""

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
d.set_script_timeout(90)
try:
    d.get(SEARCH)
    for _ in range(45):
        if d.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length'): break
        time.sleep(1)
    time.sleep(2)
    res = d.execute_async_script(PROBE)
    for k in ("error", "id", "url", "status", "ms", "bytes", "blobs", "pageTitle", "coordHits"):
        if k in res: print(f"{k}: {res[k]}")
    print("\nPRICE __typenames:", res.get("titles"))
    print("\nRAW PRICE STRINGS:")
    for s in res.get("rawPriceStrings", []): print("  ", s)
    print("\nHITS:")
    for h in res.get("hits", []):
        print(json.dumps(h, indent=1, ensure_ascii=False)[:900])
        print("-" * 70)
finally:
    d.quit()
