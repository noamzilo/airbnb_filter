// Airbnb Archiver — the decorator (content script).
// Adds a 3-way rubric to each listing card (side list + map popup card):
//   ★ star (liked) · ? maybe · 🗑 trash (archive) — mutually exclusive.
// Trash hides the listing (with a 1.5s undo); the actual data removal is done by
// the interceptor (background.js). This script also defensively hides archived
// listings React re-renders before the next fetch.

document.documentElement.setAttribute("data-archiver-loaded", "1"); // inject marker

let cats = { starred: {}, maybe: {}, archived: {} };
let tagCoords = {};
let showArchived = false;

const CURRENCY = /[$€£₲¥₩₪₫฿]/;
const UNDO_MS = 1500;

async function refreshState() {
  cats = await Store.getAll();
  tagCoords = await Store.getTagCoords();
  showArchived = (await Store.getSettings()).showArchived;
  decorateAll();
}
browser.storage.onChanged.addListener(refreshState);

function categoryOf(id) {
  if (cats.starred[id]) return "starred";
  if (cats.maybe[id]) return "maybe";
  if (cats.archived[id]) return "archived";
  return null;
}

/* ----------------------------- helpers ----------------------------- */

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s; }
function idFromHref(href) { const m = href && href.match(/\/rooms\/(\d+)/); return m ? m[1] : null; }

function mapElement() {
  return document.querySelector('[data-testid="map/GoogleMap"]')
    || document.querySelector('[aria-roledescription="map"]')
    || document.querySelector('[aria-label="Map"]');
}

// Track the last-clicked map marker (the popup card renders inside it) so we get
// a reliable title/price/coordinate and can target the exact pin.
let lastMarker = null;
let lastMarkerInfo = null;
function parseMarkerText(text) {
  const t = (text || "").replace(/[★☆?🗑↩]/g, "").replace(/\bUnarchive\b/g, "").replace(/\s+/g, " ").trim();
  const ci = t.search(CURRENCY);
  const title = (ci > 0 ? t.slice(0, ci) : t).replace(/[,\s]+$/, "").trim();
  const pm = t.match(/[$€£₲]\s?[\d.,]+(?:\s*[A-Z]{3})?/);
  return { title, price: pm ? pm[0].replace(/\s+/g, " ").trim() : "" };
}
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".archiver-actions, .archiver-toast")) return; // our UI
  const m = e.target.closest && e.target.closest("gmp-advanced-marker");
  if (m) { lastMarker = m; lastMarkerInfo = parseMarkerText(m.textContent); }
}, true);

function isOverMap(el, mapEl) {
  if (!mapEl) return false;
  const r = el.getBoundingClientRect();
  const mr = mapEl.getBoundingClientRect();
  if (!r.width || !mr.width) return false;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return cx >= mr.left && cx <= mr.right && cy >= mr.top && cy <= mr.bottom;
}

/* ----------------------------- snapshot ----------------------------- */

function snapshotFromCard(anchor, container, id) {
  const img = container.querySelector("img");
  const lines = (container.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const title = (anchor.getAttribute("aria-label") || lines[0] || `Listing ${id}`).trim();
  const price = lines.find((l) => CURRENCY.test(l)) || "";
  return {
    title: truncate(title, 120),
    price,
    url: new URL(anchor.getAttribute("href"), location.origin).href.split("?")[0],
    thumbnail: img ? img.src : "",
  };
}

/* ----------------------------- markers ----------------------------- */

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

// Persistently hide pins of archived listings (Google Maps re-creates markers,
// so a one-shot hide gets wiped). Keyed by precise position="lat,lng".
function hideArchivedMarkers() {
  if (showArchived) return;
  const coords = new Set(Object.values(cats.archived).map((s) => s.coord).filter(Boolean));
  if (!coords.size) return;
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    const p = m.getAttribute("position");
    if (p && coords.has(p)) m.style.display = "none";
  }
}

