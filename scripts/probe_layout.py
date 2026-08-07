# Measure Airbnb's NATIVE search-page geometry (no extension), so the panel can
# be sized to the real results column instead of guessing an offset from the map.
#
#   python scripts/probe_layout.py [--headed]
#
# Measures twice: as loaded, and again after clicking the "Homes" nav tab (which
# expands the search bar and pushes the whole results column down -- the state
# where a fixed-offset panel covers the search bar).

import sys, json, time, pathlib
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
URL = ("https://www.airbnb.com/s/Tel-Aviv--Israel/homes"
       "?checkin=2026-10-13&checkout=2026-11-12&adults=1")

MEASURE = r"""
const q = (s) => document.querySelector(s);
const map = q('[data-testid="map/GoogleMap"]') || q('[aria-roledescription="map"]');
const cards = [...document.querySelectorAll('[itemprop="itemListElement"]')];
const rects = cards.map(c => c.getBoundingClientRect()).filter(r => r.width && r.height);
const top = rects.length ? Math.min(...rects.map(r => r.top)) : null;
const left = rects.length ? Math.min(...rects.map(r => r.left)) : null;
const right = rects.length ? Math.max(...rects.map(r => r.right)) : null;
const header = q("header");
const mr = map ? map.getBoundingClientRect() : null;
return {
  innerH: window.innerHeight, innerW: window.innerWidth,
  scrollY: window.scrollY,
  headerBottom: header ? Math.round(header.getBoundingClientRect().bottom) : null,
  headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
  cardCount: cards.length,
  cardsTop: top === null ? null : Math.round(top),
  cardsLeft: left === null ? null : Math.round(left),
  cardsRight: right === null ? null : Math.round(right),
  mapTop: mr ? Math.round(mr.top) : null,
  mapLeft: mr ? Math.round(mr.left) : null,
  mapBottom: mr ? Math.round(mr.bottom) : null,
  // what the current code would compute
  currentPanelTop: mr ? Math.max(56, Math.round(mr.top - 96)) : null,
};
"""

opts = Options()
opts.binary_location = FIREFOX
if "--headed" not in sys.argv:
    opts.add_argument("-headless")
opts.set_preference("intl.accept_languages", "en-US,en")

driver = webdriver.Firefox(options=opts)
try:
    driver.set_window_size(1600, 950)
    driver.set_page_load_timeout(120)
    driver.get(URL)
    time.sleep(12)
    print("as loaded:")
    print(json.dumps(driver.execute_script(MEASURE), indent=2))

    # Click the "Homes" nav tab -> expands the search bar, pushes content down.
    clicked = driver.execute_script("""
      const hdr = document.querySelector("header") || document.body;
      const t = [...hdr.querySelectorAll('a,button,[role=tab],[role=link],div[role=button],span')]
        .find(e => /^Homes$/.test((e.textContent||"").trim())
                   && e.getBoundingClientRect().width > 20
                   && e.getBoundingClientRect().top < 140);
      if (!t) return false;
      t.scrollIntoView({block:"center"});
      t.click();
      return true;
    """)
    print("clicked Homes tab:", clicked)
    time.sleep(6)
    print("after expanding the search bar:")
    print(json.dumps(driver.execute_script(MEASURE), indent=2))
finally:
    driver.quit()
