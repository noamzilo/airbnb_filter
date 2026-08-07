# Launch Firefox on a COPY of the real profile, so pages that need a login
# (/guest/messages) can be driven. The original profile is only ever read.
# Shared by scripts/recon_thread_layout.py and scripts/test_thread_bar.py;
# repro_broken_page.py has its own copy that also brings the installed add-on.

import os, shutil, pathlib, tempfile

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
SRC = pathlib.Path(os.environ["APPDATA"]) / "Mozilla/Firefox/Profiles/axoocsbc.default-release"

# Just enough for a logged-in session; no caches, no add-ons (the scripts inject
# content.js themselves, which is how every other test exercises it).
KEEP_FILES = ["cookies.sqlite", "prefs.js", "permissions.sqlite", "cert9.db", "key4.db",
              "logins.json", "containers.json", "search.json.mozlz4"]
KEEP_DIRS = ["storage"]


# extensions=True also brings the installed add-on across, so Firefox starts it
# normally (background script and all) instead of the scripts injecting it.
EXT_FILES = ["extensions.json", "addons.json", "extension-settings.json",
             "extension-preferences.json"]
EXT_DIRS = ["extensions", "browser-extension-data", "extension-store", "extension-store-menus"]


def copy_profile(prefix="ffcopy-", extensions=False):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix=prefix))
    for f in KEEP_FILES + (EXT_FILES if extensions else []):
        p = SRC / f
        if p.exists():
            shutil.copy2(p, tmp / f)
    for d in KEEP_DIRS + (EXT_DIRS if extensions else []):
        p = SRC / d
        if p.is_dir():
            shutil.copytree(p, tmp / d, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("*.lock", "parent.lock"))
    return tmp


def firefox_on_copy(tmp, headless=True, width=1500, height=1000):
    from selenium import webdriver
    from selenium.webdriver.firefox.options import Options
    opts = Options()
    opts.binary_location = FIREFOX
    if headless:
        opts.add_argument("-headless")
    opts.add_argument("-profile"); opts.add_argument(str(tmp))
    opts.set_preference("intl.accept_languages", "en-US,en")
    d = webdriver.Firefox(options=opts)
    d.set_window_size(width, height)
    return d


# The inbox rows are click handlers, not links, so the first thread is opened by
# clicking. Returns the thread URL, or None.
def open_first_thread(d, time_mod):
    d.get("https://www.airbnb.com/guest/messages")
    time_mod.sleep(8)
    d.execute_script(r"""
      const el = document.querySelector('[aria-label^="Conversation with"]')
        || [...document.querySelectorAll('[role="listitem"],li')].find(e=>e.getBoundingClientRect().height>60);
      if (el) (el.querySelector('a,button,[role="button"]') || el).click();
    """)
    for _ in range(20):
        time_mod.sleep(1)
        if "/guest/messages/" in d.current_url and d.current_url.rstrip("/").split("/")[-1].isdigit():
            return d.current_url
    return None
