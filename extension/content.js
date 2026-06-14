// Airbnb Archiver — the decorator (content script).
// Adds ⭐ star + 🗑 trash controls to listing cards (side list and the map popup
// card), the undo flow (bottom toast with a progress bar), and greying when
// "show archived" is on. The hiding of archived listings is done by the
// interceptor (background.js); this script also defensively hides any archived
// listing React re-renders before the next fetch.
//
// Map price pills are not decorated: clicking a pill opens Airbnb's popup card,
// and you star/trash from that card.

document.documentElement.setAttribute("data-archiver-loaded", "1"); // inject marker (first line)

let archived = {};
let starred = {};
let showArchived = false;

const CURRENCY = /[$€£₲¥₩₪₫฿]/;
const UNDO_MS = 1500;

async function refreshState() {
  archived = await Store.getArchived();
  starred = await Store.getStarred();
  showArchived = (await Store.getSettings()).showArchived;
  decorateAll();
}
browser.storage.onChanged.addListener(refreshState);

/* ----------------------------- helpers ----------------------------- */

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s; }
function idFromHref(href) { const m = href && href.match(/\/rooms\/(\d+)/); return m ? m[1] : null; }

function mapElement() {
  return (
    document.querySelector('[data-testid="map/GoogleMap"]') ||
    document.querySelector('[aria-roledescription="map"]') ||
    document.querySelector('[aria-label="Map"]')
  );
}

// Track the last-clicked map marker, so map-card trash can target the exact pin
// and read a reliable title/price from the marker's own text.
let lastMarker = null;
let lastMarkerInfo = null;
function parseMarkerText(text) {
  // Strip our own injected glyphs (the popup card renders inside the marker).
  const t = (text || "").replace(/[★☆🗑↩]/g, "").replace(/\bUnarchive\b/g, "").replace(/\s+/g, " ").trim();
  const ci = t.search(CURRENCY);
  const title = (ci > 0 ? t.slice(0, ci) : t).replace(/[,\s]+$/, "").trim();
  const pm = t.match(/[$€£₲]\s?[\d.,]+(?:\s*[A-Z]{3})?/);
  return { title, price: pm ? pm[0].replace(/\s+/g, " ").trim() : "" };
}
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".archiver-actions, .archiver-toast")) return; // ignore our UI
  const m = e.target.closest && e.target.closest("gmp-advanced-marker");
  if (m) { lastMarker = m; lastMarkerInfo = parseMarkerText(m.textContent); }
}, true);

// Is this card sitting over the map? (a map popup card vs a side-list card)
function isOverMap(el, mapEl) {
  if (!mapEl) return false;
  const r = el.getBoundingClientRect();
  const mr = mapEl.getBoundingClientRect();
  if (!r.width || !mr.width) return false;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return cx >= mr.left && cx <= mr.right && cy >= mr.top && cy <= mr.bottom;
}

/* ----------------------------- snapshot / price ----------------------------- */

