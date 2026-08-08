# End-to-end test of the content script against LIVE Airbnb.
# Injects the real content.js with an in-memory Store/browser stub, then drives
# the curated panel + map tagging + pin colouring. Text-only assertions.

import time, pathlib, sys, re
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from lib_stub import STUB, INJECT_CSS

FILTER = (ROOT / "extension" / "filter.js").read_text(encoding="utf-8")
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
STYLES = (ROOT / "extension" / "content.css").read_text(encoding="utf-8")
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true")


opts = Options(); opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
opts.add_argument("-headless"); opts.set_preference("intl.accept_languages", "en-US,en")

results = []
def check(label, cond, extra=""):
    results.append(bool(cond)); print(("PASS" if cond else "FAIL") + "  " + label + (("  " + extra) if extra else ""), flush=True)

d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1400, 950); d.get(URL)
    for _ in range(45):
        if d.execute_script('return document.querySelectorAll(\'a[href*="/rooms/"]\').length'): break
        time.sleep(1)
    for _ in range(25):
        if d.execute_script("return document.querySelectorAll('gmp-advanced-marker').length"): break
        time.sleep(1)

    # execute_script bodies are function-scoped, so re-export filter.js's `const
    # Filter` as a global (in the real extension both files share one scope).
    d.execute_script(INJECT_CSS, STYLES)
    d.execute_script(STUB); d.execute_script(FILTER + "\nwindow.Filter = Filter;")
    d.execute_script(CONTENT); time.sleep(1.5)

    check("panel shown with empty state", d.execute_script(
        "const p=document.querySelector('.archiver-panel'); return !!p && p.style.display!=='none' && !!document.querySelector('.archiver-panel-empty')"))

    # Seed two tagged listings -> panel renders rows with category backgrounds
    d.execute_script("""
      window.__cats={starred:{A:{title:'Alpha',price:'$1',url:'https://www.airbnb.com/rooms/A',ts:2}},
                     maybe:{B:{title:'Beta',price:'$2',url:'https://www.airbnb.com/rooms/B',ts:1}}, archived:{}};
      window.__ls.forEach(f=>f({starred:{}}));
    """); time.sleep(0.6)
    check("panel lists starred + maybe rows", d.execute_script("return document.querySelectorAll('.archiver-row').length")==2)
    check("rows coloured by category", d.execute_script(
        "return !!document.querySelector('.archiver-row--starred') && !!document.querySelector('.archiver-row--maybe')"))

    # Custom order respected
    d.execute_script("window.__order=['B','A']; window.__ls.forEach(f=>f({order:{}}));"); time.sleep(0.5)
    check("custom order applied", d.execute_script("return document.querySelector('.archiver-row').dataset.id")=="B")

    # --- row layout: square photo on the left half, meta on the right --------
    geom = d.execute_script("""
      const row=document.querySelector('.archiver-row');
      const m=row.querySelector('.archiver-media'), t=row.querySelector('.archiver-row-meta');
      if(!m||!t) return null;
      const rr=row.getBoundingClientRect(), mr=m.getBoundingClientRect(), tr=t.getBoundingClientRect();
      return {rw:rr.width, mw:mr.width, mh:mr.height, tw:tr.width, mleft:mr.left-rr.left, tleft:tr.left-mr.right};
    """)
    check("row has media + meta halves", geom is not None, str(geom))
    if geom:
        check("photo takes the left half", abs(geom["mw"]/geom["rw"] - 0.5) < 0.06 and geom["mleft"] < 2, f"{geom['mw']:.0f}/{geom['rw']:.0f}")
        check("photo is square", abs(geom["mw"] - geom["mh"]) <= 2, f"{geom['mw']:.0f}x{geom['mh']:.0f}")
        check("meta sits to the right of the photo", geom["tleft"] >= -1 and geom["tw"] > 40)

    # --- headline is the 30-night normalised price, not "Listing <id>" -------
    d.execute_script("""
      window.__prices={A:{symbol:'$',nights:14,total:563.58,nightly:40.26,monthly:1208}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.5)
    head = d.execute_script("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A'); return r?r.querySelector('.archiver-row-price').textContent:'';")
    sub = d.execute_script("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A'); return r?r.querySelector('.archiver-row-sub').textContent:'';")
    check("headline shows price per 30 nights", "$1,208" in head and "30 nights" in head, repr(head))
    check("no 'Listing <id>' title anywhere", d.execute_script("return !/Listing \\d/.test(document.querySelector('.archiver-panel').innerText)"))
    per = d.execute_script("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A'); return r?r.querySelector('.archiver-row-perday').textContent:'';")
    check("per-night shown on its own line", "$40" in per and "night" in per, repr(per))

    # --- the period you actually selected ------------------------------------
    # Airbnb spells the dates checkin/checkout, with NO underscore, and only the
    # underscored forms were listed as price-context keys. So probeUrl dropped
    # them, every probe asked Airbnb with no dates, and Airbnb answered with its
    # dateless default quote: every row read "for 5 nights" no matter what period
    # was selected. The row must quote the stay you chose, and must never dress a
    # default quote up as one.
    orig_url = d.execute_script("return location.href")
    stay_of = ("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A');"
               " return r?r.querySelector('.archiver-row-stay').textContent:'';")
    stale_of = ("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A');"
                " return r?r.querySelector('.archiver-row-price').classList.contains('archiver-row-price--stale'):null;")
    d.execute_script("""
      const u=new URL(location.href);
      u.searchParams.set('checkin','2026-09-01'); u.searchParams.set('checkout','2026-09-15');
      history.replaceState(null,'',u.toString());
      window.__prices={A:{symbol:'$',nights:14,total:563.58,nightly:40.26,monthly:1208,
                          ctx:Filter.ctxOf(location.href),probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.7)
    stay = d.execute_script(stay_of)
    head2 = d.execute_script("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A'); return r?r.querySelector('.archiver-row-price').textContent:'';")
    check("row quotes the selected period, not a default", "$564" in stay and "14 nights" in stay, repr(stay))
    check("and names the dates it covers", "1-15 Sep" in stay, repr(stay))
    check("headline is still the 30-night comparison figure", "$1,208" in head2 and "30 nights" in head2, repr(head2))
    check("a quote matching the selection is not stale", d.execute_script(stale_of) is False)

    # A quote for a different number of nights is stale even when the context
    # string happens to line up.
    d.execute_script("""
      window.__prices={A:{symbol:'$',nights:5,total:200,nightly:40,monthly:1200,
                          ctx:Filter.ctxOf(location.href),probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.7)
    check("a quote for the wrong period is flagged stale", d.execute_script(stale_of) is True,
          repr(d.execute_script(stay_of)))

    # No dates chosen: Airbnb still quotes something, but calling it "5 nights"
    # would be inventing a period the user never picked.
    d.execute_script("""
      history.replaceState(null,'',arguments[0]);
      window.__prices={A:{symbol:'$',nights:5,total:200,nightly:40,monthly:1200,
                          ctx:Filter.ctxOf(location.href),probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """, orig_url); time.sleep(0.7)
    stay = d.execute_script(stay_of)
    check("with no dates it says so instead of inventing a period",
          stay.strip() == "no dates selected", repr(stay))
    d.execute_script("""
      window.__prices={A:{symbol:'$',nights:14,total:563.58,nightly:40.26,monthly:1208}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.5)
    check("price headline links to the room", d.execute_script(
        "const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A'); return r.querySelector('a.archiver-row-price').href.includes('/rooms/')"))
    check("row has a Go-to-property button", d.execute_script(
        "const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A'); const p=r&&r.querySelector('a.archiver-host-prop'); return !!p && /\\/rooms\\//.test(p.href);"))

    # The pets flag is still read and cached (see the host block below), but the
    # user asked for no badge in the row -- so there must not be one.
    d.execute_script("window.__hosts={A:{name:'Barbara',pets:true}}; window.__ls.forEach(f=>f({hosts:{}}));")
    time.sleep(0.6)
    check("no pets badge rendered in the row", d.execute_script(
        "return !document.querySelector('.archiver-pets')"))
    check("a known pets flag stays out of the row text", d.execute_script(
        "const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A');"
        "return r ? !/pets/i.test(r.innerText) : false;"),
        d.execute_script("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A'); return r?r.innerText.replace(/\\n/g,' | '):''"))
    d.execute_script("window.__hosts={}; window.__ls.forEach(f=>f({hosts:{}}));"); time.sleep(0.4)

    # --- carousel actually cycles -------------------------------------------
    d.execute_script("""
      window.__images={A:['https://a0.muscache.com/im/x1.jpg','https://a0.muscache.com/im/x2.jpg','https://a0.muscache.com/im/x3.jpg']};
      window.__ls.forEach(f=>f({images:{}}));
    """); time.sleep(0.5)
    car = d.execute_script("""
      const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='A');
      const img=r.querySelector('.archiver-media-img'), next=r.querySelector('.archiver-cnav--next'), prev=r.querySelector('.archiver-cnav--prev');
      const cnt=r.querySelector('.archiver-media-count');
      if(!next||!prev||!cnt) return {ok:false};
      const first=img.getAttribute('src'), c0=cnt.textContent;
      next.click(); const second=img.getAttribute('src'), c1=cnt.textContent;
      next.click(); const third=img.getAttribute('src');
      prev.click(); const back=img.getAttribute('src');
      return {ok:true, first, second, third, back, c0, c1};
    """)
    check("carousel has nav + counter", car and car.get("ok"), str(car))
    if car and car.get("ok"):
        check("next advances the photo", car["second"] != car["first"] and car["third"] != car["second"], f"{car['first']} -> {car['second']}")
        check("prev goes back", car["back"] == car["second"])
        check("counter tracks position", car["c0"] == "1/3" and car["c1"] == "2/3", f"{car['c0']} {car['c1']}")

    # --- carousels keep their place while prices land -------------------------
    # A price probe writing to storage used to rebuild every row, snapping each
    # carousel back to photo 1 -- which read as "jumping to previous images".
    d.execute_script("""
      window.__cats={starred:{
        P1:{title:'P1',price:'$1',url:'https://www.airbnb.com/rooms/P1',ts:3},
        P2:{title:'P2',price:'$2',url:'https://www.airbnb.com/rooms/P2',ts:2},
        P3:{title:'P3',price:'$3',url:'https://www.airbnb.com/rooms/P3',ts:1}},maybe:{},archived:{}};
      window.__images={P1:['a1.jpg','a2.jpg','a3.jpg'],P2:['b1.jpg','b2.jpg','b3.jpg'],P3:['c1.jpg','c2.jpg','c3.jpg']};
      window.__prices={}; window.__tagcoords={}; window.__order=['P1','P2','P3'];
      window.__settings.showAllPlaces=true;
      window.__ls.forEach(f=>f({starred:{}}));
    """); time.sleep(0.8)

    # Each row must show ITS OWN photos, not a shared set.
    srcs = d.execute_script("""
      return [...document.querySelectorAll('.archiver-row')].map(r=>({
        id:r.dataset.id, src:(r.querySelector('.archiver-media-img')||{}).getAttribute('src')}));
    """)
    check("each row shows its own photos", len(set(s["src"] for s in srcs)) == len(srcs) and len(srcs) == 3, str(srcs))
    check("photos match the right listing",
          all(s["src"].startswith({"P1": "a", "P2": "b", "P3": "c"}[s["id"]]) for s in srcs), str(srcs))

    # Advance two carousels, then land a price like a probe would.
    d.execute_script("""
      const rows=[...document.querySelectorAll('.archiver-row')];
      rows[0].querySelector('.archiver-cnav--next').click();
      rows[0].querySelector('.archiver-cnav--next').click();
      rows[1].querySelector('.archiver-cnav--next').click();
    """)
    before = d.execute_script("return [...document.querySelectorAll('.archiver-media-img')].map(i=>i.getAttribute('src'))")
    check("carousels advanced", before[0] == "a3.jpg" and before[1] == "b2.jpg", str(before))

    d.execute_script("""
      window.__prices={P1:{symbol:'$',monthly:1500,nightly:50,basis:'monthly',ctx:'',probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.8)
    after = d.execute_script("return [...document.querySelectorAll('.archiver-media-img')].map(i=>i.getAttribute('src'))")
    check("a price landing does NOT reset the carousels", after == before, f"{before} -> {after}")
    check("the price actually updated in place",
          "$1,500" in d.execute_script("return document.querySelector('.archiver-row .archiver-row-price').textContent"),
          d.execute_script("return document.querySelector('.archiver-row .archiver-row-price').textContent"))

    # Typing a note must survive a price landing too (no rebuild = no lost caret).
    d.execute_script("const t=document.querySelector('.archiver-row .archiver-note'); t.focus(); t.value='typing';")
    d.execute_script("""
      window.__prices={P2:{symbol:'$',monthly:999,nightly:33,basis:'monthly',ctx:'',probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.8)
    check("note keeps focus while a price lands",
          d.execute_script("return document.activeElement && document.activeElement.classList.contains('archiver-note')"))

    # --- per-night shown alongside per-30-nights ------------------------------
    d.execute_script("""
      window.__prices={P1:{symbol:'$',monthly:1935,nightly:64.5,basis:'monthly',original:2662,ctx:'',probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.6)
    row = d.execute_script("""
      const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='P1');
      return {head:r.querySelector('.archiver-row-price').textContent,
              per:(r.querySelector('.archiver-row-perday')||{}).textContent,
              sub:r.querySelector('.archiver-row-sub').textContent};
    """)
    check("shows price per 30 nights", "$1,935" in row["head"] and "30 nights" in row["head"], str(row))
    check("ALSO shows price per night", "$65" in row["per"] and "night" in row["per"], str(row))
    # This line used to read "Airbnb monthly rate  ·  was $2,662", which says
    # nothing you can act on: not what triggers the discount, not how big it is.
    check("no useless 'monthly rate' wording", "monthly rate" not in row["sub"], str(row))
    check("an un-itemised reduction still says it is reduced",
          "reduced from $2,662" in row["sub"], str(row))

    # --- what the discount actually is ---------------------------------------
    # From how many nights it starts, what percentage it takes off, and what that
    # is in money. Thresholds verified live (scripts/recon_thresh.py): nothing at
    # 6 nights, weekly at exactly 7, monthly at exactly 28.
    d.execute_script("""
      window.__prices={P1:{symbol:'$',monthly:1128,nightly:37.6,total:330.65,nights:11,basis:'stay',
        discount:{label:'Weekly stay discount',kind:'weekly',minNights:7,amount:58.35,base:389,pct:15},
        ctx:'',probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.6)
    sub = d.execute_script("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='P1'); return r.querySelector('.archiver-row-sub').textContent;")
    check("discount says from how many nights", "7+ nights" in sub, repr(sub))
    check("discount says the percentage", "15% off" in sub, repr(sub))
    check("discount says the money", "saves $58" in sub, repr(sub))

    d.execute_script("""
      window.__prices={P1:{symbol:'$',monthly:781,nightly:26,total:728.55,nights:28,basis:'stay',
        discount:{label:'Monthly stay discount',kind:'monthly',minNights:28,amount:195.45,base:924,pct:21},
        ctx:'',probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.6)
    sub = d.execute_script("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='P1'); return r.querySelector('.archiver-row-sub').textContent;")
    check("a monthly discount reports its own threshold",
          "28+ nights" in sub and "21% off" in sub and "saves $195" in sub, repr(sub))

    d.execute_script("""
      window.__prices={P1:{symbol:'$',monthly:1065,nightly:35.5,total:213,nights:6,basis:'stay',
        discount:null,ctx:'',probedAt:Date.now()}};
      window.__ls.forEach(f=>f({prices:{}}));
    """); time.sleep(0.6)
    sub = d.execute_script("const r=[...document.querySelectorAll('.archiver-row')].find(x=>x.dataset.id==='P1'); return r.querySelector('.archiver-row-sub').textContent;")
    check("no discount -> the line claims none", sub.strip() == "", repr(sub))

    # --- the list scrolls ----------------------------------------------------
    d.execute_script("""
      const s={},m={};
      for(let i=0;i<25;i++) s['s'+i]={title:'T'+i,price:'$'+i,url:'https://www.airbnb.com/rooms/'+i,ts:i};
      window.__cats={starred:s,maybe:m,archived:{}}; window.__order=[];
      window.__ls.forEach(f=>f({starred:{}}));
    """); time.sleep(1.0)
    scroll = d.execute_script("""
      const p=document.querySelector('.archiver-panel');
      const l=document.querySelector('.archiver-panel-list');
      const map=document.querySelector('[data-testid="map/GoogleMap"]');
      const over=l.scrollHeight-l.clientHeight;
      const mapBefore=map?Math.round(map.getBoundingClientRect().top):null;
      l.scrollTop=400; const moved=l.scrollTop;
      const mapAfter=map?Math.round(map.getBoundingClientRect().top):null;
      l.scrollTop=0;
      return {over, moved, clientH:l.clientHeight, rows:document.querySelectorAll('.archiver-row').length,
              inFlow: !p.classList.contains('archiver-panel-overlay'),
              position: getComputedStyle(p).position,
              panelH: Math.round(p.getBoundingClientRect().height),
              mapBefore, mapAfter, vh: window.innerHeight};
    """)
    if scroll["inFlow"]:
        # The panel used to grow to the full height of the list and let the PAGE
        # scroll, exactly as Airbnb's cards did. With a long saved list that meant
        # scrolling the map off screen to reach the bottom of your own list. It is
        # now pinned to the viewport and the LIST scrolls inside it.
        check("in flow: panel is pinned to the viewport", scroll["position"] == "sticky"
              and scroll["panelH"] <= scroll["vh"] + 1, str(scroll))
        check("in flow: the list is its own scrollbox", scroll["over"] > 100 and scroll["moved"] == 400, str(scroll))
        check("in flow: every row is laid out", scroll["rows"] == 25, str(scroll))
        check("in flow: scrolling the list leaves the map alone",
              scroll["mapBefore"] == scroll["mapAfter"], str(scroll))

        # Firefox on Windows draws an overlay scrollbar that reserves no width and
        # fades out, and no CSS changes that, so the panel draws its own.
        bar = d.execute_script("""
          const p=document.querySelector('.archiver-panel');
          const b=p.querySelector('.archiver-sbar'), t=p.querySelector('.archiver-sbar-thumb');
          const l=p.querySelector('.archiver-panel-list');
          if(!b||!t) return {found:false};
          const br=b.getBoundingClientRect(), pr=p.getBoundingClientRect();
          const top0=t.getBoundingClientRect().top-br.top;
          l.scrollTop=l.scrollHeight; l.dispatchEvent(new Event('scroll'));
          const th=t.getBoundingClientRect().height;
          const top1=t.getBoundingClientRect().top-br.top;
          b.dispatchEvent(new PointerEvent('pointerdown',{clientY:br.top+br.height*0.5,bubbles:true}));
          const jumped=Math.round(l.scrollTop), halfway=Math.round((l.scrollHeight-l.clientHeight)*0.5);
          l.scrollTop=0; l.dispatchEvent(new Event('scroll'));
          return {found:true, hidden:b.hidden, w:Math.round(br.width),
                  inside: br.right<=pr.right+1, thumbAtTop:Math.round(top0),
                  thumbAtBottom:Math.round(top1), endsAtBottom:Math.abs((top1+th)-br.height)<3,
                  jumped, halfway, backToTop:Math.round(t.getBoundingClientRect().top-br.top)};
        """)
        check("the list has a visible scrollbar", bar["found"] and not bar["hidden"]
              and bar["w"] >= 6 and bar["inside"], str(bar))
        check("its thumb tracks the scroll position", bar["thumbAtTop"] == 0
              and bar["endsAtBottom"] and bar["backToTop"] == 0, str(bar))
        check("clicking the track jumps there", abs(bar["jumped"] - bar["halfway"]) <= 2, str(bar))

        # --- collapsing a row ------------------------------------------------
        col = d.execute_script("""
          const rows=[...document.querySelectorAll('.archiver-row')];
          const r=rows[0], id=r.dataset.id;
          const h0=Math.round(r.getBoundingClientRect().height);
          const btn=r.querySelector('.archiver-collapse');
          if(!btn) return {found:false};
          btn.click();
          const h1=Math.round(r.getBoundingClientRect().height);
          const after=[...document.querySelectorAll('.archiver-row')].map(x=>x.dataset.id);
          const handle=r.querySelector('.archiver-handle');
          return {found:true, before:h0, after:h1, id, firstStill:after[0]===id,
                  order:after.slice(0,4),
                  collapsedClass:r.classList.contains('archiver-row--collapsed'),
                  handleUsable: !!handle && handle.getBoundingClientRect().width>0,
                  photoKept: r.querySelector('.archiver-media').getBoundingClientRect().height>0,
                  tabsHidden: r.querySelector('.archiver-tabbed').getBoundingClientRect().height===0,
                  persisted: Object.keys(window.__collapsed||{})};
        """)
        check("a row can be collapsed", col["found"] and col["collapsedClass"]
              and col["after"] < col["before"] / 2, str(col))
        check("collapsing keeps the row where it was", col["firstStill"], str(col))
        check("a collapsed row can still be dragged", col["handleUsable"], str(col))
        check("it keeps its photo and loses the tall parts",
              col["photoKept"] and col["tabsHidden"], str(col))
        check("the collapsed state is saved", col["persisted"] == [col["id"]], str(col))
        colAll = d.execute_script("""
          const b=document.querySelector('.archiver-collapse-all');
          const l=document.querySelector('.archiver-panel-list');
          if(!b) return {found:false};
          const h0=l.scrollHeight, label0=b.textContent;
          b.click();
          const n=document.querySelectorAll('.archiver-row--collapsed').length;
          const h1=l.scrollHeight, label1=b.textContent;
          b.click();
          return {found:true, h0, h1, label0, label1, collapsed:n,
                  total:document.querySelectorAll('.archiver-row').length,
                  expandedAgain:document.querySelectorAll('.archiver-row--collapsed').length};
        """)
        check("one button collapses the whole list", colAll["found"]
              and colAll["collapsed"] == colAll["total"] and colAll["h1"] < colAll["h0"] / 3, str(colAll))
        check("and expands it again", colAll["expandedAgain"] == 0
              and colAll["label0"] == "Collapse" and colAll["label1"] == "Expand", str(colAll))
        d.execute_script("window.__collapsed={}; window.__ls.forEach(f=>f({collapsed:{}}));")
        time.sleep(0.5)
        # Airbnb's "1 2 3 4 5" pager pages through THEIR results, not ours -- with
        # the grid replaced it offers pages of nothing. It must go with the grid.
        pager = d.execute_script("""
          const nav=[...document.querySelectorAll('nav')].find(n =>
            [...n.querySelectorAll('a,button')].filter(e=>/^\\s*\\d+\\s*$/.test(e.textContent||'')).length >= 2
            && n.querySelector('a[href*="/s/"],a[href*="cursor"],a[href*="items_offset"]'));
          if (!nav) return {found:false};
          return {found:true, display:getComputedStyle(nav).display,
                  h:Math.round(nav.getBoundingClientRect().height)};
        """)
        if pager["found"]:
            check("in flow: Airbnb's pager is hidden", pager["display"] == "none" and pager["h"] == 0, str(pager))
        else:
            print("SKIP  no Airbnb pager rendered on this page", flush=True)
    else:
        check("list overflows its panel", scroll["over"] > 200, str(scroll))
        check("list actually scrolls", scroll["moved"] > 100, f"scrollTop={scroll['moved']}")

    # --- drag handle reorders ------------------------------------------------
    drag = d.execute_script("""
      const l=document.querySelector('.archiver-panel-list'); l.scrollTop=0;
      const rows=[...l.querySelectorAll('.archiver-row')]; const before=rows.map(r=>r.dataset.id);
      const row=rows[0], h=row.querySelector('.archiver-handle');
      if(!h) return {ok:false};
      const hr=h.getBoundingClientRect();
      const x=hr.left+5, y=hr.top+5;
      const rowH=row.getBoundingClientRect().height;
      const ev=(t,cy,el)=>el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:cy,button:0,buttons:1,pointerId:1}));
      ev('pointerdown',y,h);
      for(let k=1;k<=8;k++) ev('pointermove', y+(rowH*2.2*k/8), window);
      ev('pointerup', y+rowH*2.2, window);
      const after=[...l.querySelectorAll('.archiver-row')].map(r=>r.dataset.id);
      return {ok:true, before:before.slice(0,4), after:after.slice(0,4),
              saved:(window.__order||[]).slice(0,4), savedLen:(window.__order||[]).length,
              rowCount:after.length, transform:row.style.transform};
    """)
    check("drag handle present", drag.get("ok"), str(drag))
    if drag.get("ok"):
        check("dragging reorders the rows", drag["before"] != drag["after"] and drag["after"][0] != drag["before"][0], f"{drag['before']} -> {drag['after']}")
        check("dragged row moved down past neighbours", drag["before"][0] in drag["after"][1:], str(drag["after"]))
        check("new order persisted", drag["saved"] == drag["after"], f"saved={drag['saved']}")
        check("persisted order keeps every listing", drag["savedLen"] == drag["rowCount"], f"{drag['savedLen']} vs {drag['rowCount']}")
        check("transform cleared on drop", not drag["transform"], repr(drag["transform"]))

    # Reordering while the map filters the list must not drop the hidden ones.
    part = d.execute_script("""
      window.__cats={starred:{
        A1:{title:'A1',coord:'-25.29,-57.57',ts:5}, A2:{title:'A2',coord:'-25.28,-57.56',ts:4},
        FAR1:{title:'F1',coord:'31.77,35.21',ts:3}, FAR2:{title:'F2',coord:'48.86,2.35',ts:2}},
        maybe:{},archived:{}};
      window.__tagcoords={A1:{lat:-25.29,lng:-57.57},A2:{lat:-25.28,lng:-57.56},
                          FAR1:{lat:31.77,lng:35.21},FAR2:{lat:48.86,lng:2.35}};
      window.__order=['A1','FAR1','A2','FAR2'];
      window.__settings.showAllPlaces=false;   // this block is about the map filter
      window.__ls.forEach(f=>f({starred:{}}));
      return null;
    """); time.sleep(0.8)
    part = d.execute_script("""
      const l=document.querySelector('.archiver-panel-list');
      const rows=[...l.querySelectorAll('.archiver-row')];
      const visible=rows.map(r=>r.dataset.id);
      if(visible.length!==2) return {ok:false, visible};
      const row=rows[0], h=row.querySelector('.archiver-handle');
      const hr=h.getBoundingClientRect(), x=hr.left+5, y=hr.top+5;
      const rowH=row.getBoundingClientRect().height;
      const ev=(t,cy,el)=>el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:cy,button:0,buttons:1,pointerId:1}));
      ev('pointerdown',y,h);
      for(let k=1;k<=6;k++) ev('pointermove', y+(rowH*1.2*k/6), window);
      ev('pointerup', y+rowH*1.2, window);
      return {ok:true, visible, after:[...l.querySelectorAll('.archiver-row')].map(r=>r.dataset.id), saved:window.__order};
    """)
    check("filtered list shows only in-view rows", part.get("ok"), str(part))
    if part.get("ok"):
        check("visible rows swapped", part["after"] == ["A2", "A1"], str(part["after"]))
        check("hidden listings survive the reorder", sorted(part["saved"]) == ["A1", "A2", "FAR1", "FAR2"], str(part["saved"]))
        check("hidden listings keep their slots", part["saved"] == ["A2", "FAR1", "A1", "FAR2"], str(part["saved"]))

    # --- geo filter: only listings inside the current map view --------------
    # ASU is inside the search URL's ne/sw box, JER (Jerusalem) is not, NOLOC
    # has no coordinate on record.
    d.execute_script("""
      window.__cats={starred:{
        ASU:{title:'Asuncion',price:'$1',url:'https://www.airbnb.com/rooms/ASU',coord:'-25.29,-57.57',ts:3},
        JER:{title:'Jerusalem',price:'$2',url:'https://www.airbnb.com/rooms/JER',coord:'31.77,35.21',ts:2},
        NOLOC:{title:'Unknown',price:'$3',url:'https://www.airbnb.com/rooms/NOLOC',ts:1}},
        maybe:{},archived:{}};
      window.__tagcoords={ASU:{lat:-25.29,lng:-57.57},JER:{lat:31.77,lng:35.21}};
      window.__order=['ASU','JER','NOLOC']; window.__settings.showAllPlaces=false;
      window.__ls.forEach(f=>f({starred:{}}));
    """); time.sleep(0.8)
    shown = d.execute_script("return [...document.querySelectorAll('.archiver-row')].map(r=>r.dataset.id)")
    check("far-away listing hidden (Jerusalem not shown in Asuncion)", "JER" not in shown, str(shown))
    check("in-view listing shown", "ASU" in shown, str(shown))
    check("listing with no coordinate still shown", "NOLOC" in shown, str(shown))
    check("header counts what's on this map", "1 of 3 on this map" in d.execute_script(
        "return document.querySelector('.archiver-panel-count').textContent"),
        d.execute_script("return document.querySelector('.archiver-panel-count').textContent"))
    divs = d.execute_script("return [...document.querySelectorAll('.archiver-divider')].map(e=>e.textContent)")
    check("dividers explain what's not listed",
          any("without a saved location" in t for t in divs) and any("1 more elsewhere" in t for t in divs), str(divs))

    # Zooming/panning the map (URL bounds change) re-filters without a reload.
    d.execute_script("""
      const u=new URL(location.href);
      u.searchParams.set('ne_lat','31.80'); u.searchParams.set('ne_lng','35.25');
      u.searchParams.set('sw_lat','31.74'); u.searchParams.set('sw_lng','35.17');
      history.replaceState(null,'',u.toString());
    """); time.sleep(1.6)
    shown = d.execute_script("return [...document.querySelectorAll('.archiver-row')].map(r=>r.dataset.id)")
    check("moving the map to Jerusalem swaps the list", "JER" in shown and "ASU" not in shown, str(shown))

    # A tight zoom that contains nothing -> explicit empty state, not a blank list
    d.execute_script("""
      const u=new URL(location.href);
      u.searchParams.set('ne_lat','48.87'); u.searchParams.set('ne_lng','2.36');
      u.searchParams.set('sw_lat','48.85'); u.searchParams.set('sw_lng','2.33');
      history.replaceState(null,'',u.toString());
    """); time.sleep(1.6)
    shown = d.execute_script("return [...document.querySelectorAll('.archiver-row')].map(r=>r.dataset.id)")
    check("zoomed elsewhere: only the unplaced one remains", shown == ["NOLOC"], str(shown))

    # "Show all" escape hatch
    d.execute_script("window.__settings.showAllPlaces=true; window.__ls.forEach(f=>f({settings:{}}));"); time.sleep(0.8)
    shown = d.execute_script("return [...document.querySelectorAll('.archiver-row')].map(r=>r.dataset.id)")
    check("'Show all' reveals every listing again", sorted(shown)==["ASU","JER","NOLOC"], str(shown))
    check("scope button reflects state", d.execute_script(
        "const b=document.querySelector('.archiver-scope'); return b.classList.contains('on') && b.textContent==='On this map'"))

    # --- distance from a reference place (Booking-style) --------------------
    # Ref point is 0.01 deg of latitude north of ASU, which is 1.11 km, so the
    # row must read "1.1 km". JER is on another continent (whole-km format),
    # and NOLOC has no coordinate, so its distance line must stay hidden.
    d.execute_script(
        "window.__settings.refPlace={lat:-25.28,lng:-57.57,raw:'-25.28, -57.57'};"
        "window.__ls.forEach(f=>f({settings:{}}));"); time.sleep(0.8)
    dist = d.execute_script("""
      const t=id=>{const r=document.querySelector(`.archiver-row[data-id="${id}"] .archiver-row-dist`);
        return r? {text:r.textContent, shown:r.style.display!=='none'} : null;};
      return {ASU:t('ASU'), JER:t('JER'), NOLOC:t('NOLOC')};
    """)
    check("nearby listing shows its distance",
          dist["ASU"] and dist["ASU"]["shown"] and "1.1 km from your place" in dist["ASU"]["text"], str(dist))
    check("far listing shows whole kilometres",
          dist["JER"] and dist["JER"]["shown"] and re.search(r"\d{4,} km", dist["JER"]["text"]), str(dist))
    check("no coordinate -> no distance line",
          dist["NOLOC"] and not dist["NOLOC"]["shown"] and dist["NOLOC"]["text"] == "", str(dist))
    d.execute_script("window.__settings.refPlace=null; window.__ls.forEach(f=>f({settings:{}}));"); time.sleep(0.8)
    check("clearing the place hides every distance", d.execute_script(
        "return [...document.querySelectorAll('.archiver-row-dist')].every(e=>e.style.display==='none'&&e.textContent==='')"))

    # --- the place bar: type an address like on Google Maps -----------------
    # Suggestions and geocoding go through Airbnb's own endpoints, live here on
    # purpose: this is the whole feature, and it must survive Airbnb's side.
    bar = d.execute_script("""
      const b=document.querySelector('.archiver-placebar');
      return {present:!!b,
              aboveList: b? !!b.nextElementSibling && b.nextElementSibling.classList.contains('archiver-panel-list'):false,
              clearHidden: b? b.querySelector('.archiver-place-clear').style.display==='none':null};
    """)
    check("place bar sits between the header and the list", bar["present"] and bar["aboveList"], str(bar))
    check("no place set -> no clear button", bar["clearHidden"] is True, str(bar))
    d.execute_script("""
      const i=document.querySelector('.archiver-place-input');
      i.focus(); i.value='Avenida Mariscal Lopez 3374, Asuncion';
      i.dispatchEvent(new Event('input',{bubbles:true}));
    """)
    sugs = []
    for _ in range(24):
        time.sleep(0.5)
        sugs = d.execute_script("return [...document.querySelectorAll('.archiver-place-sug')].map(b=>b.textContent)")
        if sugs: break
    check("typing an address brings live suggestions", bool(sugs), str(sugs))
    if sugs:
        d.execute_script(
            "document.querySelector('.archiver-place-sug')"
            ".dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))")
        rp = None
        for _ in range(40):
            time.sleep(0.5)
            rp = d.execute_script("return (window.__settings.refPlace)||null")
            if rp: break
        check("picking a suggestion geocodes to real coordinates near Asuncion",
              bool(rp) and abs(rp["lat"] + 25.29) < 0.2 and abs(rp["lng"] + 57.6) < 0.2, str(rp))
        time.sleep(1.0)
        check("rows then show their distance from it", d.execute_script(
            "return [...document.querySelectorAll('.archiver-row-dist')]"
            ".some(e=>e.style.display!=='none' && /(km|m) from your place/.test(e.textContent))"))
        check("the bar shows the picked place and a clear button", d.execute_script(
            "const b=document.querySelector('.archiver-placebar');"
            "return b.querySelector('.archiver-place-input').value.length>0"
            " && b.querySelector('.archiver-place-clear').style.display!=='none'"))
        d.execute_script("document.querySelector('.archiver-place-clear').click()"); time.sleep(0.8)
        check("the x forgets the place", d.execute_script(
            "return !window.__settings.refPlace"
            " && [...document.querySelectorAll('.archiver-row-dist')].every(e=>e.style.display==='none')"))

    d.execute_script("window.__settings.showAllPlaces=false; window.__ls.forEach(f=>f({settings:{}}));"); time.sleep(0.5)

    # restore the original map bounds + the two-row fixture for the remaining checks
    d.execute_script("""
      const u=new URL(location.href);
      u.searchParams.set('ne_lat','-25.26'); u.searchParams.set('ne_lng','-57.55');
      u.searchParams.set('sw_lat','-25.32'); u.searchParams.set('sw_lng','-57.60');
      history.replaceState(null,'',u.toString());
      window.__cats={starred:{A:{title:'Alpha',price:'$1',url:'https://www.airbnb.com/rooms/A',ts:2}},
                     maybe:{B:{title:'Beta',price:'$2',url:'https://www.airbnb.com/rooms/B',ts:1}}, archived:{}};
      window.__tagcoords={}; window.__order=['B','A']; window.__ls.forEach(f=>f({starred:{}}));
    """); time.sleep(0.8)

    # Comment saves via the input listener (debounced ~400ms)
    d.execute_script("""
      const t=document.querySelector('.archiver-row .archiver-note');
      t.value='great view'; t.dispatchEvent(new Event('input',{bubbles:true}));
    """); time.sleep(0.7)
    check("comment saved to notes", "great view" in d.execute_script("return Object.values(window.__notes).join('|')"))

    # Re-rate from the panel: trash a row -> it goes, with a way back.
    # The panel used to archive on the spot with no undo while the map's trash
    # had one; the panel is the surface you actually click, so a misclick there
    # was the easiest way to lose a listing. Both now share archiveWithUndo.
    trash = "const b=[...document.querySelectorAll('.archiver-row .archiver-rowbtn')].find(x=>x.textContent==='🗑'); b&&b.click();"
    d.execute_script(trash)
    time.sleep(0.4)
    mid = d.execute_script("""
      return {rows:[...document.querySelectorAll('.archiver-row')].filter(r=>r.style.display!=='none').length,
              toast:!!document.querySelector('.archiver-toast .archiver-undo'),
              archived:Object.keys(window.__cats.archived).length};
    """)
    check("trash from panel removes the row", mid["rows"] == 1, str(mid))
    check("...and offers an undo before committing", mid["toast"] and mid["archived"] == 0, str(mid))
    d.execute_script("document.querySelector('.archiver-toast .archiver-undo').click();")
    time.sleep(0.4)
    undone = d.execute_script("""
      return {rows:[...document.querySelectorAll('.archiver-row')].filter(r=>r.style.display!=='none').length,
              archived:Object.keys(window.__cats.archived).length};
    """)
    check("undo puts the row back and archives nothing", undone["rows"] == 2 and undone["archived"] == 0, str(undone))
    # Let it through this time: the archive must still actually happen.
    d.execute_script(trash)
    time.sleep(2.2)
    check("trash commits once the undo window elapses",
          d.execute_script("return Object.keys(window.__cats.archived).length") == 1
          and d.execute_script("return document.querySelectorAll('.archiver-row').length") == 1)

    # Map tagging still works: open a pin popup (in-viewport marker), star it
    before = d.execute_script("return Object.keys(window.__cats.starred).length")
    marker = d.execute_script("""
      const h=innerHeight,w=innerWidth;
      return [...document.querySelectorAll('gmp-advanced-marker')].find(m=>{
        if(!/[$€£₲]/.test(m.textContent||''))return false;
        const r=m.getBoundingClientRect();
        return r.width&&r.top>70&&r.top<h-90&&r.left>20&&r.left<w-90;
      })||null;
    """)
    if marker:
        ActionChains(d).move_to_element(marker).pause(0.3).click(marker).perform(); time.sleep(2.4)
        check("map popup has rubric controls", d.execute_script("return document.querySelectorAll('.archiver-actions--map .archiver-star').length")>0)
        d.execute_script("const b=document.querySelector('.archiver-actions--map .archiver-star'); b&&b.click();"); time.sleep(0.5)
        check("starring from map updates store", d.execute_script("return Object.keys(window.__cats.starred).length")>before)

    # Pin colouring: mark a visible marker's coord starred -> a bubble turns blue
    pos = d.execute_script("const m=[...document.querySelectorAll('gmp-advanced-marker')].find(x=>x.style.display!=='none'&&x.getAttribute('position')&&/[$€£₲]/.test(x.textContent||'')); return m?m.getAttribute('position'):null;")
    if pos:
        d.execute_script("""
          const pos=arguments[0]; const [lat,lng]=pos.split(',').map(Number);
          window.__cats={starred:{c:{coord:pos,ts:1}},maybe:{},archived:{}}; window.__tagcoords={c:{lat,lng}};
          window.__ls.forEach(f=>f({starred:{}}));
        """, pos); time.sleep(1.0)
        blue = d.execute_script("""
          let n=0; for(const m of document.querySelectorAll('gmp-advanced-marker')){ if(m.style.display==='none')continue;
            for(const el of m.querySelectorAll('div')){const s=getComputedStyle(el); if(parseFloat(s.borderRadius)>=6 && s.backgroundColor==='rgb(47, 128, 237)'){n++;break;}}}
          return n;""")
        check("starred marker turns blue", blue >= 1, f"blue={blue}")

        # Hovering the panel row lights up that listing's pin (Airbnb's own
        # card->pin link is gone now that our panel replaced its cards).
        hov = d.execute_script("""
          const row=document.querySelector('.archiver-row[data-id="c"]');
          if(!row) return {ok:false, why:'no row'};
          const lit=()=>[...document.querySelectorAll('gmp-advanced-marker')].filter(m=>m.querySelector('.archiver-pill-hover')).length;
          const before=lit();
          row.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));
          const during=lit();
          const z=[...document.querySelectorAll('gmp-advanced-marker')].filter(m=>m.style.zIndex==='9999').length;
          row.dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}));
          const after=lit();
          return {ok:true, before, during, after, z};
        """)
        check("hover highlights the matching pin", hov.get("ok") and hov["before"]==0 and hov["during"]==1 and hov["z"]>=1, str(hov))
        check("un-hover clears the highlight", hov.get("ok") and hov["after"]==0, str(hov))

        # Landing the class is not the same as the pin visibly changing, which is
        # what "hover a row and its pin lights up" actually promises. The pill is
        # Google's own element and carries inline styles plus a 200ms transform
        # transition (a running transition outranks even !important), so measure
        # the pin's real box AFTER the transition settles.
        d.execute_script("""
          document.querySelector('.archiver-row[data-id="c"]')
            .dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));
        """)
        size0 = d.execute_script("""
          const el=document.querySelector('.archiver-pill-hover');
          const r=el?el.getBoundingClientRect():null;
          return r?{w:Math.round(r.width), h:Math.round(r.height)}:null;
        """)
        time.sleep(0.6)
        lit = d.execute_script("""
          const el=document.querySelector('.archiver-pill-hover');
          if(!el) return {err:'not highlighted'};
          const cs=getComputedStyle(el), r=el.getBoundingClientRect();
          return {w:Math.round(r.width), h:Math.round(r.height), transform:cs.transform,
                  scaled: cs.transform.startsWith('matrix(1.3'),
                  ring: cs.outlineWidth==='3px' && cs.outlineColor==='rgb(224, 17, 95)',
                  glow: cs.boxShadow.includes('224, 17, 95')};
        """)
        check("the pin actually grows, not just gains a class",
              lit.get("scaled") and size0 and lit["w"] > size0["w"] + 5, f"{size0} -> {lit}")
        check("and gets a ring you can see across the map",
              lit.get("ring") and lit.get("glow"), str(lit))
        d.execute_script("""
          document.querySelector('.archiver-row[data-id="c"]')
            .dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}));
        """)

    # --- two flats, one coordinate -------------------------------------------
    # Airbnb reports many coordinates rounded to 4dp, which is also the window we
    # match pins in, so listings in one building are indistinguishable by
    # position alone (scripts/test-marker-id.js measures 7 such pairs in one real
    # search). Archiving one used to hide every pin in the building - silently,
    # permanently, and only on the map, so the panel still listed them.
    # Two pins, same position, different prices: only the archived one may go.
    fixture = d.execute_script("""
      const LAT=-25.9999, LNG=-57.9999, pos=LAT+','+LNG;
      const mk=(price,tag)=>{ const m=document.createElement('gmp-advanced-marker');
        m.setAttribute('position',pos); m.dataset.fake=tag;
        const inner=document.createElement('div'); inner.textContent='Flat in Centro '+price;
        m.appendChild(inner); document.body.appendChild(m); return m; };
      const a=mk('$111','A'), b=mk('$222','B');
      return {ok: !!(document.querySelector('gmp-advanced-marker[data-fake="A"]')
                   && document.querySelector('gmp-advanced-marker[data-fake="B"]')),
              lat:LAT, lng:LNG, pos,
              textA:(a.textContent||''), textB:(b.textContent||'')};
    """)
    check("two same-coordinate pins staged", fixture["ok"] and "$111" in fixture["textA"]
          and "$222" in fixture["textB"], str(fixture))
    if fixture["ok"] and "$111" in fixture["textA"]:
        d.execute_script("""
          const f=arguments[0];
          window.__cats={starred:{},maybe:{},archived:{ARCH:{title:'archived flat',
            price:'$111', coord:f.pos, url:'https://www.airbnb.com/rooms/ARCH', ts:1}}};
          window.__tagcoords={ARCH:{lat:f.lat,lng:f.lng}};
          window.__ls.forEach(g=>g({archived:{}}));
        """, fixture)
        time.sleep(1.2)
        state = d.execute_script("""
          const g=t=>document.querySelector('gmp-advanced-marker[data-fake="'+t+'"]');
          return {a:g('A').style.display, b:g('B').style.display,
                  aFor:g('A').dataset.archiverHidden||'', bFor:g('B').dataset.archiverHidden||''};
        """)
        check("the archived flat's pin is hidden", state["a"] == "none" and state["aFor"] == "ARCH", str(state))
        check("its neighbour at the same coordinate is NOT hidden", state["b"] != "none", str(state))

        # And the other half that was missing entirely: unarchiving put nothing
        # back, so the pin stayed gone until Google Maps happened to rebuild it.
        d.execute_script("""
          window.__cats={starred:{},maybe:{},archived:{}};
          window.__ls.forEach(g=>g({archived:{}}));
        """)
        time.sleep(1.2)
        back = d.execute_script("""
          const a=document.querySelector('gmp-advanced-marker[data-fake="A"]');
          return {display:a.style.display, flag:a.dataset.archiverHidden||''};
        """)
        check("unarchiving brings the pin back", back["display"] != "none" and back["flag"] == "", str(back))
    d.execute_script("for(const m of document.querySelectorAll('gmp-advanced-marker[data-fake]')) m.remove();")

    # --- live price probe: refresh a saved listing's price from Airbnb --------
    # Seed a REAL listing (id + coord taken from this page) with no stored price
    # and let the panel probe it. Proves the whole chain: render -> scoped search
    # around the saved coordinate -> parse -> store.
    target = d.execute_script("""
      const out={};
      for (const s of document.querySelectorAll('script[id^="data-deferred-state"]')) {
        try { const h=Filter.harvest(JSON.parse(s.textContent)); for(const k in h) out[k]=h[k]; } catch(e){}
      }
      const id = Object.keys(out).find(k => out[k].coord && out[k].price && out[k].price.monthly!=null);
      return id ? {id, coord: out[id].coord, pageMonthly: out[id].price.monthly} : null;
    """)
    check("found a real listing to probe", target is not None, str(target))
    if target:
        d.execute_script("""
          const t=arguments[0];
          window.__cats={starred:{[t.id]:{title:'probe target',
            url:'https://www.airbnb.com/rooms/'+t.id, coord:t.coord.lat+','+t.coord.lng, ts:1}},
            maybe:{},archived:{}};
          window.__tagcoords={[t.id]:{lat:t.coord.lat,lng:t.coord.lng}};
          window.__prices={}; window.__images={}; window.__order=[];
          window.__settings.showAllPlaces=true;   // don't depend on map bounds here
          window.__ls.forEach(f=>f({starred:{}}));
        """, target)
        got = None
        for _ in range(30):
            got = d.execute_script("return window.__prices[arguments[0]] || null", target["id"])
            if got: break
            time.sleep(1)
        check("probe stored a price for the saved listing", got is not None, str(got))
        if got:
            check("probed price is a real 30-night figure",
                  isinstance(got.get("monthly"), (int, float)) and got["monthly"] > 0, str(got))
            check("probed price matches what the page quotes",
                  got.get("monthly") == target["pageMonthly"], f"probe={got.get('monthly')} page={target['pageMonthly']}")
            check("probed price is stamped with a context", bool(got.get("ctx") is not None and got.get("probedAt")), str(got))
            check("probe also refreshed photos",
                  len(d.execute_script("return (window.__images[arguments[0]]||[])", target["id"])) >= 2,
                  str(d.execute_script("return (window.__images[arguments[0]]||[]).length", target["id"])))
            head = d.execute_script("const r=document.querySelector('.archiver-row'); return r?r.querySelector('.archiver-row-price').textContent:''")
            check("row renders the probed price", "$" in head or any(c.isdigit() for c in head), repr(head))
            check("row is not marked stale after probing", d.execute_script(
                "const a=document.querySelector('.archiver-row .archiver-row-price'); return a && !a.classList.contains('archiver-row-price--stale')"))

        # A probe that comes back with nothing is NOT proof of anything: a login
        # wall, a rate-limit page and a markup change all look identical to it,
        # and all answer 200. So the first empty answer must not be written down
        # as "Unavailable" - it must be retried in the background first.
        # Phase 1: retries parked ten minutes out, so nothing can be concluded.
        d.execute_script("""
          window.__archiverProbeRetryMs=[600000];
          window.__cats={starred:{DEAD1:{title:'gone', url:'https://www.airbnb.com/rooms/DEAD1',
            coord:'-25.0001,-57.0001', ts:1}},maybe:{},archived:{}};
          window.__tagcoords={DEAD1:{lat:-25.0001,lng:-57.0001}};
          window.__prices={}; window.__ls.forEach(f=>f({starred:{}}));
        """)
        early = None
        for _ in range(15):
            time.sleep(1)
            early = d.execute_script("return window.__prices.DEAD1 || null")
            if early: break
        check("an empty probe is not written down as Unavailable on the first try",
              early is None, str(early))
        check("row waits rather than claiming a price it doesn't have",
              "Unavailable" not in d.execute_script(
                  "const r=document.querySelector('.archiver-row'); return r?r.innerText:''"))

        # Phase 2: same nowhere-listing, retries collapsed - once it has said the
        # same thing every time, believe it.
        d.execute_script("""
          window.__archiverProbeRetryMs=[300,300,300];
          window.__cats={starred:{DEAD2:{title:'gone', url:'https://www.airbnb.com/rooms/DEAD2',
            coord:'-25.0002,-57.0002', ts:1}},maybe:{},archived:{}};
          window.__tagcoords={DEAD2:{lat:-25.0002,lng:-57.0002}};
          window.__prices={}; window.__ls.forEach(f=>f({starred:{}}));
        """)
        dead = None
        for _ in range(60):
            dead = d.execute_script("return window.__prices.DEAD2 || null")
            if dead: break
            time.sleep(1)
        check("listing Airbnb won't quote is marked unavailable once retries are spent",
              dead is not None and dead.get("unavailable") is True, str(dead))
        check("unavailable row says so", "Unavailable" in d.execute_script(
            "const r=document.querySelector('.archiver-row'); return r?r.innerText:''"),
            d.execute_script("const r=document.querySelector('.archiver-row'); return r?r.innerText.split('\\n')[0]:''"))
        d.execute_script("delete window.__archiverProbeRetryMs;")

    # --- host name + link to the conversation --------------------------------
    # Real listing id off this page; its host name is fetched live from the room
    # page (that page needs no login, unlike /guest/messages).
    # Must be a DIFFERENT listing from the probe target above: the room page is
    # fetched once per listing per page load, so reusing it would hit that cache
    # and never re-populate the (deliberately cleared) host store.
    real = d.execute_script("""
      const skip = arguments[0];
      const ids = [...document.querySelectorAll('a[href*="/rooms/"]')]
        .map(a => (a.getAttribute('href').match(/\\/rooms\\/(\\d+)/)||[])[1])
        .filter(Boolean);
      return ids.find(i => i !== skip) || null;
    """, (target or {}).get("id"))
    check("found a real listing for the host lookup", bool(real), str(real))
    if real:
        d.execute_script("""
          const id=arguments[0];
          window.__cats={starred:{[id]:{title:'host target',url:'https://www.airbnb.com/rooms/'+id,ts:1}},maybe:{},archived:{}};
          window.__hosts={}; window.__prices={}; window.__order=[];
          window.__settings.showAllPlaces=true;
          window.__ls.forEach(f=>f({starred:{}}));
        """, real)
        # Don't race the fetch: just require the host line to render something
        # from the first paint (the pending state, or an already-resolved name).
        time.sleep(1.0)
        line = d.execute_script("const r=document.querySelector('.archiver-row-host'); return r?r.innerText:''")
        check("host line renders immediately", ("looking up host" in line) or ("Hosted by" in line), repr(line))

        got = None
        for _ in range(30):
            got = d.execute_script("return window.__hosts[arguments[0]] || null", real)
            if got and got.get("name"): break
            time.sleep(1)
        check("host name fetched live from the room page", bool(got and got.get("name")), str(got))
        if got and got.get("name"):
            check("host name rendered in the row", got["name"] in d.execute_script(
                "const r=document.querySelector('.archiver-row-host'); return r?r.innerText:''"),
                d.execute_script("const r=document.querySelector('.archiver-row-host'); return r?r.innerText:''"))
            check("real listing name captured too", bool(got.get("listingName")), str(got))
        # The same room-page fetch also answers "does it allow pets?" -- kept in
        # the store for later use, deliberately NOT shown in the row.
        check("pets flag still read off the same room page", isinstance((got or {}).get("pets"), bool), str(got))
        # With no conversation on record yet, the link falls back to Airbnb's
        # compose form -- and says so, because that is NOT the existing chat.
        chat = d.execute_script("const a=document.querySelector('.archiver-host-chat'); return a?a.getAttribute('href'):''")
        check("with no thread known, falls back to the compose form",
              chat.endswith(f"/contact_host/{real}/send_message"), repr(chat))
        check("fallback link is visibly marked as 'not your chat'", d.execute_script(
            "const a=document.querySelector('.archiver-host-chat');"
            "return a.classList.contains('archiver-host-chat--new') && a.textContent.includes('Message')"))

        # Once the thread is known, the button must go to the REAL conversation.
        d.execute_script("""
          window.__threads={[arguments[0]]:'2592958621'};
          window.__ls.forEach(f=>f({threads:{}}));
        """, real); time.sleep(0.6)
        chat = d.execute_script("const a=document.querySelector('.archiver-host-chat'); return a?a.getAttribute('href'):''")
        check("known thread links straight into the chat",
              chat.endswith("/guest/messages/2592958621"), repr(chat))
        check("and is labelled as an existing chat", d.execute_script(
            "const a=document.querySelector('.archiver-host-chat');"
            "return !a.classList.contains('archiver-host-chat--new') && a.textContent.includes('Chat')"))

    print("\n" + ("ALL PASS" if all(results) else "SOME FAILED"), flush=True)
finally:
    d.quit()
