// Diagnostic probe: did the content script load? where are the price pills?
const map = document.querySelector('[data-testid="map/GoogleMap"]')
  || document.querySelector('[aria-roledescription="map"]');
const mr = map && map.getBoundingClientRect();

function loc(e) {
  const r = e.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return {
    x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    inMap: mr ? (cx >= mr.left && cx <= mr.right && cy >= mr.top && cy <= mr.bottom) : false,
  };
}

const cur = [...document.querySelectorAll('button,[role=button],div,span')].filter(e => {
  const t = e.textContent || '';
  if (!/[$€£₲]/.test(t)) return false;
  const r = e.getBoundingClientRect();
  return r.width > 16 && r.width < 220 && r.height > 10 && r.height < 80 && e.children.length <= 2;
});

return {
  loaded: document.documentElement.getAttribute('data-archiver-loaded'),
  doneCount: document.querySelectorAll('[data-archiver-done]').length,
  actions: document.querySelectorAll('.archiver-actions').length,
  win: { w: window.innerWidth, h: window.innerHeight },
  mapRect: mr ? { x: Math.round(mr.left), y: Math.round(mr.top), w: Math.round(mr.width), h: Math.round(mr.height) } : null,
  curCount: cur.length,
  curInMap: cur.filter(e => loc(e).inMap).length,
  samples: cur.slice(0, 4).map(e => ({ text: e.textContent.trim().slice(0, 24), ...loc(e), html: e.outerHTML.slice(0, 180) })),
};
