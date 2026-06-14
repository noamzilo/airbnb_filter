# Live DOM recon for the map: find a price pill, real-click it to open the popup
# card, then dump the card's structure (ancestors, close button, prices, /rooms
# link). No extension needed. Compact text output only.

import time, json, pathlib
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes"
       "?checkin=2026-07-03&checkout=2026-07-17&adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60"
       "&zoom=15&search_by_map=true")

PILLS = """
const map = document.querySelector('[data-testid="map/GoogleMap"]')
  || document.querySelector('[aria-roledescription="map"]');
const mr = map.getBoundingClientRect();
window.__pills = [...map.querySelectorAll('button,[role=button],div,span')].filter(e => {
  const t = e.textContent || '';
  if (!/[$€£₲]/.test(t)) return false;
  const r = e.getBoundingClientRect();
  const cx=r.left+r.width/2, cy=r.top+r.height/2;
  return r.width>20 && r.width<170 && r.height>14 && r.height<64
      && cx>=mr.left && cx<=mr.right && cy>=mr.top && cy<=mr.bottom;
});
"""

opts = Options()
opts.binary_location = FIREFOX
opts.add_argument("-headless")
opts.set_preference("intl.accept_languages", "en-US,en")

d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1400, 950)
    d.get(URL)
    for _ in range(45):
        if d.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length'):
            break
        time.sleep(1)

    n = 0
    for _ in range(25):
        n = d.execute_script(PILLS + "return window.__pills.length;")
        if n:
            break
        time.sleep(1)
    print("pills over map:", n, flush=True)
    if not n:
        raise SystemExit("no pills")

    # Real-click the first pill to open its popup card.
    pill = d.execute_script("const p=window.__pills[0]; return p.closest('button,[role=button]')||p;")
    print("pill[0] outerHTML:", d.execute_script("return arguments[0].outerHTML.slice(0,260);", pill), flush=True)
    print("pill[0] has /rooms ancestor link:", d.execute_script(
        "return !!arguments[0].closest('a[href*=\"/rooms/\"]') || (function(n){for(let i=0;i<6&&n;i++,n=n.parentElement){if(n.querySelector&&n.querySelector('a[href*=\"/rooms/\"]'))return true;}return false;})(arguments[0]);",
        pill), flush=True)

    ActionChains(d).move_to_element(pill).pause(0.3).click(pill).perform()
    time.sleep(2)

    info = d.execute_script("""
      const map = document.querySelector('[data-testid="map/GoogleMap"]') || document.querySelector('[aria-roledescription="map"]');
      const mr = map.getBoundingClientRect();
      const overMap = el => { const r=el.getBoundingClientRect(); const cx=r.left+r.width/2,cy=r.top+r.height/2;
        return r.width&&cx>=mr.left&&cx<=mr.right&&cy>=mr.top&&cy<=mr.bottom; };
      // the popup card: a /rooms link now sitting over the map
      const link = [...document.querySelectorAll('a[href*="/rooms/"]')].find(overMap);
      const out = { popupCardFound: !!link, href: link ? link.getAttribute('href').split('?')[0] : null };
      if (link) {
        let n = link, chain = [];
        for (let i=0;i<11&&n;i++,n=n.parentElement){
          const r=n.getBoundingClientRect();
          chain.push(`[${i}] <${n.tagName.toLowerCase()}${n.className?(' class="'+String(n.className).slice(0,40)+'"'):''}> ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        out.ancestors = chain;
        const root = (function(a){let el=a,best=a;for(let i=0;i<12&&el.parentElement;i++){const r=el.getBoundingClientRect();if(r.width>0&&r.width<460&&r.height>0&&r.height<460)best=el;else if(r.width>=460||r.height>=460)break;el=el.parentElement;}return best;})(link);
        const rr = root.getBoundingClientRect();
        out.geomRoot = `${root.tagName.toLowerCase()} ${Math.round(rr.width)}x${Math.round(rr.height)}`;
      }
      out.closeButtons = [...document.querySelectorAll('button[aria-label]')]
        .filter(b => /close|cerrar|dismiss/i.test(b.getAttribute('aria-label')) && overMap(b))
        .map(b => b.getAttribute('aria-label'));
      // price leaves over map
      out.prices = [...document.querySelectorAll('span,div')]
        .filter(e => e.children.length===0 && /[$€£₲]/.test(e.textContent) && overMap(e))
        .slice(0,6)
        .map(e => ({ t: e.textContent.trim().slice(0,24), strike: /line-through/.test(getComputedStyle(e).textDecorationLine||'') }));
      return out;
    """)
    print("POPUP RECON:\n" + json.dumps(info, indent=2, ensure_ascii=False)[:4000], flush=True)
finally:
    d.quit()
