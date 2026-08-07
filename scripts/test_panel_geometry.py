# Does the panel cover Airbnb's card column WITHOUT covering the top chrome?
#
#   python scripts/test_panel_geometry.py [--headed]
#
# The panel is opaque and z-index 9000, so any overlap with the header hides
# real UI -- the expanded search pill is wider than the map column and reaches
# left underneath the panel, which is how it swallowed "Where / Check in".
#
# Injects content.js with a stubbed store (same approach as test_decorator.py --
# Selenium's install_addon does not run content scripts), then asserts geometry
# in three states: as loaded, scrolled down, and with the search bar expanded.

import sys, json, time, pathlib
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
URL = ("https://www.airbnb.com/s/Tel-Aviv--Israel/homes"
       "?checkin=2026-10-13&checkout=2026-11-12&adults=1")

# Same stub shape as test_decorator.py: content.js talks to `Store`, and
# execute_script bodies are function-scoped, so injecting store.js would leave
# `const Store` invisible to content.js. Stub it as a global instead.
STUB = r"""
window.__cats={starred:{},maybe:{},archived:{}};window.__settings={showArchived:false};
window.__tagcoords={};window.__notes={};window.__order=[];window.__ls=[];
window.__images={};window.__prices={};window.__hosts={};window.__threads={};
const fire=(ch)=>window.__ls.forEach(f=>{try{f(ch||{})}catch(e){}});
const C=["starred","maybe","archived"];
window.browser={storage:{onChanged:{addListener:f=>window.__ls.push(f)}}};
window.Store={
  getAll:async()=>window.__cats,getStarred:async()=>window.__cats.starred,getMaybe:async()=>window.__cats.maybe,getArchived:async()=>window.__cats.archived,
  getCategory:async i=>{for(const c of C)if(window.__cats[c][i])return c;return null;},
  setCategory:async(i,s,c)=>{for(const k of C)delete window.__cats[k][i];if(c)window.__cats[c][i]={...(s||{}),ts:1};fire({starred:{}});},
  getStarredData:async()=>({}),setStarredData:async()=>{},getTagCoords:async()=>window.__tagcoords||{},
  getHosts:async()=>window.__hosts||{},getThreads:async()=>window.__threads||{},
  setThread:async()=>false,setHost:async()=>false,
  getImages:async()=>window.__images||{},getPrices:async()=>window.__prices||{},
  setMedia:async(i,im,p,c)=>Store.setMediaBulk({[i]:{images:im,price:p,coord:c}}),
  setMediaBulk:async(e)=>{let n=0;for(const id in e){const v=e[id]||{};
    if(v.images&&v.images.length){window.__images[id]=v.images;n++;}
    if(v.price){window.__prices[id]=v.price;n++;}
    if(v.coord&&isFinite(v.coord.lat)){window.__tagcoords[id]={lat:v.coord.lat,lng:v.coord.lng};n++;}}
    if(n)fire({prices:{}});return n>0;},
  getNotes:async()=>window.__notes,setNote:async(i,t)=>{if(t&&t.trim())window.__notes[i]=t;else delete window.__notes[i];fire({notes:{}});},
  getOrder:async()=>window.__order,setOrder:async(a)=>{window.__order=a;fire({order:{}});},
  getSettings:async()=>window.__settings,setSetting:async(k,v)=>{window.__settings[k]=v;fire({settings:{}});}
};
"""

# Star whatever the page rendered, so the panel has real rows with real heights.
SEED = """
const ids = [...document.querySelectorAll('a[href*="/rooms/"]')]
  .map(a => (a.getAttribute("href").match(/\\/rooms\\/(\\d+)/) || [])[1])
  .filter(Boolean).slice(0, 6);
ids.forEach(id => window.__cats.starred[id] = { title: "L" + id, ts: 1 });
window.__order = ids;
window.__ls.forEach(f => { try { f({ starred: {} }); } catch (e) {} });
return ids.length;
"""

