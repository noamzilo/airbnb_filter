// Tests for always-show-starred re-injection against real captured data.
// Run: node scripts/test-reinject.js   (needs state.json from the recon step)

const fs = require("fs");
const path = require("path");
const { Filter } = require("../extension/filter.js");

const root = path.join(__dirname, "..");
const load = () => JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf-8"));

let ok = true;
function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) ok = false;
}

const idsIn = (a) => new Set((a || []).map(Filter.itemId).filter(Boolean));

// 1) Cache a listing, simulate Airbnb dropping it, then re-inject it.
{
  const state = load();
  const arr0 = Filter.locateArrays(state);
  const victim = Filter.itemId(arr0.mapSearchResults[0]);

  const seen = {};
  Filter.collectSeen(state, seen);
  check("collectSeen captured map+list+pin+coord", !!(seen[victim] && seen[victim].mapResult
    && seen[victim].searchResult && seen[victim].viewportPin && seen[victim].coord), `id=${victim}`);

  // Drop the victim from all three arrays (Airbnb "prefiltered" it out).
  Filter.filterNode(state, new Set([victim]));
  const after = Filter.locateArrays(state);
  check("victim removed before injection",
    !idsIn(after.searchResults).has(victim) && !idsIn(after.mapSearchResults).has(victim) && !idsIn(after.staysInViewport).has(victim));

  const injected = Filter.injectStarred(state, { [victim]: seen[victim] });
  const back = Filter.locateArrays(state);
  check(`injected the starred listing (count=${injected})`, injected >= 1);
  check("back in searchResults", idsIn(back.searchResults).has(victim));
  check("back in mapSearchResults", idsIn(back.mapSearchResults).has(victim));
  check("back in staysInViewport", idsIn(back.staysInViewport).has(victim));
}

// 2) Not injected when the coordinate is outside the returned bounds.
{
  const state = load();
  const seen = {};
  Filter.collectSeen(state, seen);
  const id = Object.keys(seen)[0];
  const far = JSON.parse(JSON.stringify(seen[id]));
  far.coord = { lat: 80, lng: 80 }; // nowhere near Asunción
  // remove it so "already present" isn't the reason it's skipped
  Filter.filterNode(state, new Set([id]));
  const injected = Filter.injectStarred(state, { [id]: far });
  check("not injected when out of view bounds", injected === 0);
}

// 3) Already-present starred listing is not duplicated.
{
  const state = load();
  const arr = Filter.locateArrays(state);
  const present = Filter.itemId(arr.mapSearchResults[0]);
  const seen = {};
  Filter.collectSeen(state, seen);
  const before = arr.mapSearchResults.length;
  const injected = Filter.injectStarred(state, { [present]: seen[present] });
  const after = Filter.locateArrays(state).mapSearchResults.length;
  check("present listing not duplicated", injected === 0 && after === before);
}

// 3b) Maybe injection goes into the LIST only (not the map).
{
  const state = load();
  const arr0 = Filter.locateArrays(state);
  const id = Filter.itemId(arr0.mapSearchResults[1]);
  const seen = {};
  Filter.collectSeen(state, seen);
  Filter.filterNode(state, new Set([id])); // drop it everywhere
  const injected = Filter.injectListings(state, { [id]: seen[id] }, false);
  const back = Filter.locateArrays(state);
  check("maybe injected into list only", injected >= 1
    && idsIn(back.searchResults).has(id)
    && !idsIn(back.mapSearchResults).has(id)
    && !idsIn(back.staysInViewport).has(id));
}

// 4) Starred pins are forced to FULL_PIN (Airbnb shrinks some to MINI_PIN).
{
  const state = load();
  const arr = Filter.locateArrays(state);
  const mini = (arr.staysInViewport || []).find((x) => x.pinState === "MINI_PIN");
  check("found a MINI_PIN to upgrade", !!mini);
  if (mini) {
    const id = Filter.itemId(mini);
    const upgraded = Filter.forceFullPins(state, new Set([id]));
    check("forceFullPins upgrades the starred pin", upgraded === 1 && mini.pinState === "FULL_PIN");
  }
}

console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
process.exit(ok ? 0 : 1);
