# Recon: is there a listing -> conversation URL that does NOT require knowing the
# thread id? Logged out everything needs auth, but the REDIRECT TARGET still tells
# us whether a route exists: /login?redirect_url=<route> means Airbnb recognised
# it, a 404 means it does not exist.

import time, json, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOM = "1239210296375530793"
THREAD = "2594090111"
HOST = "51004266"

CANDIDATES = [
    f"/contact_host/{ROOM}/send_message",
    f"/rooms/{ROOM}/contact_host",
    f"/guest/messages/{THREAD}",
    "/guest/messages",
    "/hosting/messages",
    f"/messaging/thread/{THREAD}",
    f"/users/show/{HOST}",
]

PROBE = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const out = [];
  for (const p of arguments[0]) {
    try {
      const r = await fetch(location.origin + p, {credentials: 'same-origin', redirect: 'follow'});
      const t = await r.text();
      const doc = new DOMParser().parseFromString(t, 'text/html');
      const title = ((doc.querySelector('title') || {}).textContent || '').slice(0, 60);
      let redirectTo = null;
      try { redirectTo = decodeURIComponent(new URL(r.url).searchParams.get('redirect_url') || '') || null; } catch (e) {}
      out.push({path: p, status: r.status, finalPath: new URL(r.url).pathname, redirectTo, title, bytes: t.length});
    } catch (e) { out.push({path: p, error: e.message}); }
  }
  done(out);
})();
"""

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
d.set_script_timeout(180)
try:
    d.get("https://www.airbnb.com/")
    time.sleep(3)
    for r in d.execute_async_script(PROBE, CANDIDATES):
        if "error" in r:
            print(f"{r['path']:<45} ERROR {r['error']}")
            continue
        verdict = ("EXISTS (auth required)" if r["redirectTo"]
                   else "404 / unknown" if r["status"] == 404 or "not found" in (r["title"] or "").lower()
                   else f"status {r['status']}")
        print(f"{r['path']:<45} {verdict}")
        print(f"{'':<45}   -> {r['finalPath']}  redirect_url={r['redirectTo']}  title={r['title']!r}")
finally:
    d.quit()
