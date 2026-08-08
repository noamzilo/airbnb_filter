// Pure-logic test for Filter.parseMoney / Filter.priceOf (no browser).
//   node scripts/test-price.js
// Uses the real recon blob (state.json) plus synthetic price shapes.

const fs = require("fs");
const path = require("path");
const { Filter } = require(path.join(__dirname, "..", "extension", "filter.js"));

let fails = 0;
function check(label, cond, extra = "") {
  if (!cond) fails++;
  console.log((cond ? "PASS" : "FAIL") + "  " + label + (extra ? "  " + extra : ""));
}
const eq = (a, b) => Math.abs(a - b) < 0.01;

/* ---- money parsing ---- */
check("plain", Filter.parseMoney("$564 USD") === 564);
check("thousands comma", Filter.parseMoney("$1,418") === 1418);
check("comma + decimal", eq(Filter.parseMoney("$1,234.56 USD"), 1234.56));
check("decimal only", eq(Filter.parseMoney("$563.58 USD"), 563.58));
check("dotted thousands", Filter.parseMoney("₲1.234.567") === 1234567);
check("single dotted thousand", Filter.parseMoney("₲850.000") === 850000);
check("comma decimal", eq(Filter.parseMoney("€1.234,50"), 1234.5));
check("no digits", Filter.parseMoney("free") === null);
check("symbol", Filter.currencyOf("$564 USD") === "$", Filter.currencyOf("$564 USD"));
check("symbol guarani", Filter.currencyOf("₲1.234") === "₲");

/* ---- price shapes ---- */
const stayTotal = {
  structuredDisplayPrice: {
    primaryLine: { accessibilityLabel: "$564 USD for 14 nights", price: "$564 USD", qualifier: "for 14 nights" },
    explanationData: {
      priceDetails: [
        { items: [{ __typename: "DefaultExplanationLineItem", description: "14 nights x $42.29 USD", priceString: "$592.00 USD" }] },
        { items: [{ __typename: "HighlightExplanationLineItem", description: "Price after discount", priceString: "$563.58 USD" }] },
      ],
    },
  },
};
let p = Filter.priceOf(stayTotal);
check("stay total -> nights", p.nights === 14, JSON.stringify(p));
check("stay total -> uses discounted total", eq(p.total, 563.58));
check("stay total -> nightly", eq(p.nightly, 40.26), String(p.nightly));
check("stay total -> 30 nights", p.monthly === 1208, String(p.monthly));

// Monthly-stay search: no `price` field at all, a `qualifier` of "monthly", and
// the pre-discount figure sitting right next to it. Captured verbatim from a
// live Jerusalem monthly search (scripts/recon_price.js).
const monthly = {
  structuredDisplayPrice: {
    primaryLine: {
      __typename: "DiscountedDisplayPriceLine",
      accessibilityLabel: "$4,883 monthly, originally $6,675",
      concatQualifierLeft: false,
      discountedPrice: "$4,883",
      originalPrice: "$6,675",
      qualifier: "monthly",
      trailing: null,
    },
    secondaryLine: null,
    displayPriceStyle: "MONTHLY",
    explanationData: {
      priceDetails: [
        { items: [
          { __typename: "DefaultExplanationLineItem", description: "Average monthly price", priceString: "$6,674.73" },
          { __typename: "DiscountedExplanationLineItem", description: "Monthly stay discount", priceString: "-$1,636.27" },
        ] },
        { items: [{ __typename: "HighlightExplanationLineItem", description: "Price after discount", priceString: "$4,882.27" }] },
      ],
    },
  },
};
p = Filter.priceOf(monthly);
check("monthly search normalises at all", p !== null && p.monthly !== null, JSON.stringify(p));
check("monthly uses the discounted price, not the original", p.monthly === 4883, String(p.monthly));
check("monthly keeps the original for context", p.original === 6675, String(p.original));
check("monthly derives a nightly rate", eq(p.nightly, 162.77), String(p.nightly));
check("monthly tagged as such", p.basis === "monthly", String(p.basis));

