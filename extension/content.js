// Airbnb Archiver — content script.
// Replaces Airbnb's results column with our own curated panel (one combined,
// reorderable, commentable list of starred + maybe listings), keeps the map as
// the discovery surface (tag from pin popups), colours starred pins blue / maybe
// yellow, and hides archived pins. State lives in browser.storage.local.

document.documentElement.setAttribute("data-archiver-loaded", "1");

let cats = { starred: {}, maybe: {}, archived: {} };
let tagCoords = {};
let notes = {};
let order = [];
let images = {};
let prices = {};
let showArchived = false;
let showAllPlaces = false;   // bypass the "only what's on the map" filter

const CURRENCY = /[$€£₲¥₩₪₫฿]/;
const UNDO_MS = 1500;

async function loadState() {
  cats = await Store.getAll();
  tagCoords = await Store.getTagCoords();
  notes = await Store.getNotes();
  order = await Store.getOrder();
  images = await Store.getImages();
  prices = (Store.getPrices ? await Store.getPrices() : {}) || {};
  hosts = (Store.getHosts ? await Store.getHosts() : {}) || {};
  threads = (Store.getThreads ? await Store.getThreads() : {}) || {};
  const s = await Store.getSettings();
  showArchived = s.showArchived;
  showAllPlaces = !!s.showAllPlaces;
}

browser.storage.onChanged.addListener(async (changes) => {
  await loadState();
  decorateAll();
  // Don't rebuild the panel for note-only changes (would steal textarea focus),
  // and never yank a row out from under an in-progress drag.
  const keys = Object.keys(changes);
  if (dragRow) return;
  if (!(keys.length === 1 && keys[0] === "notes")) renderPanel();
});

/* ----------------------------- helpers ----------------------------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s; }
function idFromHref(href) { const m = href && href.match(/\/rooms\/(\d+)/); return m ? m[1] : null; }
function decodeId(b64) { try { const d = atob(b64); const m = d.match(/:(\d+)\s*$/); return m ? m[1] : null; } catch (_) { return null; } }
function catOf(id) { return cats.starred[id] ? "starred" : cats.maybe[id] ? "maybe" : cats.archived[id] ? "archived" : null; }
function snapOf(id) { return cats.starred[id] || cats.maybe[id] || cats.archived[id] || {}; }
function mapElement() {
  return document.querySelector('[data-testid="map/GoogleMap"]')
    || document.querySelector('[aria-roledescription="map"]')
    || document.querySelector('[aria-label="Map"]');
}
function isOverMap(el, mapEl) {
  if (!mapEl) return false;
  const r = el.getBoundingClientRect(), mr = mapEl.getBoundingClientRect();
  if (!r.width || !mr.width) return false;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return cx >= mr.left && cx <= mr.right && cy >= mr.top && cy <= mr.bottom;
}
function parsePos(s) {
  if (!s) return null;
  const p = String(s).split(","); const lat = parseFloat(p[0]), lng = parseFloat(p[1]);
  return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
}

/* ----------------------------- last-clicked marker ----------------------------- */
let lastMarker = null, lastMarkerInfo = null;
function parseMarkerText(text) {
  const t = (text || "").replace(/[★☆?🗑↩]/g, "").replace(/\bUnarchive\b/g, "").replace(/\s+/g, " ").trim();
  const ci = t.search(CURRENCY);
  const title = (ci > 0 ? t.slice(0, ci) : t).replace(/[,\s]+$/, "").trim();
  const pm = t.match(/[$€£₲]\s?[\d.,]+(?:\s*[A-Z]{3})?/);
  return { title, price: pm ? pm[0].replace(/\s+/g, " ").trim() : "" };
}
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".archiver-actions, .archiver-toast, .archiver-panel")) return;
  const m = e.target.closest && e.target.closest("gmp-advanced-marker");
  if (m) { lastMarker = m; lastMarkerInfo = parseMarkerText(m.textContent); }
}, true);

