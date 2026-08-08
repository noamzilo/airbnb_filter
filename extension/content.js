// Airbnb Archiver - content script.
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
let collapsed = {};   // id -> true, rows shown as a compact strip
let showArchived = false;
let showAllPlaces = false;   // bypass the "only what's on the map" filter
let refPlace = null;         // {lat, lng} the user set; rows then show distance

const CURRENCY = /[$€£₲¥₩₪₫฿]/;
const UNDO_MS = 1500;

async function loadState() {
  cats = await Store.getAll();
  tagCoords = await Store.getTagCoords();
  notes = await Store.getNotes();
  order = await Store.getOrder();
  collapsed = (Store.getCollapsed ? await Store.getCollapsed() : {}) || {};
  images = await Store.getImages();
  prices = (Store.getPrices ? await Store.getPrices() : {}) || {};
  hosts = (Store.getHosts ? await Store.getHosts() : {}) || {};
  threads = (Store.getThreads ? await Store.getThreads() : {}) || {};
  const s = await Store.getSettings();
  showArchived = s.showArchived;
  showAllPlaces = !!s.showAllPlaces;
  refPlace = s.refPlace && isFinite(s.refPlace.lat) && isFinite(s.refPlace.lng) ? s.refPlace : null;
  // Which listing each map pin is depends on all of the above, so any reload
  // invalidates the resolution.
  taggedPointsCache = null;
  resolvedCache = null;
  // A trash whose commit has landed is no longer "pending" - the archived set
  // itself now holds the pin down.
  for (const id of [...pendingArchive]) if (cats.archived[id]) pendingArchive.delete(id);
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
/* --- collapsed rows ------------------------------------------------------
   A collapsed row is the same row in the same slot, just a strip: photo, price
   and its buttons, nothing else. It keeps its drag handle, so tidying the list
   never costs you the ability to reorder it. Persisted, so a list you tidied is
   still tidy after a reload. */
function isCollapsed(id) { return !!collapsed[id]; }
function rowClass(id, cat, extra) {
  return "archiver-row archiver-row--" + cat
    + (isCollapsed(id) ? " archiver-row--collapsed" : "")
    + (extra || "");
}
function saveCollapsed() { if (Store.setCollapsed) Store.setCollapsed(collapsed).catch(() => {}); }
function toggleCollapsed(id) {
  if (collapsed[id]) delete collapsed[id]; else collapsed[id] = true;
  saveCollapsed();
  // Apply it now rather than waiting for the storage round-trip to come back.
  const row = panelEl && panelEl.querySelector(`.archiver-row[data-id="${CSS.escape(id)}"]`);
  if (row) updateRow(row);
  updateHead(panelGroups());
  syncScrollbar();   // the list just got shorter or taller
}
function setCollapseBtn(b, id) {
  const on = isCollapsed(id);
  b.textContent = on ? "▸" : "▾";
  b.title = on ? "Expand this listing" : "Collapse this listing";
  b.setAttribute("aria-expanded", on ? "false" : "true");
}
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
let pageData = null;
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
   around that coordinate - which does server-render a price. See
   scripts/recon_pdp.py and scripts/recon_probe.py. */
const PROBE_TTL_MS = 15 * 60 * 1000;
const PROBE_MAX_INFLIGHT = 2;
const PROBE_MAX_PER_RENDER = 8;
const PROBE_GAP_MS = 400;
// A probe that comes back with NOTHING usually means Airbnb said no - but it is
// also exactly what a login wall, a rate-limit interstitial or a markup change
// looks like, and all of those answer HTTP 200. Taking the first empty answer as
// fact printed a confident "Unavailable" over the one number you're deciding on.
// So look again, on a widening delay, and only believe it after it has said the
// same thing three times across ten minutes.
const PROBE_RETRY_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
// Read at use time, not at load: twelve minutes of backoff is the behaviour
// under test, and there is no other way for a test to reach the far end of it.
function probeRetrySchedule() {
  const o = typeof window !== "undefined" && window.__archiverProbeRetryMs;
  return Array.isArray(o) && o.length ? o : PROBE_RETRY_MS;
}
// Prices also just go stale (PROBE_TTL_MS) on a tab left open. Sweeping on a
// timer refreshes them without waiting for a render to happen to fire.
const PROBE_SWEEP_MS = 60 * 1000;

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
const probedAt = new Map();    // `${id}|${ctx}` -> when we last asked
const probeFails = new Map();  // `${id}|${ctx}` -> consecutive useless answers
function probeKey(id, ctx) { return id + "|" + ctx; }
function askedRecently(key) {
  const t = probedAt.get(key);
  return !!t && Date.now() - t < PROBE_TTL_MS;
}

function schedulePriceProbes(ids) {
  if (typeof Filter === "undefined" || typeof fetch !== "function") return;
  const ctx = currentCtx();
  let queued = 0;
  for (const id of ids) {
    if (queued >= PROBE_MAX_PER_RENDER) break;
    if (priceIsFresh(id) || askedRecently(probeKey(id, ctx)) || probeQueue.includes(id)) continue;
    probeQueue.push(id);
    queued++;
  }
  pumpProbes();
}
function pumpProbes() {
  while (probeInflight < PROBE_MAX_INFLIGHT && probeQueue.length) {
    const id = probeQueue.shift();
    const ctx = currentCtx();
    const key = probeKey(id, ctx);
    if (priceIsFresh(id) || askedRecently(key)) continue;
    probedAt.set(key, Date.now());
    probeInflight++;
    probePrice(id, ctx)
      .catch((e) => { console.warn("[Archiver] price probe failed for", id, e); return "error"; })
      .then((outcome) => {
        if (outcome === "ok") probeFails.delete(key);
        else retryProbeLater(id, ctx, outcome);
        probeInflight--;
        setTimeout(pumpProbes, PROBE_GAP_MS);
      });
  }
}
// Come back to it later instead of writing down an answer we don't trust.
function retryProbeLater(id, ctx, outcome) {
  const key = probeKey(id, ctx);
  const schedule = probeRetrySchedule();
  const tries = (probeFails.get(key) || 0) + 1;
  probeFails.set(key, tries);
  if (tries > schedule.length) {
    // It has answered the same way every time now. An empty box really is
    // "Airbnb isn't offering this"; a dead fetch stays unknown.
    if (outcome === "empty") markUnavailable(id, { ctx, probedAt: Date.now() }).catch(() => {});
    return;
  }
  setTimeout(() => {
    if (currentCtx() !== ctx) return;   // dates changed; the normal path covers it
    if (priceIsFresh(id)) return;
    probedAt.delete(key);
    if (!probeQueue.includes(id)) probeQueue.push(id);
    pumpProbes();
  }, schedule[tries - 1]);
}
// Keep the last known figure so the row still says something useful.
function markUnavailable(id, stamp) {
  const prev = prices[id] || {};
  const last = prev.unavailable ? prev.lastMonthly : (prev.monthly != null ? prev.monthly : null);
  return Store.setMediaBulk({
    [id]: { price: { ...stamp, unavailable: true, monthly: null, symbol: prev.symbol || "", lastMonthly: last } },
  });
}

// Returns "ok" (we learned something we believe), "empty" (the box came back
// with no listings at all - suspicious, not proof) or "error" (never got there).
async function probePrice(id, ctx) {
  let coord = coordFor(id);
  if (!coord) coord = await coordFromListingPage(id);   // bootstrap from the saved link
  if (!coord) return "error";

  const res = await fetch(Filter.probeUrl(location.origin, location.search, coord), { credentials: "same-origin" });
  if (!res.ok) return "error";
  const found = Filter.harvestHtml(await res.text());
  const foundIds = Object.keys(found);

  const stamp = { ctx, probedAt: Date.now() };
  const tracked = new Set([...Object.keys(cats.starred), ...Object.keys(cats.maybe)]);
  const patch = {};
  // One probe returns every listing in the box, so refresh the neighbours too.
  for (const fid of foundIds) {
    if (!tracked.has(fid)) continue;
    const e = found[fid];
    patch[fid] = { images: e.images, coord: e.coord, price: e.price ? { ...e.price, ...stamp } : null };
    if (e.price) probedAt.set(probeKey(fid, ctx), Date.now());
  }
  if (Object.keys(patch).length) await Store.setMediaBulk(patch);

  // Not one listing in a 150m box - in a city that is not what "unavailable"
  // looks like, it is what being blocked looks like. Say nothing and retry.
  if (!foundIds.length) return "empty";
  // Neighbours came back and this one didn't: that is a real answer.
  if (!found[id]) await markUnavailable(id, stamp);
  return "ok";
}

// The room page has no price, but it does carry the coordinate a probe needs,
// plus the host's name, the real listing name and the house rules (pets) - so
// the saved link alone is enough to price and label a listing we've never seen
// on a map. One fetch, cached: `listingPage` dedupes concurrent callers.
const listingPageCache = {};
function fetchListingPage(id) {
  if (listingPageCache[id]) return listingPageCache[id];
  listingPageCache[id] = (async () => {
    const res = await fetch(linkFor(id), { credentials: "same-origin" });
    if (!res.ok) return {};
    const html = await res.text();
    const out = { coord: Filter.coordFromHtml(html), host: Filter.hostFromHtml(html), pets: Filter.petsFromHtml(html) };
    // Host name and pets land in the same record; a page that didn't say
    // must not overwrite what an earlier read did say.
    const facts = { ...(out.host || {}) };
    if (out.pets !== null) facts.pets = out.pets;
    if (Object.keys(facts).length) await Store.setHost(id, facts);
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
// /contact_host/<id>/send_message does NOT resolve to an existing thread - it
// opens a blank new-message form - so a known thread id always wins.
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
    // A record with only the pets flag isn't a hit - the name is still missing.
    const h = hostOf(id);
    if ((h && h.name) || hostAsked.has(id)) continue;
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
    if (e.price) probedAt.set(probeKey(id, ctx), Date.now());
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
/* --- which listing is this map pin? -------------------------------------
   Airbnb reports plenty of listing coordinates rounded to FOUR decimals - which
   was also the tolerance we matched pins by, so for those the match ran at
   exactly the grid spacing of the data and could not tell neighbours apart.
   Measured on one real captured search (scripts/test-marker-id.js): 26
   listings, 7 pairs inside 1e-4, three of them at the *identical* coordinate. A
   coordinate therefore does not identify a listing in a block of flats, which is
   most of Airbnb in a city.

   So resolve a marker by coordinate AND by the price written on its pill, and
   say how sure the answer is. Hiding an archived pin is destructive and silent,
   so it demands a confident match; colouring a starred pin is cosmetic and takes
   the best guess. When two candidates genuinely can't be told apart we do
   nothing - an archived pin lingering until the next fetch (where the
   interceptor drops it by id) is a far better failure than a listing you never
   archived quietly vanishing from the map. */
const NEAR = 1e-4;
function near(a, b) { return !!(a && b && Math.abs(a.lat - b.lat) < NEAR && Math.abs(a.lng - b.lng) < NEAR); }
// Digits of the first money amount in a string: "$1,234 for 5 nights" -> "1234".
function priceDigits(s) {
  const m = String(s == null ? "" : s).match(/[$€£₲¥₩₪₫฿]\s?[\d.,]+/);
  return m ? m[0].replace(/\D/g, "") : "";
}
// Every way this listing's price could plausibly be written on a pill: what it
// said when you tagged it, plus each figure we've since normalised.
function priceTokens(id) {
  const out = new Set();
  const add = (v) => { const d = String(v == null ? "" : v).replace(/\D/g, ""); if (d) out.add(d); };
  add(priceDigits(snapOf(id).price));
  const p = prices[id] || (getPageData()[id] || {}).price;
  if (p) {
    for (const v of [p.total, p.nightly, p.monthly]) {
      if (typeof v !== "number" || !isFinite(v)) continue;
      add(Math.round(v));
      add(v.toFixed(2));
    }
    add(priceDigits(p.label));
  }
  return out;
}
// Rebuilt only when the tagged set or its prices change - this runs on every
// decorate pass and does string work per listing.
let taggedPointsCache = null;
function taggedPoints() {
  if (taggedPointsCache) return taggedPointsCache;
  const out = [];
  for (const cat of ["starred", "maybe", "archived"]) {
    for (const id of Object.keys(cats[cat])) {
      const coord = coordFor(id);
      if (coord) out.push({ id, cat, coord, tokens: priceTokens(id) });
    }
  }
  taggedPointsCache = out;
  return out;
}
// marker element -> { id, cat, confident }
function resolveMarkers() {
  const out = new Map();
  const tagged = taggedPoints();
  if (!tagged.length) return out;
  const markers = [...document.querySelectorAll("gmp-advanced-marker")];
  const pts = markers.map((m) => parsePos(m.getAttribute("position")));
  for (let i = 0; i < markers.length; i++) {
    const p = pts[i];
    if (!p) continue;
    const cands = tagged.filter((t) => near(t.coord, p));
    if (!cands.length) continue;
    let siblings = 0;
    for (const q of pts) if (near(q, p)) siblings++;
    // One tagged listing here and one pin here: nothing to confuse it with.
    if (cands.length === 1 && siblings === 1) { out.set(markers[i], { ...cands[0], confident: true }); continue; }
    const mp = priceDigits(parseMarkerText(markers[i].textContent).price);
    const byPrice = mp ? cands.filter((t) => t.tokens.has(mp)) : [];
    out.set(markers[i], byPrice.length === 1
      ? { ...byPrice[0], confident: true }
      : { ...cands[0], confident: false });
  }
  return out;
}
let resolvedCache = null, resolvedAt = 0;
function markerResolution(force) {
  if (!force && resolvedCache && Date.now() - resolvedAt < 500) return resolvedCache;
  resolvedCache = resolveMarkers();
  resolvedAt = Date.now();
  return resolvedCache;
}
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
// Colouring takes the best guess: a pin wearing the wrong colour is visible and
// harmless, unlike a pin that silently isn't there.
function colorMarkers(resolved) {
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    if (m.style.display === "none") continue;
    const r = resolved.get(m);
    const cls = r && (r.cat === "starred" || r.cat === "maybe") ? r.cat : null;
    if (cls) { if (m.dataset.archiverColor !== cls) paint(m, cls); }
    else if (m.dataset.archiverColor) clearPaint(m);
  }
}

/* ----------------------------- archived pins -----------------------------
   Hide archived pins - and, the half that was missing, put them BACK when they
   stop being archived or when "show archived" goes on. The old code only ever
   set display:none, so unarchiving left the pin gone until Google Maps happened
   to rebuild that marker, which made both the popup's Unarchive and the
   show-archived toggle look broken.

   `data-archiver-hidden` records WHICH listing a pin was hidden for, so putting
   it back is exact and never has to re-resolve an ambiguous marker. */
const pendingArchive = new Set();   // trashed, undo window still open
function syncArchivedMarkers(resolved) {
  for (const m of document.querySelectorAll("gmp-advanced-marker")) {
    const hiddenFor = m.dataset.archiverHidden;
    if (hiddenFor) {
      if (showArchived || (!cats.archived[hiddenFor] && !pendingArchive.has(hiddenFor))) {
        m.style.removeProperty("display");
        delete m.dataset.archiverHidden;
      }
      continue;
    }
    if (showArchived) continue;
    const r = resolved.get(m);
    if (r && r.confident && r.cat === "archived") {
      m.style.display = "none";
      m.dataset.archiverHidden = r.id;
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
/* Every trash button goes through here: the thing vanishes now, you get the undo
   window, and only then is it committed. The panel's rows used to archive on the
   spot with no way back - the panel is the surface you actually click, so that
   was the trash you were most likely to hit by mistake. One function, so the two
   can't drift apart again. `pendingArchive` keeps the pin down for the duration
   without the restore pass fighting it. */
function archiveWithUndo(id, snap, hide, restore) {
  pendingArchive.add(id);
  hide();
  toastUndo(`Archiving “${truncate((snap && snap.title) || ("Listing " + id), 30)}”`,
    () => { pendingArchive.delete(id); restore(); },
    () => { Store.setCategory(id, snap, "archived").catch(() => { pendingArchive.delete(id); restore(); }); });
}
function trashMapCard(id, snapshot, anchor) {
  const marker = lastMarker;
  const coord = marker ? marker.getAttribute("position") : snapshot.coord || null;
  const snap = { ...snapshot, title: (lastMarkerInfo && lastMarkerInfo.title) || snapshot.title, price: (lastMarkerInfo && lastMarkerInfo.price) || snapshot.price, coord };
  const cardRoot = popupCardRoot(anchor);
  archiveWithUndo(id, snap,
    () => {
      cardRoot.style.display = "none";
      if (marker) { marker.style.display = "none"; marker.dataset.archiverHidden = id; }
    },
    () => {
      cardRoot.style.display = "";
      if (marker) { marker.style.removeProperty("display"); delete marker.dataset.archiverHidden; }
    });
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
  // Doing this row by row for a list of thirty would be a chore.
  const collapseAll = document.createElement("button");
  collapseAll.type = "button"; collapseAll.className = "archiver-collapse-all";
  collapseAll.addEventListener("click", toggleCollapseAll);
  head.append(title, count, collapseAll, scope);
  const list = document.createElement("div"); list.className = "archiver-panel-list";
  list.addEventListener("scroll", syncScrollbar, { passive: true });
  panelEl.append(head, buildPlaceBar(), list);
  document.body.appendChild(panelEl);
  ensureScrollbar();
  syncPlaceBar();
  return panelEl;
}

/* --- distance from your place --------------------------------------------
   A search box above the list, like Booking's "distance from" but typed like
   Google Maps: address in, suggestions out (Airbnb's own geocoder, see
   Filter.autocompleteUrl - nothing leaves the browser except airbnb.com),
   pick one and every row shows how far it is. Pasted coordinates or a Google
   Maps link work in the same box. Built once with the panel and never
   rebuilt, so a re-render can't eat what you're typing. */
function buildPlaceBar() {
  const bar = document.createElement("div"); bar.className = "archiver-placebar";
  const pin = document.createElement("span"); pin.className = "archiver-placebar-pin"; pin.textContent = "📍";
  const input = document.createElement("input");
  input.type = "text"; input.className = "archiver-place-input";
  input.placeholder = "Distance from: type an address…";
  const clear = document.createElement("button");
  clear.type = "button"; clear.className = "archiver-place-clear"; clear.textContent = "✕";
  clear.title = "Stop showing distances";
  const drop = document.createElement("div"); drop.className = "archiver-place-drop"; drop.hidden = true;
  bar.append(pin, input, clear, drop);

  const closeDrop = () => { drop.hidden = true; drop.textContent = ""; };
  const showMsg = (text) => {
    drop.hidden = false; drop.textContent = "";
    const m = document.createElement("div"); m.className = "archiver-place-msg"; m.textContent = text;
    drop.appendChild(m);
  };

  // sug: {name, coord} for pasted coordinates, {name, query, placeId} from
  // Airbnb. The place_id fetch is one ~800 KB search page, paid once per
  // place set, never per keystroke.
  const choose = async (sug) => {
    input.value = sug.name;
    if (sug.coord) { closeDrop(); await Store.setSetting("refPlace", { ...sug.coord, raw: sug.name }); return; }
    showMsg("Locating…");
    try {
      const html = await fetch(Filter.placeSearchUrl(location.origin, sug.query, sug.placeId),
        { credentials: "include" }).then((r) => r.text());
      const c = Filter.boundsCenterFromHtml(html);
      if (!c) { showMsg("Airbnb couldn't pin that down. Try adding the city."); return; }
      closeDrop();
      await Store.setSetting("refPlace", { lat: c.lat, lng: c.lng, raw: sug.name });
    } catch (_) { showMsg("Couldn't reach Airbnb to look that up."); }
  };

  let current = [];   // what Enter picks the first of
  let seq = 0;        // stamps requests so a slow reply can't paint over a newer one
  const suggest = debounce(async () => {
    const text = input.value.trim();
    if (!text) { current = []; closeDrop(); return; }
    let sugs;
    const coord = typeof Filter !== "undefined" ? Filter.parsePlace(text) : null;
    if (coord) {
      sugs = [{ name: coord.lat.toFixed(5) + ", " + coord.lng.toFixed(5), coord }];
    } else {
      const mine = ++seq;
      try {
        const j = await fetch(Filter.autocompleteUrl(location.origin, text),
          { credentials: "include" }).then((r) => r.json());
        if (mine !== seq) return;
        sugs = Filter.placesOf(j);
      } catch (_) { sugs = []; }
      if (document.activeElement !== input) return;   // answer arrived after they left
    }
    current = sugs;
    if (!sugs.length) { showMsg("No places match that."); return; }
    drop.hidden = false; drop.textContent = "";
    for (const s of sugs) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "archiver-place-sug"; b.textContent = s.name;
      // pointerdown, not click: the input's blur would close the dropdown
      // before a click ever landed.
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); choose(s); });
      drop.appendChild(b);
    }
  }, 300);

  input.addEventListener("input", suggest);
  input.addEventListener("keydown", (e) => {
    // Airbnb's page-level shortcuts must not fire while typing an address.
    e.stopPropagation();
    if (e.key === "Enter" && current.length) { e.preventDefault(); choose(current[0]); }
    if (e.key === "Escape") closeDrop();
  });
  input.addEventListener("blur", () => setTimeout(closeDrop, 200));
  input.addEventListener("focus", () => { if (input.value.trim()) suggest(); });
  clear.addEventListener("pointerdown", (e) => e.stopPropagation());
  clear.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    input.value = ""; current = []; closeDrop();
    Store.setSetting("refPlace", null);
  });
  return bar;
}