// Same shape, but a nightly search that happens to be discounted.
const discountedNightly = {
  structuredDisplayPrice: {
    primaryLine: {
      __typename: "DiscountedDisplayPriceLine",
      accessibilityLabel: "$90 per night, originally $120",
      discountedPrice: "$90", originalPrice: "$120", qualifier: "night",
    },
  },
};
p = Filter.priceOf(discountedNightly);
check("discounted nightly uses the discounted price", p.monthly === 2700, JSON.stringify(p));

const perNight = {
  structuredDisplayPrice: {
    primaryLine: { accessibilityLabel: "$120 per night", price: "$120", qualifier: "night" },
    explanationData: null,
  },
};
p = Filter.priceOf(perNight);
check("nightly -> 30 nights", p.monthly === 3600, JSON.stringify(p));

check("no price line", Filter.priceOf({}) === null);
check("garbage price", Filter.priceOf({ structuredDisplayPrice: { primaryLine: { price: "-" } } }) === null);

/* ---- length-of-stay discounts ----
   Shapes captured verbatim from live searches (scripts/recon_disc.py,
   recon_thresh.py). The thresholds are Airbnb's, verified by probing the same
   listing across lengths: nothing at 6 nights, weekly at exactly 7, monthly at
   exactly 28. */
const weeklyStay = {
  structuredDisplayPrice: {
    displayPriceStyle: "TOTAL_ONLY",
    primaryLine: { accessibilityLabel: "$331 for 11 nights, originally $389",
      discountedPrice: "$331", originalPrice: "$389", qualifier: "for 11 nights" },
    explanationData: { priceDetails: [
      { items: [
        { __typename: "DefaultExplanationLineItem", description: "11 nights x $35.36", priceString: "$389.00" },
        { __typename: "DiscountedExplanationLineItem", description: "Weekly stay discount", priceString: "-$58.35" },
      ] },
      { items: [{ __typename: "HighlightExplanationLineItem", description: "Price after discount", priceString: "$330.65" }] },
    ] },
  },
};
p = Filter.priceOf(weeklyStay);
check("weekly discount found", !!p.discount, JSON.stringify(p.discount));
check("weekly discount starts at 7 nights", p.discount.minNights === 7 && p.discount.kind === "weekly");
check("weekly discount money", eq(p.discount.amount, 58.35), String(p.discount.amount));
check("weekly discount percent", p.discount.pct === 15, String(p.discount.pct));

// A 28-night quote carried TWO reductions, so the saving must be measured as
// base minus price-after-discount, not just the first discount line.
const monthlyStayShape = {
  structuredDisplayPrice: {
    displayPriceStyle: "TOTAL_ONLY",
    primaryLine: { accessibilityLabel: "$729 for 28 nights", price: "$729", qualifier: "for 28 nights" },
    explanationData: { priceDetails: [
      { items: [
        { __typename: "DefaultExplanationLineItem", description: "Average monthly price", priceString: "$924.00" },
        { __typename: "DiscountedExplanationLineItem", description: "Monthly stay discount", priceString: "-$172.14" },
        { __typename: "DiscountedExplanationLineItem", description: "Airbnb monthly stay savings", priceString: "-$23.31" },
      ] },
      { items: [{ __typename: "HighlightExplanationLineItem", description: "Price after discount", priceString: "$728.55" }] },
    ] },
  },
};
p = Filter.priceOf(monthlyStayShape);
check("monthly discount starts at 28 nights", p.discount.minNights === 28 && p.discount.kind === "monthly");
check("counts every reduction, not just the first", eq(p.discount.amount, 195.45), String(p.discount.amount));
check("monthly discount percent", p.discount.pct === 21, String(p.discount.pct));