/* ----------------------------- snapshot ----------------------------- */
function snapshotFromCard(anchor, container, id) {
  const imgs = [...container.querySelectorAll("img")].map((i) => i.currentSrc || i.src).filter(Boolean);
  const lines = (container.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const title = (anchor.getAttribute("aria-label") || lines[0] || `Listing ${id}`).trim();
  const price = lines.find((l) => CURRENCY.test(l)) || "";
  return {
    title: truncate(title, 120), price,
    url: new URL(anchor.getAttribute("href"), location.origin).href.split("?")[0],
    thumbnail: imgs[0] || "",
    // The popup card preloads its carousel, so this is a decent photo fallback
    // for listings the interceptor hasn't harvested yet.
    images: [...new Set(imgs)].slice(0, 10),
  };
}

/* ----------------------------- pin colouring ----------------------------- */
// Coords of starred/maybe listings come from tagCoords (interceptor) + the
// snapshot's own coord + the page's embedded deferred-state (instant first paint).
// pageData: { id: { coord, images, price } } read once out of the server-rendered
// blob. Gives instant coords for colouring and photos/price for anything tagged
// off this page load (the interceptor covers listings that arrive later by XHR).
let pageData = null, deferredCoords = null;
function getPageData() {
  if (pageData) return pageData;
  pageData = {};
  try {
    for (const s of document.querySelectorAll('script[id^="data-deferred-state"]')) {
      let j;
      try { j = JSON.parse(s.textContent); } catch (_) { continue; }
      const h = Filter.harvest(j);
      for (const id of Object.keys(h)) pageData[id] = Object.assign(pageData[id] || {}, h[id]);
    }
  } catch (_) {}
  return pageData;
}
function getDeferredCoords() {
  if (deferredCoords) return deferredCoords;
  deferredCoords = {};
  const pd = getPageData();
  for (const id in pd) if (pd[id].coord) deferredCoords[id] = pd[id].coord;
  return deferredCoords;
}
// Photos + normalised price for a listing, best source first.
function mediaOf(id) {
  const snap = snapOf(id), pd = getPageData()[id] || {};
  const pick = (a) => (Array.isArray(a) && a.length ? a : null);
  const imgs = pick(images[id]) || pick(pd.images) || pick(snap.images) || (snap.thumbnail ? [snap.thumbnail] : []);
  return { imgs, price: prices[id] || pd.price || snap.price30 || null };
}
/* --- live price probing -------------------------------------------------
   A saved listing keeps its /rooms/<id> link, and its price is re-read from
   Airbnb whenever it's rendered. The room page itself carries no price (only a
   coordinate), so the probe re-runs Airbnb's own search scoped to a tiny box
   around that coordinate — which does server-render a price. See
   scripts/recon_pdp.py and scripts/recon_probe.py. */
const PROBE_TTL_MS = 15 * 60 * 1000;
const PROBE_MAX_INFLIGHT = 2;
const PROBE_MAX_PER_RENDER = 8;
const PROBE_GAP_MS = 400;

function currentCtx() { return typeof Filter !== "undefined" ? Filter.ctxOf(location.href) : ""; }
function priceIsFresh(id) {
  const p = prices[id];
  return !!(p && p.ctx === currentCtx() && p.probedAt && Date.now() - p.probedAt < PROBE_TTL_MS);
}
function linkFor(id) {
  const u = snapOf(id).url;
  return (u && /\/rooms\/\d/.test(u)) ? u.split("?")[0] : `${location.origin}/rooms/${id}`;
}

let probeQueue = [], probeInflight = 0;
const probeAttempted = new Set();   // `${id}|${ctx}` — one shot per context per page load

function schedulePriceProbes(ids) {
  if (typeof Filter === "undefined" || typeof fetch !== "function") return;
  const ctx = currentCtx();
  let queued = 0;
  for (const id of ids) {
    if (queued >= PROBE_MAX_PER_RENDER) break;
    if (priceIsFresh(id) || probeAttempted.has(id + "|" + ctx) || probeQueue.includes(id)) continue;
    probeQueue.push(id);
    queued++;
  }
  pumpProbes();
}
function pumpProbes() {
  while (probeInflight < PROBE_MAX_INFLIGHT && probeQueue.length) {
    const id = probeQueue.shift();
    const ctx = currentCtx();
    if (priceIsFresh(id) || probeAttempted.has(id + "|" + ctx)) continue;
    probeAttempted.add(id + "|" + ctx);
    probeInflight++;
    probePrice(id, ctx)
      .catch((e) => console.warn("[Archiver] price probe failed for", id, e))
      .then(() => { probeInflight--; setTimeout(pumpProbes, PROBE_GAP_MS); });
  }
}

async function probePrice(id, ctx) {
  let coord = coordFor(id);
  if (!coord) coord = await coordFromListingPage(id);   // bootstrap from the saved link
  if (!coord) return;

  const res = await fetch(Filter.probeUrl(location.origin, location.search, coord), { credentials: "same-origin" });
  if (!res.ok) return;
  const found = Filter.harvestHtml(await res.text());

  const stamp = { ctx, probedAt: Date.now() };
  const tracked = new Set([...Object.keys(cats.starred), ...Object.keys(cats.maybe)]);
  const patch = {};
  // One probe returns every listing in the box, so refresh the neighbours too.
  for (const fid of Object.keys(found)) {
    if (!tracked.has(fid)) continue;
    const e = found[fid];
    patch[fid] = { images: e.images, coord: e.coord, price: e.price ? { ...e.price, ...stamp } : null };
    if (e.price) probeAttempted.add(fid + "|" + ctx);
  }
  if (!found[id]) {
    // Airbnb didn't return it for these dates — that's "not bookable", not a
    // parse failure. Keep the last known figure so the row still says something.
    const prev = prices[id] || {};
    const last = prev.unavailable ? prev.lastMonthly : (prev.monthly != null ? prev.monthly : null);
    patch[id] = { price: { ...stamp, unavailable: true, monthly: null, symbol: prev.symbol || "", lastMonthly: last } };
  }
  if (Object.keys(patch).length) await Store.setMediaBulk(patch);
}

// The room page has no price, but it does carry the coordinate a probe needs,
// plus the host's name and the real listing name — so the saved link alone is
// enough to price and label a listing we've never seen on a map. One fetch,
// cached: `listingPage` dedupes concurrent callers.
const listingPageCache = {};
function fetchListingPage(id) {
  if (listingPageCache[id]) return listingPageCache[id];
  listingPageCache[id] = (async () => {
    const res = await fetch(linkFor(id), { credentials: "same-origin" });
    if (!res.ok) return {};
    const html = await res.text();
    const out = { coord: Filter.coordFromHtml(html), host: Filter.hostFromHtml(html) };
    if (out.host) await Store.setHost(id, out.host);
    return out;
  })().catch((e) => { console.warn("[Archiver] listing page fetch failed", id, e); return {}; });
  return listingPageCache[id];
}
async function coordFromListingPage(id) {
  return (await fetchListingPage(id)).coord || null;
}

/* --- host name + "message the host" ------------------------------------ */
let hosts = {};
let threads = {};
function hostOf(id) { return hosts[id] || null; }
// The existing conversation if we know it, otherwise Airbnb's compose window.
// /contact_host/<id>/send_message does NOT resolve to an existing thread — it
// opens a blank new-message form — so a known thread id always wins.
function chatUrlFor(id) {
  const t = threads[id];
  return t ? Filter.threadUrl(location.origin, t) : Filter.contactUrl(location.origin, id);
}
function hasThread(id) { return !!threads[id]; }
const hostAsked = new Set();
function scheduleHostLookups(ids) {
  if (typeof Filter === "undefined" || typeof fetch !== "function") return;
  let n = 0;
  for (const id of ids) {
    if (n >= 4) break;                       // the room page is ~600KB; go easy
    if (hostOf(id) || hostAsked.has(id)) continue;
    hostAsked.add(id);
    n++;
    fetchListingPage(id);
  }
}

// Prices for listings on the page we're already on: free, no probe needed.
async function seedFromPageData() {
  if (typeof Filter === "undefined" || !Store.setMediaBulk) return;
  const ctx = currentCtx(), pd = getPageData();
  const stamp = { ctx, probedAt: Date.now() };
  const patch = {};
  for (const id of [...Object.keys(cats.starred), ...Object.keys(cats.maybe)]) {
    const e = pd[id];
    if (!e) continue;
    patch[id] = { images: e.images, coord: e.coord, price: e.price ? { ...e.price, ...stamp } : null };
    if (e.price) probeAttempted.add(id + "|" + ctx);
  }
  if (Object.keys(patch).length) await Store.setMediaBulk(patch);
}

// Remember photos/price for a listing the moment it's tagged.
function seedMedia(id, snap) {
  const pd = getPageData()[id] || {};
  const imgs = (pd.images && pd.images.length) ? pd.images : (snap && snap.images) || null;
  const coord = pd.coord || parsePos(snap && snap.coord);
  if (Store.setMedia && (imgs || pd.price || coord)) Store.setMedia(id, imgs, pd.price, coord).catch(() => {});
}
function coordVals(catMap) {
  const dc = getDeferredCoords();
  const out = [];
  for (const id of Object.keys(catMap)) {
    const c = tagCoords[id] || parsePos(catMap[id] && catMap[id].coord) || dc[id];
    if (c) out.push(c);
  }
  return out;
}
function matchAny(pos, list) { return list.some((c) => Math.abs(c.lat - pos.lat) < 1e-4 && Math.abs(c.lng - pos.lng) < 1e-4); }
// The largest rounded, non-transparent element in a marker (full pill body or dot).
function colorableEl(m) {
  let best = null, bestArea = -1;
  for (const el of m.querySelectorAll("div")) {
    const s = getComputedStyle(el);
    if (parseFloat(s.borderRadius) >= 6 && s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") {
      const r = el.getBoundingClientRect(); const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
  }
  return best;
}
function paint(m, cls) {
  const el = colorableEl(m); if (!el) return;
  const bg = cls === "starred" ? "#2f80ed" : "#f2c200";
  const fg = cls === "starred" ? "#ffffff" : "#1a1a1a";
  el.style.setProperty("background-color", bg, "important");
  el.querySelectorAll("*").forEach((c) => c.style.setProperty("color", fg, "important"));
  m.dataset.archiverColor = cls;
}
function clearPaint(m) {
  const el = colorableEl(m);
  if (el) { el.style.removeProperty("background-color"); el.querySelectorAll("*").forEach((c) => c.style.removeProperty("color")); }
  delete m.dataset.archiverColor;
}
function colorMarkers() {
  const starred = coordVals(cats.starred), maybe = coordVals(cats.maybe);
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    if (m.style.display === "none") continue;
    const pos = parsePos(m.getAttribute("position"));
    let cls = null;
    if (pos) { if (matchAny(pos, starred)) cls = "starred"; else if (matchAny(pos, maybe)) cls = "maybe"; }
    if (cls) { if (m.dataset.archiverColor !== cls) paint(m, cls); }
    else if (m.dataset.archiverColor) clearPaint(m);
  }
}

/* ----------------------------- archived pins ----------------------------- */
function hideArchivedMarkers() {
  if (showArchived) return;
  const coords = coordVals(cats.archived).map((c) => `${c.lat},${c.lng}`);
  const set = new Set([...Object.values(cats.archived).map((s) => s.coord).filter(Boolean), ...coords]);
  if (!set.size) return;
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    const p = m.getAttribute("position"); if (!p) continue;
    const pos = parsePos(p);
    if (set.has(p) || (pos && coordVals(cats.archived).some((c) => Math.abs(c.lat - pos.lat) < 1e-4 && Math.abs(c.lng - pos.lng) < 1e-4))) {
      m.style.display = "none";
    }
  }
}

