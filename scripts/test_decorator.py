# End-to-end test of the decorator against the LIVE Airbnb DOM.
# The extension won't auto-load under Selenium, so we inject the real content.js
# with an in-memory Store/browser stub, then drive the actual flows and assert
# DOM outcomes. Output is compact text — no screenshots.

import time, json, pathlib, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true")

STUB = r"""
window.__arch = {}; window.__star = {}; window.__set = { showArchived:false }; window.__ls = [];
const fire = () => window.__ls.forEach(f => { try { f(); } catch(e){} });
window.browser = { storage: { onChanged: { addListener: f => window.__ls.push(f) } } };
window.Store = {
  getArchived: async () => window.__arch,
  addArchived: async (id,s) => { window.__arch[id] = {...s, archivedAt:1}; fire(); },
  removeArchived: async (id) => { delete window.__arch[id]; fire(); },
  getStarred: async () => window.__star,
  addStarred: async (id,s) => { window.__star[id] = {...s}; fire(); },
  removeStarred: async (id) => { delete window.__star[id]; fire(); },
  getSettings: async () => window.__set,
  setSetting: async (k,v) => { window.__set[k]=v; fire(); },
};
"""

PILLS = """
const map = document.querySelector('[data-testid="map/GoogleMap"]');
window.__pills = [...document.querySelectorAll('gmp-advanced-marker')].filter(m=>/[$€£₲]/.test(m.textContent||''));
"""

opts = Options()
opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless")
opts.set_preference("intl.accept_languages", "en-US,en")

results = []
def check(label, cond, extra=""):
    results.append((bool(cond), label))
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

    # Inject stub + real content.js
    d.execute_script(STUB)
    d.execute_script(CONTENT)
    time.sleep(1.5)

    # 1) Side cards decorated
    actions = d.execute_script("return document.querySelectorAll('.archiver-actions').length")
    check("side cards get action toolbars", actions > 0, f"actions={actions}")

    # 2) Star a side card, assert it lands in the stub store
    d.execute_script("""
      const a = document.querySelector('.archiver-actions .archiver-star'); a && a.click();
    """)
    time.sleep(0.5)
    nstar = d.execute_script("return Object.keys(window.__star).length")
    check("clicking ☆ adds to Liked store", nstar >= 1, f"starred={nstar}")

    # 3) Open a map popup card (real click on a marker)
    d.execute_script(PILLS)
    marker = d.execute_script("return window.__pills[0] || null;")
    ActionChains(d).move_to_element(marker).pause(0.3).click(marker).perform()
    time.sleep(2)
    # decorateAll runs on mutation; give it a beat
    time.sleep(0.6)
    mapActions = d.execute_script("return document.querySelectorAll('.archiver-actions--map').length")
    check("map popup card gets a trash control", mapActions > 0, f"mapActions={mapActions}")

    # 4) Mark the specific map card, then click its trash
    clicked = d.execute_script("""
      const t = document.querySelector('.archiver-actions--map .archiver-trash');
      if (!t) return false;
      const card = t.closest('[data-archiver-id]') || t.parentElement.parentElement;
      if (card) card.setAttribute('data-archiver-test', '1');
      t.click();
      return true;
    """)
    check("map trash button present + clicked", clicked)
    time.sleep(0.6)

    # 5) That card is now hidden, a marker hidden, toast shown
    hiddenCard = d.execute_script("""
      const c = document.querySelector('[data-archiver-test="1"]');
      if (!c) return false;
      return c.getBoundingClientRect().width === 0 || c.offsetParent === null || getComputedStyle(c).display === 'none';
    """)
    check("clicked map card hidden (popup closed)", hiddenCard)
    hiddenMarkers = d.execute_script("return [...document.querySelectorAll('gmp-advanced-marker')].filter(m=>m.style.display==='none').length")
    check("a map marker was hidden", hiddenMarkers >= 1, f"hidden={hiddenMarkers}")
    toast = d.execute_script("return !!document.querySelector('.archiver-toast') && !!document.querySelector('.archiver-progress-fill')")
    check("undo toast with progress bar shown", toast)

    # 6) After the undo window, it commits to the archive store
    time.sleep(3.2)
    narch = d.execute_script("return Object.keys(window.__arch).length")
    check("commits to Archived after 3s", narch >= 1, f"archived={narch}")

    # 7) Persistent hide: simulate Google Maps re-creating markers, then poke the
    #    DOM to trigger decorateAll(); the archived marker must be re-hidden.
    d.execute_script("""
      document.querySelectorAll('gmp-advanced-marker').forEach(m => m.style.display = '');
      document.body.appendChild(document.createElement('span'));
    """)
    time.sleep(0.6)
    archCoord = d.execute_script("return Object.values(window.__arch)[0].coord;")
    stillHidden = d.execute_script("""
      const c = arguments[0];
      const ms = [...document.querySelectorAll('gmp-advanced-marker')].filter(m => m.getAttribute('position') === c);
      return ms.length > 0 && ms.every(m => m.style.display === 'none');
    """, archCoord)
    check("archived marker re-hidden after re-render (by coord)", stillHidden, f"coord={archCoord}")

    # 8) Regression: opening a DIFFERENT pill's popup must NOT get hidden by the
    #    archived one (titles like "Apartment in <area>" are not unique).
    other = d.execute_script("""
      const arch = Object.values(window.__arch)[0].coord;
      return [...document.querySelectorAll('gmp-advanced-marker')]
        .find(m => m.getAttribute('position') && m.getAttribute('position') !== arch
                && m.style.display !== 'none' && /[$€£₲]/.test(m.textContent||'')) || null;
    """)
    if other:
        from selenium.webdriver.common.action_chains import ActionChains as AC
        AC(d).move_to_element(other).pause(0.3).click(other).perform()
        time.sleep(1.2)
        otherStillVisible = d.execute_script("return arguments[0].style.display !== 'none';", other)
        check("a different (non-archived) pill stays visible after opening", otherStillVisible)

    print("\n" + ("ALL PASS" if all(ok for ok,_ in results) else "SOME FAILED"), flush=True)
finally:
    d.quit()