// Reflect the stored place in the bar. Never touches the input while it has
// focus: the storage echo of a save must not yank the text being typed.
function syncPlaceBar() {
  const bar = panelEl && panelEl.querySelector(".archiver-placebar");
  if (!bar) return;
  const input = bar.querySelector(".archiver-place-input");
  const clear = bar.querySelector(".archiver-place-clear");
  clear.style.display = refPlace ? "" : "none";
  if (document.activeElement !== input) {
    input.value = refPlace ? (refPlace.raw || refPlace.lat + ", " + refPlace.lng) : "";
  }
}

/* --- the list's scrollbar ------------------------------------------------
   The panel is pinned to the viewport and the list scrolls inside it, so there
   has to be a visible bar saying how far down you are. The platform won't give
   one: Firefox on Windows draws an overlay scrollbar that reserves no width and
   fades out, and no CSS changes that (see content.css). So draw it: a track on
   the panel's right edge with a draggable thumb, click-to-jump on the track. */
let sbarEl = null, sbarThumb = null;
function ensureScrollbar() {
  if (!panelEl) return null;
  if (sbarEl && panelEl.contains(sbarEl)) return sbarEl;
  sbarEl = document.createElement("div"); sbarEl.className = "archiver-sbar"; sbarEl.hidden = true;
  sbarThumb = document.createElement("div"); sbarThumb.className = "archiver-sbar-thumb";
  sbarEl.appendChild(sbarThumb);

  const listOf = () => panelEl && panelEl.querySelector(".archiver-panel-list");
  // Click the track: jump to that position in the list.
  sbarEl.addEventListener("pointerdown", (e) => {
    const list = listOf();
    if (!list || e.target === sbarThumb) return;
    e.preventDefault(); e.stopPropagation();
    const r = sbarEl.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)));
    list.scrollTop = frac * (list.scrollHeight - list.clientHeight);
    syncScrollbar();
  });
  // Drag the thumb. Listens on window, like the row drag, so a fast drag that
  // leaves the 8px-wide track doesn't just stop.
  sbarThumb.addEventListener("pointerdown", (e) => {
    const list = listOf();
    if (!list || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY, startTop = list.scrollTop;
    const track = sbarEl.getBoundingClientRect().height;
    const thumbH = sbarThumb.getBoundingClientRect().height;
    const range = list.scrollHeight - list.clientHeight;
    const move = (ev) => {
      const room = Math.max(1, track - thumbH);
      list.scrollTop = startTop + (ev.clientY - startY) * (range / room);
      syncScrollbar();
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  });

  panelEl.appendChild(sbarEl);
  return sbarEl;
}
function syncScrollbar() {
  if (!panelEl || !ensureScrollbar()) return;
  const list = panelEl.querySelector(".archiver-panel-list");
  if (!list) return;
  const range = list.scrollHeight - list.clientHeight;
  if (range <= 2) { sbarEl.hidden = true; return; }
  sbarEl.hidden = false;
  const top = list.offsetTop + 4;
  const h = Math.max(24, list.offsetHeight - 8);
  sbarEl.style.top = top + "px";
  sbarEl.style.height = h + "px";
  const thumbH = Math.max(28, Math.round(h * (list.clientHeight / list.scrollHeight)));
  sbarThumb.style.height = thumbH + "px";
  sbarThumb.style.top = Math.round((list.scrollTop / range) * (h - thumbH)) + "px";
}

/* --- taking the card grid's place ---------------------------------------
   The panel used to be a fixed overlay at z-index 9000 laid over Airbnb's
   column. That always covered more than the cards: anything Airbnb draws in
   that space - the search dropdown, menus - went under it. The fix is to stop
   overlaying and start REPLACING: mount the panel where the card grid lives and
   hide the grid, so we inherit the column's width and its place in Airbnb's own
   stacking order. Their popovers then paint over us like they do over cards.

   What must not happen is hiding too much. Climbing to the outermost element
   that still excludes the map hides the whole column, and Airbnb reflows the map
   to full width (measured: left 816 -> 0). So take the cards' lowest common
   ancestor and nothing above it. */
let hiddenGrid = null;
function findCardGrid() {
  const map = mapElement();
  if (!map) return null;
  const mr = map.getBoundingClientRect();
  if (!mr.width) return null;
  const cards = [...document.querySelectorAll('[itemprop="itemListElement"]')]
    .filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width && r.height && r.left < mr.left;
    });
  if (!cards.length) return null;
  let lca = cards[0];
  for (const c of cards.slice(1)) {
    while (lca && !lca.contains(c)) lca = lca.parentElement;
    if (!lca) return null;
  }
  // Never accept something that would take the map or the header with it.
  if (lca === document.body || lca.contains(map)) return null;
  const hdr = document.querySelector("header");
  if (hdr && lca.contains(hdr)) return null;
  return lca;
}
/* Airbnb's pager belongs to the grid we just replaced: it pages through THEIR
   18-per-page results, not ours. Left alone it reads as "5 pages" under a panel
   holding a single row, and clicking a page just reloads the same panel. Our
   list is one scroll over every saved listing on this map, so the pager has
   nothing left to page - hide it with the grid, restore it with the grid.
   Matched structurally (a nav in the results column whose links are numbered
   search pages), not by its English aria-label. */