/* ----------------------------- undo toast (map trash) ----------------------------- */
let toastEl = null, toastTimer = null;
function removeToast() { if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; } if (toastEl) { toastEl.remove(); toastEl = null; } }
function toastUndo(label, onUndo, onDone) {
  removeToast();
  let cancelled = false;
  toastEl = document.createElement("div"); toastEl.className = "archiver-toast";
  const span = document.createElement("span"); span.textContent = label;
  const undo = document.createElement("button"); undo.className = "archiver-undo"; undo.textContent = "Undo";
  undo.addEventListener("click", () => { cancelled = true; removeToast(); onUndo && onUndo(); });
  const bar = document.createElement("div"); bar.className = "archiver-progress";
  const fill = document.createElement("div"); fill.className = "archiver-progress-fill"; bar.appendChild(fill);
  toastEl.append(span, undo, bar); document.body.appendChild(toastEl);
  fill.style.width = "0%"; void fill.offsetWidth; fill.style.transition = `width ${UNDO_MS}ms linear`; fill.style.width = "100%";
  toastTimer = setTimeout(() => { removeToast(); if (!cancelled) onDone && onDone(); }, UNDO_MS);
}

/* ----------------------------- map popup tagging ----------------------------- */
function popupCardRoot(anchor) {
  let el = anchor, best = anchor;
  for (let i = 0; i < 12 && el.parentElement; i++) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.width < 460 && r.height > 0 && r.height < 460) best = el;
    else if (r.width >= 460 || r.height >= 460) break;
    el = el.parentElement;
  }
  return best;
}
function makeBtn(cls, glyph, title) {
  const b = document.createElement("button"); b.className = "archiver-btn " + cls; b.textContent = glyph; b.title = title; return b;
}
function makeUnarchive(id) {
  const b = document.createElement("button"); b.className = "archiver-unarchive"; b.textContent = "↩ Unarchive";
  b.addEventListener("click", async (e) => { e.preventDefault(); e.stopPropagation(); await Store.setCategory(id, null, null); });
  return b;
}
function trashMapCard(id, snapshot, anchor) {
  const marker = lastMarker;
  const coord = marker ? marker.getAttribute("position") : snapshot.coord || null;
  const snap = { ...snapshot, title: (lastMarkerInfo && lastMarkerInfo.title) || snapshot.title, price: (lastMarkerInfo && lastMarkerInfo.price) || snapshot.price, coord };
  const cardRoot = popupCardRoot(anchor);
  cardRoot.style.display = "none";
  if (marker) marker.style.display = "none";
  toastUndo(`Archiving “${truncate(snap.title || ("Listing " + id), 30)}”`,
    () => { cardRoot.style.display = ""; if (marker) marker.style.display = ""; },
    () => Store.setCategory(id, snap, "archived"));
}
function cardContainer(anchor) {
  let el = anchor;
  for (let i = 0; i < 6 && el.parentElement; i++) {
    if (el.getAttribute && el.getAttribute("itemprop") === "itemListElement") break;
    el = el.parentElement;
  }
  return el;
}
function decorateMapCards() {
  const mapEl = mapElement(); if (!mapEl) return;
  for (const anchor of document.querySelectorAll('a[href*="/rooms/"]')) {
    const id = idFromHref(anchor.getAttribute("href")); if (!id) continue;
    const container = cardContainer(anchor);
    if (!container || container.dataset.archiverDone === "1") continue;
    if (!isOverMap(container, mapEl)) continue; // only the map popup card
    container.dataset.archiverDone = "1"; container.dataset.archiverId = id;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    const cat = catOf(id);
    if (cat === "archived") { container.classList.add("archiver-greyed"); container.appendChild(makeUnarchive(id)); continue; }

    const snap = snapshotFromCard(anchor, container, id);
    if (lastMarker) snap.coord = lastMarker.getAttribute("position");

    const actions = document.createElement("div"); actions.className = "archiver-actions archiver-actions--map";
    const star = makeBtn("archiver-star", cat === "starred" ? "★" : "☆", "Like");
    if (cat === "starred") star.classList.add("on");
    const maybe = makeBtn("archiver-maybe", "?", "Maybe");
    if (cat === "maybe") maybe.classList.add("on");
    const trash = makeBtn("archiver-trash", "🗑", "Archive");
    const reflect = (c) => { star.classList.toggle("on", c === "starred"); star.textContent = c === "starred" ? "★" : "☆"; maybe.classList.toggle("on", c === "maybe"); };
    const toggle = (target) => async (e) => {
      e.preventDefault(); e.stopPropagation();
      const cur = await Store.getCategory(id); const next = cur === target ? null : target;
      await Store.setCategory(id, snap, next); reflect(next);
      if (next) seedMedia(id, snap);
    };
    star.addEventListener("click", toggle("starred"));
    maybe.addEventListener("click", toggle("maybe"));
    trash.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); trashMapCard(id, snap, anchor); });
    actions.append(star, maybe, trash);
    container.appendChild(actions);
  }
}

