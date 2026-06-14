// Airbnb Archiver — popup: Liked (starred) + Archived tabs.

const toggleEl = document.getElementById("showArchived");

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

function fill(listEl, map, sortKey, emptyMsg, actionLabel, onAction) {
  const ids = Object.keys(map).sort((a, b) => (map[b][sortKey] || 0) - (map[a][sortKey] || 0));
  listEl.textContent = "";
  if (!ids.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = emptyMsg;
    listEl.appendChild(e);
    return ids.length;
  }
  for (const id of ids) listEl.appendChild(row(id, map[id], actionLabel, () => onAction(id)));
  return ids.length;
}

async function render() {
  const [starred, archived, settings] = await Promise.all([
    Store.getStarred(), Store.getArchived(), Store.getSettings(),
  ]);
  toggleEl.checked = settings.showArchived;

  const nStar = fill(
    document.getElementById("list-starred"), starred, "starredAt",
    "Click ☆ on a listing to like it.", "Remove",
    (id) => Store.removeStarred(id)
  );
  const nArch = fill(
    document.getElementById("list-archived"), archived, "archivedAt",
    "Click 🗑 on a listing to archive it.", "Unarchive",
    (id) => Store.removeArchived(id)
  );

  document.getElementById("count-starred").textContent = nStar;
  document.getElementById("count-archived").textContent = nArch;
}

// Tabs
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    document.getElementById("panel-starred").hidden = tab.dataset.tab !== "starred";
    document.getElementById("panel-archived").hidden = tab.dataset.tab !== "archived";
  });
}

toggleEl.addEventListener("change", () => Store.setSetting("showArchived", toggleEl.checked));
browser.storage.onChanged.addListener(render);
render();
