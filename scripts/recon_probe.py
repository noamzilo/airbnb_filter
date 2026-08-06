# Recon: probe ONE listing's current price by re-running Airbnb's own search
# scoped to a tiny box around its coordinate. The /rooms/<id> page carries no
# price (see recon_pdp.py), but /s/ HTML server-renders structuredDisplayPrice.

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
  // 1. Pick a target from the CURRENT page's data: id + coord + its price now.
  let target = null;
  const walk = (n, cb) => { if (Array.isArray(n)) { for (const c of n) walk(c, cb); return; }
    if (n && typeof n === 'object') { cb(n); for (const k in n) walk(n[k], cb); } };
  for (const s of document.querySelectorAll('script[id^="data-deferred-state"]')) {
    let j; try { j = JSON.parse(s.textContent); } catch (e) { continue; }
    walk(j, (n) => {
      if (target) return;
      const dsl = n.demandStayListing;
      const c = dsl && dsl.location && dsl.location.coordinate;
      if (dsl && dsl.id && c && n.structuredDisplayPrice) {
        target = { id: atob(dsl.id).split(':').pop(), lat: c.latitude, lng: c.longitude,
                   priceNow: (n.structuredDisplayPrice.primaryLine || {}).accessibilityLabel };
      }
    });
  }
  if (!target) return done({ error: 'no target found' });

  // 2. Re-run the search scoped to a tiny box around it. Copy the CURRENT search
  //    params wholesale (keys like "flexible_trip_lengths[]" carry the brackets,
  //    and the monthly-stay mode is spread across several of them) minus the ones
  //    that would re-centre the search somewhere else.
  //    Keep ONLY what sets the price (dates, occupancy, monthly mode, currency).
  //    Copying the user's filters too would make a filtered-out listing look
  //    "unavailable" when it is merely filtered.
  const KEEP = new Set(['adults','children','infants','pets','check_in','check_out',
    'monthly_start_date','monthly_end_date','monthly_length','flexible_trip_lengths[]',
    'price_filter_input_type','date_picker_type','search_mode','currency','refinement_paths[]']);
  const q = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(location.search)) if (KEEP.has(k)) q.append(k, v);
  if (!q.has('refinement_paths[]')) q.set('refinement_paths[]', '/homes');
  q.set('search_by_map', 'true');
  q.set('zoom', '17');
  const PAD = 0.0015;
  q.set('ne_lat', (target.lat + PAD).toFixed(6)); q.set('ne_lng', (target.lng + PAD).toFixed(6));
  q.set('sw_lat', (target.lat - PAD).toFixed(6)); q.set('sw_lng', (target.lng - PAD).toFixed(6));
  const url = `${location.origin}/s/homes?${q.toString()}`;

  const t0 = performance.now();
  let text;
  try { const r = await fetch(url, { credentials: 'same-origin' }); text = await r.text(); }
  catch (e) { return done({ error: 'fetch failed: ' + e.message, url }); }
  const ms = Math.round(performance.now() - t0);

  // 3. Can we find our listing (and a price) in the response?
  const out = { target, url, ms, bytes: text.length, found: false, ids: [], price: null };
  const doc = new DOMParser().parseFromString(text, 'text/html');
  for (const s of doc.querySelectorAll('script[id^="data-deferred-state"]')) {
    let j; try { j = JSON.parse(s.textContent); } catch (e) { continue; }
    walk(j, (n) => {
      const dsl = n.demandStayListing;
      if (!dsl || !dsl.id) return;
      let id; try { id = atob(dsl.id).split(':').pop(); } catch (e) { return; }
      if (!out.ids.includes(id)) out.ids.push(id);
      if (id === target.id && n.structuredDisplayPrice && !out.found) {
        out.found = true;
        out.price = (n.structuredDisplayPrice.primaryLine || {}).accessibilityLabel;
        out.style = n.structuredDisplayPrice.displayPriceStyle;
        out.pics = (n.contextualPictures || []).length;
      }
    });
  }
  out.idCount = out.ids.length;
  out.ids = out.ids.slice(0, 6);
  done(out);
})();
"""

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
d.set_script_timeout(120)
try:
    d.get(SEARCH)
    for _ in range(45):
        if d.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length'): break
        time.sleep(1)
    time.sleep(2)
    print(json.dumps(d.execute_async_script(PROBE), indent=1, ensure_ascii=False))
finally:
    d.quit()
