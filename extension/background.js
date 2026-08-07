// Airbnb Archiver — the interceptor (the make-or-break piece).
// Rewrites Airbnb's search data BEFORE the page renders it: removes archived
// listings, and re-injects starred listings Airbnb dropped (so they always show
// on the map + list). Firefox-only capability (filterResponseData).

let archivedSet = new Set();
let starredSet = new Set();
let maybeSet = new Set();
let tagCache = {};            // persisted full objects for starred+maybe (storage key "starredData")
let tagCoordsCache = {};      // persisted { id: {lat,lng} } for starred+maybe (pin colouring)
let imagesCache = {};         // persisted { id: [url,...] } for the panel carousel
let pricesCache = {};         // persisted { id: {monthly,nightly,total,nights,symbol} }
let showArchived = false;
let rewriteDocuments = false;   // opt-in; see Filter.shouldFilter
let lastCtx = "";             // price context (dates/guests) of the last search seen
const seen = {};              // session cache: { id: {searchResult,mapResult,viewportPin,coord} }

let refreshing = false;
async function refresh() {
  if (refreshing) return;     // our own persist writes re-enter onChanged
  refreshing = true;
  try {
    const { archived = {}, settings = {}, starred = {}, maybe = {}, starredData = {}, tagCoords = {}, images = {}, prices = {} } =
      await browser.storage.local.get(["archived", "settings", "starred", "maybe", "starredData", "tagCoords", "images", "prices"]);
    archivedSet = new Set(Object.keys(archived));
    starredSet = new Set(Object.keys(starred));
    maybeSet = new Set(Object.keys(maybe));
    tagCache = starredData;
    tagCoordsCache = tagCoords;
    imagesCache = images;
    pricesCache = prices;
    showArchived = !!settings.showArchived;
    rewriteDocuments = !!settings.rewriteDocuments;
  } finally {
    refreshing = false;
  }
  // A listing tagged just now is usually already in `seen` from the response that
  // rendered it — harvest its photos/price immediately instead of waiting for the
  // next search (otherwise the panel shows a lone thumbnail and no price).
  persistFromSeen();
}
refresh();
browser.storage.onChanged.addListener(refresh);

/* ---- persist coords promptly (for pin colouring) + starred objects (slower) ---- */
let coordTimer = null, dataTimer = null, coordDirty = false, dataDirty = false;
function persistFromSeen() {
  // coords + photos + normalised price for starred + maybe (drive pin colouring
  // and the panel rows) — prompt
  for (const id of new Set([...starredSet, ...maybeSet])) {
    const s = seen[id];
    if (!s) continue;
    if (s.coord) {
      const cur = tagCoordsCache[id];
      if (!cur || cur.lat !== s.coord.lat || cur.lng !== s.coord.lng) { tagCoordsCache[id] = { lat: s.coord.lat, lng: s.coord.lng }; coordDirty = true; }
    }
    const item = s.searchResult || s.mapResult;
    const imgs = Filter.imagesOf(item);
    if (imgs.length && JSON.stringify(imagesCache[id]) !== JSON.stringify(imgs)) { imagesCache[id] = imgs; coordDirty = true; }
    // Stamp with the price context so the content script knows whether a stored
    // price still applies to the current dates/guests or needs a live probe.
    const p = Filter.priceOf(item);
    if (p) {
      const cur = pricesCache[id];
      const same = cur && cur.ctx === lastCtx && !cur.unavailable
        && cur.monthly === p.monthly && cur.nightly === p.nightly;
      if (!same) { pricesCache[id] = { ...p, ctx: lastCtx, probedAt: Date.now() }; coordDirty = true; }
    }
  }
  // full objects for starred (drive map re-injection) — heavier, slower
  for (const id of starredSet) {
    if (seen[id] && seen[id].coord) { tagCache[id] = JSON.parse(JSON.stringify(seen[id])); dataDirty = true; }
  }
  if (coordDirty && !coordTimer) coordTimer = setTimeout(flushCoords, 300);
  if (dataDirty && !dataTimer) dataTimer = setTimeout(flushData, 2000);
}
function flushCoords() {
  coordTimer = null;
  if (!coordDirty) return;
  coordDirty = false;
  browser.storage.local.set({ tagCoords: tagCoordsCache, images: imagesCache, prices: pricesCache }).catch(() => {});
}
function flushData() {
  dataTimer = null;
  if (!dataDirty) return;
  dataDirty = false;
  browser.storage.local.set({ starredData: tagCache }).catch(() => {});
}

