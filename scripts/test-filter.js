// Quick correctness check for extension/filter.js against real captured data.
// Run: node scripts/test-filter.js   (needs state.json from the recon step)

const fs = require("fs");
const path = require("path");
const { Filter } = require("../extension/filter.js");

const root = path.join(__dirname, "..");
const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf-8"));
const ss = state.niobeClientData[0][1].data.presentation.staysSearch;

const idsIn = (arr) => arr.map((x) => Filter.itemId(x)).filter(Boolean);

const cardsBefore = idsIn(ss.results.searchResults);
const mapBefore = idsIn(ss.mapResults.mapSearchResults);
const pinsBefore = idsIn(ss.mapResults.staysInViewport);

// Archive the first two listings.
const archive = new Set(cardsBefore.slice(0, 2));
console.log("Archiving ids:", [...archive]);

const removed = Filter.filterNode(state, archive);

const cardsAfter = idsIn(ss.results.searchResults);
const mapAfter = idsIn(ss.mapResults.mapSearchResults);
const pinsAfter = idsIn(ss.mapResults.staysInViewport);

let ok = true;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) ok = false;
}

check(`removed count > 0 (got ${removed})`, removed > 0);
for (const id of archive) {
  check(`card id ${id} gone`, !cardsAfter.includes(id));
  check(`map  id ${id} gone`, !mapAfter.includes(id));
  check(`pin  id ${id} gone`, !pinsAfter.includes(id));
}
check(
  `non-archived survive (cards ${cardsBefore.length}->${cardsAfter.length})`,
  cardsAfter.length === cardsBefore.length - archive.size
);
check(`base64 decode works`, Filter.decodeId("RGVtYW5kU3RheUxpc3Rpbmc6NTEzMDk3NzQ=") === "51309774");

// Round-trip the whole blob to make sure stringify stays valid JSON.
const fresh = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf-8"));
const { text, removed: r2 } = Filter.filterJsonText(JSON.stringify(fresh), archive);
check(`filterJsonText valid + removed ${r2}`, typeof JSON.parse(text) === "object" && r2 === removed);

console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
process.exit(ok ? 0 : 1);
