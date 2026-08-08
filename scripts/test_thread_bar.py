# The bridge bar on a REAL, logged-in /guest/messages/<threadId> page.
#
# It used to float (position:fixed, bottom) and sat right on top of Airbnb's
# compose box -- you could not see the message you were typing. It now sits in
# the blank strip ABOVE the conversation (Airbnb's own header band, empty across
# the middle), still fixed, so the chat loses no space. This asserts that on the
# real page, as geometry:
#   * the bar is above the host-name header, not over it
#   * it overlaps nothing of Airbnb's -- not the composer, not the header nav
#   * the conversation is NOT pushed down: the chat keeps the room it had
#   * it stays put (no re-mount churn against Airbnb's own re-renders)
#
#   python scripts/test_thread_bar.py [--headed] [<threadUrl>]
#
# Needs the real profile for the login (copied, read-only) -- see lib_profile.py.

import sys, time, pathlib, shutil
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from lib_profile import copy_profile, firefox_on_copy, open_first_thread
from lib_stub import STUB          # was scraped out of test_decorator.py, which
                                   # stopped holding it when it moved to lib_stub

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILTER = (ROOT / "extension" / "filter.js").read_text(encoding="utf-8")
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
STYLES = (ROOT / "extension" / "content.css").read_text(encoding="utf-8")

headed = "--headed" in sys.argv
url = next((a for a in sys.argv[1:] if a.startswith("http")), None)

results = []
def check(label, cond, extra=""):
    results.append(bool(cond))
    print(("PASS" if cond else "FAIL") + "  " + label + (("  " + extra) if extra else ""), flush=True)

HEADER_JS = r"""
  // The host-name header: first child of the flex column that also holds the
  // message pane -- the same rule threadDock() uses in content.js.
  const sec = document.querySelector('[data-testid="orbital-panel-thread"]');
  if (!sec) return null;
  const anchor = sec.querySelector('[data-testid="message-thread-container"]')
    || sec.querySelector('[data-testid="message-list"]');
  let node = anchor;
  for (let i = 0; i < 10 && node && node !== sec; i++) {
    const p = node.parentElement, st = getComputedStyle(p);
    let first = p.firstElementChild;
    if (first && first.classList.contains('archiver-bridge')) first = first.nextElementSibling;
    if (st.display.includes('flex') && st.flexDirection === 'column' && first && first !== node) return first;
    node = p;
  }
  return null;
"""

# Measured with the bar NOT yet injected, so we know what the chat had before.
BASELINE = r"""
  const header = (() => {%s})();
  const sec = document.querySelector('[data-testid="orbital-panel-thread"]');
  const compose = document.querySelector('[data-testid="messaging-composebar"], #message_input');
  const r = (e) => { const b = e.getBoundingClientRect();
    return {top: Math.round(b.top), left: Math.round(b.left), right: Math.round(b.right),
            bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height)}; };
  return {header: header ? r(header) : null, compose: compose ? r(compose) : null,
          section: sec ? r(sec) : null};
""" % HEADER_JS

GEOM = r"""
  const bar = document.querySelector('.archiver-bridge');
  if (!bar) return {bar: false};
  const header = (() => {%s})();
  const sec = document.querySelector('[data-testid="orbital-panel-thread"]');
  const compose = document.querySelector('[data-testid="messaging-composebar"], #message_input');
  const rect = (e) => { const r = e.getBoundingClientRect();
    return {top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
            bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height)}; };
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const br = rect(bar);
  const cr = compose ? rect(compose) : null;
  const hr = header ? rect(header) : null;

  // Everything of Airbnb's own that the bar's rectangle lands on. The band is
  // supposed to be empty there; the logo and the nav are the things to miss.
  const hits = [];
  for (const el of document.querySelectorAll('header a, header button, header img, nav a, nav button')) {
    const r = rect(el);
    if (r.w > 4 && r.h > 4 && overlaps(br, r)) hits.push((el.textContent || el.tagName).trim().slice(0, 24) || el.tagName);
  }
  return {
    bar: true, pos: getComputedStyle(bar).position,
    top: bar.classList.contains('archiver-bridge--top'),
    docked: bar.classList.contains('archiver-bridge--docked'),
    onBody: bar.parentElement === document.body,
    br, cr, hr, headerText: header ? header.innerText.trim().slice(0, 40) : '',
    hitsCompose: !!(cr && overlaps(br, cr)),
    hitsHeader: !!(hr && overlaps(br, hr)),
    hitsAirbnbChrome: hits,
    composeVisible: !!(cr && cr.top >= 0 && cr.bottom <= innerHeight + 1 && cr.h > 10),
    text: bar.innerText.replace(/\n+/g, ' | ').slice(0, 120),
  };
""" % HEADER_JS