/* ----------------------------- the panel ----------------------------- */
let panelEl = null;
function ensurePanel() {
  if (panelEl && document.body.contains(panelEl)) return panelEl;
  panelEl = document.createElement("div"); panelEl.className = "archiver-panel";
  const head = document.createElement("div"); head.className = "archiver-panel-head";
  let ver = ""; try { ver = browser.runtime.getManifest().version; } catch (_) {}
  const title = document.createElement("span"); title.className = "archiver-panel-title";
  title.textContent = "My listings" + (ver ? "  ·  v" + ver : "");
  const count = document.createElement("span"); count.className = "archiver-panel-count";
  const scope = document.createElement("button");
  scope.type = "button"; scope.className = "archiver-scope";
  scope.addEventListener("click", () => Store.setSetting("showAllPlaces", !showAllPlaces));
  head.append(title, count, scope);
  const list = document.createElement("div"); list.className = "archiver-panel-list";
  panelEl.append(head, list);
  document.body.appendChild(panelEl);
  return panelEl;
}
// Bottom of Airbnb's top chrome — everything the panel must stay clear of.
// The header's own box is not enough. Expanding the search bar does NOT grow the
// header (measured: 152px either way); the expanded bar is position:absolute
// inside it and hangs ~16px past its bottom edge, and it is wider than the map
// column, so it reaches left underneath the panel. That overhang is exactly what
// swallowed "Where / Check in", so measure the descendants too and take the
// lowest edge any of them reach.
function chromeBottom() {
  let b = 0;
  for (const el of document.querySelectorAll("header")) {
    const cr = el.getBoundingClientRect();
    if (!cr.height || cr.top > 240) continue;   // only the chrome pinned at the top
    b = Math.max(b, cr.bottom);
    // Only short things that hang just past the header count as chrome. The
    // header also contains a full-viewport overlay host; letting that vote sent
    // the bottom to 865 and collapsed the panel to a sliver at the foot of the
    // screen. Real overhang here is the 66px-tall search bar clearing 152 by 16.
    const MAX_OVERHANG = 200;
    for (const kid of el.querySelectorAll("*")) {
      const kr = kid.getBoundingClientRect();
      if (!kr.width || !kr.height) continue;
      if (kr.top > cr.bottom) continue;               // a dropdown/menu, not chrome
      if (kr.height > MAX_OVERHANG) continue;         // an overlay host, not chrome
      if (kr.bottom > cr.bottom + MAX_OVERHANG) continue;
      b = Math.max(b, kr.bottom);
    }
  }
  return b;
}

// Top of Airbnb's own card column. Airbnb already lays this out below whatever
// chrome is showing, so following it keeps the panel the size of the cards it
// replaces — which is the whole point: cover them, hide nothing else.
// `colRight` is the map's left edge: only count cards actually in the results
// column. Some itemListElement nodes measure far to the right of the map (they
// sit in a horizontally overflowing container), and letting those vote drags the
// top edge to a row that isn't in the column we're covering.
function cardsTop(colRight) {
  let top = Infinity;
  for (const c of document.querySelectorAll('[itemprop="itemListElement"]')) {
    const cr = c.getBoundingClientRect();
    if (!cr.width || !cr.height) continue;
    if (cr.left >= colRight) continue;
    top = Math.min(top, cr.top);
  }
  return top === Infinity ? null : top;
}

function positionPanel() {
  const map = mapElement();
  if (!map) { if (panelEl) panelEl.style.display = "none"; return false; }
  const r = map.getBoundingClientRect();
  if (!r.width || r.left < 40) { if (panelEl) panelEl.style.display = "none"; return false; }
  // Cover the results column and nothing above it. This used to sit at
  // `max(56, map.top - 96)` — a guess that landed 56px over a 152px-tall header
  // and covered the left half of the search bar. Take the cards' own top, and
  // never rise above the live chrome (they scroll under a sticky header).
  const ct = cardsTop(r.left);
  const wanted = ct === null ? r.top - 96 : ct;   // no cards in the DOM yet
  const top = Math.max(0, Math.round(chromeBottom()), Math.round(wanted));
  // Always run to the bottom of the window. Sizing to the map's own box breaks
  // both ways: a map taller than the window pushed the list off-screen (it got
  // clipped instead of scrolling), and a map SHORTER than the window left
  // Airbnb's own two-column cards showing underneath the panel.
  const bottom = window.innerHeight;
  ensurePanel();
  // Must stay "flex" — an inline display:block here beats the stylesheet, the
  // list stops being a flex item, and it grows past the panel instead of scrolling.
  panelEl.style.display = "flex";
  panelEl.style.top = top + "px";
  panelEl.style.left = "0px";
  panelEl.style.width = Math.round(r.left) + "px";
  panelEl.style.height = Math.max(120, Math.round(bottom - top)) + "px";
  return true;
}
function orderedIds() {
  const all = [...Object.keys(cats.starred), ...Object.keys(cats.maybe)];
  const set = new Set(all);
  const inOrder = order.filter((id) => set.has(id));
  const placed = new Set(inOrder);
  const rest = all.filter((id) => !placed.has(id)).sort((a, b) => (snapOf(b).ts || 0) - (snapOf(a).ts || 0));
  return [...inOrder, ...rest];
}

