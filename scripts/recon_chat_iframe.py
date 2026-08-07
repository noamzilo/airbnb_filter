# Can a real /guest/messages/<threadId> conversation be EMBEDDED in an iframe
# inside a panel row, at panel width?  That is the whole premise of the row's
# "Chat" tab, so it gets verified before anything is built on it.
#
#   python scripts/recon_chat_iframe.py [--headed] [--width 380] [<threadUrl>]
#
# Reports, as text:
#   - whether the frame loaded at all (X-Frame-Options / CSP would blank it)
#   - whether we can read into it (same-origin => contentDocument is readable)
#   - what it actually renders at that width: message text, composer, and the
#     inbox sidebar / nav chrome we would need to crop.

import sys, time, pathlib
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib_profile import copy_profile, firefox_on_copy, open_first_thread

headed = "--headed" in sys.argv
url = next((a for a in sys.argv[1:] if a.startswith("http")), None)
width = 380
if "--width" in sys.argv:
    width = int(sys.argv[sys.argv.index("--width") + 1])

# Read into the frame and describe what a user would see in a column that narrow.
PROBE = r"""
const done = arguments[arguments.length - 1];
const f = document.getElementById('archiver-probe-frame');
const out = {w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height};
let d = null;
try { d = f.contentDocument; } catch (e) { out.crossOrigin = String(e); }
out.readable = !!d;
if (d) {
  out.frameUrl = d.location.href;
  out.title = d.title;
  const b = d.body;
  out.bodyText = b ? b.innerText.replace(/\s+/g,' ').trim().slice(0, 400) : null;
  out.bodyLen = b ? b.innerText.length : 0;
  const pick = (sel) => { const e = d.querySelector(sel); if (!e) return null;
    const r = e.getBoundingClientRect();
    return {w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left)}; };
  out.thread   = pick('[data-testid="orbital-panel-thread"]');
  out.msgList  = pick('[data-testid="message-list"]') || pick('[data-testid="message-thread-container"]');
  out.composer = pick('textarea') || pick('[contenteditable="true"]');
  out.sidebar  = pick('[data-testid="orbital-panel-inbox"]') || pick('[data-testid="inbox-list"]');
  out.header   = pick('header');
  // Anything scrollable inside? That is what "scroll down in the chat" needs.
  const scrollers = [];
  for (const el of d.querySelectorAll('div,section,main,ul')) {
    if (el.scrollHeight - el.clientHeight > 40 && el.clientHeight > 80) {
      const r = el.getBoundingClientRect();
      scrollers.push({tag: el.tagName.toLowerCase(),
                      testid: el.getAttribute('data-testid') || '',
                      w: Math.round(r.width), h: Math.round(r.height),
                      scrollH: el.scrollHeight, clientH: el.clientHeight});
    }
  }
  out.scrollers = scrollers.slice(0, 8);
  out.scrollerCount = scrollers.length;
  // Does the page complain about being framed?
  out.framedNotice = /refused to connect|cannot be displayed|didn.t load/i.test(out.bodyText || '');
}
done(JSON.stringify(out, null, 1));
"""

tmp = copy_profile(prefix="ffchat-")
print(f"profile copy -> {tmp}", flush=True)
d = firefox_on_copy(tmp, headless=not headed, width=1500, height=1000)
d.set_script_timeout(60)
try:
    if not url:
        print("finding a real thread...", flush=True)
        url = open_first_thread(d, time)
    if not url:
        print("FAIL: could not open any conversation (not logged in?)")
        sys.exit(1)
    print(f"thread: {url}", flush=True)

    # Frame it from a page on the same origin -- exactly where the panel lives.
    print("loading a search page, then framing the thread inside it...", flush=True)
    d.get("https://www.airbnb.com/s/Jerusalem/homes")
    time.sleep(6)
    d.execute_script(
        """
        const f = document.createElement('iframe');
        f.id = 'archiver-probe-frame';
        f.src = arguments[0];
        f.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;'
          + 'width:' + arguments[1] + 'px;height:420px;border:2px solid red;background:#fff';
        document.body.appendChild(f);
        """,
        url, width)
    time.sleep(18)
    print(d.execute_async_script(PROBE))
finally:
    d.quit()