MEASURE = """
const p = document.querySelector(".archiver-panel");
if (!p || p.style.display === "none") return { panel: false };
const pr = p.getBoundingClientRect();
const hdrs = [...document.querySelectorAll("header")]
  .map(h => h.getBoundingClientRect()).filter(h => h.height && h.top <= 240);
const hb = hdrs.length ? Math.max(...hdrs.map(h => h.bottom)) : 0;
// Every bit of chrome that is actually visible in the top strip.
let worst = null;
for (const h of hdrs) {
  const overlapY = Math.min(pr.bottom, h.bottom) - Math.max(pr.top, h.top);
  const overlapX = Math.min(pr.right, h.right) - Math.max(pr.left, h.left);
  if (overlapY > 0 && overlapX > 0) worst = { overlapY: Math.round(overlapY), overlapX: Math.round(overlapX) };
}
const cards = [...document.querySelectorAll('[itemprop="itemListElement"]')]
  .map(c => c.getBoundingClientRect())
  .filter(c => c.width && c.height && c.left < pr.right);
const visible = cards.filter(c => c.bottom > hb + 1 && c.top < window.innerHeight);
// Cards can only show through in the band between the chrome and the panel's top
// edge. When the panel starts right at the chrome that band is empty, so nothing
// can peek no matter where the cards are.
// Ground truth beats rect arithmetic here: whatever sits above the panel may be
// Airbnb chrome legitimately covering the column. Hit-test the band instead and
// ask what the user would actually click on.
let uncovered = 0;
const bandTop = Math.max(hb, 0), bandBot = pr.top;
for (let y = Math.round(bandTop) + 2; y < bandBot - 1; y += 4) {
  for (const x of [pr.left + 30, (pr.left + pr.right) / 2, pr.right - 30]) {
    const hit = document.elementFromPoint(x, y);
    if (hit && hit.closest && hit.closest('[itemprop="itemListElement"]')) { uncovered++; }
  }
}

// The expanded search bar: position:absolute inside the header, hanging past the
// header's own bottom edge and reaching left across the results column. This is
// the thing that actually got covered, so measure it directly.
const sbtn = [...document.querySelectorAll("button")]
  .find(b => /^Search$/.test((b.textContent||"").trim()) && b.getBoundingClientRect().width > 40);
let searchBar = null, searchCovered = null;
if (sbtn) {
  let n = sbtn, best = sbtn;
  for (let i = 0; i < 12 && n; i++) { const r = n.getBoundingClientRect(); if (r.width > 500) { best = n; break; } n = n.parentElement; }
  const sr = best.getBoundingClientRect();
  searchBar = { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height),
                bottom: Math.round(sr.bottom) };
  const oy = Math.min(pr.bottom, sr.bottom) - Math.max(pr.top, sr.top);
  const ox = Math.min(pr.right, sr.right) - Math.max(pr.left, sr.left);
  searchCovered = (oy > 1 && ox > 1) ? { overlapX: Math.round(ox), overlapY: Math.round(oy) } : null;
}
return {
  panel: true,
  panelTop: Math.round(pr.top), panelBottom: Math.round(pr.bottom),
  panelLeft: Math.round(pr.left), panelRight: Math.round(pr.right),
  headerBottom: Math.round(hb),
  headerOverlap: worst,
  cardsVisible: visible.length,
  cardsPeekingAbovePanel: uncovered,
  searchBar, searchCovered,
  // In-flow mode: the panel took the card grid's place rather than covering it.
  inFlow: !p.classList.contains("archiver-panel-overlay"),
  position: getComputedStyle(p).position,
  mapLeft: (() => { const m = document.querySelector('[data-testid="map/GoogleMap"]')
                         || document.querySelector('[aria-roledescription="map"]');
                    return m ? Math.round(m.getBoundingClientRect().left) : null; })(),
};
"""

