# Reproduce a broken Airbnb search page against the REAL installed extension.
#
# Selenium's install_addon does not run background scripts, so the interceptor
# can't be exercised that way (see CLAUDE.md). Instead we launch Firefox on a
# COPY of the real profile: the add-on is already installed+enabled there, so
# Firefox starts it normally, background script and all. The original profile is
# only ever read.
#
#   python scripts/repro_broken_page.py "<url>" [--headed] [--no-ext]
#
# Prints, as text: document size, whether the parser broke (JSON payload of a
# <script type=application/json> leaking into body text), stylesheet count, and
# the extension's own console errors.

import sys, os, shutil, pathlib, json, tempfile
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
SRC = pathlib.Path(os.environ["APPDATA"]) / "Mozilla/Firefox/Profiles/axoocsbc.default-release"

# Everything needed for a logged-in run with add-ons; skip caches and the big stuff.
KEEP_FILES = ["cookies.sqlite", "prefs.js", "extensions.json", "addons.json",
              "extension-settings.json", "extension-preferences.json",
              "permissions.sqlite", "cert9.db", "key4.db", "logins.json",
              "containers.json", "handlers.json", "search.json.mozlz4"]
KEEP_DIRS = ["extensions", "storage", "browser-extension-data", "extension-store",
             "extension-store-menus"]

url = next((a for a in sys.argv[1:] if a.startswith("http")), None)
if not url:
    sys.exit("usage: repro_broken_page.py <url> [--headed] [--no-ext]")
headed = "--headed" in sys.argv
no_ext = "--no-ext" in sys.argv

tmp = pathlib.Path(tempfile.mkdtemp(prefix="ffrepro-"))
print(f"copying profile -> {tmp}", flush=True)
for f in KEEP_FILES:
    p = SRC / f
    if p.exists():
        shutil.copy2(p, tmp / f)
for d in KEEP_DIRS:
    p = SRC / d
    if p.is_dir():
        shutil.copytree(p, tmp / d, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.lock", "parent.lock"))

if no_ext:
    x = tmp / "extensions" / "airbnb-archiver@noam.local.xpi"
    if x.exists():
        x.unlink()
        print("removed the archiver xpi from the copy (control run)", flush=True)

opts = Options()
opts.binary_location = FIREFOX
opts.add_argument("-profile")
opts.add_argument(str(tmp))
if not headed:
    opts.add_argument("-headless")
opts.set_preference("intl.accept_languages", "en-US,en")
opts.set_preference("extensions.autoDisableScopes", 0)   # keep profile add-ons enabled
opts.set_preference("browser.sessionstore.resume_from_crash", False)
opts.set_preference("devtools.console.stdout.content", True)

PROBE = r"""
// Does any application/json payload leak into rendered body text? That is the
// signature of the HTML parser losing sync (class-name soup on screen).
const bodyText = document.body ? document.body.innerText : "";
const leak = /atm_[a-z0-9_]{4,}\s+atm_[a-z0-9_]{4,}/.test(bodyText);
const jsonScripts = [...document.querySelectorAll('script[type="application/json"]')];
let blob = null, blobOk = null;
const dsl = document.querySelector('script[id^="data-deferred-state-"]');
if (dsl) { blob = dsl.textContent.length; try { JSON.parse(dsl.textContent); blobOk = true; } catch (e) { blobOk = String(e).slice(0,120); } }
return {
  title: document.title,
  htmlLen: document.documentElement.outerHTML.length,
  stylesheets: document.styleSheets.length,
  jsonScripts: jsonScripts.length,
  deferredBlobLen: blob,
  deferredBlobParses: blobOk,
  bodyLeaksClassSoup: leak,
  bodyTextHead: bodyText.slice(0, 240),
  roomLinks: document.querySelectorAll('a[href*="/rooms/"]').length,
  archiverPanel: !!document.querySelector('.archiver-panel, #archiver-panel'),
};
"""

print("launching firefox...", flush=True)
driver = webdriver.Firefox(options=opts)
try:
    driver.set_page_load_timeout(120)
    driver.get(url)
    import time
    time.sleep(12)          # let hydration run
    res = driver.execute_script(PROBE)
    print(json.dumps(res, indent=2))
    out = pathlib.Path(tempfile.gettempdir()) / "repro_page.html"
    out.write_text(driver.page_source, encoding="utf-8")
    print("saved rendered DOM ->", out)
finally:
    driver.quit()
    shutil.rmtree(tmp, ignore_errors=True)