let hiddenPager = null;
function findPager() {
  const map = mapElement();
  const mr = map && map.getBoundingClientRect();
  for (const nav of document.querySelectorAll("nav")) {
    const r = nav.getBoundingClientRect();
    if (mr && mr.width && r.width && r.left >= mr.left) continue;   // not in the results column
    const numbered = [...nav.querySelectorAll("a,button")]
      .filter((e) => /^\s*\d+\s*$/.test(e.textContent || ""));
    if (numbered.length < 2) continue;
    if (!nav.querySelector('a[href*="/s/"], a[href*="cursor"], a[href*="items_offset"]')) continue;
    return nav;
  }
  return null;
}
function hidePager() {
  const pager = findPager();
  if (pager) {
    if (hiddenPager && hiddenPager !== pager && document.contains(hiddenPager)) {
      hiddenPager.style.removeProperty("display");
    }
    pager.style.display = "none";
    hiddenPager = pager;
  } else if (hiddenPager && document.contains(hiddenPager)) {
    hiddenPager.style.display = "none";   // Airbnb sometimes clears the style back
  }
}
function restorePager() {
  if (hiddenPager && document.contains(hiddenPager)) hiddenPager.style.removeProperty("display");
  hiddenPager = null;
}

// Returns true if the panel is mounted in the column (in flow).
function mountPanel() {
  // findCardGrid only sees VISIBLE cards, so the moment we hide the grid it
  // stops finding one. A fresh hit therefore means Airbnb has re-rendered the
  // column and built a new grid; no hit means ours is still the current one.
  const grid = findCardGrid();
  if (grid) {
    ensurePanel();
    if (panelEl.previousElementSibling !== grid || panelEl.parentElement !== grid.parentElement) {
      grid.parentElement.insertBefore(panelEl, grid);
    }
    if (hiddenGrid && hiddenGrid !== grid && document.contains(hiddenGrid)) {
      hiddenGrid.style.removeProperty("display");
    }
    grid.style.display = "none";
    hiddenGrid = grid;
    return true;
  }
  if (hiddenGrid && document.contains(hiddenGrid) && panelEl &&
      panelEl.parentElement === hiddenGrid.parentElement) {
    hiddenGrid.style.display = "none";   // Airbnb sometimes clears the style back
    return true;
  }
  return false;
}
// Bottom of Airbnb's top chrome - everything the panel must stay clear of.
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
// replaces - which is the whole point: cover them, hide nothing else.
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
  if (!map) { if (panelEl) panelEl.style.display = "none"; restorePager(); return false; }
  const r = map.getBoundingClientRect();
  if (!r.width || r.left < 40) { if (panelEl) panelEl.style.display = "none"; restorePager(); return false; }

  // Preferred: sit in the column in Airbnb's own flow. Nothing to position, and
  // nothing of theirs ends up underneath us.
  if (mountPanel()) {
    hidePager();
    panelEl.classList.remove("archiver-panel-overlay");
    for (const p of ["left", "width", "height"]) panelEl.style.removeProperty(p);
    // Pin it to the viewport and let the LIST scroll (see content.css). Sticky
    // needs a top, and that top has to clear whatever chrome Airbnb is showing,
    // which is the same measurement the overlay fallback makes.
    const top = Math.max(0, Math.round(chromeBottom()));
    panelEl.style.top = top + "px";
    panelEl.style.maxHeight = Math.max(200, Math.round(window.innerHeight - top)) + "px";
    panelEl.style.display = "flex";
    syncScrollbar();
    return true;
  }
  // Fallback: no card grid to replace (Airbnb markup changed, or the column
  // hasn't rendered yet) - lay the old overlay over the column instead.
  panelEl = ensurePanel();
  if (panelEl.parentElement !== document.body) document.body.appendChild(panelEl);
  if (hiddenGrid) { hiddenGrid.style.removeProperty("display"); hiddenGrid = null; }
  restorePager();   // their pager comes back with their grid
  panelEl.classList.add("archiver-panel-overlay");
  panelEl.style.removeProperty("max-height");   // the overlay sizes itself exactly
  // Cover the results column and nothing above it. This used to sit at
  // `max(56, map.top - 96)` - a guess that landed 56px over a 152px-tall header
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
  // Must stay "flex" - an inline display:block here beats the stylesheet, the
  // list stops being a flex item, and it grows past the panel instead of scrolling.
  panelEl.style.display = "flex";
  panelEl.style.top = top + "px";
  panelEl.style.left = "0px";
  panelEl.style.width = Math.round(r.left) + "px";
  panelEl.style.height = Math.max(120, Math.round(bottom - top)) + "px";
  syncScrollbar();
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
// coordinate for. Unplaced listings are always shown - hiding a listing we
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
// overwrite the global order with just those ids - that would throw away the
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
  // Same resolver the colouring uses: prefer a pin we're sure of, settle for the
  // best guess so hovering a row in a shared building still points somewhere.
  // Resolved fresh, never from the memo: Google rebuilds markers as you pan, and
  // a cached answer can point at elements that have since left the document, so
  // the class would land on nothing and the hover would look dead.
  let best = null;
  for (const [m, r] of markerResolution(true)) {
    if (r.id !== id || m.style.display === "none" || !document.contains(m)) continue;
    best = m;
    if (r.confident) break;
  }
  if (!best) return;
  best.style.zIndex = "9999";
  const el = colorableEl(best);
  if (el) el.classList.add("archiver-pill-hover");
  hoverMarker = best;
}