/* ----------------------------- pin colouring ----------------------------- */
// Markers expose only position="lat,lng"; map starred/maybe ids -> coords via
// tagCoords (from the interceptor) or the snapshot's own coord.
function parsePos(s) {
  if (!s) return null;
  const p = String(s).split(",");
  const lat = parseFloat(p[0]), lng = parseFloat(p[1]);
  return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
}
function coordList(catMap) {
  const out = [];
  for (const id of Object.keys(catMap)) {
    const c = tagCoords[id] || parsePos(catMap[id] && catMap[id].coord);
    if (c) out.push(c);
  }
  return out;
}
function matchAny(pos, list) {
  return list.some((c) => Math.abs(c.lat - pos.lat) < 2e-4 && Math.abs(c.lng - pos.lng) < 2e-4);
}
function findBubble(m) {
  for (const el of m.querySelectorAll("div")) {
    const s = getComputedStyle(el);
    if (parseFloat(s.borderRadius) >= 14 && s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") return el;
  }
  return null;
}
function paintMarker(m, cls) {
  const bubble = findBubble(m);
  if (!bubble) return;
  const bg = cls === "starred" ? "#2f80ed" : "#f2c200";
  const fg = cls === "starred" ? "#ffffff" : "#1a1a1a";
  bubble.style.setProperty("background-color", bg, "important");
  bubble.querySelectorAll("*").forEach((e) => e.style.setProperty("color", fg, "important"));
  m.dataset.archiverColor = cls;
}
function clearMarkerColor(m) {
  const bubble = findBubble(m);
  if (bubble) {
    bubble.style.removeProperty("background-color");
    bubble.querySelectorAll("*").forEach((e) => e.style.removeProperty("color"));
  }
  delete m.dataset.archiverColor;
}
function colorMarkers() {
  const starred = coordList(cats.starred);
  const maybe = coordList(cats.maybe);
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    if (m.style.display === "none") continue;
    const pos = parsePos(m.getAttribute("position"));
    let cls = null;
    if (pos) {
      if (matchAny(pos, starred)) cls = "starred";
      else if (matchAny(pos, maybe)) cls = "maybe";
    }
    if (cls) { if (m.dataset.archiverColor !== cls) paintMarker(m, cls); }
    else if (m.dataset.archiverColor) clearMarkerColor(m);
  }
}

/* ----------------------------- undo toast ----------------------------- */

let toastEl = null, toastTimer = null;
function removeToast() {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastEl) { toastEl.remove(); toastEl = null; }
}
function toastUndo(label, onUndo, onDone) {
  removeToast();
  let cancelled = false;
  toastEl = document.createElement("div");
  toastEl.className = "archiver-toast";
  const span = document.createElement("span"); span.textContent = label;
  const undo = document.createElement("button"); undo.className = "archiver-undo"; undo.textContent = "Undo";
  undo.addEventListener("click", () => { cancelled = true; removeToast(); onUndo && onUndo(); });
  const bar = document.createElement("div"); bar.className = "archiver-progress";
  const fill = document.createElement("div"); fill.className = "archiver-progress-fill"; bar.appendChild(fill);
  toastEl.append(span, undo, bar);
  document.body.appendChild(toastEl);
  fill.style.width = "0%"; void fill.offsetWidth;
  fill.style.transition = `width ${UNDO_MS}ms linear`; fill.style.width = "100%";
  toastTimer = setTimeout(() => { removeToast(); if (!cancelled) onDone && onDone(); }, UNDO_MS);
}

/* ----------------------------- trash flows ----------------------------- */

function trashSideCard(id, snapshot, container) {
  container.style.display = "none";
  toastUndo(
    `Archiving “${truncate(snapshot.title || ("Listing " + id), 30)}”`,
    () => { container.style.display = ""; },
    () => Store.setCategory(id, snapshot, "archived")
  );
}

function trashMapCard(id, snapshot, anchor) {
  const marker = lastMarker;
  const coord = marker ? marker.getAttribute("position") : snapshot.coord || null;
  const snap = {
    ...snapshot,
    title: (lastMarkerInfo && lastMarkerInfo.title) || snapshot.title,
    price: (lastMarkerInfo && lastMarkerInfo.price) || snapshot.price,
    coord,
  };
  const cardRoot = popupCardRoot(anchor);
  cardRoot.style.display = "none";
  if (marker) marker.style.display = "none";
  toastUndo(
    `Archiving “${truncate(snap.title || ("Listing " + id), 30)}”`,
    () => { cardRoot.style.display = ""; if (marker) marker.style.display = ""; },
    () => Store.setCategory(id, snap, "archived")
  );
}

