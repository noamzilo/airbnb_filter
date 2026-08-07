# How much genuinely BLANK space is there above the conversation header, at the
# widths a real window actually has? The bar must live there without taking any
# room from the chat, so we need the band's height per layout -- including the
# narrow layout where Airbnb drops the inbox sidebar and the thread goes
# full-width (which is what the user is looking at).
#
#   python scripts/recon_thread_topband.py [--headed] [<threadUrl>]

import sys, time, pathlib, shutil
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from lib_profile import copy_profile, firefox_on_copy, open_first_thread

headed = "--headed" in sys.argv
url = next((a for a in sys.argv[1:] if a.startswith("http")), None)

PROBE = r"""
const sec = document.querySelector('[data-testid="orbital-panel-thread"]');
if (!sec) return {sec: false};
const sr = sec.getBoundingClientRect();

// The host-name header: the first child of the flex column that also holds the
// message pane (same rule threadDock() uses).
const anchor = sec.querySelector('[data-testid="message-thread-container"]')
  || sec.querySelector('[data-testid="message-list"]');
let header = null, col = null, node = anchor;
for (let i = 0; i < 10 && node && node !== sec; i++) {
  const p = node.parentElement, st = getComputedStyle(p);
  if (st.display.includes('flex') && st.flexDirection === 'column'
      && p.firstElementChild && p.firstElementChild !== node) { header = p.firstElementChild; col = p; break; }
  node = p;
}
const hr = header ? header.getBoundingClientRect() : null;

// Walking down the thread column's x-range from y=0: where does content start?
// That run of empty rows IS the blank band the bar is supposed to occupy.
const cx = sr.left + sr.width / 2;
let firstContent = null;
for (let y = 2; y < innerHeight && firstContent === null; y += 2) {
  for (const x of [sr.left + 20, cx, sr.right - 20]) {
    const el = document.elementFromPoint(x, y);
    if (!el) continue;
    const tag = el.tagName.toLowerCase();
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    if (own || ['img','svg','path','input','textarea','button'].includes(tag) || el.closest('button,a,img,svg')) {
      firstContent = {y, x: Math.round(x), tag, text: (own || el.textContent || '').trim().slice(0, 40)};
      break;
    }
  }
}
// The inbox sidebar is only rendered on wide layouts.
const inbox = [...document.querySelectorAll('[aria-label^="Conversation with"]')]
  .map(e => e.getBoundingClientRect()).filter(r => r.width > 100)[0];
const r = (x) => x ? {top: Math.round(x.top), left: Math.round(x.left), w: Math.round(x.width), h: Math.round(x.height)} : null;

// Everything of Airbnb's own that intrudes into the band (0 .. header top) --
// a fixed bar up there must not land on the logo, the nav, or anything else.
const bandBottom = hr ? hr.top : 0;
const intruders = [];
for (const el of document.querySelectorAll('header *, nav *, [role="banner"] *')) {
  const b = el.getBoundingClientRect();
  if (b.width < 8 || b.height < 8 || b.top >= bandBottom || b.bottom <= 0) continue;
  if (el.children.length && ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
      && !['img','svg','button','a','input'].includes(el.tagName.toLowerCase())) continue;
  intruders.push({...r(b), tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 24)});
}
intruders.sort((a, b) => a.left - b.left);
// The widest run of band with nothing in it, inside the thread column.
let free = [];
if (hr) {
  let x = sr.left;
  for (const it of intruders) {
    if (it.left > x) free.push([Math.round(x), Math.round(Math.min(it.left, sr.right))]);
    x = Math.max(x, it.left + it.w);   // r() has no .right -- using it gave NaN
    if (x >= sr.right) break;
  }
  if (x < sr.right) free.push([Math.round(x), Math.round(sr.right)]);
  free = free.filter(([a, b]) => b - a > 40);
}
return {sec: true, vw: innerWidth, vh: innerHeight, section: r(sr), header: r(hr),
        headerText: header ? header.innerText.replace(/\n+/g, ' / ').trim().slice(0, 50) : '',
        inbox: r(inbox), firstContent, intruders: intruders.slice(0, 12), free};
"""

tmp = copy_profile("fftopband-")
d = firefox_on_copy(tmp, headless=not headed)
try:
    if not url:
        url = open_first_thread(d, time)
        print("thread:", url, flush=True)
    else:
        d.get(url)
    time.sleep(7)
    for w, h in [(1500, 1000), (1280, 950), (1150, 950), (1000, 950), (900, 950)]:
        d.set_window_size(w, h)
        time.sleep(2.5)
        p = d.execute_script(PROBE)
        if not p.get("sec"):
            print(f"\n{w}x{h}: no thread section"); continue
        print(f"\n--- window {w}x{h}  (viewport {p['vw']}x{p['vh']}) ---")
        print(f"  inbox sidebar : {p['inbox']}")
        print(f"  thread column : {p['section']}")
        print(f"  host header   : {p['header']}  {p['headerText']!r}")
        print(f"  first content down the column: {p['firstContent']}")
        if p["header"]:
            print(f"  >> BLANK BAND above the header: 0 .. {p['header']['top']} px "
                  f"({p['header']['top']} tall), column is {p['section']['w']} wide")
            print(f"  Airbnb's own stuff in that band:")
            for it in p["intruders"]:
                print(f"     x {it['left']:>5}..{it['left']+it['w']:<5} y {it['top']:>3}..{it['top']+it['h']:<4} "
                      f"{it['tag']:<7} {it['text']!r}")
            print(f"  >> FREE x-ranges inside the column: {p['free']}")
finally:
    d.quit()
    shutil.rmtree(tmp, ignore_errors=True)
