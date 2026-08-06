// Diagnostic: why isn't the curated panel's list scrolling?
const p = document.querySelector('.archiver-panel');
const l = document.querySelector('.archiver-panel-list');
const h = document.querySelector('.archiver-panel-head');
const map = document.querySelector('[data-testid="map/GoogleMap"]')
  || document.querySelector('[aria-roledescription="map"]')
  || document.querySelector('[aria-label="Map"]');
const cs = (e) => e ? getComputedStyle(e) : null;
const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
const ps = cs(p), ls = cs(l);
return {
  win: { w: innerWidth, h: innerHeight },
  mapBox: box(map),
  panelInline: p ? { top: p.style.top, height: p.style.height, width: p.style.width, display: p.style.display } : null,
  panelComputed: ps ? { display: ps.display, flexDirection: ps.flexDirection, height: ps.height, overflow: ps.overflow, position: ps.position } : null,
  panelBox: box(p),
  headBox: box(h),
  listComputed: ls ? { display: ls.display, flex: ls.flex, minHeight: ls.minHeight, overflowY: ls.overflowY, height: ls.height } : null,
  listBox: box(l),
  listScroll: l ? { scrollH: l.scrollHeight, clientH: l.clientHeight } : null,
  rows: document.querySelectorAll('.archiver-row').length,
  sheetSeen: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.selectorText === '.archiver-panel-list'); } catch (e) { return false; } }),
};
