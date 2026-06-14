# Drive Firefox with the extension loaded, run a JS probe, print compact JSON.
# No screenshots — everything comes back as text so it's cheap.
#
# Usage:
#   python scripts/drive.py                      # run built-in probe
#   python scripts/drive.py scripts/probe.js     # run a JS file (must `return` a value)
#   python scripts/drive.py scripts/probe.js --headed --click-pill 0
#
# --click-pill N : real-click the Nth map price pill before running the probe
#                  (opens Airbnb's popup card so the probe can inspect it).

import sys, json, time, pathlib
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
EXT = str(pathlib.Path(__file__).resolve().parent.parent / "extension")
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes"
       "?checkin=2026-07-03&checkout=2026-07-17&adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60"
       "&zoom=15&search_by_map=true")

args = sys.argv[1:]
headed = "--headed" in args
click_pill = None
if "--click-pill" in args:
    click_pill = int(args[args.index("--click-pill") + 1])
js_file = next((a for a in args if a.endswith(".js")), None)

PILL_FILTER = """
const map = document.querySelector('[data-testid="map/GoogleMap"]')
  || document.querySelector('[aria-roledescription="map"]');
const pills = map ? [...map.querySelectorAll('button,[role=button],div,span')].filter(e => {
  const t = e.textContent || '';
  if (!/[$€£₲]/.test(t)) return false;
  const r = e.getBoundingClientRect();
  return r.width > 20 && r.width < 170 && r.height > 14 && r.height < 64;
}) : [];
"""

BUILTIN_PROBE = PILL_FILTER + """
return {
  roomLinks: document.querySelectorAll('a[href*="/rooms/"]').length,
  injectedActions: document.querySelectorAll('.archiver-actions').length,
  hasMap: !!map,
  pillCount: pills.length,
  pillSample: pills[0] ? pills[0].outerHTML.slice(0, 400) : null,
};
"""

opts = Options()
opts.binary_location = FIREFOX
if not headed:
    opts.add_argument("-headless")
opts.set_preference("dom.webdriver.enabled", False)
opts.set_preference("intl.accept_languages", "en-US,en")

print("launching firefox (headless=%s)..." % (not headed), flush=True)
driver = webdriver.Firefox(options=opts)
try:
    try:
        addon_id = driver.install_addon(EXT, temporary=True)
        print("installed addon:", addon_id, flush=True)
    except Exception as e:
        print("INSTALL FAILED:", repr(e), flush=True)
    driver.set_page_load_timeout(60)
    print("navigating...", flush=True)
    try:
        driver.get(URL)
    except Exception as e:
        print("get() warning:", e, flush=True)

    # Wait for listing cards to render.
    n = 0
    for _ in range(45):
        n = driver.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length')
        if n > 0:
            break
        time.sleep(1)
    print("room links after wait:", n, flush=True)

    # Poll for the content-script load marker.
    loaded = None
    for _ in range(10):
        loaded = driver.execute_script("return document.documentElement.getAttribute('data-archiver-loaded')")
        if loaded:
            break
        time.sleep(0.5)
    print("content script loaded marker:", loaded, flush=True)

    if n == 0:
        body = driver.execute_script("return (document.body && document.body.innerText || '').slice(0, 400)")
        print("PAGE TEXT SNIPPET:\n", body, flush=True)

    if click_pill is not None:
        clicked = driver.execute_script(PILL_FILTER + """
          const p = pills[arguments[0]];
          if (!p) return false;
          p.scrollIntoView({block:'center'});
          (p.closest('button,[role=button]') || p).click();
          return true;
        """, click_pill)
        print("clicked pill #%s: %s" % (click_pill, clicked), flush=True)
        time.sleep(1.5)

    js = pathlib.Path(js_file).read_text(encoding="utf-8") if js_file else BUILTIN_PROBE
    result = driver.execute_script(js)
    print("PROBE RESULT:\n" + json.dumps(result, indent=2, ensure_ascii=False)[:6000], flush=True)
finally:
    driver.quit()
