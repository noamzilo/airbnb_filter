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
};

// Export for Node tests; harmless in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Filter };
}