// No discount at all -> nothing to report (6 nights, verified live).
const noDiscount = {
  structuredDisplayPrice: {
    primaryLine: { accessibilityLabel: "$213 for 6 nights", price: "$213", qualifier: "for 6 nights" },
    explanationData: { priceDetails: [
      { items: [{ __typename: "DefaultExplanationLineItem", description: "6 nights x $35.50", priceString: "$213.00" }] },
    ] },
  },
};
check("no discount line -> no discount reported", Filter.priceOf(noDiscount).discount === null);
check("discountOf tolerates a missing breakdown", Filter.discountOf({}) === null && Filter.discountOf(null) === null);
// A monthly-mode search reaches priceOf by a different branch; it must report too.
check("monthly-mode search still reports its discount",
  Filter.priceOf(monthly).discount && Filter.priceOf(monthly).discount.kind === "monthly",
  JSON.stringify(Filter.priceOf(monthly).discount));

// Date arithmetic for the ladder probes (one at 7 nights, one at 28).
check("addDays basic", Filter.addDays("2026-09-01", 7) === "2026-09-08");
check("addDays across a month", Filter.addDays("2026-09-01", 28) === "2026-09-29");
check("addDays across a year", Filter.addDays("2026-12-20", 28) === "2027-01-17");
check("addDays across a leap day", Filter.addDays("2028-02-27", 7) === "2028-03-05");
check("addDays rejects junk", Filter.addDays("soon", 7) === null);

/* ---- probe plumbing ---- */
const MONTHLY_SEARCH = "?adults=1&refinement_paths%5B%5D=%2Fhomes&flexible_trip_lengths%5B%5D=one_month"
  + "&monthly_start_date=2026-09-01&monthly_length=3&monthly_end_date=2026-12-01"
  + "&price_filter_input_type=2&ne_lat=31.85&ne_lng=35.30&sw_lat=31.72&sw_lng=35.15"
  + "&zoom=12&search_by_map=true&query=Jerusalem&amenities%5B%5D=4&min_bedrooms=2";

const ctx = Filter.ctxOf("https://www.airbnb.com/s/Jerusalem--Israel/homes" + MONTHLY_SEARCH);
check("ctx captures the monthly-stay params", ctx.includes("monthly_start_date=2026-09-01") && ctx.includes("flexible_trip_lengths[]=one_month"), ctx);
check("ctx ignores map position", !ctx.includes("ne_lat") && !ctx.includes("zoom"), ctx);
check("panning doesn't change ctx",
  Filter.ctxOf("https://www.airbnb.com/s/x/homes" + MONTHLY_SEARCH.replace("ne_lat=31.85", "ne_lat=31.99")) === ctx);
check("changing dates does change ctx",
  Filter.ctxOf("https://www.airbnb.com/s/x/homes" + MONTHLY_SEARCH.replace("2026-09-01", "2026-10-01")) !== ctx);
check("ctx of a junk url is empty", Filter.ctxOf("not a url") === "");

const probe = Filter.probeUrl("https://www.airbnb.com", MONTHLY_SEARCH, { lat: 31.7813, lng: 35.2104 });
const pq = new URL(probe).searchParams;
check("probe keeps monthly mode", pq.get("monthly_start_date") === "2026-09-01" && pq.get("flexible_trip_lengths[]") === "one_month", probe);
check("probe keeps occupancy", pq.get("adults") === "1");
check("probe boxes the coordinate", Math.abs(+pq.get("ne_lat") - 31.7828) < 1e-6 && Math.abs(+pq.get("sw_lng") - 35.2089) < 1e-6, probe);
check("probe overrides the map view", pq.get("search_by_map") === "true" && pq.get("zoom") === "17");
// Filters must NOT be copied: a filtered-out listing would look "unavailable".
check("probe drops the user's filters", !pq.has("amenities[]") && !pq.has("min_bedrooms") && !pq.has("query"), probe);
check("probe is self-identifying", pq.get("archiver_probe") === "1");

/* ---- a normal dated stay ----
   Only the monthly search was covered above, and monthly_* happened to be spelled
   right. Airbnb spells a normal stay "checkin"/"checkout" with NO underscore
   (verified live), and we listed only the underscored forms, so the dates fell
   out of both ctxOf and probeUrl: cached prices never went stale on a date
   change, and every probe asked Airbnb with no dates and got its default quote
   back. That is where a hard "5 nights" came from on every row. */
