# What does a LOGGED-IN /guest/messages/<threadId> page actually look like?
# The bridge bar floats over the compose box there; to mount it somewhere sane we
# need the real geometry. That page redirects to /login on a clean profile, so
# launch Firefox on a COPY of the real profile (same trick as
# repro_broken_page.py -- the original is only ever read).
#
#   python scripts/recon_thread_layout.py [--headed] [<threadUrl>]
#
# Prints a text skeleton of the conversation pane: every laid-out box with its
# rect, background and text, so the empty areas are visible as gaps.

import sys, os, time, shutil, pathlib, tempfile
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
SRC = pathlib.Path(os.environ["APPDATA"]) / "Mozilla/Firefox/Profiles/axoocsbc.default-release"
KEEP_FILES = ["cookies.sqlite", "prefs.js", "permissions.sqlite", "cert9.db", "key4.db",
              "logins.json", "containers.json", "search.json.mozlz4"]
KEEP_DIRS = ["storage"]

headed = "--headed" in sys.argv
url = next((a for a in sys.argv[1:] if a.startswith("http")), None)

tmp = pathlib.Path(tempfile.mkdtemp(prefix="ffthread-"))
print(f"copying profile -> {tmp}", flush=True)
for f in KEEP_FILES:
    p = SRC / f
    if p.exists(): shutil.copy2(p, tmp / f)
