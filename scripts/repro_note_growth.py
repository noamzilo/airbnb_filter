# Why does the bridge note stop growing after a line or two in real use, when
# test_thread_bar.py (which types five lines in one burst) says it grows fine?
# Types like a human -- a line at a time, with pauses long enough for the
# debounced save, the storage listener and the MutationObserver to all run in
# between -- and reports the box after every step.
#
#   python scripts/repro_note_growth.py [--headed] [--real-ext] [<threadUrl>]
#
# --real-ext runs the INSTALLED extension (profile copy keeps extensions/)
# instead of injecting content.js, to rule the harness itself in or out.

import sys, time, pathlib, shutil
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from lib_profile import copy_profile, firefox_on_copy, open_first_thread

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILTER = (ROOT / "extension" / "filter.js").read_text(encoding="utf-8")
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
STYLES = (ROOT / "extension" / "content.css").read_text(encoding="utf-8")
STUB = (ROOT / "scripts" / "test_decorator.py").read_text(encoding="utf-8").split('STUB = r"""')[1].split('"""')[0]

headed = "--headed" in sys.argv
real_ext = "--real-ext" in sys.argv
url = next((a for a in sys.argv[1:] if a.startswith("http")), None)

MEASURE = r"""
  const n = document.querySelector('.archiver-bridge-note');
  const b = document.querySelector('.archiver-bridge');
  if (!n) return null;
  const cs = getComputedStyle(n);
  return {
    lines: n.value.split('\n').length,
    inlineH: n.style.height || '(none)',
    cssH: cs.height,
    clientH: n.clientHeight, scrollH: n.scrollHeight, offsetH: n.offsetHeight,
    boxH: Math.round(n.getBoundingClientRect().height),
    barH: b ? Math.round(b.getBoundingClientRect().height) : null,
    barTop: b ? Math.round(b.getBoundingClientRect().top) : null,
    focused: document.activeElement === n,
    scrollTop: n.scrollTop,
    clipped: n.scrollHeight > n.clientHeight + 1 || n.scrollTop > 0,
  };
"""

tmp = copy_profile("ffnote-", extensions=real_ext)
print(f"profile copy -> {tmp}  (real extension: {real_ext})", flush=True)
d = firefox_on_copy(tmp, headless=not headed)
try:
    if not url:
        url = open_first_thread(d, time)
        print("thread:", url, flush=True)
    else:
        d.get(url)
    time.sleep(8)

    if real_ext:
        loaded = d.execute_script("return document.documentElement.getAttribute('data-archiver-loaded')")
        print("installed extension active:", loaded, flush=True)
    else:
        d.execute_script("const s=document.createElement('style');s.textContent=arguments[0];document.head.appendChild(s);", STYLES)
        d.execute_script(STUB)
        d.execute_script(FILTER + "\nwindow.Filter = Filter;")
        d.execute_script(CONTENT)
    time.sleep(4)

    note = d.find_element("css selector", ".archiver-bridge-note")
    note.click()
    print("\nafter focus            :", d.execute_script(MEASURE), flush=True)

    for i, word in enumerate(["dfgfdggfd", "dfgdfgfgd", "third line", "fourth line", "fifth line"]):
        if i:
            note.send_keys("\n")
            print(f"  after Enter {i}        :", d.execute_script(MEASURE), flush=True)
        note.send_keys(word)
        print(f"  after typing line {i+1} :", d.execute_script(MEASURE), flush=True)
        # Long enough for the 400ms debounced save, the storage listener and the
        # 250ms MutationObserver to all fire before the next keystroke.
        time.sleep(1.2)
        print(f"  1.2s later            :", d.execute_script(MEASURE), flush=True)

    d.execute_script("document.querySelector('.archiver-bridge-note').blur()")
    time.sleep(1.0)
    print("\nafter blur             :", d.execute_script(MEASURE), flush=True)

    # --- case 2: ONE long run of characters, no Enter at all -----------------
    # Keyboard-mashing wraps into several visual lines without ever firing a
    # newline; if growth keys off anything line-shaped it misses this entirely.
    print("\n=== case 2: long wrapped text, no newlines ===", flush=True)
    note.click()
    print("  after focus (empty-ish):", d.execute_script(MEASURE), flush=True)
    for chunk in ["dfgfdggfd ", "dfgdfgfgd ", "sdkfjhskdjfh ", "qwertyuiopasdfgh ", "zxcvbnmqwerty "]:
        note.send_keys(chunk)
        time.sleep(1.0)
        print(f"  +{chunk!r:<20}:", d.execute_script(MEASURE), flush=True)

    # --- case 3: focusing a note that ALREADY has several lines --------------
    print("\n=== case 3: re-focusing a note that already has lines ===", flush=True)
    d.execute_script("document.querySelector('.archiver-bridge-note').blur()")
    time.sleep(1.0)
    print("  blurred                :", d.execute_script(MEASURE), flush=True)
    note.click()
    time.sleep(1.0)
    print("  re-focused             :", d.execute_script(MEASURE), flush=True)

    # --- case 4: keep typing after it has already grown once -----------------
    print("\n=== case 4: more text on top of an already-grown box ===", flush=True)
    for chunk in ["MORE ", "AND MORE ", "AND EVEN MORE "]:
        note.send_keys(chunk)
        time.sleep(1.0)
        print(f"  +{chunk!r:<20}:", d.execute_script(MEASURE), flush=True)
finally:
    d.quit()
    shutil.rmtree(tmp, ignore_errors=True)
