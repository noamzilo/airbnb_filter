# Do documents survive being loaded AT BROWSER STARTUP?
#
#   python scripts/test_startup_load.py [--headed] [--tabs N]
#
# Both real-world corruptions happened on a tab that loaded while Firefox was
# starting (session restore right after an add-on upgrade). Every other harness
# here navigates a browser that is already up, with the background script long
# since initialized -- so none of them exercise the race where several main_frame
# requests are buffered by an interceptor that is still starting.
#
# This opens the search URLs as command-line tabs, so their document requests are
# in flight as the extension boots, then asserts every tab parsed intact.

import sys, os, shutil, pathlib, json, tempfile, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
SRC = pathlib.Path(os.environ["APPDATA"]) / "Mozilla/Firefox/Profiles/axoocsbc.default-release"
BASE = ("https://www.airbnb.com/s/Jerusalem-District--Israel/homes"
        "?place_id=ChIJI57rru3EAhURPVFStGthoUw&refinement_paths%5B%5D=%2Fhomes"
        "&checkin=2026-10-13&checkout=2026-10-18&adults=")

tabs = 3
if "--tabs" in sys.argv: tabs = int(sys.argv[sys.argv.index("--tabs") + 1])
URLS = [BASE + str(i + 1) for i in range(tabs)]

KEEP_FILES = ["cookies.sqlite", "prefs.js", "extensions.json", "addons.json",
              "extension-settings.json", "extension-preferences.json",
              "permissions.sqlite", "cert9.db", "key4.db"]
KEEP_DIRS = ["extensions", "storage", "browser-extension-data"]

tmp = pathlib.Path(tempfile.mkdtemp(prefix="ffstartup-"))
for f in KEEP_FILES:
    if (SRC / f).exists(): shutil.copy2(SRC / f, tmp / f)
for d in KEEP_DIRS:
    if (SRC / d).is_dir():
        shutil.copytree(SRC / d, tmp / d, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.lock", "parent.lock"))

opts = Options()
opts.binary_location = FIREFOX
opts.add_argument("-profile"); opts.add_argument(str(tmp))
if "--headed" not in sys.argv: opts.add_argument("-headless")
opts.set_preference("intl.accept_languages", "en-US,en")
opts.set_preference("extensions.autoDisableScopes", 0)
# Hand Firefox the URLs on the command line: their requests race the add-on's
# startup, which is the condition session restore creates.
for u in URLS:
    opts.add_argument("-new-tab"); opts.add_argument(u)

PROBE = r"""
const bodyText = document.body ? document.body.innerText : "";
return {
  url: location.href.slice(-14),
  htmlLen: document.documentElement.outerHTML.length,
  stylesheets: document.styleSheets.length,
  roomLinks: document.querySelectorAll('a[href*="/rooms/"]').length,
  classSoup: /atm_[a-z0-9_]{4,}\s+atm_[a-z0-9_]{4,}/.test(bodyText),
  replacementChars: (document.documentElement.outerHTML.match(/\uFFFD/g) || []).length,
  // "Superhost" alone in the body with no stylesheets is the unstyled-card look
  intact: document.styleSheets.length > 3 && !/atm_[a-z0-9_]{4,}\s+atm_/.test(bodyText),
};
"""

fails = []
def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (("  " + str(detail)) if detail else ""))
    if not cond: fails.append(name)

driver = webdriver.Firefox(options=opts)
try:
    time.sleep(20)   # let every startup tab finish loading
    handles = driver.window_handles
    print(f"tabs open: {len(handles)}")
    checked = 0
    for h in handles:
        driver.switch_to.window(h)
        if "airbnb.com" not in driver.current_url:
            continue
        r = driver.execute_script(PROBE)
        print(json.dumps(r))
        checked += 1
        check(f"tab {r['url']}: document intact", r["intact"],
              f'sheets={r["stylesheets"]} soup={r["classSoup"]}')
        check(f"tab {r['url']}: no mojibake", r["replacementChars"] == 0, r["replacementChars"])
        check(f"tab {r['url']}: listings rendered", r["roomLinks"] > 10, r["roomLinks"])
    check("at least one Airbnb tab was checked", checked > 0, checked)
finally:
    driver.quit()
    shutil.rmtree(tmp, ignore_errors=True)

print("\n" + ("ALL PASS" if not fails else "FAILED: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
