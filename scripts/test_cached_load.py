# Does the interceptor survive a CACHED document load?
#
#   python scripts/test_cached_load.py [--headed]
#
# repro_broken_page.py always ran against a fresh temp profile, so every load was
# a network load -- it never exercised the path where Firefox serves the document
# out of its own HTTP cache. That matters: if the stream filter hands us encoded
# (still-gzipped) bytes on a cache read, decoding them as UTF-8 and re-encoding
# the result destroys the document, which is exactly the observed corruption.
#
# Loads the same URL three times in one profile -- cold, warm, and after a
# same-URL renavigation -- and asserts the document is intact every time.

import sys, os, shutil, pathlib, json, tempfile, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
SRC = pathlib.Path(os.environ["APPDATA"]) / "Mozilla/Firefox/Profiles/axoocsbc.default-release"
URL = ("https://www.airbnb.com/s/Jerusalem-District--Israel/homes"
       "?place_id=ChIJI57rru3EAhURPVFStGthoUw&refinement_paths%5B%5D=%2Fhomes"
       "&checkin=2026-10-13&checkout=2026-10-18&adults=1")

KEEP_FILES = ["cookies.sqlite", "prefs.js", "extensions.json", "addons.json",
              "extension-settings.json", "extension-preferences.json",
              "permissions.sqlite", "cert9.db", "key4.db"]
KEEP_DIRS = ["extensions", "storage", "browser-extension-data"]

tmp = pathlib.Path(tempfile.mkdtemp(prefix="ffcache-"))
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
# Make the disk cache real and eager, so the second load genuinely comes from it.
opts.set_preference("browser.cache.disk.enable", True)
opts.set_preference("browser.cache.memory.enable", True)

PROBE = r"""
const bodyText = document.body ? document.body.innerText : "";
return {
  title: document.title,
  htmlLen: document.documentElement.outerHTML.length,
  stylesheets: document.styleSheets.length,
  roomLinks: document.querySelectorAll('a[href*="/rooms/"]').length,
  // the corruption signatures seen on screen
  classSoup: /atm_[a-z0-9_]{4,}\s+atm_[a-z0-9_]{4,}/.test(bodyText),
  replacementChars: (document.documentElement.outerHTML.match(/\uFFFD/g) || []).length,
  bodyHead: bodyText.slice(0, 120),
};
"""

fails = []
def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (("  " + str(detail)) if detail else ""))
    if not cond: fails.append(name)

driver = webdriver.Firefox(options=opts)
try:
    driver.set_page_load_timeout(120)
    for label in ["cold (network)", "warm (may hit cache)", "renavigate"]:
        driver.get(URL)
        time.sleep(10)
        r = driver.execute_script(PROBE)
        print(f"\n--- {label} ---")
        print(json.dumps(r, indent=2))
        check(f"{label}: page has stylesheets", r["stylesheets"] > 3, r["stylesheets"])
        check(f"{label}: no class-name soup in body", not r["classSoup"])
        check(f"{label}: no replacement chars (mojibake)", r["replacementChars"] == 0,
              r["replacementChars"])
        check(f"{label}: listings rendered", r["roomLinks"] > 10, r["roomLinks"])
        if label == "cold (network)":
            driver.get("about:blank"); time.sleep(1)
finally:
    driver.quit()
    shutil.rmtree(tmp, ignore_errors=True)

print("\n" + ("ALL PASS" if not fails else "FAILED: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
