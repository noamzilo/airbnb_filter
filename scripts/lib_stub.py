# The in-memory Store / browser stub the content script is injected against.
#
# Selenium's install_addon does not run the extension's content scripts here (see
# docs/closing-the-loop.md), so every browser test injects extension/content.js
# itself with this stub standing in for storage and the background page. Shared
# by test_decorator.py and test_chat_tab.py so the two can't drift apart.

# The real extension ships content.css alongside the script; inject it too, or
# nothing about layout, geometry or scrolling is actually being tested.
INJECT_CSS = "const s=document.createElement('style');s.textContent=arguments[0];document.head.appendChild(s);"

STUB = r"""
window.__cats={starred:{},maybe:{},archived:{}};window.__settings={showArchived:false};
window.__tagcoords={};window.__notes={};window.__order=[];window.__ls=[];
window.__images={};window.__prices={};window.__hosts={};window.__threads={};window.__collapsed={};
const fire=(ch)=>window.__ls.forEach(f=>{try{f(ch||{})}catch(e){}});
const C=["starred","maybe","archived"];
window.browser={storage:{onChanged:{addListener:f=>window.__ls.push(f)}}};
window.Store={
  getAll:async()=>window.__cats,getStarred:async()=>window.__cats.starred,getMaybe:async()=>window.__cats.maybe,getArchived:async()=>window.__cats.archived,
  getCategory:async i=>{for(const c of C)if(window.__cats[c][i])return c;return null;},
  setCategory:async(i,s,c)=>{for(const k of C)delete window.__cats[k][i];if(c)window.__cats[c][i]={...(s||{}),ts:Date.now?1:1};fire({starred:{}});},
  getStarredData:async()=>({}),setStarredData:async()=>{},getTagCoords:async()=>window.__tagcoords||{},
  getHosts:async()=>window.__hosts||{},
  getThreads:async()=>window.__threads||{},
  setThread:async(l,t)=>{window.__threads=window.__threads||{};if(window.__threads[l]===t)return false;window.__threads[l]=t;fire({threads:{}});return true;},
  setHost:async(i,info)=>{if(!info)return false;window.__hosts=window.__hosts||{};window.__hosts[i]={...(window.__hosts[i]||{}),...info};fire({hosts:{}});return true;},
  getImages:async()=>window.__images||{},getPrices:async()=>window.__prices||{},
  setMedia:async(i,im,p,c)=>Store.setMediaBulk({[i]:{images:im,price:p,coord:c}}),
  setMediaBulk:async(e)=>{let n=0;for(const id in e){const v=e[id]||{};
    if(v.images&&v.images.length){window.__images[id]=v.images;n++;}
    if(v.price){window.__prices[id]=v.price;n++;}
    if(v.coord&&isFinite(v.coord.lat)){window.__tagcoords[id]={lat:v.coord.lat,lng:v.coord.lng};n++;}}
    if(n)fire({prices:{}});return n>0;},
  getNotes:async()=>window.__notes,setNote:async(i,t)=>{if(t&&t.trim())window.__notes[i]=t;else delete window.__notes[i];fire({notes:{}});},
  getCollapsed:async()=>window.__collapsed||{},setCollapsed:async(m)=>{window.__collapsed={...m};fire({collapsed:{}});},
  getOrder:async()=>window.__order,setOrder:async(a)=>{window.__order=a;fire({order:{}});},
  getSettings:async()=>window.__settings,setSetting:async(k,v)=>{window.__settings[k]=v;fire({settings:{}});}
};
"""