for dname in KEEP_DIRS:
    p = SRC / dname
    if p.is_dir():
        shutil.copytree(p, tmp / dname, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.lock", "parent.lock"))

# A text skeleton: boxes big enough to matter, with their own text (not their
# children's), so empty regions show up as vertical gaps in the listing.
SKELETON = r"""
const out = [];
const seen = new Set();
for (const el of document.querySelectorAll('body *')) {
  const r = el.getBoundingClientRect();
  if (r.width < 60 || r.height < 14) continue;
  if (r.bottom < 0 || r.top > innerHeight) continue;
  const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
  const s = getComputedStyle(el);
  const tagish = el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '')
    + (el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : '')
    + (el.getAttribute('aria-label') ? '{' + el.getAttribute('aria-label').slice(0, 30) + '}' : '');
  const key = tagish + '|' + Math.round(r.top) + '|' + Math.round(r.left) + '|' + Math.round(r.width);
  if (seen.has(key)) continue;
  seen.add(key);
  if (!own && s.backgroundColor === 'rgba(0, 0, 0, 0)' && el.children.length) continue;  // pure wrapper
  out.push({
    tag: tagish,
    top: Math.round(r.top), left: Math.round(r.left),
    w: Math.round(r.width), h: Math.round(r.height),
    bg: s.backgroundColor, pos: s.position,
    text: own.slice(0, 70),
  });
}
out.sort((a, b) => a.top - b.top || a.left - b.left);
return out.slice(0, 120);
"""

opts = Options()
opts.binary_location = FIREFOX
if not headed: opts.add_argument("-headless")
opts.add_argument("-profile"); opts.add_argument(str(tmp))
opts.set_preference("intl.accept_languages", "en-US,en")

d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1500, 1000)
    if not url:
        d.get("https://www.airbnb.com/guest/messages")
        time.sleep(8)
        # The inbox rows are click handlers, not links -- open the first one.
        d.execute_script(r"""
          const el = document.querySelector('[aria-label^="Conversation with"]')
            || [...document.querySelectorAll('[role="listitem"],li')].find(e=>e.getBoundingClientRect().height>60);
          if (el) (el.querySelector('a,button,[role="button"]') || el).click();
        """)
        for _ in range(20):
            time.sleep(1)
            if "/guest/messages/" in d.current_url and d.current_url.rstrip("/").split("/")[-1].isdigit():
                break
        url = d.current_url
        print("first thread:", url, flush=True)
        if "/guest/messages/" not in url:
            print("no thread opened -- page text:", d.execute_script("return document.body.innerText.slice(0,400)"))
            raise SystemExit(1)
    else:
        d.get(url)
    time.sleep(9)
    print("title:", d.title)
    print("url  :", d.current_url)
    rows = d.execute_script(SKELETON)
    print(f"\n{'top':>5} {'left':>5} {'w':>5} {'h':>5}  {'pos':<8} {'bg':<22} tag / text")
    for r in rows:
        print(f"{r['top']:>5} {r['left']:>5} {r['w']:>5} {r['h']:>5}  {r['pos']:<8} {r['bg']:<22} "
              f"{r['tag']}  {r['text']!r}")

    # --- where exactly does the conversation pane start? ---------------------
    # The bar wants to live in the empty band above the host's name, so measure
    # the header: its ancestors, and every child of the pane in document order.
    print("\n================ conversation header ================")
    hdr = d.execute_script(r"""
      const box = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
        return {tag: e.tagName.toLowerCase() + (e.getAttribute('data-testid') ? '[' + e.getAttribute('data-testid') + ']' : ''),
                top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
                bg: s.backgroundColor, pos: s.position, overflow: s.overflow + '/' + s.overflowY,
                display: s.display, cls: (e.className || '').toString().slice(0, 34), text: own.slice(0, 46)}; };

      // Anchor on the compose box -- unambiguous -- and walk up to the column
      // that holds the whole conversation (compose + header, not the whole page).
      const compose = document.querySelector('#message_input, [data-testid*="composebar"]');
      if (!compose) return null;
      let pane = compose;
      while (pane.parentElement) {
        const r = pane.getBoundingClientRect();
        if (r.height > innerHeight * 0.55 && r.width > 400 && r.width < innerWidth * 0.75) break;
        pane = pane.parentElement;
      }
      const pr = pane.getBoundingClientRect();

      // Everything laid out in the pane's top third, in document order: this is
      // the band the bar would move into.
      const topBand = [...pane.querySelectorAll('*')].filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 40 && r.height > 10 && r.top < pr.top + pr.height / 3;
      }).map(box);

      const chain = []; let e = pane;
      for (let i = 0; i < 6 && e && e !== document.body; i++) { chain.push(box(e)); e = e.parentElement; }
      return {chain, pane: box(pane), kids: [...pane.children].map(box), topBand: topBand.slice(0, 25),
              compose: box(compose), vh: innerHeight, vw: innerWidth, titleText: '(anchored on compose)'};
    """)
    if not hdr:
        print("  (couldn't find the conversation title)")
    else:
        print(f"  title text : {hdr['titleText']!r}")
        print(f"  viewport   : {hdr['vw']}x{hdr['vh']}")
        print(f"  compose box: {hdr['compose']}")
        print("  ancestors of the title (innermost first):")
        for b in hdr["chain"]:
            print(f"    top={b['top']:>5} left={b['left']:>5} {b['w']:>5}x{b['h']:<5} {b['pos']:<8} "
                  f"{b['bg']:<22} of={b['overflow']:<16} {b['tag']} .{b['cls']}")
        print(f"  pane: {hdr['pane']}")
        print("  pane children in order:")
        for b in hdr["kids"]:
            print(f"    top={b['top']:>5} left={b['left']:>5} {b['w']:>5}x{b['h']:<5} {b['pos']:<8} "
                  f"{b['bg']:<22} {b['tag']} .{b['cls']}  {b['text']!r}")
        print("  everything in the pane's top third (document order):")
        for b in hdr["topBand"]:
            print(f"    top={b['top']:>5} left={b['left']:>5} {b['w']:>5}x{b['h']:<5} {b['pos']:<8} "
                  f"{b['bg']:<22} {b['tag']} .{b['cls']}  {b['text']!r}")
    # --- the thread column as a tree -----------------------------------------
    # To dock the bar in the flow (instead of floating it over the compose box)
    # we need the container that holds BOTH the host-name header and the message
    # pane, and how it lays its children out.
    print("\n================ thread column tree ================")
    tree = d.execute_script(r"""
      const sec = document.querySelector('[data-testid="orbital-panel-thread"]');
      if (!sec) return null;
      const out = [];
      (function walk(e, depth) {
        if (depth > 6) return;
        const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
        out.push({depth,
          tag: e.tagName.toLowerCase() + (e.getAttribute('data-testid') ? '[' + e.getAttribute('data-testid') + ']' : ''),
          top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
          disp: s.display + (s.display.includes('flex') ? '/' + s.flexDirection : ''),
          of: s.overflowY, pos: s.position, text: own.slice(0, 40)});
        for (const c of e.children) walk(c, depth + 1);
      })(sec, 0);
      return out;
    """)
    if tree:
        for n in tree:
            print(f"  {'  ' * n['depth']}{n['tag']:<40.40} top={n['top']:>4} {n['w']:>4}x{n['h']:<4} "
                  f"{n['disp']:<14} of={n['of']:<8} {n['pos']:<8} {n['text']!r}")

    # --- occupancy map: where is the page actually EMPTY? --------------------
    # An ASCII picture of the viewport. '#' = text, 'o' = image/control,
    # ':' = coloured panel, '.' = blank white. The empty white regions are the
    # runs of '.', which is what "put it in the empty area" has to mean.
    print("\n================ occupancy map (viewport) ================")
    grid = d.execute_script(r"""
      const COLS = 100, ROWS = 44;
      const cw = innerWidth / COLS, ch = innerHeight / ROWS;
      const lines = [];
      for (let r = 0; r < ROWS; r++) {
        let line = '';
        for (let c = 0; c < COLS; c++) {
          const x = c * cw + cw / 2, y = r * ch + ch / 2;
          const el = document.elementFromPoint(x, y);
          if (!el) { line += ' '; continue; }
          const tag = el.tagName.toLowerCase();
          const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          if (own) line += '#';
          else if (tag === 'img' || tag === 'svg' || tag === 'path' || tag === 'input'
                   || tag === 'textarea' || tag === 'button' || el.closest('button,a,img,svg')) line += 'o';
          else {
            let bg = 'rgba(0, 0, 0, 0)', e = el;
            for (let i = 0; i < 6 && e; i++, e = e.parentElement) {
              const b = getComputedStyle(e).backgroundColor;
              if (b && b !== 'rgba(0, 0, 0, 0)') { bg = b; break; }
            }
            line += (bg === 'rgb(255, 255, 255)' || bg === 'rgba(0, 0, 0, 0)') ? '.' : ':';
          }
        }
        lines.push(line);
      }
      return {lines, cw, ch, vw: innerWidth, vh: innerHeight};
    """)
    print(f"  each cell = {grid['cw']:.0f}x{grid['ch']:.0f} px    # text   o image/control   : coloured   . blank")
    print("      " + "".join(str((i // 10) % 10) for i in range(100)))
    for i, line in enumerate(grid["lines"]):
        print(f"  {round(i * grid['ch']):>4}|{line}")
finally:
    d.quit()
    shutil.rmtree(tmp, ignore_errors=True)