/* --- what the map is currently looking at ------------------------------
   Airbnb keeps the live viewport in the URL as ne_lat/ne_lng/sw_lat/sw_lng and
   rewrites them on every pan and zoom (verified live, scripts/recon_bounds.py).
   A fresh city search has no map params yet, so fall back to the spread of the
   pins actually being rendered. */
function mapBounds() {
  const p = new URLSearchParams(location.search);
  const num = (k) => { const v = parseFloat(p.get(k)); return isFinite(v) ? v : null; };
  const neLat = num("ne_lat"), neLng = num("ne_lng"), swLat = num("sw_lat"), swLng = num("sw_lng");
  if (neLat != null && neLng != null && swLat != null && swLng != null) {
    return {
      minLat: Math.min(swLat, neLat), maxLat: Math.max(swLat, neLat),
      minLng: Math.min(swLng, neLng), maxLng: Math.max(swLng, neLng), src: "url",
    };
  }
  const pts = [];
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    const c = parsePos(m.getAttribute("position"));
    if (c) pts.push(c);
  }
  if (pts.length < 2) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const c of pts) {
    minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
    minLng = Math.min(minLng, c.lng); maxLng = Math.max(maxLng, c.lng);
  }
  // Pins sit inside the viewport, so pad out a bit or edge listings drop off.
  const padLat = Math.max(0.15 * (maxLat - minLat), 0.002);
  const padLng = Math.max(0.15 * (maxLng - minLng), 0.002);
  return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLng: minLng - padLng, maxLng: maxLng + padLng, src: "pins" };
}
function inBounds(c, b) {
  return !!(c && b && c.lat >= b.minLat && c.lat <= b.maxLat && c.lng >= b.minLng && c.lng <= b.maxLng);
}
// Split the list into what's on the map now, what isn't, and what we have no
// coordinate for. Unplaced listings are always shown — hiding a listing we
// simply never learned the location of would look like we lost it.
function panelGroups() {
  const ids = orderedIds();
  const b = showAllPlaces ? null : mapBounds();
  if (!b) return { shown: ids, unplaced: [], hidden: 0, total: ids.length, filtered: false };
  const shown = [], unplaced = [];
  let hidden = 0;
  for (const id of ids) {
    const c = coordFor(id);
    if (!c) unplaced.push(id);
    else if (inBounds(c, b)) shown.push(id);
    else hidden++;
  }
  return { shown, unplaced, hidden, total: ids.length, filtered: true };
}

/* --- drag to reorder ---------------------------------------------------
   Pointer-driven, not HTML5 drag-and-drop: Airbnb's own handlers swallow
   dragstart/drop on the page, and this also gives live reordering. */
let dragRow = null;
function attachDrag(handle, row) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const list = row.parentElement;
    if (!list) return;
    const startY = e.clientY;
    let offset = 0;
    dragRow = row;
    row.classList.add("dragging");
    document.body.style.userSelect = "none";

    const apply = (y) => { row.style.transform = `translateY(${(y - startY) + offset}px)`; };
    const move = (ev) => {
      // Autoscroll when dragging past either end of the list.
      const lr = list.getBoundingClientRect();
      const edge = ev.clientY < lr.top + 60 ? -18 : ev.clientY > lr.bottom - 60 ? 18 : 0;
      if (edge) { const was = list.scrollTop; list.scrollTop += edge; offset += list.scrollTop - was; }
      apply(ev.clientY);

      // Swap with whichever neighbour's midpoint we've crossed, then re-anchor
      // the transform so the row stays put under the cursor.
      const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
      const prev = row.previousElementSibling, next = row.nextElementSibling;
      let ref = null;
      if (prev && mid < prev.getBoundingClientRect().top + prev.offsetHeight / 2) ref = prev;
      else if (next && mid > next.getBoundingClientRect().top + next.offsetHeight / 2) ref = next.nextElementSibling;
      else return;
      const wasTop = row.getBoundingClientRect().top;
      row.style.transform = "none";
      list.insertBefore(row, ref);
      offset = (wasTop - row.getBoundingClientRect().top) - (ev.clientY - startY);
      apply(ev.clientY);
    };
    const up = () => {
      // Listen on window, not the handle: re-inserting the row mid-drag can drop
      // an element-scoped pointer capture.
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      row.style.transform = "";
      row.classList.remove("dragging");
      document.body.style.userSelect = "";
      dragRow = null;
      commitOrder([...list.children].map((c) => c.dataset.id).filter(Boolean));
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  });
}

// The panel usually shows a subset (only what's on the map), so a drop must not
// overwrite the global order with just those ids — that would throw away the
// ordering of everything off-screen. Splice the new sequence back into the slots
// the visible rows already occupied, leaving hidden listings where they are.
function commitOrder(visibleNow) {
  const seq = visibleNow.slice();
  const vis = new Set(seq);
  let k = 0;
  const next = orderedIds().map((id) => (vis.has(id) && k < seq.length ? seq[k++] : id));
  order = next;
  Store.setOrder(next);
}

/* --- hover a row -> light up its map pin (Airbnb's own link is gone since
       our panel replaced its cards, so we rebuild it) --- */
function coordFor(id) {
  return tagCoords[id] || parsePos(snapOf(id).coord) || (getPageData()[id] || {}).coord || null;
}
let hoverMarker = null;
function highlightMarker(id, on) {
  if (hoverMarker) {
    hoverMarker.style.zIndex = "";
    const el = colorableEl(hoverMarker);
    if (el) el.classList.remove("archiver-pill-hover");
    hoverMarker = null;
  }
  if (!on) return;
  const c = coordFor(id);
  if (!c) return;
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    if (m.style.display === "none") continue;
    const p = parsePos(m.getAttribute("position"));
    if (!p || Math.abs(p.lat - c.lat) > 1e-4 || Math.abs(p.lng - c.lng) > 1e-4) continue;
    m.style.zIndex = "9999";
    const el = colorableEl(m);
    if (el) el.classList.add("archiver-pill-hover");
    hoverMarker = m;
    return;
  }
}

