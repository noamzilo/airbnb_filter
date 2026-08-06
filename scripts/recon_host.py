# Recon for "host name + link to the chat":
#   1. Does the /rooms/<id> page expose the HOST's name (and id)?
#   2. What does /guest/messages/<threadId> expose, and does it need a login?
# Uses the user's example pair:
#   chat https://www.airbnb.com/guest/messages/2594090111
#   room https://www.airbnb.com/rooms/1239210296375530793

import time, json, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOM = "1239210296375530793"
THREAD = "2594090111"

FETCH = r"""
const done = arguments[arguments.length - 1];
const url = arguments[0], patterns = arguments[1];
(async () => {
  let res, text;
  try { res = await fetch(url, {credentials: 'same-origin'}); text = await res.text(); }
  catch (e) { return done({url, error: e.message}); }
  const out = {url, status: res.status, finalUrl: res.url, bytes: text.length, hits: {}, blobs: 0};
  const doc = new DOMParser().parseFromString(text, 'text/html');
  out.title = (doc.querySelector('title') || {}).textContent;
  out.loginWall = /log in|sign up/i.test(out.title || '') || /"loginRequired"|\/login/.test(text.slice(0, 5000));
  for (const p of patterns) {
    const re = new RegExp('"' + p + '"\\s*:\\s*("[^"]{0,80}"|\\{[^}]{0,120}\\}|\\d+)', 'g');
    const m = text.match(re);
    if (m) out.hits[p] = [...new Set(m)].slice(0, 4);
  }
  for (const s of doc.querySelectorAll('script[id^="data-deferred-state"], script[type="application/json"]')) out.blobs++;
  done(out);
})();
"""

PATTERNS = ["hostName", "host_name", "smartName", "hostId", "host_id", "userId",
            "listingId", "listing_id", "threadId", "thread_id", "name",
            "hostAvatar", "primaryHost", "hostPassportName"]

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
d.set_script_timeout(90)
try:
    d.get("https://www.airbnb.com/")
    time.sleep(3)
    for label, url in [
        ("ROOM ", f"https://www.airbnb.com/rooms/{ROOM}"),
        ("CHAT ", f"https://www.airbnb.com/guest/messages/{THREAD}"),
    ]:
        r = d.execute_async_script(FETCH, url, PATTERNS)
        print(f"=== {label} {url}")
        for k in ("error", "status", "finalUrl", "bytes", "title", "loginWall", "blobs"):
            if k in r: print(f"   {k}: {r[k]}")
        for k, v in (r.get("hits") or {}).items():
            print(f"   HIT {k}: {v}")
        print()
finally:
    d.quit()