/* --- price, normalised to 30 nights --- */
function fmtMoney(sym, v) { return (sym || "") + Math.round(v).toLocaleString("en-US"); }
/* The stay you actually selected. Read from the URL rather than from whatever
   the quote's label happens to say, so the row can state the period it is
   quoting and can tell you when a stored price was quoted for a different one. */
function currentStay() { return typeof Filter !== "undefined" ? Filter.stayOf(location.search) : null; }
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtStayRange(st) {
  if (!st || !st.checkin || !st.checkout) return "";
  const a = new Date(st.checkin + "T00:00:00Z"), b = new Date(st.checkout + "T00:00:00Z");
  if (!isFinite(a.getTime()) || !isFinite(b.getTime())) return "";
  const d = (x) => x.getUTCDate(), m = (x) => MONTHS[x.getUTCMonth()];
  const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  return sameMonth ? `${d(a)}-${d(b)} ${m(b)}` : `${d(a)} ${m(a)} - ${d(b)} ${m(b)}`;
}
function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
// "📍 2.4 km from your place", or "" when no reference place is set or this
// listing's location was never learned (then saying nothing beats guessing).
function distText(id) {
  if (!refPlace || typeof Filter === "undefined") return "";
  const c = coordFor(id);
  const km = c ? Filter.distanceKm(refPlace, c) : null;
  const s = km == null ? "" : Filter.fmtDistance(km);
  return s ? "📍 " + s + " from your place" : "";
}
// The line for the period you picked: what the whole stay costs, over how many
// nights, between which dates. Empty when nothing is selected, because a
// dateless quote is Airbnb's default and saying "for 5 nights" about it is a lie.
function stayText(price) {
  const st = currentStay();
  if (st && st.months) return plural(st.months, "month") + " selected";
  if (!st) return price && price.nights ? "no dates selected" : "";
  if (price && price.total != null && price.nights) {
    const range = fmtStayRange(st);
    return fmtMoney(price.symbol, price.total) + " for " + plural(price.nights, "night")
      + (range ? "  ·  " + range : "");
  }
  const range = fmtStayRange(st);
  return plural(st.nights, "night") + (range ? "  ·  " + range : "");
}
function priceText(id) {
  const { price } = mediaOf(id);
  if (price && price.unavailable) {
    return {
      head: "Unavailable", unit: "", muted: true, stay: stayText(null),
      sub: price.lastMonthly != null
        ? "last seen " + fmtMoney(price.symbol, price.lastMonthly) + " / 30 nights"
        : "not offered for these dates",
    };
  }
  if (price && price.monthly != null) {
    const st = currentStay();
    const bits = [];
    // What the discount actually is: from how many nights it starts, what
    // percentage it takes off, and what that is in money. "Airbnb monthly rate"
    // used to sit here and said none of that.
    const dsc = price.discount;
    if (dsc && dsc.pct > 0) {
      bits.push((dsc.minNights ? dsc.minNights + "+ nights: " : "")
        + dsc.pct + "% off, saves " + fmtMoney(price.symbol, dsc.amount));
    } else if (price.original != null && price.original > price.monthly) {
      // No breakdown to read (an older cached quote): at least say it is reduced.
      bits.push("reduced from " + fmtMoney(price.symbol, price.original));
    }
    return {
      head: fmtMoney(price.symbol, price.monthly),
      unit: "/ 30 nights",
      perDay: price.nightly != null ? fmtMoney(price.symbol, price.nightly) + " / night" : "",
      stay: stayText(price),
      sub: bits.join("  ·  "),
      // Quoted for a different search than the one on screen, so a probe is on
      // its way. A nights count that disagrees with the selected period says the
      // same thing, and says it even if the context string somehow matches.
      stale: price.ctx !== currentCtx()
        || !!(st && st.nights && price.nights && price.nights !== st.nights),
    };
  }
  const raw = snapOf(id).price || "";
  return { head: raw || "-", unit: "", perDay: "", stay: "", sub: raw ? "" : "checking price…", stale: true };
}

