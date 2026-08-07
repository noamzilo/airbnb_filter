# The Chat tab against a REAL, logged-in conversation.
#
#   python scripts/test_chat_live.py [--headed]
#
# test_chat_tab.py covers the tab mechanics with a stub; this covers the premise
# underneath them -- that a row can embed an actual /guest/messages/<threadId>
# and you can read and scroll the conversation inside the panel. /guest/messages
# needs a login, so it drives a read-only COPY of the real profile
# (scripts/lib_profile.py), like test_thread_bar.py.
#
# What could break this: Airbnb tightening x-frame-options / CSP frame-ancestors,
# or changing what its layout collapses to at panel width. Both would show up
# here as the frame going blank or growing an inbox sidebar.

import time, pathlib, sys
sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from lib_profile import copy_profile, firefox_on_copy, open_first_thread
from lib_stub import STUB, INJECT_CSS

FILTER = (ROOT / "extension" / "filter.js").read_text(encoding="utf-8")
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
STYLES = (ROOT / "extension" / "content.css").read_text(encoding="utf-8")
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true")

headed = "--headed" in sys.argv

results = []
def check(label, cond, extra=""):
    results.append(bool(cond))
    print(("PASS" if cond else "FAIL") + "  " + label + (("  " + extra) if extra else ""), flush=True)

# Read into the embedded conversation from the parent page. Same-origin, so
# contentDocument is readable -- which is also what makes the embed legal at all.
INSIDE = r"""
const done = arguments[arguments.length - 1];
const row = document.querySelector('.archiver-row[data-id="A"]');
const f = row && row.querySelector('.archiver-chat iframe');
if (!f) { done(JSON.stringify({noFrame: true})); }
else {
  const fr = f.getBoundingClientRect();
  const out = {frameW: Math.round(fr.width), frameH: Math.round(fr.height)};
  let d = null;
  try { d = f.contentDocument; } catch (e) { out.blocked = String(e); }
  out.readable = !!d;
  if (d) {
    out.url = d.location.href;
    out.text = (d.body ? d.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 200);
    out.textLen = d.body ? d.body.innerText.length : 0;
    out.loginWall = /log in|sign up/i.test(out.text) && out.textLen < 200;
    const wide = (sel) => { const e = d.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width) : -1; };
    out.threadW = wide('[data-testid="orbital-panel-thread"]');
    out.sidebarW = Math.max(wide('[data-testid="orbital-panel-inbox"]'), wide('[data-testid="inbox-list"]'));
    out.headerW = wide('header');
    out.hasComposer = !!(d.querySelector('textarea') || d.querySelector('[contenteditable="true"]'));
    // The scroller the user actually drags to read back through the thread.
    let best = null;
    for (const el of d.querySelectorAll('div,section,main,ul')) {
      if (el.scrollHeight - el.clientHeight > 40 && el.clientHeight > 80) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    }
    if (best) {
      const before = best.scrollTop;
      best.scrollTop = 0; const top = best.scrollTop;
      best.scrollTop = best.scrollHeight; const bottom = best.scrollTop;
      best.scrollTop = before;
      out.scroll = {testid: best.getAttribute('data-testid') || '', h: best.clientHeight,
                    scrollH: best.scrollHeight, top, bottom, moved: bottom > top + 40};
    }
  }
  done(JSON.stringify(out));
}
"""

tmp = copy_profile(prefix="ffchatlive-")
print(f"profile copy -> {tmp}", flush=True)
d = firefox_on_copy(tmp, headless=not headed, width=1400, height=950)
d.set_script_timeout(90)
try:
    print("finding a real conversation...", flush=True)
    thread_url = open_first_thread(d, time)
    if not thread_url:
        print("FAIL  could not open any conversation (is the profile logged in?)")
        sys.exit(1)
    thread_id = thread_url.rstrip("/").split("/")[-1]
    print(f"thread {thread_id}", flush=True)

    d.get(URL)
    for _ in range(45):
        if d.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length'): break
        time.sleep(1)
    d.execute_script(INJECT_CSS, STYLES)
    d.execute_script(STUB); d.execute_script(FILTER + "\nwindow.Filter = Filter;")
    d.execute_script(CONTENT); time.sleep(1.5)

    # One starred listing on this map, with that real conversation attached.
    d.execute_script("""
      window.__cats={starred:{A:{title:'Alpha',price:'$1',url:'https://www.airbnb.com/rooms/A',ts:2}},maybe:{},archived:{}};
      window.__tagcoords={A:{lat:-25.29,lng:-57.57}};
      window.__threads={A:arguments[0]};
      window.__ls.forEach(f=>f({starred:{}}));
    """, thread_id)
    time.sleep(1.0)
    check("the row offers a Chat tab", d.execute_script(
        "return !!document.querySelector('.archiver-row[data-id=\"A\"] .archiver-tab[data-tab=\"chat\"]')"))

    d.execute_script("document.querySelector('.archiver-row[data-id=\"A\"] .archiver-tab[data-tab=\"chat\"]').click();")
    print("waiting for the embedded conversation to load...", flush=True)
    time.sleep(20)

    import json
    r = json.loads(d.execute_async_script(INSIDE))
    print(json.dumps(r, indent=1), flush=True)

    check("the conversation is embedded in the row", not r.get("noFrame"))
    check("Airbnb allows framing it (not blocked by CSP / X-Frame-Options)",
          r.get("readable"), str(r.get("blocked") or ""))
    check("the frame is on the thread, not bounced to a login",
          r.get("url", "").endswith(thread_id) and not r.get("loginWall"), str(r.get("url")))
    check("real conversation text is rendered", r.get("textLen", 0) > 80, f"{r.get('textLen')} chars")
    check("the thread fills the panel column", r.get("threadW", 0) >= r.get("frameW", 0) - 12,
          f"thread {r.get('threadW')} of {r.get('frameW')}")
    check("Airbnb's inbox sidebar collapses away at this width", r.get("sidebarW", 1) <= 0, str(r.get("sidebarW")))
    check("and so does its page header", r.get("headerW", 1) <= 0, str(r.get("headerW")))
    check("you can scroll back through the conversation",
          r.get("scroll") and r["scroll"]["moved"], str(r.get("scroll")))
    check("you can reply without leaving the panel", r.get("hasComposer"))

finally:
    d.quit()

print()
print("ALL PASS" if all(results) else f"{results.count(False)} FAILED of {len(results)}")
sys.exit(0 if all(results) else 1)