function pickObjs(set) {
  const out = {};
  for (const id of set) {
    const o = seen[id] || tagCache[id];
    if (o && o.coord) out[id] = o;
  }
  return out;
}

/* ---- core: parse once, learn, remove archived, inject starred ---- */
function processJson(text) {
  const root = JSON.parse(text);
  Filter.collectSeen(root, seen);
  persistFromSeen();
  const removed = showArchived ? 0 : Filter.filterNode(root, archivedSet);
  // Map re-injection DISABLED: splicing cached GraphQL objects into a live
  // response crashes Airbnb's client (blank page). The panel already shows all
  // starred/maybe from snapshots, so this was redundant. Colouring + forceFullPins
  // still make starred pins blue/full whenever Airbnb returns them.
  const fullPins = Filter.forceFullPins(root, starredSet);
  if (removed || fullPins) console.log(`[Archiver] removed ${removed}, fullPins ${fullPins}`);
  return JSON.stringify(root);
}

function concatChunks(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function rewriteJson(text) {
  try { return processJson(text); }
  catch (e) { console.warn("[Archiver] XHR process failed, passing through", e); return text; }
}

function rewriteHtml(text) {
  const out = text.replace(
    /(<script id="data-deferred-state-\d+"[^>]*>)([\s\S]*?)(<\/script>)/g,
    (full, open, json, close) => {
      try { return open + Filter.escapeForScript(processJson(json)) + close; }
      catch (e) { console.warn("[Archiver] HTML blob process failed, passing through", e); return full; }
    }
  );
  // A document we hand back malformed doesn't fail loudly — the parser silently
  // loses sync, swallows the page up to the next </script>, and paints the raw
  // JSON of a later <script type="application/json"> as class-name soup. Only
  // ship a rewrite that still looks like the document we were given.
  if (!Filter.sameHtmlShape(text, out)) {
    console.warn("[Archiver] rewritten document changed shape, passing original through");
    return text;
  }
  return out;
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // The page URL carries the dates/guests; an XHR's own URL doesn't. Worth
    // recording even for requests we then leave alone.
    lastCtx = Filter.ctxOf(details.documentUrl || details.url);

    // Never create a stream filter we aren't going to use: holding one open is
    // itself the risk. See Filter.shouldFilter for why documents are opt-in.
    if (!Filter.shouldFilter(details, { rewriteDocuments: rewriteDocuments })) return;

    // NB: we process even when nothing is tagged yet, so `seen` is warm and the
    // very first star/maybe still gets photos + a price for the panel.
    const isDoc = details.type === "main_frame";
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];

    filter.ondata = (event) => chunks.push(new Uint8Array(event.data));
    filter.onstop = () => {
      const buf = concatChunks(chunks);
      // Decide on the bytes BEFORE writing any. Writing inside the try meant a
      // throw mid-write fell into the catch and wrote the body a second time,
      // appending a whole duplicate document to a partial one.
      let bytes = buf;
      try {
        const text = new TextDecoder("utf-8").decode(buf);
        const out = isDoc ? rewriteHtml(text) : rewriteJson(text);
        if (out !== text) bytes = new TextEncoder().encode(out);
      } catch (e) {
        console.warn("[Archiver] rewrite failed, passing original through", e);
      }
      try { filter.write(bytes); } catch (e) { console.warn("[Archiver] write failed", e); }
      filter.close();
    };
    filter.onerror = () => console.warn("[Archiver] stream filter error:", filter.error);
  },
  {
    urls: ["*://*.airbnb.com/s/*", "*://*.airbnb.com/api/v3/StaysSearch*"],
    types: ["main_frame", "xmlhttprequest"],
  },
  ["blocking"]
);

console.log("[Archiver] background interceptor registered");