// Which photo each listing is showing. A re-render (a price landing, a note
// saving) rebuilds the rows, and without this every carousel snapped back to
// photo 1 - which looked like the carousel jumping backwards on its own.
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
  row.className = rowClass(id, cat);
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
      if (target === "archived") {
        archiveWithUndo(id, snapOf(id),
          () => { row.style.display = "none"; },
          () => { row.style.removeProperty("display"); });
        return;
      }
      const cur = catOf(id);
      await Store.setCategory(id, snap, cur === target ? null : target);
    });
    return b;
  };
  ctrls.append(mk("★", cat === "starred", "starred", "Star"), mk("?", cat === "maybe", "maybe", "Maybe"), mk("🗑", false, "archived", "Archive"));
  // Last, so the .archiver-rowbtn.on:nth-child(1|2) colour rules still mean
  // star and maybe.
  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "archiver-rowbtn archiver-collapse";
  collapseBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  collapseBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleCollapsed(id); });
  setCollapseBtn(collapseBtn, id);
  ctrls.appendChild(collapseBtn);
  head.append(a, ctrls);

  const perDay = document.createElement("div");
  perDay.className = "archiver-row-perday"; perDay.textContent = p.perDay || "";
  if (!p.perDay) perDay.style.display = "none";

  // What the stay you actually picked costs, on its own line: the 30-night
  // headline is a comparison figure, this is the number you'd pay.
  const stay = document.createElement("div");
  stay.className = "archiver-row-stay"; stay.textContent = p.stay || "";
  if (!p.stay) stay.style.display = "none";

  const sub = document.createElement("div"); sub.className = "archiver-row-sub"; sub.textContent = p.sub;

  // How far from the place the user pinned in the popup (Booking-style).
  const dist = document.createElement("div");
  dist.className = "archiver-row-dist"; dist.textContent = distText(id);
  if (!dist.textContent) dist.style.display = "none";

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

  meta.append(head, perDay, stay, sub, dist, hostRow, buildTabbed(id));
  row.append(media, meta);
  return row;
}

