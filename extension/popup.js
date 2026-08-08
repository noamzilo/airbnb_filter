// Airbnb Archiver - popup: Liked / Maybe / Archived tabs.

const toggleEl = document.getElementById("showArchived");
const rewriteEl = document.getElementById("rewriteDocuments");
const refEl = document.getElementById("refPlace");
const refHint = document.getElementById("refPlaceHint");
const REF_HINT_DEFAULT = refHint.textContent;

// Reflect the stored reference place, but never yank text out from under
// active typing: storage.onChanged re-renders the popup on every save,
// including the save this very field just made.
function showRefPlace(settings) {
  const rp = settings.refPlace;
  if (document.activeElement !== refEl) {
    refEl.value = rp ? (rp.raw || rp.lat + ", " + rp.lng) : "";
  }
  if (rp) {
    refHint.className = "hint ok";
    refHint.textContent = "Measuring from " + rp.lat.toFixed(5) + ", " + rp.lng.toFixed(5)
      + ". Saved listings show their straight-line distance.";
  } else {
    refHint.className = "hint";
    refHint.textContent = REF_HINT_DEFAULT;
  }
}

refEl.addEventListener("input", () => {
  const raw = refEl.value.trim();
  if (!raw) {
    refHint.className = "hint";
    refHint.textContent = REF_HINT_DEFAULT;
    Store.setSetting("refPlace", null);
    return;
  }
  const place = Filter.parsePlace(raw);
  if (place) {
    Store.setSetting("refPlace", { ...place, raw });
  } else {
    refHint.className = "hint bad";
    refHint.textContent = "Couldn't read coordinates from that. Paste \"lat, lng\" or a Google Maps link.";
  }
});

function row(id, snap, actionLabel, onAction) {
  const r = document.createElement("div");
  r.className = "row";

  const img = document.createElement("img");
  if (snap.thumbnail) img.src = snap.thumbnail;
  img.alt = "";

  const meta = document.createElement("div");
  meta.className = "meta";
  const link = document.createElement("a");
  link.href = snap.url || `https://www.airbnb.com/rooms/${id}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = snap.title || `Listing ${id}`;
  const price = document.createElement("div");
  price.className = "price";
  price.textContent = snap.price || "";
  meta.append(link, price);

  const btn = document.createElement("button");
  btn.className = "act";
  btn.textContent = actionLabel;
  btn.addEventListener("click", onAction);

  r.append(img, meta, btn);
  return r;
}

function fill(listEl, map, emptyMsg, actionLabel, onAction) {
  const ids = Object.keys(map).sort((a, b) => (map[b].ts || 0) - (map[a].ts || 0));
  listEl.textContent = "";
  if (!ids.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = emptyMsg;
    listEl.appendChild(e);
    return 0;
  }
  for (const id of ids) listEl.appendChild(row(id, map[id], actionLabel, () => onAction(id)));
  return ids.length;
}

async function render() {
  const { starred, maybe, archived } = await Store.getAll();
  const settings = await Store.getSettings();
  toggleEl.checked = settings.showArchived;
  rewriteEl.checked = settings.rewriteDocuments;
  showRefPlace(settings);

  const clear = (id) => Store.setCategory(id, null, null);
  const nStar = fill(document.getElementById("list-starred"), starred, "Click ☆ on a listing to like it.", "Remove", clear);
  const nMaybe = fill(document.getElementById("list-maybe"), maybe, "Click ? on a listing to mark it maybe.", "Remove", clear);
  const nArch = fill(document.getElementById("list-archived"), archived, "Click 🗑 on a listing to archive it.", "Unarchive", clear);

  document.getElementById("count-starred").textContent = nStar;
  document.getElementById("count-maybe").textContent = nMaybe;
  document.getElementById("count-archived").textContent = nArch;
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const name of ["starred", "maybe", "archived"]) {
      document.getElementById("panel-" + name).hidden = tab.dataset.tab !== name;
    }
  });
}

try { document.getElementById("ver").textContent = "v" + browser.runtime.getManifest().version; } catch (_) {}
toggleEl.addEventListener("change", () => Store.setSetting("showArchived", toggleEl.checked));
rewriteEl.addEventListener("change", () => Store.setSetting("rewriteDocuments", rewriteEl.checked));
browser.storage.onChanged.addListener(render);
render();