# The contract that matters once the panel is in flow: it may overlap Airbnb's
# chrome geometrically (the column scrolls under the sticky header, exactly as
# their own cards do) but it must never PAINT over it. Hit-test the chrome and
# assert nothing there resolves to the panel.
CHROME_ON_TOP = """
const p = document.querySelector(".archiver-panel");
if (!p) return { samples: 0, panelOnTop: 0 };
const pr = p.getBoundingClientRect();
const boxes = [...document.querySelectorAll("header")]
  .map(h => h.getBoundingClientRect()).filter(h => h.height && h.top <= 240);
// the expanded search bar hangs past the header, so include it explicitly
const sbtn = [...document.querySelectorAll("button")]
  .find(b => /^Search$/.test((b.textContent||"").trim()) && b.getBoundingClientRect().width > 40);
if (sbtn) {
  let n = sbtn, best = sbtn;
  for (let i = 0; i < 12 && n; i++) { const r = n.getBoundingClientRect(); if (r.width > 500) { best = n; break; } n = n.parentElement; }
  boxes.push(best.getBoundingClientRect());
}
let samples = 0, panelOnTop = 0;
for (const b of boxes) {
  for (let y = Math.max(b.top + 3, 1); y < b.bottom - 2 && y < window.innerHeight; y += 6) {
    for (let x = Math.max(b.left + 6, pr.left + 6); x < Math.min(b.right - 6, pr.right - 6); x += 40) {
      samples++;
      const el = document.elementFromPoint(x, y);
      if (el && p.contains(el)) panelOnTop++;
    }
  }
}
return { samples, panelOnTop };
"""

opts = Options()
opts.binary_location = FIREFOX
if "--headed" not in sys.argv:
    opts.add_argument("-headless")
opts.set_preference("intl.accept_languages", "en-US,en")

fails = []
def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("  " + str(detail) if detail else ""))
    if not cond:
        fails.append(name)