const DATED_SEARCH = "?adults=2&checkin=2026-09-01&checkout=2026-09-12"
  + "&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60&zoom=15&search_by_map=true&query=Asuncion";

const dctx = Filter.ctxOf("https://www.airbnb.com/s/Asuncion/homes" + DATED_SEARCH);
check("ctx captures the selected dates",
  dctx.includes("checkin=2026-09-01") && dctx.includes("checkout=2026-09-12"), dctx);
check("changing the stay changes ctx",
  Filter.ctxOf("https://www.airbnb.com/s/x/homes" + DATED_SEARCH.replace("2026-09-12", "2026-09-20")) !== dctx);
check("panning still doesn't change ctx",
  Filter.ctxOf("https://www.airbnb.com/s/x/homes" + DATED_SEARCH.replace("zoom=15", "zoom=13")) === dctx);

const dprobe = new URL(Filter.probeUrl("https://www.airbnb.com", DATED_SEARCH, { lat: -25.2865, lng: -57.5754 })).searchParams;
check("probe carries the selected dates",
  dprobe.get("checkin") === "2026-09-01" && dprobe.get("checkout") === "2026-09-12", dprobe.toString());
check("probe carries occupancy", dprobe.get("adults") === "2");
check("probe still drops the user's filters", !dprobe.has("query"));

check("stayOf reads the selected period", JSON.stringify(Filter.stayOf(DATED_SEARCH))
  === JSON.stringify({ checkin: "2026-09-01", checkout: "2026-09-12", nights: 11, months: null }),
  JSON.stringify(Filter.stayOf(DATED_SEARCH)));
check("stayOf counts nights across a month boundary",
  Filter.stayOf("?checkin=2026-08-28&checkout=2026-09-03").nights === 6);
check("stayOf accepts the underscored spelling too",
  Filter.stayOf("?check_in=2026-09-01&check_out=2026-09-04").nights === 3);
check("stayOf is null with no dates", Filter.stayOf("?adults=1&zoom=15") === null);
check("stayOf rejects a backwards range", Filter.stayOf("?checkin=2026-09-12&checkout=2026-09-01") === null);
check("stayOf rejects junk dates", Filter.stayOf("?checkin=soon&checkout=later") === null);
const monthlyStay = Filter.stayOf(MONTHLY_SEARCH);
check("stayOf reports a monthly search in months", monthlyStay && monthlyStay.months === 3 && monthlyStay.nights === null,
  JSON.stringify(monthlyStay));

check("coordFromHtml reads a room page",
  JSON.stringify(Filter.coordFromHtml('junk{"latitude":31.78485,"longitude":35.20905,"x":1}')) === '{"lat":31.78485,"lng":35.20905}',
  JSON.stringify(Filter.coordFromHtml('{"latitude":31.78485,"longitude":35.20905}')));
check("coordFromHtml on a page without coords", Filter.coordFromHtml("<html>nothing</html>") === null);

/* ---- host / owner ---- */
// Shaped exactly like the live room page (scripts/recon_hostname.py).
const PDP = '...{"__typename":"StaysPdpHostInfo","passportData":{"__typename":"PassportCardData",'
  + '"name":"Corporate Stays - Paraguay","userId":"RGVtYW5kVXNlcjo1MTAwNDI2Ng==",'
  + '"contextualUserId":"Q29udGV4dHVhbFVzZXI6MTQ2","titleText":"Superhost"}}...'
  + '{"isSuperHost":"true","hostId":"51004266"}...'
  + '"name":{"__typename":"UGCText","localizedString":"Light-Filled 1BR w/ Pool & Gym Access"}...';
