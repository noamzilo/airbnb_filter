// Airbnb Archiver — the interceptor (the make-or-break piece).
// Rewrites Airbnb's search data BEFORE the page renders it: removes archived
// listings, and re-injects starred listings Airbnb dropped (so they always show
// on the map + list). Firefox-only capability (filterResponseData).

let archivedSet = new Set();
let starredSet = new Set();
let maybeSet = new Set();
let tagCache = {};            // persisted full objects for starred+maybe (storage key "starredData")
let tagCoordsCache = {};      // persisted { id: {lat,lng} } for starred+maybe (pin colouring)
let showArchived = false;
const seen = {};              // session cache: { id: {searchResult,mapResult,viewportPin,coord} }

async function refresh() {
  const { archived = {}, settings = {}, starred = {}, maybe = {}, starredData = {}, tagCoords = {} } =
    await browser.storage.local.get(["archived", "settings", "starred", "maybe", "starredData", "tagCoords"]);
  archivedSet = new Set(Object.keys(archived));
  starredSet = new Set(Object.keys(starred));
  maybeSet = new Set(Object.keys(maybe));
  tagCache = starredData;
  tagCoordsCache = tagCoords;
  showArchived = !!settings.showArchived;
}
refresh();
browser.storage.onChanged.addListener(refresh);

/* ---- persist starred full objects + starred/maybe coords (throttled) ---- */
let persistTimer = null, persistDirty = false;
function persistFromSeen() {
  let changed = false;
  for (const id of new Set([...starredSet, ...maybeSet])) {
    if (!(seen[id] && seen[id].coord)) continue;
    tagCache[id] = JSON.parse(JSON.stringify(seen[id]));
    const c = seen[id].coord;
    const cur = tagCoordsCache[id];
    if (!cur || cur.lat !== c.lat || cur.lng !== c.lng) tagCoordsCache[id] = { lat: c.lat, lng: c.lng };
    changed = true;
  }
  if (changed) {
    persistDirty = true;
    if (!persistTimer) persistTimer = setTimeout(flush, 2000);
  }
}
function flush() {
  persistTimer = null;
  if (!persistDirty) return;
  persistDirty = false;
  browser.storage.local.set({ starredData: tagCache, tagCoords: tagCoordsCache }).catch(() => {});
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
  const injected = Filter.injectListings(root, pickObjs(starredSet), true);   // starred: map + list
  const injectedMaybe = Filter.injectListings(root, pickObjs(maybeSet), false); // maybe: list only
  const fullPins = Filter.forceFullPins(root, starredSet);
  if (removed || injected || injectedMaybe || fullPins) {
    console.log(`[Archiver] removed ${removed}, injected ${injected}+${injectedMaybe}, fullPins ${fullPins}`);
  }
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
  return text.replace(
    /(<script id="data-deferred-state-\d+"[^>]*>)([\s\S]*?)(<\/script>)/g,
    (full, open, json, close) => {
      try { return open + Filter.escapeForScript(processJson(json)) + close; }
      catch (e) { console.warn("[Archiver] HTML blob process failed, passing through", e); return full; }
    }
  );
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Nothing tagged at all: let the response stream through untouched.
    if (archivedSet.size === 0 && starredSet.size === 0 && maybeSet.size === 0) return;

    const isDoc = details.type === "main_frame";
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];

    filter.ondata = (event) => chunks.push(new Uint8Array(event.data));
    filter.onstop = () => {
      const buf = concatChunks(chunks);
      try {
        const text = new TextDecoder("utf-8").decode(buf);
        const out = isDoc ? rewriteHtml(text) : rewriteJson(text);
        filter.write(new TextEncoder().encode(out));
      } catch (e) {
        console.warn("[Archiver] rewrite failed, passing original through", e);
        filter.write(buf);
      }
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
