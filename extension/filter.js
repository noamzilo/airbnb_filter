// Airbnb Archiver — pure filtering logic over Airbnb's search JSON.
// Loaded in the background page (see manifest). No DOM, no storage here so it
// stays trivially testable with Node (see scripts/test-filter.mjs).
//
// Airbnb returns three listing arrays, all keyed by the same permanent room id
// (see PROJECT_LOG.md §2.3):
//   - "searchResults"     -> id at item.demandStayListing.id  (base64 "DemandStayListing:<id>")
//   - "mapSearchResults"  -> id at item.demandStayListing.id  (same encoding)
//   - "staysInViewport"   -> id at item.listingId             (plain string)

const Filter = {
  // base64 "DemandStayListing:<digits>"  ->  "<digits>"  (or null)
  decodeId(b64) {
    try {
      const decoded = (typeof atob === "function")
        ? atob(b64)
        : Buffer.from(b64, "base64").toString("utf-8"); // Node fallback for tests
      const m = decoded.match(/:(\d+)\s*$/);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  },

  itemId(item) {
    if (!item || typeof item !== "object") return null;
    if (item.demandStayListing && item.demandStayListing.id) {
      return Filter.decodeId(item.demandStayListing.id);
    }
    if (item.listingId != null) return String(item.listingId);
    return null;
  },

  // Recursively walk the JSON; wherever we find one of the three known listing
  // arrays, drop entries whose id is archived. Returns how many were removed.
  filterNode(node, archivedSet) {
    let removed = 0;
    if (Array.isArray(node)) {
      for (const child of node) removed += Filter.filterNode(child, archivedSet);
      return removed;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (Array.isArray(val) &&
            (key === "searchResults" || key === "mapSearchResults" || key === "staysInViewport")) {
          const before = val.length;
          node[key] = val.filter((el) => {
            const id = Filter.itemId(el);
            return !(id && archivedSet.has(id));
          });
          removed += before - node[key].length;
        }
        removed += Filter.filterNode(val, archivedSet);
      }
    }
    return removed;
  },

  // Parse -> filter -> stringify. Throws if text isn't valid JSON (caller guards).
  filterJsonText(text, archivedSet) {
    const root = JSON.parse(text);
    const removed = Filter.filterNode(root, archivedSet);
    return { text: JSON.stringify(root), removed };
  },

  // Make JSON safe to drop back inside a <script> tag (avoid "</script>" breakout).
  escapeForScript(jsonText) {
    return jsonText.replace(/</g, "\\u003c");
  },

  /* ---- always-show-starred: cache + re-injection ---- */

  // { lat, lng } from a listing object, or null.
  coordOf(item) {
    const c = item && item.demandStayListing && item.demandStayListing.location
      && item.demandStayListing.location.coordinate;
    if (c && typeof c.latitude === "number" && typeof c.longitude === "number") {
      return { lat: c.latitude, lng: c.longitude };
    }
    return null;
  },

  // First array found under each of the three known keys (live references).
  locateArrays(root) {
    const found = { searchResults: null, mapSearchResults: null, staysInViewport: null };
    (function walk(node) {
      if (Array.isArray(node)) { for (const c of node) walk(c); return; }
      if (node && typeof node === "object") {
        for (const k of Object.keys(node)) {
          if (found[k] === null && Array.isArray(node[k])
              && (k === "searchResults" || k === "mapSearchResults" || k === "staysInViewport")) {
            found[k] = node[k];
          }
          walk(node[k]);
        }
      }
    })(root);
    return found;
  },

  // Record each listing's array objects + coordinate into `seen` (mutated).
  collectSeen(root, seen) {
    const arr = Filter.locateArrays(root);
    const note = (it, field) => {
      const id = Filter.itemId(it);
      if (!id) return;
      const e = (seen[id] = seen[id] || {});
      e[field] = it;
      const c = Filter.coordOf(it);
      if (c) e.coord = c;
    };
    (arr.searchResults || []).forEach((it) => note(it, "searchResult"));
    (arr.mapSearchResults || []).forEach((it) => note(it, "mapResult"));
    (arr.staysInViewport || []).forEach((it) => note(it, "viewportPin"));
  },

  // Bounding box of listings actually returned (null if fewer than 2 coords).
  bboxOf(items) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity, n = 0;
    for (const it of items || []) {
      const c = Filter.coordOf(it);
      if (!c) continue;
      n++;
      minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
      minLng = Math.min(minLng, c.lng); maxLng = Math.max(maxLng, c.lng);
    }
    return n >= 2 ? { minLat, maxLat, minLng, maxLng } : null;
  },

  // Re-inject starred listings the response omitted but that fall in view.
  // starredObjById: { id: { searchResult?, mapResult?, viewportPin?, coord } }
  injectStarred(root, starredObjById) {
    let injected = 0;
    try {
      const ids = Object.keys(starredObjById || {});
      if (!ids.length) return 0;
      const arr = Filter.locateArrays(root);
      const bbox = Filter.bboxOf(arr.mapSearchResults || arr.searchResults || []);
      if (!bbox) return 0;
      const padLat = 0.2 * (bbox.maxLat - bbox.minLat);
      const padLng = 0.2 * (bbox.maxLng - bbox.minLng);
      const setOf = (a) => new Set((a || []).map(Filter.itemId).filter(Boolean));
      const inMap = setOf(arr.mapSearchResults), inList = setOf(arr.searchResults), inVp = setOf(arr.staysInViewport);
      const clone = (o) => JSON.parse(JSON.stringify(o));

      for (const id of ids) {
        const cached = starredObjById[id];
        const c = cached && cached.coord;
        if (!c) continue;
        if (c.lat < bbox.minLat - padLat || c.lat > bbox.maxLat + padLat
          || c.lng < bbox.minLng - padLng || c.lng > bbox.maxLng + padLng) continue;
        let did = false;
        if (arr.mapSearchResults && cached.mapResult && !inMap.has(id)) { arr.mapSearchResults.push(clone(cached.mapResult)); did = true; }
        if (arr.staysInViewport && cached.viewportPin && !inVp.has(id)) { arr.staysInViewport.push(clone(cached.viewportPin)); did = true; }
        if (arr.searchResults && cached.searchResult && !inList.has(id)) { arr.searchResults.push(clone(cached.searchResult)); did = true; }
        if (did) injected++;
      }
    } catch (_) { /* never let injection break the response */ }
    return injected;
  },
};

// Export for Node tests; harmless in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Filter };
}