/* --- the note / chat tabs ---------------------------------------------
   The bottom of every row is one slot with two tabs over it: your note (the
   default, and what used to be the whole slot) and the actual conversation with
   the host, embedded live. The point is reading and answering chats without
   leaving the map - the 💬 button in the host row above still opens the full
   thread in its own tab.

   Verified with scripts/recon_chat_iframe.py: framing a real
   /guest/messages/<threadId> from a page on www.airbnb.com works
   (x-frame-options is SAMEORIGIN, and we are that origin), and at panel width
   Airbnb's own responsive layout collapses its inbox sidebar and nav to zero -
   so the frame shows the conversation alone, scroller and composer included.
   Nothing has to be cropped. ------------------------------------------ */

// Which tab each row is on, kept per listing like carouselAt: a re-render must
// not flip you back to the note. Rows are independent - several chats can be
// open at once.
const tabAt = {};

function buildTabbed(id) {
  const box = document.createElement("div"); box.className = "archiver-tabbed";

  const tabs = document.createElement("div"); tabs.className = "archiver-tabs";
  const mk = (key, label, title) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "archiver-tab"; b.dataset.tab = key;
    b.textContent = label; b.title = title;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());  // not a drag
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      tabAt[id] = key;
      applyTab(box, id);
    });
    return b;
  };
  tabs.append(
    mk("note", "Note", "Your private note about this place"),
    mk("chat", "Chat", "Your conversation with the host, right here"));

  const note = document.createElement("textarea");
  note.className = "archiver-note"; note.placeholder = "Add a note…"; note.value = notes[id] || "";
  note.addEventListener("input", debounce(() => Store.setNote(id, note.value), 400));

  const chat = document.createElement("div"); chat.className = "archiver-chat";

  box.append(tabs, note, chat);
  applyTab(box, id);
  return box;
}

// Show one tab and hide the other. The hidden pane is only ever hidden, never
// removed: pulling the iframe out of the DOM would end the conversation's
// browsing context, so flipping to the note and back would reload the chat and
// lose your place in it.
function applyTab(box, id) {
  const key = tabAt[id] === "chat" ? "chat" : "note";
  for (const b of box.querySelectorAll(".archiver-tab")) b.classList.toggle("on", b.dataset.tab === key);
  const note = box.querySelector(".archiver-note");
  const chat = box.querySelector(".archiver-chat");
  if (note) note.style.display = key === "note" ? "" : "none";
  if (chat) {
    chat.style.display = key === "chat" ? "" : "none";
    if (key === "chat") fillChat(chat, id);
  }
}

