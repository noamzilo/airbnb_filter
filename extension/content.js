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
let showArchived = false;

const CURRENCY = /[$€£₲¥₩₪₫฿]/;
const UNDO_MS = 1500;

async function loadState() {
  cats = await Store.getAll();
  tagCoords = await Store.getTagCoords();
  notes = await Store.getNotes();
  order = await Store.getOrder();
  showArchived = (await Store.getSettings()).showArchived;
}

browser.storage.onChanged.addListener(async (changes) => {
  await loadState();
  decorateAll();
  // Don't rebuild the panel for note-only changes (would steal textarea focus).
  const keys = Object.keys(changes);
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
  const img = container.querySelector("img");
  const lines = (container.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const title = (anchor.getAttribute("aria-label") || lines[0] || `Listing ${id}`).trim();
  const price = lines.find((l) => CURRENCY.test(l)) || "";
  return {
    title: truncate(title, 120), price,
    url: new URL(anchor.getAttribute("href"), location.origin).href.split("?")[0],
    thumbnail: img ? img.src : "",
  };
}

/* ----------------------------- pin colouring ----------------------------- */
// Coords of starred/maybe listings come from tagCoords (interceptor) + the
// snapshot's own coord + the page's embedded deferred-state (instant first paint).
let deferredCoords = null;
function getDeferredCoords() {
  if (deferredCoords) return deferredCoords;
  deferredCoords = {};
  try {
    for (const s of document.querySelectorAll('script[id^="data-deferred-state"]')) {
      const j = JSON.parse(s.textContent);
      (function w(n) {
        if (Array.isArray(n)) { n.forEach(w); return; }
        if (n && typeof n === "object") {
          const dsl = n.demandStayListing;
          const c = dsl && dsl.location && dsl.location.coordinate;
          if (dsl && dsl.id && c && typeof c.latitude === "number") {
            const id = decodeId(dsl.id);
            if (id) deferredCoords[id] = { lat: c.latitude, lng: c.longitude };
          }
          for (const k in n) w(n[k]);
        }
      })(j);
    }
  } catch (_) {}
  return deferredCoords;
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
  const head = document.createElement("div"); head.className = "archiver-panel-head"; head.textContent = "My listings";
  const list = document.createElement("div"); list.className = "archiver-panel-list";
  panelEl.append(head, list);
  document.body.appendChild(panelEl);
  return panelEl;
}
function positionPanel() {
  const map = mapElement();
  if (!map) { if (panelEl) panelEl.style.display = "none"; return false; }
  const r = map.getBoundingClientRect();
  if (!r.width || r.left < 40) { if (panelEl) panelEl.style.display = "none"; return false; }
  ensurePanel();
  panelEl.style.display = "block";
  panelEl.style.top = Math.max(0, r.top) + "px";
  panelEl.style.left = "0px";
  panelEl.style.width = Math.round(r.left) + "px";
  panelEl.style.height = Math.round(r.height) + "px";
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
function reorder(fromId, toId) {
  if (fromId === toId) return;
  const ids = orderedIds().filter((x) => x !== fromId);
  const idx = ids.indexOf(toId);
  ids.splice(idx < 0 ? ids.length : idx, 0, fromId);
  order = ids; Store.setOrder(ids);
}
function panelRow(id) {
  const snap = snapOf(id), cat = catOf(id);
  const row = document.createElement("div");
  row.className = "archiver-row archiver-row--" + cat;
  row.draggable = true; row.dataset.id = id;
  row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", id); row.classList.add("dragging"); });
  row.addEventListener("dragend", () => row.classList.remove("dragging"));
  row.addEventListener("dragover", (e) => e.preventDefault());
  row.addEventListener("drop", (e) => { e.preventDefault(); reorder(e.dataTransfer.getData("text/plain"), id); });

  const handle = document.createElement("div"); handle.className = "archiver-handle"; handle.textContent = "⠿";
  const img = document.createElement("img"); img.className = "archiver-row-img"; img.alt = ""; if (snap.thumbnail) img.src = snap.thumbnail;
  const meta = document.createElement("div"); meta.className = "archiver-row-meta";
  const a = document.createElement("a"); a.className = "archiver-row-title"; a.href = snap.url || `https://www.airbnb.com/rooms/${id}`; a.target = "_blank"; a.rel = "noreferrer"; a.textContent = snap.title || `Listing ${id}`;
  const price = document.createElement("div"); price.className = "archiver-row-price"; price.textContent = snap.price || "";
  const note = document.createElement("textarea"); note.className = "archiver-note"; note.placeholder = "Add a note…"; note.rows = 1; note.value = notes[id] || "";
  const grow = () => { note.style.height = "auto"; note.style.height = Math.min(note.scrollHeight, 120) + "px"; };
  note.addEventListener("input", () => { grow(); });
  note.addEventListener("input", debounce(() => Store.setNote(id, note.value), 400));
  setTimeout(grow, 0);
  meta.append(a, price, note);

  const ctrls = document.createElement("div"); ctrls.className = "archiver-row-ctrls";
  const mk = (glyph, on, target) => {
    const b = document.createElement("button"); b.className = "archiver-rowbtn" + (on ? " on" : ""); b.textContent = glyph;
    b.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (target === "archived") { await Store.setCategory(id, snap, "archived"); return; }
      const cur = catOf(id); await Store.setCategory(id, snap, cur === target ? null : target);
    });
    return b;
  };
  ctrls.append(mk("★", cat === "starred", "starred"), mk("?", cat === "maybe", "maybe"), mk("🗑", false, "archived"));

  row.append(handle, img, meta, ctrls);
  return row;
}
function renderPanel() {
  if (!positionPanel()) return;
  const list = panelEl.querySelector(".archiver-panel-list");
  list.textContent = "";
  const ids = orderedIds();
  if (!ids.length) {
    const e = document.createElement("div"); e.className = "archiver-panel-empty";
    e.textContent = "Nothing here yet — star or “maybe” listings from the map.";
    list.appendChild(e); return;
  }
  for (const id of ids) list.appendChild(panelRow(id));
}

/* ----------------------------- orchestration ----------------------------- */
function decorateAll() {
  try { decorateMapCards(); } catch (e) { console.warn("[Archiver] decorateMapCards", e); }
  try { hideArchivedMarkers(); } catch (e) { console.warn("[Archiver] hideArchivedMarkers", e); }
  try { colorMarkers(); } catch (e) { console.warn("[Archiver] colorMarkers", e); }
  try { positionPanel(); } catch (e) { console.warn("[Archiver] positionPanel", e); }
}
const observer = new MutationObserver(debounce(decorateAll, 250));
window.addEventListener("resize", debounce(positionPanel, 200));

async function start() {
  await loadState();
  observer.observe(document.body, { childList: true, subtree: true });
  decorateAll();
  renderPanel();
  console.log("[Archiver] active");
}
start();
