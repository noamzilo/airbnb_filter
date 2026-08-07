# The Note / Chat tabs at the bottom of every panel row.
#
#   python scripts/test_chat_tab.py
#
# Mechanics only, against a live search page with the usual in-memory Store stub
# (no login needed, so this runs like test_decorator.py). It asserts the tab
# switching, the lazy load, the empty state, and -- the part that is easy to
# break -- that an open conversation is never re-created, because re-inserting an
# iframe anywhere in the DOM would reload the chat and lose your place in it.
#
# That the embedded frame really renders a logged-in conversation is proved
# separately by scripts/test_chat_live.py.

import time, pathlib, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from lib_stub import STUB, INJECT_CSS  # the same stub test_decorator.py runs against

FILTER = (ROOT / "extension" / "filter.js").read_text(encoding="utf-8")
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
STYLES = (ROOT / "extension" / "content.css").read_text(encoding="utf-8")
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true")

results = []
def check(label, cond, extra=""):
    results.append(bool(cond))
    print(("PASS" if cond else "FAIL") + "  " + label + (("  " + extra) if extra else ""), flush=True)

# Two listings, both inside the map box above, so both rows are on screen.
SEED = """
  window.__cats={starred:{A:{title:'Alpha',price:'$1',url:'https://www.airbnb.com/rooms/A',ts:2}},
                 maybe:{B:{title:'Beta',price:'$2',url:'https://www.airbnb.com/rooms/B',ts:1}},archived:{}};
  window.__tagcoords={A:{lat:-25.29,lng:-57.57},B:{lat:-25.29,lng:-57.58}};
  window.__ls.forEach(f=>f({starred:{}}));
"""
ROW = "document.querySelector('.archiver-row[data-id=\"%s\"]')"
def click_tab(d, rid, tab):
    d.execute_script(f"{ROW % rid}.querySelector('.archiver-tab[data-tab=\"{tab}\"]').click();")

def state(d, rid):
    return d.execute_script(f"""
      const row = {ROW % rid}; if (!row) return null;
      const note = row.querySelector('.archiver-note'), chat = row.querySelector('.archiver-chat');
      const f = chat && chat.querySelector('iframe');
      return {{
        tabs: [...row.querySelectorAll('.archiver-tab')].map(b=>b.dataset.tab),
        active: (row.querySelector('.archiver-tab.on')||{{dataset:{{}}}}).dataset.tab,
        noteShown: !!note && note.offsetParent !== null,
        chatShown: !!chat && chat.offsetParent !== null,
        chatH: chat ? Math.round(chat.getBoundingClientRect().height) : 0,
        hasFrame: !!f,
        frameSrc: f ? f.src : null,
        frameStamp: f ? (f.dataset.stamp || null) : null,
        empty: !!(chat && chat.querySelector('.archiver-chat-empty')),
        startHref: (chat && chat.querySelector('.archiver-chat-start') || {{}}).href || null,
      }};
    """)

opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")

