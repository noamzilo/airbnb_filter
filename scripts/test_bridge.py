# Tests the listing <-> conversation bridge bar on a REAL /rooms/<id> page.
# (The thread side, /guest/messages/<id>, needs a logged-in session -- see
# scripts/recon_host.py, which shows it redirects to /login for a clean profile.)
#
#   python scripts/test_bridge.py

import time, pathlib, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from lib_stub import STUB          # was scraped out of test_decorator.py, which
                                   # stopped holding it when it moved to lib_stub
FILTER = (ROOT / "extension" / "filter.js").read_text(encoding="utf-8")
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
STYLES = (ROOT / "extension" / "content.css").read_text(encoding="utf-8")

ROOM = "1239210296375530793"   # the user's example apartment

results = []
def check(label, cond, extra=""):
    results.append(bool(cond))
    print(("PASS" if cond else "FAIL") + "  " + label + (("  " + extra) if extra else ""), flush=True)

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")
d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1400, 950)
    d.get(f"https://www.airbnb.com/rooms/{ROOM}")
    for _ in range(45):
        if d.execute_script("return document.readyState") == "complete": break
        time.sleep(1)
    time.sleep(3)
    d.execute_script("const s=document.createElement('style');s.textContent=arguments[0];document.head.appendChild(s);", STYLES)
    d.execute_script(STUB); d.execute_script(FILTER + "\nwindow.Filter = Filter;"); d.execute_script(CONTENT)
    time.sleep(2)

    check("bridge bar injected on a room page", d.execute_script("return !!document.querySelector('.archiver-bridge')"))
    btn = d.execute_script("const a=document.querySelector('.archiver-bridge-btn'); return a?a.getAttribute('href'):''")
    check("button points at the conversation with this host",
          btn.endswith(f"/contact_host/{ROOM}/send_message"), repr(btn))

    got = None
    for _ in range(25):
        got = d.execute_script("return (window.__hosts||{})[arguments[0]] || null", ROOM)
        if got and got.get("name"): break
        time.sleep(1)
    check("host looked up from the page itself", bool(got and got.get("name")), str(got))
    if got:
        txt = d.execute_script("return document.querySelector('.archiver-bridge').innerText")
        check("bar names the apartment", (got.get("listingName") or "___") in txt, repr(txt))
        check("bar names the host", got["name"] in txt, repr(txt))
        check("button says who you're messaging", got["name"] in d.execute_script(
            "return document.querySelector('.archiver-bridge-btn').textContent"),
            d.execute_script("return document.querySelector('.archiver-bridge-btn').textContent"))

    # --- the note grows here too, and this bar is anchored to the BOTTOM ------
    # Growing room has to be measured upward here: measuring downward (toward the
    # window edge the bar is already sitting on) caps the box at a line or two,
    # which reads as "it just stops expanding".
    note = d.find_element("css selector", ".archiver-bridge-note")
    idle_h = d.execute_script("return Math.round(document.querySelector('.archiver-bridge-note').getBoundingClientRect().height)")
    note.click()
    note.send_keys("one\ntwo\nthree\nfour\nfive\nsix")
    time.sleep(0.8)
    grown = d.execute_script("""
      const n = document.querySelector('.archiver-bridge-note');
      const r = n.getBoundingClientRect();
      return {h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom),
              scrollH: n.scrollHeight, clientH: n.clientHeight, vh: innerHeight,
              lines: n.value.split('\\n').length};
    """)
    check("floating bar's note grows too", grown["h"] > idle_h + 20, f"{idle_h}px -> {grown['h']}px")
    check("all six lines visible in the floating bar",
          grown["scrollH"] <= grown["clientH"], f"scrollH={grown['scrollH']} clientH={grown['clientH']}")
    check("grown note stays on screen (grows upward, not off the bottom)",
          grown["top"] >= 0 and grown["bottom"] <= grown["vh"], str(grown))
    d.execute_script("document.querySelector('.archiver-bridge-note').blur()"); time.sleep(0.6)
    check("floating bar's note shrinks back on blur", d.execute_script(
        "return Math.round(document.querySelector('.archiver-bridge-note').getBoundingClientRect().height)") == idle_h)

    # --- learning listingId -> threadId from a chat page ---------------------
    # /guest/messages needs a login, so simulate the thread page: same URL shape,
    # same "the thread links its listing" DOM. The real page was confirmed working
    # by the user (the "Open the apartment" button worked from a live chat).
    THREAD = "2592958621"
    LISTING = "827677023435973204"
    d.get("https://www.airbnb.com/")
    time.sleep(2)
    d.execute_script("const s=document.createElement('style');s.textContent=arguments[0];document.head.appendChild(s);", STYLES)
    d.execute_script(STUB); d.execute_script(FILTER + "\nwindow.Filter = Filter;")
    # Simulate the real shape: an inbox sidebar of OTHER conversations (each
    # linking its own listing once) plus the open thread's listing, which recurs.
    d.execute_script("""
      history.replaceState(null, '', '/guest/messages/' + arguments[0]);
      document.body.innerHTML =
        '<aside><a href="/rooms/111111111">another chat</a>' +
        '<a href="/rooms/222222222">yet another chat</a></aside>' +
        '<main><a href="/rooms/' + arguments[1] + '">the listing</a>' +
        '<a href="/rooms/' + arguments[1] + '">book it</a></main>';
    """, THREAD, LISTING)
    d.execute_script(CONTENT)
    time.sleep(2.5)

    check("bridge bar shows on a thread page", d.execute_script("return !!document.querySelector('.archiver-bridge')"))
    href = d.execute_script("const a=document.querySelector('.archiver-bridge-btn'); return a?a.getAttribute('href'):''")
    check("thread page buttons through to the apartment", href.endswith(f"/rooms/{LISTING}"), repr(href))
    learned = d.execute_script("return window.__threads || {}")
    check("visiting a chat records listing -> thread", learned.get(LISTING) == THREAD, str(learned))

    # ...and that mapping is what the panel then links to.
    check("the learned mapping produces the real chat url", d.execute_script(
        "return Filter.threadUrl(location.origin, (window.__threads||{})[arguments[0]])", LISTING
    ).endswith(f"/guest/messages/{THREAD}"))

    # The bar is for room/thread pages only -- it must not appear on search.
    d.get("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1")
    for _ in range(40):
        if d.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length'): break
        time.sleep(1)
    time.sleep(2)
    d.execute_script(STUB); d.execute_script(FILTER + "\nwindow.Filter = Filter;"); d.execute_script(CONTENT)
    time.sleep(2)
    check("no bridge bar on a search page", not d.execute_script("return !!document.querySelector('.archiver-bridge')"))
finally:
    d.quit()

print("\n" + ("ALL PASS" if all(results) else "SOME FAILED"))
sys.exit(0 if all(results) else 1)