/* --- price, normalised to 30 nights --- */
function fmtMoney(sym, v) { return (sym || "") + Math.round(v).toLocaleString("en-US"); }
function priceText(id) {
  const { price } = mediaOf(id);
  if (price && price.unavailable) {
    return {
      head: "Unavailable", unit: "", muted: true,
      sub: price.lastMonthly != null
        ? "last seen " + fmtMoney(price.symbol, price.lastMonthly) + " / 30 nights"
        : "not offered for these dates",
    };
  }
  if (price && price.monthly != null) {
    const bits = [];
    if (price.basis === "monthly") bits.push("Airbnb monthly rate");
    if (price.total != null && price.nights) bits.push(fmtMoney(price.symbol, price.total) + " for " + price.nights + " nights");
    if (price.original != null && price.original > price.monthly) bits.push("was " + fmtMoney(price.symbol, price.original));
    return {
      head: fmtMoney(price.symbol, price.monthly),
      unit: "/ 30 nights",
      perDay: price.nightly != null ? fmtMoney(price.symbol, price.nightly) + " / night" : "",
      sub: bits.join("  ·  "),
      stale: price.ctx !== currentCtx(),   // quoted for different dates; a probe is on the way
    };
  }
  const raw = snapOf(id).price || "";
  return { head: raw || "—", unit: "", perDay: "", sub: raw ? "" : "checking price…", stale: true };
}

// Which photo each listing is showing. A re-render (a price landing, a note
// saving) rebuilds the rows, and without this every carousel snapped back to
// photo 1 — which looked like the carousel jumping backwards on its own.
const carouselAt = {};

function buildCarousel(urls, id) {
  const wrap = document.createElement("div"); wrap.className = "archiver-media";
  wrap.dataset.urls = urls.length;
  const img = document.createElement("img");
  img.className = "archiver-media-img"; img.alt = ""; img.loading = "lazy"; img.draggable = false;
  wrap.appendChild(img);
  if (!urls.length) { wrap.classList.add("archiver-media--empty"); return wrap; }
  let i = Math.min(Math.max(carouselAt[id] | 0, 0), urls.length - 1);
  img.src = urls[i];
  if (urls.length < 2) return wrap;

  const count = document.createElement("div"); count.className = "archiver-media-count"; count.textContent = (i + 1) + "/" + urls.length;
  const show = (n) => {
    i = (n + urls.length) % urls.length;
    carouselAt[id] = i;
    img.src = urls[i];
    count.textContent = (i + 1) + "/" + urls.length;
    new Image().src = urls[(i + 1) % urls.length]; // prefetch the next one
  };
  const nav = (cls, glyph, delta) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "archiver-cnav " + cls; b.textContent = glyph;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); show(i + delta); });
    return b;
  };
  wrap.append(nav("archiver-cnav--prev", "‹", -1), nav("archiver-cnav--next", "›", 1), count);
  return wrap;
}