d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1400, 950); d.get(URL)
    for _ in range(45):
        if d.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length'): break
        time.sleep(1)
    d.execute_script(INJECT_CSS, STYLES)
    d.execute_script(STUB); d.execute_script(FILTER + "\nwindow.Filter = Filter;")
    d.execute_script(CONTENT); time.sleep(1.5)
    d.execute_script(SEED); time.sleep(0.8)

    # --- the tabs exist, and the note is still what you get by default --------
    s = state(d, "A")
    check("row has both tabs", s and s["tabs"] == ["note", "chat"], str(s and s["tabs"]))
    check("note is the default tab", s["active"] == "note", s["active"])
    check("note is visible, chat is not", s["noteShown"] and not s["chatShown"])
    check("no conversation is loaded until you ask for one", not s["hasFrame"])

    # --- the note still works from inside the tabbed box ----------------------
    d.execute_script(f"""
      const n = {ROW % 'A'}.querySelector('.archiver-note');
      n.value = 'balcony faces the river';
      n.dispatchEvent(new Event('input', {{bubbles:true}}));
    """); time.sleep(0.8)
    check("note still saves", d.execute_script("return window.__notes.A") == "balcony faces the river",
          str(d.execute_script("return window.__notes.A")))

    # --- with no thread on record there is nothing to embed ------------------
    click_tab(d, "A", "chat"); time.sleep(0.5)
    s = state(d, "A")
    check("Chat tab becomes active", s["active"] == "chat", s["active"])
    check("chat pane replaces the note", s["chatShown"] and not s["noteShown"])
    check("chat pane is big enough to read in", s["chatH"] >= 200, f"{s['chatH']}px")
    check("unmessaged listing shows the empty state, not a frame", s["empty"] and not s["hasFrame"])
    check("empty state offers the compose form",
          s["startHref"] and s["startHref"].endswith("/contact_host/A/send_message"), str(s["startHref"]))

    # --- tabs are per row, independent --------------------------------------
    check("the other row is untouched, still on its note",
          state(d, "B")["active"] == "note" and state(d, "B")["noteShown"])

    # --- learning the thread upgrades the pane in place ----------------------
    d.execute_script("window.__threads={A:'2597754369'}; window.__ls.forEach(f=>f({threads:{}}));")
    time.sleep(1.0)
    s = state(d, "A")
    check("a known conversation is embedded", s["hasFrame"] and not s["empty"])
    check("it frames that listing's thread",
          s["frameSrc"] and s["frameSrc"].endswith("/guest/messages/2597754369"), str(s["frameSrc"]))

    # Stamp the live frame so we can tell "same iframe" from "built again".
    d.execute_script(f"{ROW % 'A'}.querySelector('.archiver-chat iframe').dataset.stamp='keep-me';")

    # --- an open chat must survive everything that re-renders the panel ------
    d.execute_script("window.__prices={A:{monthly:900,symbol:'$',ctx:'adults=1'}}; window.__ls.forEach(f=>f({prices:{}}));")
    time.sleep(0.8)
    check("a price landing does not reload the chat", state(d, "A")["frameStamp"] == "keep-me")

    click_tab(d, "A", "note"); time.sleep(0.3); click_tab(d, "A", "chat"); time.sleep(0.4)
    s = state(d, "A")
    check("flipping to the note and back keeps the same conversation", s["frameStamp"] == "keep-me")
    check("and lands back on the chat", s["active"] == "chat" and s["chatShown"])

    # The hard one: a full rebuild, as a map pan that drops the other listing.
    d.execute_script("""
      delete window.__cats.maybe.B;
      window.__ls.forEach(f=>f({maybe:{}}));
    """); time.sleep(1.0)
    check("the dropped row is gone", d.execute_script("return document.querySelectorAll('.archiver-row').length") == 1)
    check("rebuilding the list does NOT reload the surviving chat",
          state(d, "A")["frameStamp"] == "keep-me", str(state(d, "A")["frameStamp"]))
    check("and it is still on the chat tab", state(d, "A")["active"] == "chat")

    # --- reordering is the one case that must still work --------------------
    d.execute_script("""
      window.__cats.maybe.B={title:'Beta',price:'$2',url:'https://www.airbnb.com/rooms/B',ts:1};
      window.__order=['B','A']; window.__ls.forEach(f=>f({order:{}}));
    """); time.sleep(1.0)
    check("reorder still applies", d.execute_script("return document.querySelector('.archiver-row').dataset.id") == "B")
    check("re-adding a row keeps the chat that was already open",
          state(d, "A")["frameStamp"] == "keep-me", str(state(d, "A")["frameStamp"]))

finally:
    d.quit()

print()
print("ALL PASS" if all(results) else f"{results.count(False)} FAILED of {len(results)}")
sys.exit(0 if all(results) else 1)