// The conversation loads only when its tab is actually opened - booting Airbnb's
// message app once per row for a panel of forty would be ruinous - and then
// stays loaded. Re-running this is free unless the pane's state genuinely
// changed, which is what upgrades "no conversation yet" into the real thread the
// moment one is learned.
function fillChat(pane, id) {
  const want = hasThread(id) ? "frame" : "empty";
  if (pane.dataset.state === want) return;
  pane.dataset.state = want;
  pane.textContent = "";

  if (want === "empty") {
    // Nothing to embed: a listing you've never messaged has no thread, and
    // /contact_host is a blank compose form, not a conversation.
    const box = document.createElement("div"); box.className = "archiver-chat-empty";
    const p = document.createElement("p"); p.textContent = "No conversation about this place yet.";
    const a = document.createElement("a");
    a.className = "archiver-chat-start";
    a.href = chatUrlFor(id); a.target = "_blank"; a.rel = "noreferrer";
    a.textContent = "💬 Message the host";
    const hint = document.createElement("p");
    hint.className = "archiver-chat-hint";
    hint.textContent = "Send one message and the thread appears here.";
    box.append(p, a, hint);
    pane.appendChild(box);
    return;
  }

  const f = document.createElement("iframe");
  f.className = "archiver-chat-frame";
  f.title = "Conversation with the host";
  f.src = chatUrlFor(id);
  pane.appendChild(f);
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
  // must NOT rebuild the DOM - that resets every carousel and steals focus from
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
  lastSig = sig;

  updateHead(g);

  const items = [];
  if (!g.total) {
    items.push(emptyItem("Nothing here yet - star or “maybe” listings from the map."));
  } else {
    for (const id of g.shown) items.push(rowItem(id));
    if (g.unplaced.length) {
      items.push(dividerItem(`${g.unplaced.length} without a saved location`));
      for (const id of g.unplaced) items.push(rowItem(id));
    }
    if (!g.shown.length && !g.unplaced.length) {
      items.push(emptyItem(`None of your ${g.total} listings are in this part of the map.`));
    } else if (g.hidden) {
      items.push(dividerItem(`${g.hidden} more elsewhere on the map`));
    }
  }
  syncList(list, items);
  list.scrollTop = scroll; // a re-render shouldn't jump you back to the top
  syncScrollbar();
  if (!g.total) return;
  // Rows that were kept are still showing the old price/host, so refresh them.
  for (const row of list.querySelectorAll(".archiver-row")) updateRow(row);
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

/* --- rebuilding the list without throwing away what's still in it ------
   The panel used to empty the list and re-create every row whenever the set of
   listings changed - which is every map pan. That is now unaffordable: a row's
   Chat tab holds a live iframe, and removing (or even moving) an iframe ends its
   browsing context, so the conversation you were reading would reload from the
   top. So match the wanted list against what's on screen by key and touch only
   the difference. Rows that keep their relative order are never moved, so
   panning a couple of listings out of view leaves an open chat - and a carousel,
   and a note caret - completely undisturbed. -------------------------- */
function rowItem(id) { return { key: "r:" + id, build: () => panelRow(id) }; }
function dividerItem(text) { return { key: "d:" + text, build: () => divider(text) }; }
function emptyItem(text) {
  return { key: "e:" + text, build: () => {
    const e = document.createElement("div");
    e.className = "archiver-panel-empty"; e.textContent = text;
    return e;
  } };
}
function syncList(list, items) {
  const have = new Map();
  for (const child of [...list.children]) {
    const k = child.dataset ? child.dataset.key : null;
    if (k && !have.has(k)) have.set(k, child);
    else child.remove();            // unkeyed or a duplicate: not reusable
  }
  let cursor = list.firstChild;
  for (const it of items) {
    let node = have.get(it.key);
    if (node) {
      have.delete(it.key);
      if (node === cursor) { cursor = cursor.nextSibling; continue; }  // already in place
    } else {
      node = it.build();
      node.dataset.key = it.key;
    }
    list.insertBefore(node, cursor);
  }
  for (const stale of have.values()) stale.remove();
}
function setChatLink(a, id) {
  a.href = chatUrlFor(id);
  const known = hasThread(id);
  a.textContent = known ? "💬 Chat" : "💬 Message";
  a.classList.toggle("archiver-host-chat--new", !known);
  a.title = known
    ? "Open your existing conversation about this listing"
    : "No conversation recorded yet - this opens Airbnb's new-message form. Open the chat once and this will link straight to it.";
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
// Collapse everything on screen, or open it all back up. Only touches the rows
// the panel is actually showing, so it can't quietly re-tidy another city.
function toggleCollapseAll() {
  let g;
  try { g = panelGroups(); } catch (e) { return; }
  const ids = [...g.shown, ...g.unplaced];
  if (!ids.length) return;
  const anyOpen = ids.some((id) => !collapsed[id]);
  for (const id of ids) { if (anyOpen) collapsed[id] = true; else delete collapsed[id]; }
  saveCollapsed();
  if (panelEl) for (const row of panelEl.querySelectorAll(".archiver-row")) updateRow(row);
  updateHead(g);
  syncScrollbar();
}
function updateHead(g) {
  const count = panelEl && panelEl.querySelector(".archiver-panel-count");
  const scope = panelEl && panelEl.querySelector(".archiver-scope");
  const collapseAll = panelEl && panelEl.querySelector(".archiver-collapse-all");
  if (collapseAll) {
    const ids = [...g.shown, ...g.unplaced];
    const anyOpen = ids.some((id) => !collapsed[id]);
    collapseAll.textContent = anyOpen ? "Collapse" : "Expand";
    collapseAll.title = anyOpen ? "Shrink every listing shown to a strip" : "Show every listing shown in full";
    collapseAll.disabled = !ids.length;
    collapseAll.classList.toggle("on", !anyOpen && ids.length > 0);
  }
  if (count) count.textContent = g.filtered ? `${g.shown.length} of ${g.total} on this map` : `${g.total} listing${g.total === 1 ? "" : "s"}`;
  if (scope) {
    scope.textContent = showAllPlaces ? "On this map" : "Show all";
    scope.title = showAllPlaces
      ? "Only show listings inside the current map view"
      : `Show all ${g.total} listings, including other cities`;
    scope.classList.toggle("on", showAllPlaces);
  }
  syncPlaceBar();
}
// Refresh a row's live bits without touching the DOM the user is interacting
// with (carousel position, note caret).
function updateRow(row) {
  const id = row.dataset.id;
  if (!id) return;
  const cat = catOf(id);
  row.className = rowClass(id, cat, row.classList.contains("dragging") ? " dragging" : "");
  const collapseBtn = row.querySelector(".archiver-collapse");
  if (collapseBtn) setCollapseBtn(collapseBtn, id);

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
  const stay = row.querySelector(".archiver-row-stay");
  if (stay) { stay.textContent = p.stay || ""; stay.style.display = p.stay ? "" : "none"; }
  const sub = row.querySelector(".archiver-row-sub");
  if (sub) sub.textContent = p.sub;
  const dist = row.querySelector(".archiver-row-dist");
  if (dist) { const t = distText(row.dataset.id); dist.textContent = t; dist.style.display = t ? "" : "none"; }
  const hostRow = row.querySelector(".archiver-row-host");
  if (hostRow) fillHost(hostRow, id);
  const chat = row.querySelector(".archiver-host-chat");
  if (chat) setChatLink(chat, id);
  // Keeps the row on its tab, and swaps "no conversation yet" for the real
  // thread as soon as visiting one teaches us the mapping.
  const tabbed = row.querySelector(".archiver-tabbed");
  if (tabbed) applyTab(tabbed, id);

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
/* Where the bar belongs on a MESSAGE THREAD page: in the flow at the top of the
   conversation column, above the host's name. Floating it (fixed, bottom) put it
   straight over Airbnb's compose box - you couldn't see what you were typing.
   Verified layout (scripts/recon_thread_layout.py, logged in): the thread column
   is `section[data-testid="orbital-panel-thread"]`, and inside it a flex column
   holds the header (host name) above the message pane + composer. Insert before
   that header and the pane simply shrinks. Anchored on data-testids and on
   *computed* flex direction rather than Airbnb's hashed class names.
   Returns null on any other page, where the floating bar covers nothing. */
function threadDock() {
  const sec = document.querySelector('[data-testid="orbital-panel-thread"]');
  if (!sec) return null;
  const anchor = sec.querySelector('[data-testid="message-thread-container"]')
    || sec.querySelector('[data-testid="message-list"]')
    || sec.querySelector('[data-testid="messaging-composebar"]');
  if (!anchor) return null;
  let node = anchor;
  for (let i = 0; i < 10 && node !== sec && node.parentElement; i++) {
    const p = node.parentElement;
    const st = getComputedStyle(p);
    let first = p.firstElementChild;
    // Our own bar, once docked, must not be mistaken for the header - that
    // would make every pass re-insert it and churn the page forever.
    if (first && first.classList.contains("archiver-bridge")) first = first.nextElementSibling;
    if (st.display.indexOf("flex") !== -1 && st.flexDirection === "column" && first && first !== node) {
      return { parent: p, before: first };
    }
    node = p;
  }
  return null;
}
/* The blank strip ABOVE the conversation - Airbnb's own header band, which is
   empty across the middle. Sitting there costs the chat nothing (the bar is
   fixed, out of the flow) and still reads as "above the host's name".
   Measured live at 900–1500px wide (scripts/recon_thread_topband.py): the band
   is 81–97px tall, with only the logo on the left and the nav on the right, so
   the free middle is 400–500px+. Returns the slot, or null when it won't fit -
   then we fall back to docking in the flow. */
function topBandSlot(header) {
  const hr = header.getBoundingClientRect();
  const bandBottom = hr.top;
  if (bandBottom < 52 || hr.width < 300) return null;
  let left = hr.left, right = hr.right;
  const mid = (hr.left + hr.right) / 2;
  for (const el of document.querySelectorAll("header a, header button, header img, header svg, nav a, nav button")) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.top >= bandBottom || r.bottom <= 0) continue;
    if (r.right <= left || r.left >= right) continue;   // clear of us already
    if (r.right <= mid) left = Math.max(left, r.right + 10);
    else right = Math.min(right, r.left - 10);
  }
  if (right - left < 280) return null;
  return { left, width: right - left, bottom: bandBottom };
}
// Only ever write a style that actually changed: an attribute set to the same
// value still fires the MutationObserver, and this runs from it - writing
// unconditionally would keep the page re-laying-out forever.
function setStyle(el, prop, val) { if (el.style[prop] !== val) el.style[prop] = val; }
function clearBridgePlacement(bar) {
  bar.classList.remove("archiver-bridge--docked", "archiver-bridge--top");
  setStyle(bar, "left", ""); setStyle(bar, "top", ""); setStyle(bar, "width", "");
}
function mountBridge(bar) {
  // Never move or re-measure the bar while you're typing in it: the note grows
  // as it fills, so its height is deliberately "wrong" for the slot, and moving
  // a focused field (or re-parenting it) would take the caret with it.
  if (bar.contains(document.activeElement)) return;
  const dock = threadDock();
  const slot = dock && topBandSlot(dock.before);
  if (slot) {
    // Fixed in the blank band: costs the conversation no space at all.
    if (bar.parentElement !== document.body) {
      bar.classList.remove("archiver-bridge--docked");
      document.body.appendChild(bar);
    }
    bar.classList.add("archiver-bridge--top");
    setStyle(bar, "left", Math.round(slot.left) + "px");
    setStyle(bar, "width", Math.round(slot.width) + "px");
    // Its height is only known once it has been laid out at that width.
    setStyle(bar, "top", Math.max(2, Math.round(slot.bottom - bar.offsetHeight - 6)) + "px");
    return;
  }
  if (dock) {
    // Nothing fits up there - dock in the flow above the header. Still better
    // than floating over the composer.
    if (bar.classList.contains("archiver-bridge--top")) clearBridgePlacement(bar);
    bar.classList.add("archiver-bridge--docked");
    if (bar.parentElement !== dock.parent || bar.nextElementSibling !== dock.before) {
      dock.parent.insertBefore(bar, dock.before);
    }
    return;
  }
  // Not a thread page: the original floating bar, which covers nothing there.
  clearBridgePlacement(bar);
  if (bar.parentElement !== document.body) document.body.appendChild(bar);
}
function repositionBridge() {
  const bar = document.querySelector(".archiver-bridge");
  if (bar) mountBridge(bar);
}
// How tall the note is allowed to get - which depends on which way it grows.
// The top-band bar is pinned by its top, so the box extends DOWN and the limit
// is the bottom of the window. The floating bar is anchored to `bottom`, so it
// extends UP and the limit is how much is above it: measuring downward there
// left only the ~70px under the bar, which looked exactly like "it stops
// expanding after two lines".
function noteRoom(note) {
  const bar = note.closest(".archiver-bridge");
  const r = note.getBoundingClientRect();
  if (!bar) return window.innerHeight - 32;
  if (bar.classList.contains("archiver-bridge--top")) return window.innerHeight - r.top - 16;
  if (getComputedStyle(bar).position === "fixed") return r.bottom - 16;   // grows upward
  return window.innerHeight - 32;                                        // in flow
}
// Grow the note to hold everything typed in it; the extra height simply covers
// whatever is behind the bar, which is the point.
function growNote(note) {
  if (document.activeElement !== note) return;
  note.style.height = "auto";
  // scrollHeight is the content box; the height we set is the border box, so add
  // the borders back or the last line stays clipped behind a scrollbar.
  const borders = note.offsetHeight - note.clientHeight;
  note.style.height = Math.max(32, Math.min(note.scrollHeight + borders, noteRoom(note))) + "px";
}
// Self-heal: whatever event we failed to hook (paste variants, IME, a re-render
// that swapped the field), a focused note that doesn't fit gets re-grown on the
// next decorate pass. Costs nothing when it already fits - and writes nothing,
// so it can't churn the MutationObserver that calls it.
function growNoteIfClipped(note) {
  if (!note || document.activeElement !== note) return;
  if (note.scrollHeight > note.clientHeight) growNote(note);
}
function bridgeBar() {
  let bar = document.querySelector(".archiver-bridge");
  if (bar) { mountBridge(bar); return bar; }
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
  // A one-line slot while you're not using it; while you are, it grows to fit
  // every line and simply covers what's underneath (the bar is fixed and on top).
  note.addEventListener("focus", () => growNote(note));
  note.addEventListener("input", () => growNote(note));
  // keyup/paste are belt and braces: `input` covers every text change, but a
  // missed one must not leave you typing into a box you can't read.
  note.addEventListener("keyup", () => growNoteIfClipped(note));
  note.addEventListener("paste", () => setTimeout(() => growNote(note), 0));
  note.addEventListener("blur", () => { note.style.height = ""; });
  text.append(title, subtitle);
  const go = document.createElement("a");
  go.className = "archiver-bridge-btn"; go.target = "_top"; go.rel = "noreferrer";
  // Note as a sibling, not nested in the text block: the floating bar wraps it
  // onto its own line, the top-band bar keeps all three on one row.
  bar.append(text, note, go);
  mountBridge(bar);
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
    growNoteIfClipped(noteEl);   // last resort, on every decorate pass
    // Set the value when the listing changes, or to reflect an external edit -
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
/* Which listing an open conversation is about. This used to serialise
   `document.body.innerHTML` and regex the result on EVERY decorate pass - a
   multi-megabyte string rebuilt over and over, on the one page (a live chat)
   that never stops mutating. The thread's own /rooms links carry the same
   answer, read straight off the DOM, and the answer can't change while you stay
   on that thread - so read it from links and remember it.
   Same rule as Filter.listingIdFromThread: the inbox sidebar links every OTHER
   conversation's listing too, so the one that recurs is the open one. */
const threadListing = new Map();   // pathname -> listing id
const threadScans = new Map();     // pathname -> full-text fallbacks spent
function listingForThread() {
  const path = location.pathname;
  if (threadListing.has(path)) return threadListing.get(path);
  const counts = new Map();
  for (const a of document.querySelectorAll('a[href*="/rooms/"]')) {
    const m = (a.getAttribute("href") || "").match(/\/rooms\/(\d+)/);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
  // No links yet (the thread is still booting), or the id only lives in the
  // page's JSON: fall back to the full-text scan a few times, then stop asking.
  if (!best) {
    const tries = (threadScans.get(path) || 0) + 1;
    threadScans.set(path, tries);
    if (tries <= 3) best = Filter.listingIdFromThread(document.body ? document.body.innerHTML : "");
  }
  if (best) threadListing.set(path, best);
  return best;
}
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
  // On a thread page the listing isn't in the URL - it's whatever room the
  // conversation links to.
  const id = roomId || listingForThread();
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
// Re-price whatever the panel is showing, on a timer rather than only when a
// render happens to fire. Anything still fresh is skipped inside.
function sweepProbes() {
  if (!panelEl || !document.body.contains(panelEl) || panelEl.style.display === "none") return;
  let g;
  try { g = panelGroups(); } catch (e) { return; }
  try { schedulePriceProbes([...g.shown, ...g.unplaced]); } catch (e) { console.warn("[Archiver] probe sweep", e); }
}
function syncPanelToMap() {
  if (dragRow) return;
  let g;
  try { g = panelGroups(); } catch (e) { return; }
  if (groupSig(g) !== lastSig) renderPanel();
}

function decorateAll() {
  try { decorateMapCards(); } catch (e) { console.warn("[Archiver] decorateMapCards", e); }
  // Resolve pins to listings once, then let both passes read the same answer.
  let resolved = new Map();
  try { resolved = markerResolution(true); } catch (e) { console.warn("[Archiver] resolveMarkers", e); }
  try { syncArchivedMarkers(resolved); } catch (e) { console.warn("[Archiver] syncArchivedMarkers", e); }
  try { colorMarkers(resolved); } catch (e) { console.warn("[Archiver] colorMarkers", e); }
  try { positionPanel(); } catch (e) { console.warn("[Archiver] positionPanel", e); }
  try { syncPanelToMap(); } catch (e) { console.warn("[Archiver] syncPanelToMap", e); }
  try { decorateBridge(); } catch (e) { console.warn("[Archiver] decorateBridge", e); }
}
const observer = new MutationObserver(debounce(decorateAll, 250));
window.addEventListener("resize", debounce(() => { positionPanel(); repositionBridge(); }, 200));
// The top edge now follows the cards, which move under the sticky header as you
// scroll - so re-place it on scroll too, or a strip of Airbnb's own cards shows
// through above the panel.
window.addEventListener("scroll", debounce(positionPanel, 100), { passive: true });
window.addEventListener("popstate", () => setTimeout(syncPanelToMap, 50));

async function start() {
  await loadState();
  observer.observe(document.body, { childList: true, subtree: true });
  // Listings rendered on this very page are priced for free - probe only the rest.
  try { await seedFromPageData(); } catch (e) { console.warn("[Archiver] seedFromPageData", e); }
  decorateAll();
  renderPanel();
  // Backstop: history.pushState from the page fires no event we can see.
  // Re-place the panel on the same backstop. Geometry can change with no DOM
  // mutation to observe (the search bar expanding, a late font, the map getting
  // its size), and without this a panel hidden at first render never recovers.
  setInterval(() => { syncPanelToMap(); try { positionPanel(); } catch (e) {} }, 700);
  // Prices expire and probes get blocked; both are fixed by asking again a bit
  // later, so don't make it wait for the next render.
  setInterval(sweepProbes, PROBE_SWEEP_MS);
  console.log("[Archiver] active");
}
start();
