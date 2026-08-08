# Recon: what shapes does structuredDisplayPrice take?
# Loads a search in real Firefox, pulls the server-rendered deferred state, and
# dumps every distinct primaryLine/secondaryLine shape it finds. Text-only.
#
#   python scripts/recon_price.py            # monthly-stay search (Jerusalem)
#   python scripts/recon_price.py <url>

import time, json, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

MONTHLY = ("https://www.airbnb.com/s/Jerusalem--Israel/homes?adults=1"
           "&refinement_paths%5B%5D=%2Fhomes"
           "&flexible_trip_lengths%5B%5D=one_month"
           "&monthly_start_date=2026-09-01&monthly_length=3&monthly_end_date=2026-12-01"
           "&price_filter_input_type=2&search_type=filter_change"
           "&ne_lat=31.85&ne_lng=35.30&sw_lat=31.72&sw_lng=35.15&zoom=12&search_by_map=true")

URL = sys.argv[1] if len(sys.argv) > 1 else MONTHLY

DUMP = r"""
const out = {blobs: 0, items: 0, samples: [], shapes: {}};
const seenShape = new Set();
function walk(n, cb) {
  if (Array.isArray(n)) { for (const c of n) walk(c, cb); return; }
  if (n && typeof n === 'object') { cb(n); for (const k in n) walk(n[k], cb); }
}
for (const s of document.querySelectorAll('script[id^="data-deferred-state"]')) {
  out.blobs++;
  let j; try { j = JSON.parse(s.textContent); } catch (e) { continue; }
  walk(j, (n) => {
    const sdp = n.structuredDisplayPrice;
    if (!sdp || !sdp.primaryLine) return;
    out.items++;
    const pl = sdp.primaryLine, sl = sdp.secondaryLine;
    const key = [pl.__typename, sl && sl.__typename, sdp.displayPriceStyle,
                 Object.keys(pl).sort().join('+')].join('|');
    out.shapes[key] = (out.shapes[key] || 0) + 1;
    if (!seenShape.has(key) && out.samples.length < 6) {
      seenShape.add(key);
      out.samples.push({
        key,
        title: n.title, name: n.nameLocalized && n.nameLocalized.localizedStringWithTranslationPreference,
        primaryLine: pl, secondaryLine: sl,
        displayPriceStyle: sdp.displayPriceStyle,
        explanation: sdp.explanationData ? JSON.stringify(sdp.explanationData).slice(0, 900) : null,
      });
    }
  });
}
return out;
"""

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
try:
    d.get(URL)
    for _ in range(45):
        if d.execute_script("return document.querySelectorAll('script[id^=\"data-deferred-state\"]').length"): break
        time.sleep(1)
    time.sleep(2)
    res = d.execute_script(DUMP)
    print("blobs:", res["blobs"], "priced items:", res["items"])
    print("\nSHAPES:")
    for k, v in sorted(res["shapes"].items(), key=lambda kv: -kv[1]):
        print(f"  {v:4d}  {k}")
    print("\nSAMPLES:")
    for s in res["samples"]:
        print(json.dumps(s, indent=1, ensure_ascii=False))
        print("-" * 70)
    if not res["items"]:
        print("\nPAGE TEXT:", d.execute_script("return document.body.innerText.slice(0,400)"))

    # Run the shipped Filter.priceOf over every priced item on this page and
    # report coverage - a shape we can't normalise shows as "price not captured".
    import pathlib
    d.execute_script((pathlib.Path(__file__).resolve().parent.parent / "extension" / "filter.js")
                     .read_text(encoding="utf-8") + "\nwindow.Filter=Filter;")
    cov = d.execute_script(r"""
      const out={total:0, ok:0, fails:[], samples:[]};
      function walk(n, cb){ if(Array.isArray(n)){for(const c of n)walk(c,cb);return;}
        if(n&&typeof n==='object'){cb(n);for(const k in n)walk(n[k],cb);} }
      for(const s of document.querySelectorAll('script[id^="data-deferred-state"]')){
        let j; try{j=JSON.parse(s.textContent);}catch(e){continue;}
        walk(j,(n)=>{ if(!n.structuredDisplayPrice||!n.structuredDisplayPrice.primaryLine) return;
          out.total++;
          const p=Filter.priceOf(n);
          if(p&&p.monthly!=null){ out.ok++; if(out.samples.length<5) out.samples.push(
              {label:p.label, monthly:p.symbol+p.monthly, nightly:p.nightly, basis:p.basis}); }
          else if(out.fails.length<5) out.fails.push(JSON.stringify(n.structuredDisplayPrice.primaryLine));
        });
      }
      return out;
    """)
    print(f"\nCOVERAGE: Filter.priceOf normalised {cov['ok']}/{cov['total']} priced items")
    for s in cov["samples"]:
        print("   ", json.dumps(s, ensure_ascii=False))
    for f in cov["fails"]:
        print("  UNPARSED:", f)
finally:
    d.quit()
