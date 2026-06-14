// Airbnb Archiver — thin wrapper over browser.storage.local.
// Shared by the background page, the content script, and the popup.
//
// Shape:
//   archived: { "<roomId>": { title, price, url, thumbnail, archivedAt } }
//   starred:  { "<roomId>": { title, price, url, thumbnail, starredAt } }
//   settings: { showArchived: boolean }

const Store = {
  async getArchived() {
    const { archived = {} } = await browser.storage.local.get("archived");
    return archived;
  },
  async addArchived(id, snapshot) {
    const archived = await Store.getArchived();
    archived[id] = { ...snapshot, archivedAt: Date.now() };
    await browser.storage.local.set({ archived });
  },
  async removeArchived(id) {
    const archived = await Store.getArchived();
    delete archived[id];
    await browser.storage.local.set({ archived });
  },

  async getStarred() {
    const { starred = {} } = await browser.storage.local.get("starred");
    return starred;
  },
  async addStarred(id, snapshot) {
    const starred = await Store.getStarred();
    starred[id] = { ...snapshot, starredAt: Date.now() };
    await browser.storage.local.set({ starred });
  },
  async removeStarred(id) {
    const starred = await Store.getStarred();
    delete starred[id];
    await browser.storage.local.set({ starred });
  },

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