/* ----------------------------- controls ----------------------------- */

function makeBtn(cls, glyph, title) {
  const b = document.createElement("button");
  b.className = "archiver-btn " + cls;
  b.textContent = glyph; b.title = title;
  return b;
}

function makeUnarchive(id) {
  const b = document.createElement("button");
  b.className = "archiver-unarchive"; b.textContent = "↩ Unarchive";
  b.addEventListener("click", async (e) => { e.preventDefault(); e.stopPropagation(); await Store.setCategory(id, null, null); });
  return b;
}

/* ----------------------------- cards ----------------------------- */

function cardContainer(anchor) {
  let el = anchor;
  for (let i = 0; i < 6 && el.parentElement; i++) {
    if (el.getAttribute && el.getAttribute("itemprop") === "itemListElement") break;
    el = el.parentElement;
  }
  return el;
}

function decorateCards() {
  const mapEl = mapElement();
  for (const anchor of document.querySelectorAll('a[href*="/rooms/"]')) {
    const id = idFromHref(anchor.getAttribute("href"));
    if (!id) continue;
    const container = cardContainer(anchor);
    if (!container || container.dataset.archiverDone === "1") continue;

    const onMap = isOverMap(container, mapEl);
    const cat = categoryOf(id);

    // Side list is a curated view: show ONLY starred / maybe; hide the rest
    // (unsorted "unseen" and archived). The map stays the discovery surface.
    if (!onMap && cat !== "starred" && cat !== "maybe") {
      container.style.display = "none";
      container.dataset.archiverDone = "1";
      continue;
    }

    container.dataset.archiverDone = "1";
    container.dataset.archiverId = id;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    // Map popup of an archived listing (only reachable with "show archived" on).
    if (onMap && cat === "archived") {
      container.classList.add("archiver-greyed");
      container.appendChild(makeUnarchive(id));
      continue;
    }

    const snap = snapshotFromCard(anchor, container, id);
    if (onMap && lastMarker) snap.coord = lastMarker.getAttribute("position");

    const actions = document.createElement("div");
    actions.className = "archiver-actions" + (onMap ? " archiver-actions--map" : "");

    const star = makeBtn("archiver-star", "☆", "Like");
    const maybe = makeBtn("archiver-maybe", "?", "Maybe");
    const trash = makeBtn("archiver-trash", "🗑", "Archive");

    const reflect = (c) => {
      star.classList.toggle("on", c === "starred");
      star.textContent = c === "starred" ? "★" : "☆";
      maybe.classList.toggle("on", c === "maybe");
    };
    reflect(cat);

    const toggle = (target) => async (e) => {
      e.preventDefault(); e.stopPropagation();
      const cur = await Store.getCategory(id);
      const next = cur === target ? null : target;
      await Store.setCategory(id, snap, next);
      reflect(next);
      // On a side card, untagging removes it from the curated list immediately.
      if (!onMap && next !== "starred" && next !== "maybe") container.style.display = "none";
    };
    star.addEventListener("click", toggle("starred"));
    maybe.addEventListener("click", toggle("maybe"));
    trash.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (onMap) trashMapCard(id, snap, anchor);
      else trashSideCard(id, snap, container);
    });

    actions.append(star, maybe, trash);
    container.appendChild(actions);
  }
}

/* ----------------------------- orchestration ----------------------------- */

function decorateAll() {
  try { decorateCards(); } catch (e) { console.warn("[Archiver] decorateCards failed", e); }
  try { hideArchivedMarkers(); } catch (e) { console.warn("[Archiver] hideArchivedMarkers failed", e); }
  try { colorMarkers(); } catch (e) { console.warn("[Archiver] colorMarkers failed", e); }
}

const observer = new MutationObserver(debounce(decorateAll, 250));

function start() {
  refreshState();
  observer.observe(document.body, { childList: true, subtree: true });
  console.log("[Archiver] decorator active");
}

start();
