// Airbnb Archiver - pure filtering logic over Airbnb's search JSON.
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

  // Should the interceptor touch this request at all?
  //
  // The XHR path is where the value is: every search and map pan comes back as
  // JSON, and rewriting it is both safe (a bad parse just passes through) and
  // necessary (that is what keeps archived listings gone). The main_frame path
  // is different -- it buffers a whole ~1.6MB HTML document and writes it back,
  // and a document handed back wrong does not fail loudly, it silently breaks
  // the page. It also earns little: the panel covers Airbnb's results column,
  // the content script hides archived pins itself, and it reads the same
  // server-rendered blob for photos and prices. So documents are left alone
  // unless `rewriteDocuments` is explicitly turned on.
  shouldFilter(details, settings) {
    const url = (details && details.url) || "";
    if (url.indexOf("archiver_probe=1") !== -1) return false;   // our own price probe
    if (details && details.type === "main_frame") {
      return !!(settings && settings.rewriteDocuments);
    }
    return true;
  },

  // Make JSON safe to drop back inside a <script> tag (avoid "</script>" breakout).
  escapeForScript(jsonText) {
    return jsonText.replace(/</g, "\\u003c");
  },

  // Cheap structural check that a rewritten document is still the same document.
  // We only ever swap the contents of the deferred-state <script> blobs, so the
  // tag skeleton must be untouched: same number of script opens and closes, and
  // the same tail. Any drift means we corrupted the markup and must not ship it.
  sameHtmlShape(before, after) {
    const count = (s, re) => (s.match(re) || []).length;
    if (count(before, /<script\b/gi) !== count(after, /<script\b/gi)) return false;
    if (count(before, /<\/script>/gi) !== count(after, /<\/script>/gi)) return false;
    return before.slice(-64) === after.slice(-64);
  },

  /* ---- always-show-starred: cache + re-injection ---- */

  // Photo URLs for a listing (for the panel's carousel). Airbnb hands us the
  // "original" (multi-MB) URLs; muscache resizes on demand via ?im_w=.
  imagesOf(item) {
    const cp = item && item.contextualPictures;
    if (!Array.isArray(cp)) return [];
    return cp
      .map((p) => p && p.picture)
      .filter((u) => typeof u === "string")
      .map((u) => (u.includes("?") ? u : u + "?im_w=720"))
      .slice(0, 10);
  },

  /* ---- price normalisation (panel shows "per 30 nights") ---- */

  // "$1,234.56 USD" -> 1234.56 ; "₲1.234.567" -> 1234567. Last separator wins as
  // the decimal point when it's ambiguous; a lone "." with 3 trailing digits is
  // read as a thousands separator (Guaraní et al).
  parseMoney(s) {
    if (s == null) return null;
    const m = String(s).replace(/ /g, " ").match(/\d[\d.,\s]*/);
    if (!m) return null;
    let t = m[0].replace(/\s/g, "").replace(/[.,]$/, "");
    const lc = t.lastIndexOf(","), ld = t.lastIndexOf(".");
    const commaIsDecimal = () => t.replace(/,(?=.*,)/g, "").replace(",", ".");
    if (lc > -1 && ld > -1) t = lc > ld ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
    else if (lc > -1) t = (t.length - lc - 1) === 2 ? commaIsDecimal() : t.replace(/,/g, "");
    else if (ld > -1) t = ((t.match(/\./g) || []).length > 1 || (t.length - ld - 1) === 3) ? t.replace(/\./g, "") : t;
    const v = parseFloat(t);
    return isFinite(v) ? v : null;
  },

  // Leading currency symbol of a price string ("$564 USD" -> "$").
  currencyOf(s) {
    const m = String(s || "").match(/^[^\d\s]+/);
    return m ? m[0] : "";
  },

  /* Length-of-stay discount, read off the price breakdown.

     Airbnb fixes the thresholds and the host sets the percentage. Verified live
     rather than assumed (scripts/recon_thresh.py, run against two real
     listings): nothing at 6 nights, a "Weekly stay discount" appearing at
     exactly 7 and holding a constant percentage through 27, and a "Monthly stay
     discount" replacing it at exactly 28.

     A stay can carry more than one reduction at once (a 28-night quote showed
     "Monthly stay discount" AND "Airbnb monthly stay savings"), so the saving is
     measured as base minus price-after-discount. That captures every line
     instead of just the first, and it is the number the guest actually keeps. */
  DISCOUNT_MIN_NIGHTS: { weekly: 7, monthly: 28 },
  discountOf(sdp) {
    const groups = (sdp && sdp.explanationData && sdp.explanationData.priceDetails) || [];
    let base = null, after = null, label = null;
    for (const g of groups) {
      for (const li of g.items || []) {
        const d = li.description || "";
        const v = Filter.parseMoney(li.priceString);
        // The first plain line is what it would cost with no discount: either
        // "N nights x $rate" or, on a monthly quote, "Average monthly price".
        if (base == null && li.__typename === "DefaultExplanationLineItem" && v != null) base = v;
        if (!label && li.__typename === "DiscountedExplanationLineItem") label = d;
        if (li.__typename === "HighlightExplanationLineItem" || /after discount|^total\b/i.test(d)) {
          if (v != null) after = v;
        }
      }
    }
    if (base == null || after == null || !(base > after)) return null;
    const amount = Math.round((base - after) * 100) / 100;
    const kind = /month/i.test(label || "") ? "monthly" : /week/i.test(label || "") ? "weekly" : null;
    return {
      label: label || "Discount",
      kind,
      minNights: kind ? Filter.DISCOUNT_MIN_NIGHTS[kind] : null,
      amount,
      base,
      pct: Math.round((amount / base) * 100),
    };
  },

  // Normalised price for a listing: { monthly, nightly, total, nights, symbol,
  // original, basis }. Airbnb quotes cards three different ways depending on the
  // search - a stay total ("$564 for 14 nights"), a nightly rate, or a monthly
  // rate on a monthly-stay search ("$4,883 monthly, originally $6,675",
  // displayPriceStyle MONTHLY, verified live via scripts/recon_price.py) - so
  // reduce all of them to one 30-night figure you can actually compare.
  priceOf(item) {
    const sdp = item && item.structuredDisplayPrice;
    const pl = sdp && sdp.primaryLine;
    if (!pl) return null;
    const label = pl.accessibilityLabel || [pl.discountedPrice || pl.price, pl.qualifier].filter(Boolean).join(" ");
    // DiscountedDisplayPriceLine has no `price` - take what you'd actually pay.
    const priceStr = pl.discountedPrice || pl.price || label;
    const amount = Filter.parseMoney(priceStr);
    if (amount == null) return null;
    const symbol = Filter.currencyOf(priceStr);
    const original = pl.originalPrice ? Filter.parseMoney(pl.originalPrice) : null;
    const discount = Filter.discountOf(sdp);

    // A monthly-stay search already quotes a per-month figure; treat it as the
    // 30-night price directly (a calendar month is within ~1.5% of 30 nights).
    if (/month/i.test(pl.qualifier || "") || sdp.displayPriceStyle === "MONTHLY") {
      return {
        symbol, original, discount, basis: "monthly", nights: null, total: null,
        nightly: Math.round((amount / 30) * 100) / 100,
        monthly: Math.round(amount),
        label,
      };
    }

    // Nights: "for 14 nights" on the price line, or "14 nights x $42" in the breakdown.
    let nights = null, total = null;
    const nm = String(label).match(/(\d+)\s*nights?/i);
    if (nm) nights = parseInt(nm[1], 10);
    for (const g of (sdp.explanationData && sdp.explanationData.priceDetails) || []) {
      for (const li of g.items || []) {
        const d = li.description || "";
        if (nights == null) { const m2 = d.match(/(\d+)\s*nights?\s*x/i); if (m2) nights = parseInt(m2[1], 10); }
        // The post-discount line is the honest stay total (pre-tax).
        if (li.__typename === "HighlightExplanationLineItem" || /after discount|^total\b/i.test(d)) {
          const v = Filter.parseMoney(li.priceString);
          if (v != null) total = v;
        }
      }
    }

    let nightly = null, basis = null;
    if (nights) { if (total == null) total = amount; nightly = total / nights; basis = "stay"; }
    else if (/night/i.test(pl.qualifier || label)) { nightly = amount; basis = "nightly"; }

    return {
      symbol, nights, total, original, discount, basis,
      nightly: nightly != null ? Math.round(nightly * 100) / 100 : null,
      monthly: nightly != null ? Math.round(nightly * 30) : null,
      label,
    };
  },

  /* ---- live price probing ---- */

  // Params that decide the quoted price. Two searches with the same signature
  // quote the same price, so a cached price survives pans and zooms but not a
  // date / guest / monthly-mode change.
  // Airbnb spells these "checkin"/"checkout", with NO underscore (verified live:
  // scripts/recon_dates.py). Listing only the underscored forms meant the dates
  // were invisible here, which broke two things at once: ctxOf could not tell two
  // date ranges apart, so a cached price looked fresh forever and never
  // re-probed; and probeUrl dropped the dates, so every probe asked Airbnb with
  // NO dates and got back its dateless default quote. That is where a hard
  // "5 nights" came from on every row whatever you had selected.
  // The underscored spellings are kept as harmless aliases.
  PRICE_CTX_KEYS: [
    "adults", "children", "infants", "pets",
    "checkin", "checkout", "check_in", "check_out",
    "monthly_start_date", "monthly_end_date", "monthly_length",
    "flexible_trip_lengths[]", "flexible_trip_dates[]",
    "price_filter_input_type", "price_filter_num_nights",
    "date_picker_type", "search_type", "search_mode", "currency",
  ],

  // The period the user actually selected, read off the search URL.
  // { checkin, checkout, nights } for a normal stay, { months } for a monthly
  // search, or null when no dates are chosen (Airbnb then quotes a default,
  // which must NOT be presented as if it were a chosen period).
  stayOf(search) {
    try {
      const p = new URLSearchParams(String(search || "").replace(/^\?/, ""));
      const ci = p.get("checkin") || p.get("check_in");
      const co = p.get("checkout") || p.get("check_out");
      const day = (s) => Date.parse(String(s) + "T00:00:00Z");
      if (ci && co) {
        const a = day(ci), b = day(co);
        if (isFinite(a) && isFinite(b) && b > a) {
          return { checkin: ci, checkout: co, nights: Math.round((b - a) / 86400000), months: null };
        }
      }
      const ml = parseInt(p.get("monthly_length"), 10);
      if (isFinite(ml) && ml > 0) {
        return { checkin: p.get("monthly_start_date"), checkout: p.get("monthly_end_date"), nights: null, months: ml };
      }
      return null;
    } catch (_) { return null; }
  },

  ctxOf(url) {
    try {
      const p = new URL(url, "https://www.airbnb.com").searchParams;
      return Filter.PRICE_CTX_KEYS
        .map((k) => { const v = p.getAll(k); return v.length ? k + "=" + v.join(",") : null; })
        .filter(Boolean).join("&");
    } catch (_) { return ""; }
  },

  /* ---- distance from a fixed reference point ----
     Booking.com-style "how far is this from my place". Every listing already
     has a coordinate on record, so the only missing piece is the reference
     point. No geocoding service is called (nothing leaves the browser except
     requests to airbnb.com), so the place is whatever coordinates the user
     pastes: "lat, lng" directly, or a Google Maps link that carries them. */

  // {lat, lng} out of pasted text, or null when none can be read.
  parsePlace(text) {
    const s = String(text || "").trim();
    if (!s) return null;
    const ok = (la, ln) => {
      const lat = parseFloat(la), lng = parseFloat(ln);
      // 0,0 is the middle of the Atlantic; a paste that reads as it is a
      // parse accident, not anyone's home.
      return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
    };
    const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";
    // A Google Maps place link: ...!3d-25.28646!4d-57.647. This is the pin
    // itself, so it wins over @, which is only where the camera was.
    let m = s.match(new RegExp("!3d" + NUM + "!4d" + NUM));
    if (m) { const r = ok(m[1], m[2]); if (r) return r; }
    // The camera: .../@-25.2864,-57.6470,15z
    m = s.match(new RegExp("@" + NUM + "," + NUM));
    if (m) { const r = ok(m[1], m[2]); if (r) return r; }
    // q= / ll= / destination= style params carrying "lat,lng"
    m = s.match(new RegExp("[?&](?:q|ll|query|center|destination)=" + NUM + "(?:,|%2C)\\s*" + NUM, "i"));
    if (m) { const r = ok(m[1], m[2]); if (r) return r; }
    // Plain "lat, lng", which is also what Google Maps' right-click
    // "copy coordinates" puts on the clipboard.
    m = s.match(new RegExp("^" + NUM + "\\s*[,;\\s]\\s*" + NUM + "$"));
    if (m) { const r = ok(m[1], m[2]); if (r) return r; }
    return null;
  },

  // Great-circle distance in km (haversine). Straight-line, like Booking's
  // own "X km from centre" figures; good enough to rank flats by.
  distanceKm(a, b) {
    if (!a || !b || !isFinite(a.lat) || !isFinite(a.lng) || !isFinite(b.lat) || !isFinite(b.lng)) return null;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
  },

  // The precision people actually read distances at: metres to the nearest 10
  // under a kilometre, one decimal under ten, whole kilometres beyond.
  fmtDistance(km) {
    if (km == null || !isFinite(km) || km < 0) return "";
    if (km < 0.995) return Math.max(10, Math.round(km * 100) * 10) + " m";
    if (km < 9.95) return (Math.round(km * 10) / 10).toFixed(1) + " km";
    return Math.round(km) + " km";
  },

  /* ---- address -> coordinates, via Airbnb's own place search ----
     Typing an address like in Google Maps needs a geocoder, and nothing may
     leave the browser except requests to airbnb.com. Airbnb's own search box
     is a geocoder: its suggestions endpoint matches street addresses
     (Google-backed, verified live with scripts/recon_autocomplete.py), and a
     suggestion's place_id resolves to coordinates through one search-page
     fetch, whose mapBoundsHint is centred on the place ("precision":"street").
     Two hops, both to airbnb.com. */

  // Airbnb's public web client key, the same one every airbnb.com page embeds.
  AUTOCOMPLETE_KEY: "d306zoyjsyarp7ifhu67rjxn52tv0t20",

  // The suggestions request. This is the minimal param set the endpoint
  // accepts (verified anonymously): the captured browser request also carries
  // a satori_config_token and personalisation params, none of them required.
  autocompleteUrl(origin, input) {
    const q = new URLSearchParams({
      key: Filter.AUTOCOMPLETE_KEY,
      locale: "en", language: "en",
      num_results: "5",
      user_input: String(input || ""),
      api_version: "1.2.0",
      options: "simple_search",
    });
    return (origin || "https://www.airbnb.com") + "/api/v2/autocompletes-personalized?" + q.toString();
  },

  // [{name, query, placeId}] out of the suggestions response.
  placesOf(json) {
    const out = [];
    for (const t of (json && json.autocomplete_terms) || []) {
      if (t.suggestion_type && t.suggestion_type !== "LOCATION") continue;
      const esp = t.explore_search_params || {};
      const name = t.display_name || esp.query;
      if (!name) continue;
      out.push({ name, query: esp.query || name, placeId: esp.place_id || null });
    }
    return out;
  },

  // The search-page fetch that turns a picked suggestion into coordinates.
  // archiver_probe=1 keeps our own interceptor's hands off it.
  placeSearchUrl(origin, query, placeId) {
    const q = new URLSearchParams();
    q.set("query", String(query || ""));
    if (placeId) q.set("place_id", placeId);
    q.append("refinement_paths[]", "/homes");
    q.set("archiver_probe", "1");
    return (origin || "https://www.airbnb.com") + "/s/homes?" + q.toString();
  },

  // Centre of the geocoded viewport in a search page's HTML: the place the
  // query resolved to. Null when the page carries no bounds (geocode failed).
  boundsCenterFromHtml(html) {
    const m = String(html).match(
      /"mapBoundsHint"\s*:\s*\{[^{}]*"northeast"\s*:\s*\{[^}]*?"latitude"\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?"longitude"\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}[^{}]*"southwest"\s*:\s*\{[^}]*?"latitude"\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/
    );
    if (!m) return null;
    const lat = (parseFloat(m[1]) + parseFloat(m[3])) / 2;
    const lng = (parseFloat(m[2]) + parseFloat(m[4])) / 2;
    return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng } : null;
  },

  // A search scoped to a tiny box around one listing - this is how a saved
  // listing's price gets refreshed. The /rooms/<id> page carries NO price at all
  // (verified, scripts/recon_pdp.py) but /s/ server-renders one. Only
  // price-setting params are carried over: copying the user's filters too would
  // make a merely filtered-out listing look unavailable.
  probeUrl(origin, search, coord, pad) {
    const keep = new Set([...Filter.PRICE_CTX_KEYS, "refinement_paths[]"]);
    const q = new URLSearchParams();
    for (const [k, v] of new URLSearchParams(search || "")) if (keep.has(k)) q.append(k, v);
    if (!q.has("refinement_paths[]")) q.set("refinement_paths[]", "/homes");
    const d = pad || 0.0015;
    q.set("search_by_map", "true");
    q.set("zoom", "17");
    q.set("ne_lat", (coord.lat + d).toFixed(6));
    q.set("ne_lng", (coord.lng + d).toFixed(6));
    q.set("sw_lat", (coord.lat - d).toFixed(6));
    q.set("sw_lng", (coord.lng - d).toFixed(6));
    q.set("archiver_probe", "1");   // so our own interceptor leaves it alone
    return origin + "/s/homes?" + q.toString();
  },

  // The server-rendered JSON blobs inside a search page's HTML.
  blobsFromHtml(html) {
    const out = [];
    const re = /<script id="data-deferred-state-\d+"[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) out.push(m[1]);
    return out;
  },

  // { id: {price, images, coord} } for every listing in a parsed search payload.
  harvest(root) {
    const out = {};
    (function walk(n) {
      if (Array.isArray(n)) { for (const c of n) walk(c); return; }
      if (!n || typeof n !== "object") return;
      const dsl = n.demandStayListing;
      if (dsl && dsl.id) {
        const id = Filter.decodeId(dsl.id);
        if (id) {
          const e = (out[id] = out[id] || {});
          if (!e.price) { const p = Filter.priceOf(n); if (p) e.price = p; }
          if (!e.images) { const im = Filter.imagesOf(n); if (im.length) e.images = im; }
          if (!e.coord) { const c = Filter.coordOf(n); if (c) e.coord = c; }
        }
      }
      for (const k in n) walk(n[k]);
    })(root);
    return out;
  },

  // Everything a search page's HTML knows about the listings in it.
  harvestHtml(html) {
    const out = {};
    for (const blob of Filter.blobsFromHtml(html)) {
      let j;
      try { j = JSON.parse(blob); } catch (_) { continue; }
      const h = Filter.harvest(j);
      for (const id in h) out[id] = Object.assign(out[id] || {}, h[id]);
    }
    return out;
  },

  /* ---- host / owner ---- */

  // Airbnb never fills passportData in search results (it's present but null),
  // so the host's name only comes from the room page. There it sits in a
  // PassportCardData block, with "Hosted by <name>" as a backstop.
  // Verified live: scripts/recon_hostname.py.
  hostFromHtml(html) {
    const s = String(html || "");
    const out = {};
    let m = s.match(/"__typename"\s*:\s*"PassportCardData"\s*,\s*"name"\s*:\s*"([^"]{1,80})"/);
    if (!m) m = s.match(/"name"\s*:\s*"([^"]{1,80})"\s*,\s*"userId"\s*:\s*"[^"]*"\s*,\s*"contextualUserId"/);
    if (!m) m = s.match(/Hosted by ([^"<\\]{1,60})/);
    if (m) out.name = m[1].trim();
    const h = s.match(/"hostId"\s*:\s*"?(\d+)"?/);
    if (h) out.hostId = h[1];
    const t = s.match(/"name"\s*:\s*\{\s*"__typename"\s*:\s*"UGCText"\s*,\s*"localizedString"\s*:\s*"([^"]{1,120})"/);
    if (t) out.listingName = t[1].trim();
    else {
      const ti = s.match(/<title[^>]*>([^<]{1,200})<\/title>/);
      // "<listing name> - <property type> in <place> - Airbnb"
      if (ti) { const cut = ti[1].split(" - ")[0].trim(); if (cut && !/log in/i.test(cut)) out.listingName = cut; }
    }
    return out.name || out.listingName ? out : null;
  },

  // Does this listing allow pets? Search results say NOTHING about amenities
  // (verified: scripts/recon_pets.py) -- but the room page does, and we already
  // fetch that page for the host name, so this rides along for free.
  //
  // Read the ICON, not the title: Airbnb writes the house rule as
  //   {"__typename":"BasicListItem","title":"Pets allowed","icon":"SYSTEM_PETS"}
  //   {"__typename":"BasicListItem","title":"No pets","icon":"SYSTEM_NO_PETS"}
  // and the title is localised while the icon is not. "No" wins over "yes" so a
  // page that mentions both (an unavailable-amenities list next to the rule)
  // never reads as pet-friendly. Verified live on both kinds of listing:
  // scripts/recon_pets2.py. Returns true / false / null (page didn't say).
  petsFromHtml(html) {
    const s = String(html || "");
    if (/"icon"\s*:\s*"SYSTEM_NO_PETS"/.test(s)) return false;
    if (/"icon"\s*:\s*"SYSTEM_PETS"/.test(s)) return true;
    return null;
  },

  // Message the host about a listing WITHOUT knowing the thread id -- Airbnb
  // resolves this to the existing conversation when there is one. Verified the
  // route exists (auth-gated, not 404): scripts/recon_contact.py.
  contactUrl(origin, listingId) {
    return `${origin}/contact_host/${listingId}/send_message`;
  },
  threadUrl(origin, threadId) {
    return `${origin}/guest/messages/${threadId}`;
  },
  // The listing a message thread is about. NOT simply the first /rooms/ link: a
  // thread page also renders the inbox sidebar, and every other conversation in
  // it links its own listing. The open thread's listing is the one that recurs
  // (header, card, CTA), so take the most frequent and break ties by order.
  listingIdFromThread(html) {
    const s = String(html || "");
    const counts = new Map();
    const re = /\/rooms\/(\d+)/g;
    let m;
    while ((m = re.exec(s))) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    if (counts.size) {
      let best = null, bestN = -1;
      for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
      return best;
    }
    const j = s.match(/"listing_?[iI]d"\s*:\s*"?(\d{6,})"?/);
    return j ? j[1] : null;
  },
  // "/guest/messages/<threadId>" -> "<threadId>"
  threadIdFromPath(pathname) {
    const m = String(pathname || "").match(/\/guest\/messages\/(\d+)/);
    return m ? m[1] : null;
  },
  roomIdFromPath(pathname) {
    const m = String(pathname || "").match(/\/rooms\/(\d+)/);
    return m ? m[1] : null;
  },

  // A room page has no price, but it does carry the coordinate a probe needs.
  coordFromHtml(html) {
    const la = String(html).match(/"lat(?:itude)?"\s*:\s*(-?\d+\.\d+)/);
    const ln = String(html).match(/"l(?:ng|ongitude)"\s*:\s*(-?\d+\.\d+)/);
    if (!la || !ln) return null;
    const lat = parseFloat(la[1]), lng = parseFloat(ln[1]);
    return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
  },

  // { lat, lng } from a listing object, or null.
  coordOf(item) {
    const c = item && item.demandStayListing && item.demandStayListing.location
      && item.demandStayListing.location.coordinate;
    if (c && typeof c.latitude === "number" && typeof c.longitude === "number") {
      return { lat: c.latitude, lng: c.longitude };
    }
    return null;
  },

  // First array found under each of the three known keys (live references).
  locateArrays(root) {
    const found = { searchResults: null, mapSearchResults: null, staysInViewport: null };
    (function walk(node) {
      if (Array.isArray(node)) { for (const c of node) walk(c); return; }
      if (node && typeof node === "object") {
        for (const k of Object.keys(node)) {
          if (found[k] === null && Array.isArray(node[k])
              && (k === "searchResults" || k === "mapSearchResults" || k === "staysInViewport")) {
            found[k] = node[k];
          }
          walk(node[k]);
        }
      }
    })(root);
    return found;
  },

  // Record each listing's array objects + coordinate into `seen` (mutated).
  // Returns the ids touched, so the caller can age the cache out (`seen` is a
  // warm cache, not a record - see touchSeen in background.js).
  collectSeen(root, seen) {
    const arr = Filter.locateArrays(root);
    const touched = [];
    const note = (it, field) => {
      const id = Filter.itemId(it);
      if (!id) return;
      const e = (seen[id] = seen[id] || {});
      e[field] = it;
      const c = Filter.coordOf(it);
      if (c) e.coord = c;
      touched.push(id);
    };
    (arr.searchResults || []).forEach((it) => note(it, "searchResult"));
    (arr.mapSearchResults || []).forEach((it) => note(it, "mapResult"));
    (arr.staysInViewport || []).forEach((it) => note(it, "viewportPin"));
    return touched;
  },

  // Bounding box of listings actually returned (null if fewer than 2 coords).
  bboxOf(items) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity, n = 0;
    for (const it of items || []) {
      const c = Filter.coordOf(it);
      if (!c) continue;
      n++;
      minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
      minLng = Math.min(minLng, c.lng); maxLng = Math.max(maxLng, c.lng);
    }
    return n >= 2 ? { minLat, maxLat, minLng, maxLng } : null;
  },

  // Re-inject starred listings onto the MAP (map card + pin) when the response
  // omitted them but they fall within the returned-results bounds. The side list
  // is rendered by our own panel, so we no longer touch searchResults.
  // objById: { id: { mapResult?, viewportPin?, coord } }
  injectStarredMap(root, objById) {
    let injected = 0;
    try {
      const ids = Object.keys(objById || {});
      if (!ids.length) return 0;
      const arr = Filter.locateArrays(root);
      const bbox = Filter.bboxOf(arr.mapSearchResults || arr.searchResults || []);
      if (!bbox) return 0;
      const padLat = 0.2 * (bbox.maxLat - bbox.minLat);
      const padLng = 0.2 * (bbox.maxLng - bbox.minLng);
      const setOf = (a) => new Set((a || []).map(Filter.itemId).filter(Boolean));
      const inMap = setOf(arr.mapSearchResults), inVp = setOf(arr.staysInViewport);
      const clone = (o) => JSON.parse(JSON.stringify(o));

      for (const id of ids) {
        const cached = objById[id];
        const c = cached && cached.coord;
        if (!c) continue;
        if (c.lat < bbox.minLat - padLat || c.lat > bbox.maxLat + padLat
          || c.lng < bbox.minLng - padLng || c.lng > bbox.maxLng + padLng) continue;
        let did = false;
        if (arr.mapSearchResults && cached.mapResult && !inMap.has(id)) { arr.mapSearchResults.push(clone(cached.mapResult)); did = true; }
        if (arr.staysInViewport && cached.viewportPin && !inVp.has(id)) { arr.staysInViewport.push(clone(cached.viewportPin)); did = true; }
        if (did) injected++;
      }
    } catch (_) { /* never let injection break the response */ }
    return injected;
  },

  // Force starred listings' map pins to the full-size price pill (Airbnb shrinks
  // some to MINI_PIN dots). Returns how many were upgraded.
  forceFullPins(root, starredIds) {
    if (!starredIds || !starredIds.size) return 0;
    let n = 0;
    const arr = Filter.locateArrays(root);
    for (const it of arr.staysInViewport || []) {
      const id = Filter.itemId(it);
      if (id && starredIds.has(id) && it.pinState !== "FULL_PIN") { it.pinState = "FULL_PIN"; n++; }
    }
    return n;
  },
};

// Export for Node tests; harmless in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Filter };
}
