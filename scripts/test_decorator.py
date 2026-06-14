# End-to-end test of the decorator against the LIVE Airbnb DOM.
# Injects the real content.js with an in-memory Store/browser stub, drives the
# star / maybe / trash rubric, and asserts DOM + store outcomes. Text only.

import time, pathlib, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true")

STUB = r"""
window.__cats = { starred:{}, maybe:{}, archived:{} };
window.__settings = { showArchived:false };
window.__ls = [];
const fire = () => window.__ls.forEach(f => { try { f(); } catch(e){} });
const CATS = ["starred","maybe","archived"];
window.browser = { storage: { onChanged: { addListener: f => window.__ls.push(f) } } };
window.Store = {
  getAll: async () => window.__cats,
  getStarred: async () => window.__cats.starred,
  getMaybe: async () => window.__cats.maybe,
  getArchived: async () => window.__cats.archived,
  getCategory: async (id) => { for (const c of CATS) if (window.__cats[c][id]) return c; return null; },
  setCategory: async (id, snap, cat) => { for (const c of CATS) delete window.__cats[c][id]; if (cat) window.__cats[cat][id] = {...(snap||{}), ts:1}; fire(); },
  getStarredData: async () => ({}), setStarredData: async () => {},
  getSettings: async () => window.__settings,
  setSetting: async (k,v) => { window.__settings[k]=v; fire(); },
};
"""

opts = Options()
opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless")
opts.set_preference("intl.accept_languages", "en-US,en")

results = []
def check(label, cond, extra=""):
    results.append(bool(cond))
    print(("PASS" if cond else "FAIL") + "  " + label + (("  " + extra) if extra else ""), flush=True)

d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1400, 950)
    d.get(URL)
    for _ in range(45):
        if d.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length'): break
        time.sleep(1)
    for _ in range(25):
        nm = d.execute_script("return document.querySelectorAll('gmp-advanced-marker').length")
        if nm: break
        time.sleep(1)
    print("markers present:", nm, flush=True)

    d.execute_script(STUB)
    d.execute_script(CONTENT)
    time.sleep(1.5)

    check("side cards get action toolbars", d.execute_script("return document.querySelectorAll('.archiver-actions').length") > 0)

    # Star a side card
    d.execute_script("const b=document.querySelector('.archiver-actions .archiver-star'); b&&b.click();")
    time.sleep(0.4)
    check("clicking star adds to Liked", d.execute_script("return Object.keys(window.__cats.starred).length") >= 1)

    # Maybe on the SAME card -> moves out of starred (mutual exclusivity)
    d.execute_script("const b=document.querySelector('.archiver-actions .archiver-maybe'); b&&b.click();")
    time.sleep(0.4)
    moved = d.execute_script("return Object.keys(window.__cats.starred).length===0 && Object.keys(window.__cats.maybe).length>=1")
    check("maybe replaces star (mutually exclusive)", moved,
          f"star={d.execute_script('return Object.keys(window.__cats.starred).length')} maybe={d.execute_script('return Object.keys(window.__cats.maybe).length')}")

    # Open a map popup card and trash it
    marker = d.execute_script("return [...document.querySelectorAll('gmp-advanced-marker')].filter(m=>/[$€£₲]/.test(m.textContent||''))[0]||null;")
    ActionChains(d).move_to_element(marker).pause(0.3).click(marker).perform()
    time.sleep(2.4)
    check("map popup card gets a trash control", d.execute_script("return document.querySelectorAll('.archiver-actions--map').length") > 0)

    clicked = d.execute_script("""
      const t = document.querySelector('.archiver-actions--map .archiver-trash');
      if (!t) return false;
      const card = t.closest('[data-archiver-id]') || t.parentElement.parentElement;
      if (card) card.setAttribute('data-archiver-test','1');
      t.click(); return true;
    """)
    check("map trash present + clicked", clicked)
    time.sleep(0.6)
    check("clicked map card hidden", d.execute_script("""
      const c=document.querySelector('[data-archiver-test="1"]'); if(!c) return false;
      return c.getBoundingClientRect().width===0 || c.offsetParent===null || getComputedStyle(c).display==='none';
    """))
    check("a map marker was hidden", d.execute_script("return [...document.querySelectorAll('gmp-advanced-marker')].filter(m=>m.style.display==='none').length") >= 1)
    check("undo toast with progress bar", d.execute_script("return !!document.querySelector('.archiver-toast') && !!document.querySelector('.archiver-progress-fill')"))

    time.sleep(1.7)  # past the 1.5s undo window
    check("commits to Archived after undo window", d.execute_script("return Object.keys(window.__cats.archived).length") >= 1)

    # Persistent re-hide by coordinate after a marker re-render
    d.execute_script("document.querySelectorAll('gmp-advanced-marker').forEach(m=>m.style.display=''); document.body.appendChild(document.createElement('span'));")
    time.sleep(0.6)
    coord = d.execute_script("return Object.values(window.__cats.archived)[0].coord;")
    check("archived marker re-hidden after re-render (by coord)", d.execute_script("""
      const c=arguments[0]; const ms=[...document.querySelectorAll('gmp-advanced-marker')].filter(m=>m.getAttribute('position')===c);
      return ms.length>0 && ms.every(m=>m.style.display==='none');
    """, coord), f"coord={coord}")

    # Regression: a different (non-archived) pill's popup must NOT vanish
    other = d.execute_script("""
      const a=Object.values(window.__cats.archived)[0].coord;
      return [...document.querySelectorAll('gmp-advanced-marker')].find(m=>m.getAttribute('position')&&m.getAttribute('position')!==a&&m.style.display!=='none'&&/[$€£₲]/.test(m.textContent||''))||null;
    """)
    if other:
        ActionChains(d).move_to_element(other).pause(0.3).click(other).perform()
        time.sleep(1.2)
        check("a different pill stays visible after opening", d.execute_script("return arguments[0].style.display!=='none';", other))

    print("\n" + ("ALL PASS" if all(results) else "SOME FAILED"), flush=True)
finally:
    d.quit()