function snapshotFromCard(anchor, container, id) {
  const img = container.querySelector("img");
  // Title/price live as siblings of the (image-only) link, so read the card's
  // visible text: first line = title, first line with a currency = price.
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

/* ----------------------------- map popup helpers ----------------------------- */

// Largest "card-sized" ancestor of the /rooms link — the whole popup card.
// Geometry-based so it doesn't depend on Airbnb's (obfuscated) class names.
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

// Map markers are <gmp-advanced-marker> web components with a precise
// position="lat,lng" attribute. We key off that — titles like
// "Apartment in Villa Morra" are NOT unique and would hide unrelated pins.
// Google Maps re-creates marker elements on render, so decorateAll() re-runs
// this to keep archived pins hidden until the interceptor drops them from data.
function hideArchivedMarkers() {
  if (showArchived) return;
  const coords = new Set(Object.values(archived).map((s) => s.coord).filter(Boolean));
  if (!coords.size) return;
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    const p = m.getAttribute("position");
    if (p && coords.has(p)) m.style.display = "none";
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
  const span = document.createElement("span");
  span.textContent = label;
  const undo = document.createElement("button");
  undo.className = "archiver-undo";
  undo.textContent = "Undo";
  undo.addEventListener("click", () => { cancelled = true; removeToast(); onUndo && onUndo(); });
  const bar = document.createElement("div");
  bar.className = "archiver-progress";
  const fill = document.createElement("div");
  fill.className = "archiver-progress-fill";
  bar.appendChild(fill);
  toastEl.append(span, undo, bar);
  document.body.appendChild(toastEl);

  // Force a reflow so the transition always runs.
  fill.style.width = "0%";
  void fill.offsetWidth;
  fill.style.transition = `width ${UNDO_MS}ms linear`;
  fill.style.width = "100%";

  toastTimer = setTimeout(() => { removeToast(); if (!cancelled) onDone && onDone(); }, UNDO_MS);
}

/* ----------------------------- trash flows ----------------------------- */

function trashSideCard(id, snapshot, container) {
  container.style.display = "none"; // map pin (if any) clears on the next data fetch
  toastUndo(
    `Archiving “${truncate(snapshot.title || ("Listing " + id), 30)}”`,
    () => { container.style.display = ""; },
    () => Store.addArchived(id, snapshot)
  );
}

function trashMapCard(id, snapshot, anchor) {
  const marker = lastMarker;
  const coord = marker ? marker.getAttribute("position") : null; // precise pin key
  // The map card's own text is often empty; prefer the clicked marker's text.
  const snap = {
    ...snapshot,
    title: (lastMarkerInfo && lastMarkerInfo.title) || snapshot.title,
    price: (lastMarkerInfo && lastMarkerInfo.price) || snapshot.price,
    coord,
  };
  const cardRoot = popupCardRoot(anchor);   // the whole popup card
  cardRoot.style.display = "none";          // close the popup → back to map view
  if (marker) marker.style.display = "none"; // hide the exact clicked pin (immediate)
  toastUndo(
    `Archiving “${truncate(snap.title || ("Listing " + id), 30)}”`,
    () => { cardRoot.style.display = ""; if (marker) marker.style.display = ""; },
    () => Store.addArchived(id, snap)
  );
}

/* ----------------------------- controls ----------------------------- */

function makeBtn(cls, glyph, title) {
  const b = document.createElement("button");
  b.className = "archiver-btn " + cls;
  b.textContent = glyph;
  b.title = title;
  return b;
}

function makeStar(id, snap) {
  const b = makeBtn("archiver-star", starred[id] ? "★" : "☆", "");
  const set = (on) => {
    b.classList.toggle("on", on);
    b.textContent = on ? "★" : "☆";
    b.title = on ? "Remove from liked" : "Add to liked";
  };
  set(!!starred[id]);
  b.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const on = !!(await Store.getStarred())[id];
    if (on) { await Store.removeStarred(id); set(false); }
    else { await Store.addStarred(id, snap); set(true); }
  });
  return b;
}

function makeUnarchive(id) {
  const b = document.createElement("button");
  b.className = "archiver-unarchive";
  b.textContent = "↩ Unarchive";
  b.addEventListener("click", async (e) => { e.preventDefault(); e.stopPropagation(); await Store.removeArchived(id); });
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

    if (archived[id] && !showArchived) {
      container.style.display = "none";
      container.dataset.archiverDone = "1";
      continue;
    }

    container.dataset.archiverDone = "1";
    container.dataset.archiverId = id;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    if (archived[id] && showArchived) {
      container.classList.add("archiver-greyed");
      container.appendChild(makeUnarchive(id));
      continue;
    }

    const onMap = isOverMap(container, mapEl);
    const snap = snapshotFromCard(anchor, container, id); // capture BEFORE injecting our UI

    const actions = document.createElement("div");
    actions.className = "archiver-actions" + (onMap ? " archiver-actions--map" : "");

    const star = makeStar(id, snap);
    const trash = makeBtn("archiver-trash", "🗑", "Archive this listing");
    trash.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (onMap) trashMapCard(id, snap, anchor);
      else trashSideCard(id, snap, container);
    });

    actions.append(star, trash); // star left of trash
    container.appendChild(actions);
  }
}

/* ----------------------------- orchestration ----------------------------- */

function decorateAll() {
  try { decorateCards(); } catch (e) { console.warn("[Archiver] decorateCards failed", e); }
  try { hideArchivedMarkers(); } catch (e) { console.warn("[Archiver] hideArchivedMarkers failed", e); }
}

const observer = new MutationObserver(debounce(decorateAll, 250));

function start() {
  document.documentElement.setAttribute("data-archiver-loaded", "1");
  refreshState();
  observer.observe(document.body, { childList: true, subtree: true });
  console.log("[Archiver] decorator active");
}

start();
