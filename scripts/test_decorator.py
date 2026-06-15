# End-to-end test of the content script against LIVE Airbnb.
# Injects the real content.js with an in-memory Store/browser stub, then drives
# the curated panel + map tagging + pin colouring. Text-only assertions.

import time, pathlib, sys
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.action_chains import ActionChains

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTENT = (ROOT / "extension" / "content.js").read_text(encoding="utf-8")
URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes?adults=1"
       "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true")

STUB = r"""
window.__cats={starred:{},maybe:{},archived:{}};window.__settings={showArchived:false};
window.__tagcoords={};window.__notes={};window.__order=[];window.__ls=[];
const fire=(ch)=>window.__ls.forEach(f=>{try{f(ch||{})}catch(e){}});
const C=["starred","maybe","archived"];
window.browser={storage:{onChanged:{addListener:f=>window.__ls.push(f)}}};
window.Store={
  getAll:async()=>window.__cats,getStarred:async()=>window.__cats.starred,getMaybe:async()=>window.__cats.maybe,getArchived:async()=>window.__cats.archived,
  getCategory:async i=>{for(const c of C)if(window.__cats[c][i])return c;return null;},
  setCategory:async(i,s,c)=>{for(const k of C)delete window.__cats[k][i];if(c)window.__cats[c][i]={...(s||{}),ts:Date.now?1:1};fire({starred:{}});},
  getStarredData:async()=>({}),setStarredData:async()=>{},getTagCoords:async()=>window.__tagcoords||{},
  getNotes:async()=>window.__notes,setNote:async(i,t)=>{if(t&&t.trim())window.__notes[i]=t;else delete window.__notes[i];fire({notes:{}});},
  getOrder:async()=>window.__order,setOrder:async(a)=>{window.__order=a;fire({order:{}});},
  getSettings:async()=>window.__settings,setSetting:async(k,v)=>{window.__settings[k]=v;fire({settings:{}});}
};
"""

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

    d.execute_script(STUB); d.execute_script(CONTENT); time.sleep(1.5)

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

    # Comment saves (and does NOT rebuild the row -> keeps focus)
    d.execute_script("const t=document.querySelector('.archiver-row .archiver-note'); t.focus(); t.value=''; ")
    ActionChains(d).send_keys("great view").perform(); time.sleep(0.7)
    check("comment saved to notes", d.execute_script("return Object.values(window.__notes).join('|')").find("great view") >= 0)

    # Re-rate from the panel: trash a row -> leaves the panel
    d.execute_script("const b=[...document.querySelectorAll('.archiver-row .archiver-rowbtn')].find(x=>x.textContent==='🗑'); b&&b.click();")
    time.sleep(0.5)
    check("trash from panel removes the row", d.execute_script("return document.querySelectorAll('.archiver-row').length")==1)

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

    print("\n" + ("ALL PASS" if all(results) else "SOME FAILED"), flush=True)
finally:
    d.quit()
