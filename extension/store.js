// Airbnb Archiver — thin wrapper over browser.storage.local.
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
    const all = await Store.getAll();
    for (const c of CATEGORIES) delete all[c][id];
    if (category) all[category][id] = { ...snapshot, ts: Date.now() };
    await browser.storage.local.set(all);
  },

  // Full-object cache for "always show starred" (managed by the background page).
  async getStarredData() { return (await browser.storage.local.get("starredData")).starredData || {}; },
  async setStarredData(data) { await browser.storage.local.set({ starredData: data }); },

  async getSettings() {
    const { settings = {} } = await browser.storage.local.get("settings");
    return { showArchived: false, ...settings };
  },
  async setSetting(key, value) {
    const settings = await Store.getSettings();
    settings[key] = value;
    await browser.storage.local.set({ settings });
  },
};
