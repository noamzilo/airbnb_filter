# Where exactly is the HOST'S DISPLAY NAME on a /rooms/<id> page?
# Prints the JSON context around "Hosted by" / host-name-ish fields so the
# parser can key off something real instead of a guess.

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
  const out = {bytes: text.length, hostedBy: [], nameFields: [], sharedBlocks: []};

  // 1. Every "Hosted by X" string, with a little JSON context around it.
  const re = /Hosted by ([^"\\\\<]{1,60})/g;
  let m;
  while ((m = re.exec(text)) && out.hostedBy.length < 6) {
    out.hostedBy.push({match: m[1], around: text.slice(Math.max(0, m.index - 220), m.index + 90)});
  }

  // 2. Structured host blocks: walk the deferred state for objects that carry a
  //    host id AND something name-like.
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const seen = new Set();
  for (const s of doc.querySelectorAll('script[id^="data-deferred-state"], script[type="application/json"]')) {
    let j; try { j = JSON.parse(s.textContent); } catch (e) { continue; }
    (function walk(n) {
      if (Array.isArray(n)) { for (const c of n) walk(c); return; }
      if (!n || typeof n !== 'object') return;
      const keys = Object.keys(n);
      const hasHost = keys.some(k => /^host(Id|Name)$/i.test(k) || k === 'hostAvatar');
      const looksLikeUser = n.__typename && /User|Host|Passport/i.test(n.__typename);
      if ((hasHost || looksLikeUser) && out.sharedBlocks.length < 10) {
        const sig = (n.__typename || '') + '|' + keys.slice(0, 8).join(',');
        if (!seen.has(sig)) { seen.add(sig); out.sharedBlocks.push(JSON.stringify(n).slice(0, 420)); }
      }
      for (const k of keys) walk(n[k]);
    })(j);
  }
  done(out);
})();
"""

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
d.set_script_timeout(90)
try:
    d.get("https://www.airbnb.com/")
    time.sleep(2)
    r = d.execute_async_script(FETCH, f"https://www.airbnb.com/rooms/{ROOM}")
    print("bytes:", r["bytes"])
    print("\n--- 'Hosted by' occurrences ---")
    for h in r["hostedBy"]:
        print(f"  name: {h['match']!r}")
        print(f"  ctx : ...{h['around'][-260:]}")
        print()
    print("--- host/user-ish JSON blocks ---")
    for b in r["sharedBlocks"]:
        print("  " + b)
        print()
finally:
    d.quit()