driver = webdriver.Firefox(options=opts)
try:
    driver.set_window_size(1600, 950)
    driver.set_page_load_timeout(120)
    driver.get(URL)
    time.sleep(12)

    css = (ROOT / "extension" / "content.css").read_text(encoding="utf-8")
    driver.execute_script("const s=document.createElement('style');s.textContent=arguments[0];document.head.appendChild(s);", css)
    driver.execute_script(STUB)
    n = driver.execute_script(SEED)
    print("seeded starred listings:", n)
    # filter.js's `const Filter` is function-scoped under execute_script; in the
    # real extension both files share one scope, so re-export it.
    driver.execute_script((ROOT / "extension" / "filter.js").read_text(encoding="utf-8")
                          + "\nwindow.Filter = Filter;")
    driver.execute_script((ROOT / "extension" / "content.js").read_text(encoding="utf-8"))
    # The panel appears on the next decorateAll tick, not on injection.
    for _ in range(20):
        if driver.execute_script("const p=document.querySelector('.archiver-panel');"
                                 "return !!p && p.style.display !== 'none';"):
            break
        time.sleep(1)
    else:
        print("panel never appeared; diagnosing:")
        print(json.dumps(driver.execute_script("""
          const p = document.querySelector(".archiver-panel");
          const m = document.querySelector('[data-testid="map/GoogleMap"]')
                 || document.querySelector('[aria-roledescription="map"]')
                 || document.querySelector('[aria-label="Map"]');
          const mr = m ? m.getBoundingClientRect() : null;
          return { panelInDom: !!p, display: p ? p.style.display : null,
                   mapFound: !!m, mapLeft: mr ? Math.round(mr.left) : null,
                   mapW: mr ? Math.round(mr.width) : null,
                   err: window.__archiverErr || null };
        """), indent=2))

    def state(label):
        m = driver.execute_script(MEASURE)
        print(f"\n--- {label} ---")
        print(json.dumps(m, indent=2))
        return m

    m = state("as loaded")
    check("panel is showing", m.get("panel"), m)
    # The core contract: replace Airbnb's card grid, don't overlay it.
    check("panel is in flow, not a fixed overlay", m.get("inFlow"), m.get("position"))
    check("panel sits in the column (map keeps its width)",
          m.get("mapLeft") is not None and m["mapLeft"] > 40, m.get("mapLeft"))
    check("Airbnb's own cards are hidden, not covered", m.get("cardsVisible") == 0,
          m.get("cardsVisible"))
    def chrome_check(label):
        c = driver.execute_script(CHROME_ON_TOP)
        check(f"{label}: panel never paints over Airbnb's chrome",
              c["samples"] > 0 and c["panelOnTop"] == 0, c)

    if m.get("panel"):
        chrome_check("as loaded")
        check("panel starts at or below the chrome", m["panelTop"] >= m["headerBottom"],
              f'top={m["panelTop"]} headerBottom={m["headerBottom"]}')

    driver.execute_script("window.scrollTo(0, 600);")
    time.sleep(2)
    m = state("scrolled down 600px")
    if m.get("panel"):
        # In flow the column scrolls UNDER the sticky header, so overlapping it is
        # correct and expected -- what must hold is that the header paints on top.
        chrome_check("scrolled")

    driver.execute_script("window.scrollTo(0, 0);")
    time.sleep(1)
    # Clicking the collapsed search pill is what actually expands the search bar
    # (the nav tab is a <span role="tab"> reading "HomesHomes" and expands nothing
    # measurable). The expanded bar is position:absolute inside the header and
    # hangs past its bottom edge -- header height stays 152 either way.
    clicked = driver.execute_script("""
      const b = document.querySelector('[data-testid="little-search-location"]');
      if (!b) return false; b.click(); return true;
    """)
    print("\nexpanded the search bar:", clicked)
    time.sleep(4)
    m = state("search bar expanded")
    check("the search bar actually expanded", bool(m.get("searchBar")), m.get("searchBar"))
    if m.get("panel"):
        # This is the regression the user reported twice: first the search bar
        # itself, then the "Recent searches" dropdown that opens under it.
        chrome_check("expanded")
        check("expanded: panel starts at or below the chrome", m["panelTop"] >= m["headerBottom"],
              f'top={m["panelTop"]} headerBottom={m["headerBottom"]}')

    # The dropdown that opens under the search bar hangs well down the page, over
    # where the panel lives. It must win there too.
    drop = driver.execute_script("""
      const p = document.querySelector(".archiver-panel");
      const pr = p.getBoundingClientRect();
      // find a popover-looking box that overlaps the panel horizontally
      let best = null;
      for (const el of document.querySelectorAll("div,section,ul")) {
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 80) continue;
        if (r.top < 150 || r.top > 400) continue;
        if (r.left > pr.right || r.right < pr.left) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== "absolute" && cs.position !== "fixed") continue;
        if (p.contains(el)) continue;
        if (!best || r.top < best.r.top) best = { el, r };
      }
      if (!best) return null;
      const r = best.r;
      const pts = [];
      for (let y = r.top + 8; y < Math.min(r.bottom - 8, window.innerHeight - 2); y += 20) {
        const x = Math.max(r.left + 20, pr.left + 20);
        if (x > Math.min(r.right, pr.right) - 10) continue;
        const hit = document.elementFromPoint(x, y);
        pts.push(hit && p.contains(hit) ? "panel" : "airbnb");
      }
      return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
               pts, panelWins: pts.filter(v => v === "panel").length };
    """)
    print("\ndropdown over panel:", json.dumps(drop))
    if drop and drop["pts"]:
        check("the search dropdown paints over the panel", drop["panelWins"] == 0, drop)
    # chromeBottom() walks the header subtree on the 700ms backstop; make sure
    # that is cheap enough to run at that cadence.
    perf = driver.execute_script("""
      const hdrs = [...document.querySelectorAll("header")];
      let nodes = 0; for (const h of hdrs) nodes += h.querySelectorAll("*").length;
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        for (const h of hdrs) {
          const cr = h.getBoundingClientRect();
          for (const k of h.querySelectorAll("*")) { const kr = k.getBoundingClientRect(); if (kr.bottom > cr.bottom + 200) continue; }
        }
      }
      return { headerNodes: nodes, msPerCall: (performance.now() - t0) / 20 };
    """)
    print("\nchromeBottom cost:", json.dumps(perf))
    check("header scan is cheap enough for a 700ms tick", perf["msPerCall"] < 12,
          f'{perf["msPerCall"]:.2f}ms over {perf["headerNodes"]} nodes')
finally:
    driver.quit()

print("\n" + ("ALL PASS" if not fails else "FAILED: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
