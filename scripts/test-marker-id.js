// Why a map pin cannot be identified by its coordinate alone.
// Run: node scripts/test-marker-id.js   (needs search.html from the recon step)
//
// Airbnb reports many listing coordinates rounded to FOUR decimals - which was
// exactly the tolerance content.js matched pins by, so for those listings the
// match ran at the resolution of the data itself and could not separate
// neighbours. Archiving one flat then hid every other flat in the building,
// silently and permanently.
//
// This test pins the two facts the fix rests on:
//   1. real searches DO contain listings at indistinguishable coordinates, and
//   2. the price on the pill separates them.
// If (1) ever stops holding, the extra care costs nothing. If (2) stops holding,
// the resolver correctly refuses to hide anything rather than guessing.

const fs = require("fs");
const path = require("path");
const { Filter } = require("../extension/filter.js");

const root = path.join(__dirname, "..");
let ok = true;
function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) ok = false;
}

const NEAR = 1e-4;
const near = (a, b) => Math.abs(a.lat - b.lat) < NEAR && Math.abs(a.lng - b.lng) < NEAR;

// The same two helpers content.js resolves markers with, kept in step by hand
// (they are DOM-free by design so this test can hold them honest).
function priceDigits(s) {
  const m = String(s == null ? "" : s).match(/[$€£₲¥₩₪₫฿]\s?[\d.,]+/);
  return m ? m[0].replace(/\D/g, "") : "";
}
function priceTokens(price) {
  const out = new Set();
  const add = (v) => { const d = String(v == null ? "" : v).replace(/\D/g, ""); if (d) out.add(d); };
  if (price) {
    for (const v of [price.total, price.nightly, price.monthly]) {
      if (typeof v !== "number" || !isFinite(v)) continue;
      add(Math.round(v));
      add(v.toFixed(2));
    }
    add(priceDigits(price.label));
  }
  return out;
}

const html = fs.readFileSync(path.join(root, "search.html"), "utf-8");
const found = Filter.harvestHtml(html);
const ids = Object.keys(found).filter((id) => found[id].coord);
check("harvested listings with coordinates", ids.length > 10, `n=${ids.length}`);

// 1) Precision is mixed - some listings come back at full float, but plenty are
// rounded to 4dp, and for those "within 1e-4" is not a tolerance at all, it is
// the grid spacing.
const dp = (v) => (String(v).split(".")[1] || "").length;
const coarse = ids.filter((id) => Math.max(dp(found[id].coord.lat), dp(found[id].coord.lng)) <= 4);
check("some coordinates are reported at 4-decimal precision", coarse.length > 0,
  `coarse=${coarse.length}/${ids.length}`);

const pairs = [];
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    if (near(found[ids[i]].coord, found[ids[j]].coord)) pairs.push([ids[i], ids[j]]);
  }
}
check("real search contains indistinguishable coordinates", pairs.length > 0, `pairs=${pairs.length}`);

// 2) The price on the pill tells them apart. Report rather than fail on the
// leftovers: two identically priced flats in one building is a real thing, and
// the resolver's answer there is "don't touch either", which is correct.
let separated = 0, tied = 0;
for (const [a, b] of pairs) {
  const ta = priceTokens(found[a].price), tb = priceTokens(found[b].price);
  const shared = [...ta].some((t) => tb.has(t));
  if (shared) { tied++; console.log(`      tie: ${a} / ${b} share a price token`); }
  else separated++;
}
check("price separates colliding listings", separated > 0, `separated=${separated} tied=${tied}`);
check("a listing always has at least one price token",
  ids.every((id) => priceTokens(found[id].price).size > 0));

// 3) The digit extraction that does the comparing.
check("priceDigits: plain", priceDigits("$564") === "564");
check("priceDigits: thousands + trailer", priceDigits("$1,234 for 5 nights") === "1234");
check("priceDigits: guaraní", priceDigits("₲1.234.567") === "1234567");
check("priceDigits: no money in the string", priceDigits("Sold out") === "");
check("priceDigits: null-safe", priceDigits(null) === "" && priceDigits(undefined) === "");
check("priceTokens: rounded and exact forms both present",
  priceTokens({ total: 1234.56 }).has("1235") && priceTokens({ total: 1234.56 }).has("123456"));

console.log(ok ? "\nALL PASS" : "\nFAILURES");
process.exit(ok ? 0 : 1);
