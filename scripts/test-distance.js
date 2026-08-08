// Pure-logic test for the distance-from-your-place feature (no browser):
// Filter.parsePlace (pasted coordinates / Google Maps links),
// Filter.distanceKm (haversine) and Filter.fmtDistance.
//   node scripts/test-distance.js

const path = require("path");
const { Filter } = require(path.join(__dirname, "..", "extension", "filter.js"));

let fails = 0;
function check(label, cond, extra = "") {
  if (!cond) fails++;
  console.log((cond ? "PASS" : "FAIL") + "  " + label + (extra ? "  " + extra : ""));
}
function near(a, b, tol) { return a != null && Math.abs(a - b) <= tol; }

/* ---- parsePlace ---- */
const P = (s) => Filter.parsePlace(s);

let r = P("-25.28646, -57.63591");
check("plain 'lat, lng'", r && near(r.lat, -25.28646, 1e-9) && near(r.lng, -57.63591, 1e-9));
check("plain 'lat lng' (space)", !!P("-25.28646 -57.63591"));
check("plain 'lat;lng'", !!P("-25.28646; -57.63591"));
check("integers work", !!P("52, 13"));

// Google Maps place URL: the !3d/!4d pair is the pin itself and must win over
// the @ camera position that sits earlier in the same URL.
r = P("https://www.google.com/maps/place/Asunci%C3%B3n/@-25.3,-57.7,12z/data=!3m1!4b1!4m6!3m5!1s0x945da8ff8d64b1c7:0x8f7c4a1ffe6db4d5!8m2!3d-25.2637399!4d-57.5759259!16zL20vMGZzbXk");
check("maps place URL uses !3d/!4d over @", r && near(r.lat, -25.2637399, 1e-9) && near(r.lng, -57.5759259, 1e-9));

r = P("https://www.google.com/maps/@-25.28646,-57.63591,15z");
check("maps camera URL (@lat,lng)", r && near(r.lat, -25.28646, 1e-9) && near(r.lng, -57.63591, 1e-9));

r = P("https://maps.google.com/?q=-25.28646,-57.63591");
check("?q=lat,lng", r && near(r.lat, -25.28646, 1e-9));
check("?q= URL-encoded comma", !!P("https://maps.google.com/?q=-25.28646%2C-57.63591"));
check("destination=lat,lng", !!P("https://www.google.com/maps/dir/?api=1&destination=-25.28,-57.63"));

check("empty is null", P("") === null && P(null) === null);
check("an address alone is null", P("Mariscal Lopez 1234, Asuncion") === null);
check("a place URL with no coords is null", P("https://www.google.com/maps/place/Asuncion") === null);
check("out-of-range lat rejected", P("125.0, 10.0") === null);
check("0,0 rejected as a parse accident", P("0, 0") === null);

/* ---- distanceKm ---- */
// Airbnb's SF office to the Golden Gate Bridge, ~8.4 km straight line.
const SF_OFFICE = { lat: 37.7716, lng: -122.4054 };
const GG_BRIDGE = { lat: 37.8199, lng: -122.4783 };
check("SF office -> Golden Gate ~8.4 km", near(Filter.distanceKm(SF_OFFICE, GG_BRIDGE), 8.4, 0.3),
  String(Filter.distanceKm(SF_OFFICE, GG_BRIDGE)));

// Paris -> London, well-known ~344 km.
check("Paris -> London ~344 km",
  near(Filter.distanceKm({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 }), 344, 5),
  String(Filter.distanceKm({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 })));

check("zero distance to itself", near(Filter.distanceKm(SF_OFFICE, SF_OFFICE), 0, 1e-9));
// ~111 m per 0.001 degree of latitude, anywhere.
check("0.001 deg lat ~111 m",
  near(Filter.distanceKm({ lat: -25.0, lng: -57.0 }, { lat: -25.001, lng: -57.0 }), 0.111, 0.002));
check("missing coord is null", Filter.distanceKm(null, SF_OFFICE) === null
  && Filter.distanceKm(SF_OFFICE, { lat: NaN, lng: 1 }) === null);

/* ---- fmtDistance ---- */
check("metres under 1 km", Filter.fmtDistance(0.111) === "110 m", Filter.fmtDistance(0.111));
check("tiny distances floor at 10 m", Filter.fmtDistance(0.003) === "10 m", Filter.fmtDistance(0.003));
check("one decimal under 10 km", Filter.fmtDistance(2.44) === "2.4 km", Filter.fmtDistance(2.44));
check("0.996 km rounds up to 1.0 km", Filter.fmtDistance(0.996) === "1.0 km", Filter.fmtDistance(0.996));
check("whole km beyond 10", Filter.fmtDistance(23.4) === "23 km", Filter.fmtDistance(23.4));
check("9.96 promotes to 10 km", Filter.fmtDistance(9.96) === "10 km", Filter.fmtDistance(9.96));
check("null / negative is empty", Filter.fmtDistance(null) === "" && Filter.fmtDistance(-1) === "");

/* ---- address -> coordinates via Airbnb's own place search ---- */
// Fixtures are the real shapes captured live by scripts/recon_autocomplete.py
// (suggestions) and a real /s/homes?place_id=... fetch (mapBoundsHint).

const u = Filter.autocompleteUrl("https://www.airbnb.com", "Mariscal Lopez 3374");
check("autocomplete URL hits airbnb and carries the input",
  u.startsWith("https://www.airbnb.com/api/v2/autocompletes-personalized?")
  && u.includes("user_input=Mariscal+Lopez+3374") && u.includes("key="), u);

const AC = {
  autocomplete_terms: [
    { id: "a", suggestion_type: "LOCATION", display_name: "Avenida Mariscal López 3374, Asunción",
      explore_search_params: { query: "Avenida Mariscal López 3374, Asunción, Paraguay", place_id: "PLACE_A" } },
    { id: "b", suggestion_type: "PROPERTY", display_name: "Some listing",
      explore_search_params: { query: "x", place_id: "y" } },
    { id: "c", suggestion_type: "LOCATION", display_name: "",
      explore_search_params: {} },
  ],
};
const places = Filter.placesOf(AC);
check("suggestions parsed: LOCATION rows only, empty names dropped",
  places.length === 1 && places[0].name === "Avenida Mariscal López 3374, Asunción"
  && places[0].placeId === "PLACE_A", JSON.stringify(places));
check("empty / malformed response gives []", Filter.placesOf({}).length === 0 && Filter.placesOf(null).length === 0);

const su = Filter.placeSearchUrl("https://www.airbnb.com", places[0] && places[0].query, "PLACE_A");
check("place-search URL carries query + place_id and skips our interceptor",
  su.includes("place_id=PLACE_A") && su.includes("archiver_probe=1") && su.includes("query="), su);

// The exact shape of the live page (captured 2026-08-08). Centre of these
// bounds is the geocoded street address.
const BOUNDS = '<script>x={"mapBoundsHint":{"__typename":"MapBounds",'
  + '"northeast":{"__typename":"Coordinate","latitude":-25.274089530501843,"longitude":-57.57477220147849},'
  + '"southwest":{"__typename":"Coordinate","latitude":-25.31292748665088,"longitude":-57.60940454900263}},'
  + '"mapMode":"DEFAULT"}</script>';
const c = Filter.boundsCenterFromHtml(BOUNDS);
check("bounds centre read off the search page",
  c && near(c.lat, -25.29351, 0.0001) && near(c.lng, -57.59209, 0.0001), JSON.stringify(c));
check("page with no bounds gives null",
  Filter.boundsCenterFromHtml("<html>no map here</html>") === null
  && Filter.boundsCenterFromHtml("") === null);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