let h = Filter.hostFromHtml(PDP);
check("host name from PassportCardData", h && h.name === "Corporate Stays - Paraguay", JSON.stringify(h));
check("host id", h.hostId === "51004266", JSON.stringify(h));
check("listing name", h.listingName === "Light-Filled 1BR w/ Pool & Gym Access", JSON.stringify(h));

h = Filter.hostFromHtml('<title>Cosy Loft - Apartments for Rent in Jerusalem - Airbnb</title> Hosted by Dana');
check("falls back to 'Hosted by'", h && h.name === "Dana", JSON.stringify(h));
check("falls back to <title> for the listing name", h.listingName === "Cosy Loft", JSON.stringify(h));
check("a login page yields no host", Filter.hostFromHtml("<title>Log In / Sign Up - Airbnb</title>") === null);

check("contact url needs no thread id",
  Filter.contactUrl("https://www.airbnb.com", "123") === "https://www.airbnb.com/contact_host/123/send_message");
check("thread url", Filter.threadUrl("https://www.airbnb.com", "999") === "https://www.airbnb.com/guest/messages/999");
check("listing id read out of a thread page",
  Filter.listingIdFromThread('<a href="/rooms/1239210296375530793?x=1">Cosy</a>') === "1239210296375530793");
check("thread page with no listing", Filter.listingIdFromThread("<div>hi</div>") === null);
// A thread page also renders the inbox sidebar: every OTHER conversation links
// its own listing once, while the open thread's listing recurs.
check("open thread wins over sidebar conversations",
  Filter.listingIdFromThread(
    '<aside><a href="/rooms/111">other chat</a><a href="/rooms/222">other chat</a></aside>' +
    '<main><a href="/rooms/999">the listing</a><img src="/rooms/999/photo"><a href="/rooms/999">book</a></main>'
  ) === "999",
  Filter.listingIdFromThread('<aside><a href="/rooms/111">x</a></aside><main><a href="/rooms/999">y</a><a href="/rooms/999">z</a></main>'));
check("ties fall back to document order",
  Filter.listingIdFromThread('<a href="/rooms/111">a</a><a href="/rooms/222">b</a>') === "111");
check("falls back to inline json when nothing is linked",
  Filter.listingIdFromThread('{"listingId":"827677023435973204"}') === "827677023435973204");

/* ---- against the real recon blob ---- */
const statePath = path.join(__dirname, "..", "state.json");
if (fs.existsSync(statePath)) {
  const root = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const arrays = Filter.locateArrays(root);
  const items = arrays.searchResults || [];
  const priced = items.map((it) => Filter.priceOf(it)).filter((x) => x && x.monthly != null);
  check("real data: every card normalises", priced.length === items.length, `${priced.length}/${items.length}`);
  check("real data: sane monthly range", priced.every((x) => x.monthly > 0 && x.monthly < 1e9));
  const imgs = items.map((it) => Filter.imagesOf(it));
  check("real data: multiple photos per card", imgs.every((a) => a.length >= 2), `min=${Math.min(...imgs.map((a) => a.length))}`);
  check("real data: photos resized", imgs[0][0].includes("im_w="), imgs[0][0]);

  // harvest() drives both the page seed and the probe response parse.
  const h = Filter.harvest(root);
  const ids = Object.keys(h);
  check("harvest finds every listing", ids.length >= 18, String(ids.length));
  check("harvest returns price+images+coord per listing",
    ids.every((id) => h[id].price && h[id].images && h[id].images.length && h[id].coord),
    JSON.stringify(h[ids[0]] && { price: !!h[ids[0]].price, imgs: h[ids[0]].images.length, coord: h[ids[0]].coord }));
  const fake = `<script id="data-deferred-state-0">${JSON.stringify(root)}</script>`;
  check("harvestHtml pulls the blob out of a page", Object.keys(Filter.harvestHtml(fake)).length === ids.length);
  check("harvestHtml on a priceless page", Object.keys(Filter.harvestHtml("<html></html>")).length === 0);
  console.log("  sample:", JSON.stringify(priced[0]));
} else {
  console.log("SKIP  state.json missing (run recon to regenerate)");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
