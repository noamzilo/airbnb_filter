// Airbnb Archiver - thin wrapper over browser.storage.local.
// Shared by the background page, the content script, and the popup.
//
// A listing is in at most ONE category (a rubric): starred / maybe / archived.
// Shape:
//   starred:  { "<roomId>": { title, price, url, thumbnail, coord, ts } }
//   maybe:    { "<roomId>": { ... } }
//   archived: { "<roomId>": { ... } }
//   starredData: { "<roomId>": <cached full search objects> }   // for always-show
//   settings: { showArchived: boolean }

const CATEGORIES = ["starred", "maybe", "archived"];

/* Every write below is a read-modify-write over a shared key, so two of them in
   flight at once lose one - star a listing and trash another in quick
   succession and whichever read first wins the whole map. Chain them instead.
   These are small local writes; correctness is worth more than the overlap. */
let writeChain = Promise.resolve();
function serial(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

const Store = {
  async getAll() {
    const o = await browser.storage.local.get(CATEGORIES);
    return { starred: o.starred || {}, maybe: o.maybe || {}, archived: o.archived || {} };
  },
  async getStarred() { return (await browser.storage.local.get("starred")).starred || {}; },
  async getMaybe() { return (await browser.storage.local.get("maybe")).maybe || {}; },
  async getArchived() { return (await browser.storage.local.get("archived")).archived || {}; },

  async getCategory(id) {
    const all = await Store.getAll();
    for (const c of CATEGORIES) if (all[c][id]) return c;
    return null;
  },

  // Put a listing in one category (or null to clear); removes it from the others.
  async setCategory(id, snapshot, category) {
    return serial(async () => {
      const all = await Store.getAll();
      for (const c of CATEGORIES) delete all[c][id];
      if (category) all[category][id] = { ...snapshot, ts: Date.now() };
      await browser.storage.local.set(all);
    });
  },

  // Full-object cache for "always show starred" (managed by the background page).
  async getStarredData() { return (await browser.storage.local.get("starredData")).starredData || {}; },
  async setStarredData(data) { await browser.storage.local.set({ starredData: data }); },

  // id -> {lat,lng} for starred+maybe listings, so the decorator can colour the
  // matching map pins (markers only expose a position, not the listing id).
  async getTagCoords() { return (await browser.storage.local.get("tagCoords")).tagCoords || {}; },

  // Panel media: photo URLs and the normalised price, harvested from Airbnb's
  // search JSON (background) or the page's embedded state (content script).
  async getImages() { return (await browser.storage.local.get("images")).images || {}; },
  async getPrices() { return (await browser.storage.local.get("prices")).prices || {}; },

  // listingId -> threadId, learned whenever a message thread is open. Airbnb's
  // /contact_host/<id>/send_message route opens a NEW-message compose window,
  // not the existing conversation, so the thread id is the only way to link
  // straight into a chat that already exists.
  async getThreads() { return (await browser.storage.local.get("threads")).threads || {}; },
  async setThread(listingId, threadId) {
    if (!listingId || !threadId) return false;
    return serial(async () => {
      const threads = await Store.getThreads();
      if (threads[listingId] === threadId) return false;
      threads[listingId] = threadId;
      await browser.storage.local.set({ threads });
      return true;
    });
  },

  // id -> { name, hostId, listingName, pets } read off the room page - one fetch
  // answers all of them. Hosts, listing names and house rules barely change, so
  // this is written once and reused.
  async getHosts() { return (await browser.storage.local.get("hosts")).hosts || {}; },
  async setHost(id, info) {
    if (!info || !Object.keys(info).length) return false;
    return serial(async () => {
      const hosts = await Store.getHosts();
      const cur = hosts[id] || {};
      const next = { ...cur, ...info };
      if (JSON.stringify(cur) === JSON.stringify(next)) return false;
      hosts[id] = next;
      await browser.storage.local.set({ hosts });
      return true;
    });
  },
  async setMedia(id, imgs, price, coord) {
    return Store.setMediaBulk({ [id]: { images: imgs, price, coord } });
  },

  // One write for many listings - a single price probe returns everything in its
  // box, so it can refresh a whole cluster at once.
  async setMediaBulk(entries) {
    return serial(() => Store._setMediaBulk(entries));
  },
  async _setMediaBulk(entries) {
    const images = await Store.getImages();
    const prices = await Store.getPrices();
    const tagCoords = await Store.getTagCoords();
    let di = false, dp = false, dc = false;
    for (const id of Object.keys(entries || {})) {
      const e = entries[id] || {};
      if (e.images && e.images.length && JSON.stringify(images[id]) !== JSON.stringify(e.images)) { images[id] = e.images; di = true; }
      if (e.price && JSON.stringify(prices[id]) !== JSON.stringify(e.price)) { prices[id] = e.price; dp = true; }
      // The panel filters by the map's current view, so a tagged listing needs a
      // coordinate on record even if the interceptor hasn't seen it yet.
      const c = e.coord;
      if (c && isFinite(c.lat) && isFinite(c.lng)) {
        const cur = tagCoords[id];
        if (!cur || cur.lat !== c.lat || cur.lng !== c.lng) { tagCoords[id] = { lat: c.lat, lng: c.lng }; dc = true; }
      }
    }
    const patch = {};
    if (di) patch.images = images;
    if (dp) patch.prices = prices;
    if (dc) patch.tagCoords = tagCoords;
    if (Object.keys(patch).length) await browser.storage.local.set(patch);
    return Object.keys(patch).length > 0;
  },

  // Per-listing comments and the panel's custom order - independent of category
  // so they survive star <-> maybe <-> archive and re-tagging.
  async getNotes() { return (await browser.storage.local.get("notes")).notes || {}; },
  async setNote(id, text) {
    return serial(async () => {
      const notes = await Store.getNotes();
      if (text && text.trim()) notes[id] = text; else delete notes[id];
      await browser.storage.local.set({ notes });
    });
  },
  // Which rows are shown as a compact strip. Persisted, because a list you
  // tidied should still be tidy after a reload, and independent of category so
  // it survives star <-> maybe like notes and order do.
  async getCollapsed() { return (await browser.storage.local.get("collapsed")).collapsed || {}; },
  async setCollapsed(map) { return serial(() => browser.storage.local.set({ collapsed: map })); },

  async getOrder() { return (await browser.storage.local.get("order")).order || []; },
  async setOrder(arr) { return serial(() => browser.storage.local.set({ order: arr })); },

  async getSettings() {
    const { settings = {} } = await browser.storage.local.get("settings");
    // rewriteDocuments: let the interceptor rewrite whole search PAGES, not just
    // the XHRs. Off by default - a page handed back wrong breaks silently.
    return { showArchived: false, rewriteDocuments: false, ...settings };
  },
  async setSetting(key, value) {
    return serial(async () => {
      const settings = await Store.getSettings();
      settings[key] = value;
      await browser.storage.local.set({ settings });
    });
  },
};