tmp = copy_profile("ffthreadbar-")
print(f"profile copy -> {tmp}", flush=True)
d = firefox_on_copy(tmp, headless=not headed)
try:
    if not url:
        url = open_first_thread(d, time)
        print("thread:", url, flush=True)
    else:
        d.get(url)
    if not url:
        print("FAIL  could not open a conversation"); raise SystemExit(1)
    time.sleep(8)

    # What the conversation looks like BEFORE we add anything, so "it took no
    # space from the chat" can be asserted rather than eyeballed.
    base = d.execute_script(BASELINE)
    print("baseline:", base, flush=True)

    d.execute_script("const s=document.createElement('style');s.textContent=arguments[0];document.head.appendChild(s);", STYLES)
    d.execute_script(STUB)
    d.execute_script(FILTER + "\nwindow.Filter = Filter;")
    d.execute_script(CONTENT)
    time.sleep(4)

    g = d.execute_script(GEOM)
    check("bridge bar injected on the thread page", g.get("bar"), str(g)[:200])
    if g.get("bar"):
        check("bar sits in the top band, out of the flow",
              g["top"] and g["pos"] == "fixed" and g["onBody"] and not g["docked"],
              f"position={g['pos']} top={g['top']} docked={g['docked']} onBody={g['onBody']}")
        check("bar is ABOVE the host-name header",
              bool(g["hr"]) and g["br"]["bottom"] <= g["hr"]["top"] + 1 and not g["hitsHeader"],
              f"bar={g['br']} header={g['hr']} {g['headerText']!r}")
        check("header still shows the conversation's host", len(g["headerText"]) > 1, repr(g["headerText"]))
        check("bar does NOT cover the compose box", bool(g["cr"]) and not g["hitsCompose"],
              f"bar={g['br']} compose={g['cr']}")
        check("compose box is fully visible", g["composeVisible"], str(g["cr"]))
        check("bar misses Airbnb's logo and nav", not g["hitsAirbnbChrome"], str(g["hitsAirbnbChrome"]))
        # The whole point of the second attempt: the chat must be exactly where
        # it was, not shoved down to make room.
        if base and base["header"] and base["compose"]:
            check("conversation NOT pushed down (header where it was)",
                  abs(g["hr"]["top"] - base["header"]["top"]) <= 1,
                  f"{base['header']['top']} -> {g['hr']['top']}")
            check("chat keeps its space (compose where it was)",
                  abs(g["cr"]["top"] - base["compose"]["top"]) <= 1,
                  f"{base['compose']['top']} -> {g['cr']['top']}")
        check("bar still names the apartment and links back", "Open the apartment" in g["text"], repr(g["text"]))
        check("note field still there", "note about this place" in d.execute_script(
            "const t=document.querySelector('.archiver-bridge-note'); return t?t.placeholder:''"))

        # Airbnb re-renders the thread constantly; the bar must not thrash
        # between parents (an insert loop would churn the page forever).
        d.execute_script("window.__barNode = document.querySelector('.archiver-bridge');")
        time.sleep(5)
        stable = d.execute_script("""
          const bar = document.querySelector('.archiver-bridge');
          return {same: bar === window.__barNode, count: document.querySelectorAll('.archiver-bridge').length,
                  top: !!bar && bar.classList.contains('archiver-bridge--top'),
                  y: bar ? Math.round(bar.getBoundingClientRect().top) : null};
        """)
        check("bar stays the same node (no re-mount churn)", stable["same"] and stable["count"] == 1, str(stable))
        check("bar stays in the top band after Airbnb re-renders", stable["top"], str(stable))

        # --- the note grows while you type in it, and only while ---------------
        # One line when idle; focused, it must show every line you've typed even
        # if that means covering the conversation underneath. And it must snap
        # back on blur, without the bar jumping somewhere else.
        note = d.find_element("css selector", ".archiver-bridge-note")
        idle = d.execute_script("""
          const n=document.querySelector('.archiver-bridge-note'), b=document.querySelector('.archiver-bridge');
          return {noteH: Math.round(n.getBoundingClientRect().height),
                  barTop: Math.round(b.getBoundingClientRect().top),
                  barBottom: Math.round(b.getBoundingClientRect().bottom)};
        """)
        note.click()
        note.send_keys("line one\nline two\nline three\nline four\nline five")
        time.sleep(0.8)
        grown = d.execute_script(r"""
          const n=document.querySelector('.archiver-bridge-note'), b=document.querySelector('.archiver-bridge');
          const hdr = (() => {%s})();
          const nr=n.getBoundingClientRect(), br=b.getBoundingClientRect();
          return {noteH: Math.round(nr.height), scrollH: n.scrollHeight, clientH: n.clientHeight,
                  barTop: Math.round(br.top), barBottom: Math.round(br.bottom),
                  headerTop: hdr ? Math.round(hdr.getBoundingClientRect().top) : null,
                  noteBottom: Math.round(nr.bottom), vh: innerHeight,
                  focused: document.activeElement === n, lines: n.value.split('\n').length};
        """ % HEADER_JS)
        check("typing five lines actually landed", grown["lines"] == 5 and grown["focused"], str(grown))
        check("note grows when focused", grown["noteH"] > idle["noteH"] + 20,
              f"{idle['noteH']}px -> {grown['noteH']}px")
        check("every line is visible, no inner scrollbar",
              grown["scrollH"] <= grown["clientH"], f"scrollH={grown['scrollH']} clientH={grown['clientH']}")
        check("grown note stays on screen", grown["noteBottom"] <= grown["vh"], str(grown))
        check("it covers the conversation below rather than being clipped",
              grown["headerTop"] is not None and grown["barBottom"] > grown["headerTop"],
              f"bar bottom {grown['barBottom']} vs header top {grown['headerTop']}")
        check("the bar itself does not jump while typing", grown["barTop"] == idle["barTop"],
              f"{idle['barTop']} -> {grown['barTop']}")

        d.execute_script("document.querySelector('.archiver-bridge-note').blur()")
        time.sleep(0.8)
        back = d.execute_script(r"""
          const n=document.querySelector('.archiver-bridge-note'), b=document.querySelector('.archiver-bridge');
          const hdr = (() => {%s})();
          return {noteH: Math.round(n.getBoundingClientRect().height),
                  barTop: Math.round(b.getBoundingClientRect().top),
                  barBottom: Math.round(b.getBoundingClientRect().bottom),
                  headerTop: hdr ? Math.round(hdr.getBoundingClientRect().top) : null,
                  kept: n.value.split('\n').length};
        """ % HEADER_JS)
        check("note shrinks back on blur", back["noteH"] == idle["noteH"], f"{grown['noteH']} -> {back['noteH']}")
        check("bar returns to the band, covering nothing",
              back["barBottom"] <= back["headerTop"] and back["barTop"] == idle["barTop"], str(back))
        check("the text you typed is still there", back["kept"] == 5, str(back))

        # Narrower windows: the band is the same height but the nav creeps in,
        # so the slot has to be re-measured rather than assumed.
        for w, h in [(1280, 950), (1000, 950)]:
            d.set_window_size(w, h); time.sleep(2.5)
            d.execute_script("window.dispatchEvent(new Event('resize'))"); time.sleep(1.2)
            gw = d.execute_script(GEOM)
            ok = (gw["top"] and not gw["hitsCompose"] and not gw["hitsHeader"]
                  and not gw["hitsAirbnbChrome"] and gw["br"]["bottom"] <= gw["hr"]["top"] + 1)
            check(f"at {w}px: still above the name and clear of everything", ok,
                  f"bar={gw['br']} header={gw['hr']} hits={gw['hitsAirbnbChrome']}")

    print("\n" + ("ALL PASS" if all(results) else "SOME FAILED"), flush=True)
finally:
    d.quit()
    shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if all(results) else 1)