function panelRow(id) {
  const snap = snapOf(id), cat = catOf(id);
  const row = document.createElement("div");
  row.className = "archiver-row archiver-row--" + cat;
  row.dataset.id = id;
  row.addEventListener("mouseenter", () => highlightMarker(id, true));
  row.addEventListener("mouseleave", () => highlightMarker(id, false));

  const media = buildCarousel(mediaOf(id).imgs, id);
  const handle = document.createElement("div");
  handle.className = "archiver-handle"; handle.textContent = "⠿"; handle.title = "Drag to reorder";
  attachDrag(handle, row);
  media.appendChild(handle);

  const meta = document.createElement("div"); meta.className = "archiver-row-meta";

  const head = document.createElement("div"); head.className = "archiver-row-head";
  const p = priceText(id);
  const a = document.createElement("a");
  a.className = "archiver-row-price";
  a.href = snap.url || `https://www.airbnb.com/rooms/${id}`;
  a.target = "_blank"; a.rel = "noreferrer"; a.title = snap.title || `Listing ${id}`;
  a.textContent = p.head;
  if (p.muted) a.classList.add("archiver-row-price--muted");
  if (p.stale) a.classList.add("archiver-row-price--stale");
  if (p.unit) { const u = document.createElement("span"); u.className = "archiver-row-unit"; u.textContent = p.unit; a.appendChild(u); }

  const ctrls = document.createElement("div"); ctrls.className = "archiver-row-ctrls";
  const mk = (glyph, on, target, title) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "archiver-rowbtn" + (on ? " on" : ""); b.textContent = glyph; b.title = title;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (target === "archived") { await Store.setCategory(id, snap, "archived"); return; }
      const cur = catOf(id);
      await Store.setCategory(id, snap, cur === target ? null : target);
    });
    return b;
  };
  ctrls.append(mk("★", cat === "starred", "starred", "Star"), mk("?", cat === "maybe", "maybe", "Maybe"), mk("🗑", false, "archived", "Archive"));
  head.append(a, ctrls);

  const perDay = document.createElement("div");
  perDay.className = "archiver-row-perday"; perDay.textContent = p.perDay || "";
  if (!p.perDay) perDay.style.display = "none";

  const sub = document.createElement("div"); sub.className = "archiver-row-sub"; sub.textContent = p.sub;

  const hostRow = document.createElement("div"); hostRow.className = "archiver-row-host";
  const hostName = document.createElement("span"); hostName.className = "archiver-host-name";
  const prop = document.createElement("a");
  prop.className = "archiver-host-prop";
  prop.target = "_blank"; prop.rel = "noreferrer";
  prop.href = snap.url || `https://www.airbnb.com/rooms/${id}`;
  prop.textContent = "🏠 Property"; prop.title = "Open this listing on Airbnb";
  const chat = document.createElement("a");
  chat.className = "archiver-host-chat";
  chat.target = "_blank"; chat.rel = "noreferrer";
  setChatLink(chat, id);
  hostRow.append(hostName, prop, chat);
  fillHost(hostRow, id);

  const note = document.createElement("textarea");
  note.className = "archiver-note"; note.placeholder = "Add a note…"; note.value = notes[id] || "";
  note.addEventListener("input", debounce(() => Store.setNote(id, note.value), 400));

  meta.append(head, perDay, sub, hostRow, note);
  row.append(media, meta);
  return row;
}
function renderPanel() {
  if (dragRow) return;
  ensurePanel();
  positionPanel();
  const list = panelEl.querySelector(".archiver-panel-list");
  if (!list) return;
  const g = panelGroups();
  const sig = groupSig(g);

  // Same listings in the same order? Then a price landing (or a category swap)
  // must NOT rebuild the DOM — that resets every carousel and steals focus from
  // a note you're typing in. Patch the rows that changed instead.
  if (sig === lastSig && list.querySelector(".archiver-row")) {
    updateHead(g);
    for (const row of list.querySelectorAll(".archiver-row")) updateRow(row);
    try { schedulePriceProbes([...g.shown, ...g.unplaced]); } catch (_) {}
    try { scheduleHostLookups([...g.shown, ...g.unplaced]); } catch (_) {}
    return;
  }

  highlightMarker(null, false);
  const scroll = list.scrollTop;
  list.textContent = "";
  lastSig = sig;

  updateHead(g);

  if (!g.total) {
    const e = document.createElement("div"); e.className = "archiver-panel-empty";
    e.textContent = "Nothing here yet — star or “maybe” listings from the map.";
    list.appendChild(e); return;
  }
  for (const id of g.shown) list.appendChild(panelRow(id));

  if (g.unplaced.length) {
    list.appendChild(divider(`${g.unplaced.length} without a saved location`));
    for (const id of g.unplaced) list.appendChild(panelRow(id));
  }
  if (!g.shown.length && !g.unplaced.length) {
    const e = document.createElement("div"); e.className = "archiver-panel-empty";
    e.textContent = `None of your ${g.total} listings are in this part of the map.`;
    list.appendChild(e);
  } else if (g.hidden) {
    list.appendChild(divider(`${g.hidden} more elsewhere on the map`));
  }
  list.scrollTop = scroll; // a re-render shouldn't jump you back to the top
  // Whatever is on screen gets its price re-read from Airbnb, and its host
  // looked up if we don't have one yet.
  try { schedulePriceProbes([...g.shown, ...g.unplaced]); } catch (e) { console.warn("[Archiver] probe scheduling", e); }
  try { scheduleHostLookups([...g.shown, ...g.unplaced]); } catch (e) { console.warn("[Archiver] host lookup", e); }
}
function divider(text) {
  const d = document.createElement("div");
  d.className = "archiver-divider"; d.textContent = text;
  return d;
}
function setChatLink(a, id) {
  a.href = chatUrlFor(id);
  const known = hasThread(id);
  a.textContent = known ? "💬 Chat" : "💬 Message";
  a.classList.toggle("archiver-host-chat--new", !known);
  a.title = known
    ? "Open your existing conversation about this listing"
    : "No conversation recorded yet — this opens Airbnb's new-message form. Open the chat once and this will link straight to it.";
}
// The host name arrives asynchronously (one room-page fetch per listing), so the
// row renders immediately and fills in when it lands.
function fillHost(hostRow, id) {
  const h = hostOf(id);
  const nameEl = hostRow.querySelector(".archiver-host-name");
  if (!nameEl) return;
  if (h && h.name) {
    nameEl.textContent = "Hosted by " + h.name;
    nameEl.classList.remove("archiver-host-name--pending");
    hostRow.title = h.listingName || "";
  } else {
    nameEl.textContent = "looking up host…";
    nameEl.classList.add("archiver-host-name--pending");
  }
}
function updateHead(g) {
  const count = panelEl && panelEl.querySelector(".archiver-panel-count");
  const scope = panelEl && panelEl.querySelector(".archiver-scope");
  if (count) count.textContent = g.filtered ? `${g.shown.length} of ${g.total} on this map` : `${g.total} listing${g.total === 1 ? "" : "s"}`;
  if (scope) {
    scope.textContent = showAllPlaces ? "On this map" : "Show all";
    scope.title = showAllPlaces
      ? "Only show listings inside the current map view"
      : `Show all ${g.total} listings, including other cities`;
    scope.classList.toggle("on", showAllPlaces);
  }
}
// Refresh a row's live bits without touching the DOM the user is interacting
// with (carousel position, note caret).
function updateRow(row) {
  const id = row.dataset.id;
  if (!id) return;
  const cat = catOf(id);
  row.className = "archiver-row archiver-row--" + cat + (row.classList.contains("dragging") ? " dragging" : "");

  const p = priceText(id);
  const a = row.querySelector(".archiver-row-price");
  if (a) {
    a.firstChild && a.firstChild.nodeType === 3 ? (a.firstChild.nodeValue = p.head) : (a.textContent = p.head);
    a.classList.toggle("archiver-row-price--muted", !!p.muted);
    a.classList.toggle("archiver-row-price--stale", !!p.stale);
    let u = a.querySelector(".archiver-row-unit");
    if (p.unit && !u) { u = document.createElement("span"); u.className = "archiver-row-unit"; a.appendChild(u); }
    if (u) { u.textContent = p.unit; u.style.display = p.unit ? "" : "none"; }
  }
  const per = row.querySelector(".archiver-row-perday");
  if (per) { per.textContent = p.perDay || ""; per.style.display = p.perDay ? "" : "none"; }
  const sub = row.querySelector(".archiver-row-sub");
  if (sub) sub.textContent = p.sub;
  const hostRow = row.querySelector(".archiver-row-host");
  if (hostRow) fillHost(hostRow, id);
  const chat = row.querySelector(".archiver-host-chat");
  if (chat) setChatLink(chat, id);

  const btns = row.querySelectorAll(".archiver-rowbtn");
  if (btns.length >= 2) {
    btns[0].classList.toggle("on", cat === "starred");
    btns[1].classList.toggle("on", cat === "maybe");
  }

  // Swap photos only if the set actually changed, so the carousel keeps its place.
  const media = row.querySelector(".archiver-media");
  const urls = mediaOf(id).imgs;
  if (media && String(urls.length) !== media.dataset.urls) {
    const fresh = buildCarousel(urls, id);
    const handle = media.querySelector(".archiver-handle");
    if (handle) fresh.appendChild(handle);
    media.replaceWith(fresh);
  }
}

/* --- jump between a listing and the conversation about it ----------------
   On a room page: a button into the chat with that host.
   On a message thread: the apartment + host it's about, and a button to it.
   Both read the host/listing name from the room page (Store.getHosts cache). */
function bridgeBar() {
  let bar = document.querySelector(".archiver-bridge");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.className = "archiver-bridge";
  const text = document.createElement("div"); text.className = "archiver-bridge-text";
  const title = document.createElement("div"); title.className = "archiver-bridge-title";
  const subtitle = document.createElement("div"); subtitle.className = "archiver-bridge-sub";
  const note = document.createElement("textarea");
  note.className = "archiver-bridge-note"; note.placeholder = "Your note about this place…"; note.rows = 2;
  // Your comment for this listing, editable right here in the chat window; saves
  // to the same place the panel reads (bridgeNoteId tracks the current listing).
  note.addEventListener("input", debounce(() => { if (bridgeNoteId) Store.setNote(bridgeNoteId, note.value); }, 400));
  text.append(title, subtitle, note);
  const go = document.createElement("a");
  go.className = "archiver-bridge-btn"; go.target = "_top"; go.rel = "noreferrer";
  bar.append(text, go);
  document.body.appendChild(bar);
  return bar;
}
function fillBridge(id, mode) {
  const bar = bridgeBar();
  const h = hostOf(id) || {};
  const snap = snapOf(id);
  const name = h.listingName || snap.title || `Listing ${id}`;
  bar.querySelector(".archiver-bridge-title").textContent = name;
  bar.querySelector(".archiver-bridge-sub").textContent = h.name ? "Hosted by " + h.name : "looking up host…";
  const noteEl = bar.querySelector(".archiver-bridge-note");
  if (noteEl) {
    // Set the value when the listing changes, or to reflect an external edit —
    // but never yank text out from under active typing here.
    if (bridgeNoteId !== id) { bridgeNoteId = id; noteEl.value = notes[id] || ""; }
    else if (document.activeElement !== noteEl) { noteEl.value = notes[id] || ""; }
  }
  const go = bar.querySelector(".archiver-bridge-btn");
  if (mode === "room") {
    go.href = chatUrlFor(id);
    go.textContent = hasThread(id)
      ? (h.name ? `💬 Chat with ${h.name}` : "💬 Open the chat")
      : (h.name ? `💬 Message ${h.name}` : "💬 Message the host");
  } else {
    go.href = `${location.origin}/rooms/${id}`;
    go.textContent = "🏠 Open the apartment";
  }
}
let bridgeId = null;
let bridgeNoteId = null;
function decorateBridge() {
  if (typeof Filter === "undefined") return;
  const roomId = Filter.roomIdFromPath(location.pathname);
  const threadId = Filter.threadIdFromPath(location.pathname);
  if (!roomId && !threadId) {
    const bar = document.querySelector(".archiver-bridge");
    if (bar) bar.remove();
    bridgeId = null;
    return;
  }
  // On a thread page the listing isn't in the URL — it's whatever room the
  // conversation links to.
  const id = roomId || Filter.listingIdFromThread(document.body ? document.body.innerHTML : "");
  if (!id) return;
  const mode = roomId ? "room" : "thread";
  // Being on a thread page is the one moment we learn which conversation belongs
  // to which listing. Remember it so the panel can link straight here later.
  if (threadId && threads[id] !== threadId) {
    threads[id] = threadId;
    if (Store.setThread) Store.setThread(id, threadId).catch(() => {});
  }
  fillBridge(id, mode);
  if (bridgeId === id) return;
  bridgeId = id;
  if (!hostOf(id)) fetchListingPage(id).then(() => fillBridge(id, mode));
}

/* ----------------------------- orchestration ----------------------------- */
// NOTE: we do NOT hide Airbnb's own cards (walking up to a card container could
// resolve to an ancestor that contains the map and blank the page). Instead the
// opaque panel fully covers the results column (see positionPanel).
// Panning the map rewrites the URL bounds without necessarily mutating anything
// we observe, so re-render whenever the set of in-view listings actually changes.
let lastSig = null;
function groupSig(g) {
  return g.shown.join(",") + "|" + g.unplaced.join(",") + "|" + g.hidden + "|" + (showAllPlaces ? 1 : 0);
}
function syncPanelToMap() {
  if (dragRow) return;
  let g;
  try { g = panelGroups(); } catch (e) { return; }
  if (groupSig(g) !== lastSig) renderPanel();
}

function decorateAll() {
  try { decorateMapCards(); } catch (e) { console.warn("[Archiver] decorateMapCards", e); }
  try { hideArchivedMarkers(); } catch (e) { console.warn("[Archiver] hideArchivedMarkers", e); }
  try { colorMarkers(); } catch (e) { console.warn("[Archiver] colorMarkers", e); }
  try { positionPanel(); } catch (e) { console.warn("[Archiver] positionPanel", e); }
  try { syncPanelToMap(); } catch (e) { console.warn("[Archiver] syncPanelToMap", e); }
  try { decorateBridge(); } catch (e) { console.warn("[Archiver] decorateBridge", e); }
}
const observer = new MutationObserver(debounce(decorateAll, 250));
window.addEventListener("resize", debounce(positionPanel, 200));
// The top edge now follows the cards, which move under the sticky header as you
// scroll — so re-place it on scroll too, or a strip of Airbnb's own cards shows
// through above the panel.
window.addEventListener("scroll", debounce(positionPanel, 100), { passive: true });
window.addEventListener("popstate", () => setTimeout(syncPanelToMap, 50));

async function start() {
  await loadState();
  observer.observe(document.body, { childList: true, subtree: true });
  // Listings rendered on this very page are priced for free — probe only the rest.
  try { await seedFromPageData(); } catch (e) { console.warn("[Archiver] seedFromPageData", e); }
  decorateAll();
  renderPanel();
  // Backstop: history.pushState from the page fires no event we can see.
  // Re-place the panel on the same backstop. Geometry can change with no DOM
  // mutation to observe (the search bar expanding, a late font, the map getting
  // its size), and without this a panel hidden at first render never recovers.
  setInterval(() => { syncPanelToMap(); try { positionPanel(); } catch (e) {} }, 700);
  console.log("[Archiver] active");
}
start();
