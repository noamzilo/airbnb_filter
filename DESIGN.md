# DESIGN - Airbnb Archiver

How the extension is built, and why it is built that way. For *what it does for
you*, see [FEATURES.md](FEATURES.md); for the decision-by-decision history see
[PROJECT_LOG.md](PROJECT_LOG.md) (D1–D48).

Version `0.1.24`, Firefox-only (MV2,
`browser_specific_settings.gecko.id = airbnb-archiver@noam.local`), scoped to
`*://*.airbnb.com/*`.

---

## 1. Architecture

Four pieces, one shared store:

| Piece | File | Role |
|---|---|---|
| **Interceptor** | [background.js](extension/background.js) + [filter.js](extension/filter.js) | rewrites Airbnb's search data *before the page renders it* |
| **Content script** | [content.js](extension/content.js) + [content.css](extension/content.css) | the panel, the map decoration, the bridge bar |
| **Popup** | [popup.html](extension/popup.html) / [popup.js](extension/popup.js) | bulk review, settings |
| **Store** | [store.js](extension/store.js) | thin wrapper over `browser.storage.local`, shared by all three |

`filter.js` is deliberately pure - no DOM, no storage - so it loads in both the
background page and the content script and stays testable under plain Node.

The rubric lives in `Store.setCategory`: a listing is in **at most one** of
`starred` / `maybe` / `archived`, and setting one deletes it from the other two.

---

## 2. The interceptor

Via Firefox's `webRequest.filterResponseData` - the whole reason this is a
Firefox add-on, since Chrome removed the equivalent.

Watched: `*://*.airbnb.com/s/*` and `*://*.airbnb.com/api/v3/StaysSearch*`,
types `main_frame` + `xmlhttprequest`.

- **Removes archived listings** from all three listing arrays Airbnb returns -
  `searchResults`, `mapSearchResults`, `staysInViewport` - found by recursive
  walk, keyed by the permanent room id (base64 `DemandStayListing:<id>`, or a
  plain `listingId`). Removal is at the *data* level, so nothing reappears on
  pan, zoom, or re-render the way a CSS hide would.
- **Forces starred pins to `FULL_PIN`**, so Airbnb can't shrink a starred
  listing to an anonymous mini dot.
- **Harvests as it goes**: every response it parses feeds a session `seen` cache
  and persists photos, normalised prices, and coordinates for anything tagged -
  so a listing starred *right now* gets its carousel and price without waiting
  for the next search. Coordinates and photos flush after 300 ms, the heavier
  full-object cache after 2 s.
- **Never breaks the page**: a JSON parse failure passes the original bytes
  through; a rewritten HTML document is shipped only if `Filter.sameHtmlShape()`
  confirms the same script-tag skeleton and tail. The output bytes are decided
  *before* anything is written - an earlier version threw mid-write and the catch
  wrote the body a second time, appending a whole duplicate document to a partial
  one.
- **Skips its own price probes** (`archiver_probe=1` in the URL).
- **`showArchived` on** → the removal pass is skipped, so archived listings come
  back (greyed, with an Unarchive button).

### XHR vs. whole pages

JSON XHRs are always rewritten: it is where the value is, and a bad parse just
passes through. Rewriting the **search HTML document** buffers ~1.6 MB and is
opt-in behind the `rewriteDocuments` setting (`Filter.shouldFilter`) - off by
default, because a document handed back wrong doesn't fail loudly: the parser
loses sync, swallows the page up to the next `</script>`, and paints raw JSON as
class-name soup. The panel covers the results column anyway and the content
script hides archived pins itself, so all the toggle buys is that archived
listings never briefly flash on first paint.

**Disabled on purpose:** `Filter.injectStarredMap()` (re-injecting cached
starred listings Airbnb dropped) is implemented and Node-tested but *not called* -
splicing cached GraphQL objects into a live response blanked Airbnb's client.
The panel renders starred/maybe from snapshots instead.

---

## 3. The panel

The panel is rendered **entirely from the store**, never from what the current
response happened to contain: `orderedIds()` is the union of `starred` and
`maybe`, and each row is drawn from that listing's snapshot plus the cached
photos, price, host and note. Airbnb dropping a listing from a search therefore
can't remove it from the list - which is the whole point, and the reason the
snapshot is written at tag time rather than looked up at render time. The only
thing that *does* follow Airbnb's response is the map pin (see §4 and the
re-injection limit in §10).

### Taking the card grid's place

The panel is inserted where Airbnb's card grid sits and the grid is hidden
(`display:none`, never removed), so the panel inherits the column's width, its
scrolling, and its place in Airbnb's own stacking order - their popovers paint
over it exactly as they did over the cards. The earlier design (a fixed overlay
at `z-index: 9000`) covered more than the cards: the search dropdown and menus
went under it.

The grid is the **lowest common ancestor** of the visible
`[itemprop="itemListElement"]` cards left of the map, and is rejected if it is
`<body>` or contains the map or the header - climbing higher hides the whole
column and Airbnb reflows the map to full width (measured: left 816 → 0).
Because the search only sees *visible* cards, a fresh hit means Airbnb
re-rendered the column and built a new grid; the previously hidden one is then
released.

**Overlay fallback** (`.archiver-panel-overlay`) is kept for when no grid can be
found: fixed, left edge of the map = the panel's width, running to the bottom of
the window. Its top is the cards' own top, clamped below `chromeBottom()` - the
lowest edge anything in the header reaches, because expanding the search bar does
*not* grow the header (measured: 152px either way); the expanded bar is
`position:absolute`, hangs ~16px past the bottom edge, and is wider than the map
column so it reaches left underneath the panel. Only overhangs ≤200px count as
chrome; letting the header's full-viewport overlay host vote sent the bottom to
865 and collapsed the panel to a sliver.

Re-placed on resize, on scroll, and on a 700 ms backstop timer - geometry can
change with no DOM mutation to observe (a late font, the map getting its size),
and without the timer a panel hidden at first render never recovers.

**Airbnb's pager** is hidden with the grid it belongs to: it pages through
*their* 18-per-page results, so above our single-scroll list it read as "5 pages"
over one row. Matched structurally (a `<nav>` in the results column whose links
are numbered search pages), not by its English aria-label, and restored the
moment the panel stops replacing the grid.

### Viewport scoping

Bounds come from Airbnb's own `ne_lat/ne_lng/sw_lat/sw_lng` URL params, which
they rewrite on every pan and zoom (verified live, `scripts/recon_bounds.py`); a
fresh city search has none yet, so the fallback is the bounding box of the pins
actually rendered, padded 15%.

Listings with **no coordinate on record are always shown**, under their own
divider - silently hiding a listing we simply never learned the location of would
look like data loss.

Because the panel usually shows a subset, a drag-drop must not overwrite the
global order with just the visible ids. `commitOrder()` splices the new visible
sequence into the slots those rows occupied, leaving off-screen listings where
they were.

### Distance from your place

Booking.com's "X km from your chosen point", rebuilt from data already on hand:
every tagged listing has a coordinate (`tagCoords` / the snapshot), so the only
missing piece is the reference point. It lives in
`settings.refPlace = {lat, lng, raw}`, and each row then shows the
great-circle distance (`Filter.distanceKm`, haversine) formatted at the
precision people read distances at (`Filter.fmtDistance`: 10 m under a
kilometre, one decimal under ten, whole km beyond).

**Set from the place bar** between the panel header and the list: type an
address the way you would in Google Maps, pick a suggestion, done. The bar is
built once with the panel and never rebuilt, so a re-render can't eat what's
being typed; `syncPlaceBar()` reflects the stored place but never touches a
focused input. Suggestion buttons act on `pointerdown`, because the input's
blur closes the dropdown before any `click` could land. The popup carries a
paste-only box for the same setting.

**No third-party geocoder**: nothing may leave the browser except requests to
airbnb.com, so the address lookup is *Airbnb's own* place search, two hops
(verified live, `scripts/recon_autocomplete.py`):

1. `Filter.autocompleteUrl` → `/api/v2/autocompletes-personalized`, the
   endpoint behind Airbnb's search box (Google-backed, matches street
   addresses). Works anonymously with the public web key every airbnb.com page
   embeds; the captured satori/personalisation params are not required.
   `Filter.placesOf` keeps the `LOCATION` suggestions.
2. A suggestion carries a `place_id` but no coordinates, so picking one
   fetches `/s/homes?query=…&place_id=…` (tagged `archiver_probe=1` so our
   interceptor skips it) and `Filter.boundsCenterFromHtml` takes the centre of
   the page's `mapBoundsHint`, which is the geocoded point
   (`"precision":"street"`). One ~800 KB fetch per place *set*, never per
   keystroke.

**The "Your place" pin on the map.** Google's map gives us no marker API, but
every visible price marker is a `gmp-advanced-marker` carrying its own
lat/lng (`position` attr) and a screen rect, and the element itself is a
zero-size point sitting exactly at its coordinate (the visible pill is an
inner child; measured live, `scripts/repro_refpin.py`). Web Mercator is
linear in lng for x and in mercator-lat for y at a fixed zoom, so
`Filter.fitMapProjection` least-squares those anchors into the map's screen
transform and `Filter.projectPoint` places the reference point;
`syncRefPin()` lays a fixed-position pin there (pointer-events: none), hides
it when it projects outside the map, and re-fits on every decorate pass and
the 700ms backstop, so it rides pans and zooms like everything else. Markers
piled at 0,0 are unrendered and excluded from the fit.

**Businesses / POIs are out of reach**: the map labels shops because Google's
tiles do, but no reachable geocoder knows them: Airbnb's own search box
returns nothing for a shop the tiles label (verified live with a real
session), and so do Nominatim and Photon (OSM). Only Google's paid Places API
could, and that would leave the browser. The no-match message in the bar
says exactly this and points at the paste route, which handles businesses
fine via a copied Maps link.

`Filter.parsePlace` still short-circuits the whole flow for pasted
coordinates or Google Maps links: plain "lat, lng" (what Maps' right-click
"copy coordinates" gives), the `!3d<lat>!4d<lng>` pair of a place link
(preferred over `@`, which is only the camera), an `@lat,lng` camera URL, or a
`q=`/`ll=`/`destination=` param. `0,0` is rejected as a parse accident. A
listing with no coordinate on record shows no distance line at all: saying
nothing beats guessing. Covered by `scripts/test-distance.js` (pure, real
captured fixtures) and the distance + place-bar blocks in `test_decorator.py`
(live: typed address → real suggestions → real geocode → rendered rows).

### Re-render discipline

Three layers, all in service of never disturbing something you are using:

1. **Same listings, same order → patch, don't rebuild.** A price landing or a
   category swap must not reset carousels or steal focus from a note.
2. **Set changed → reconcile by key** (`syncList`, D48). Rows that keep their
   relative order are never even moved. This is load-bearing for the Chat tab:
   removing *or moving* an iframe ends its browsing context, so a naive rebuild
   reloaded every open conversation on every map pan.
3. **Suppressed entirely** mid-drag, and for note-only storage changes (which
   would steal the textarea's focus).

Per-listing UI state that must survive all of the above is kept outside the DOM:
`carouselAt[id]` (which photo) and `tabAt[id]` (Note or Chat).

Drag-to-reorder is pointer-driven, not HTML5 drag-and-drop - Airbnb's own
handlers swallow `dragstart`/`drop` - with live neighbour swapping and edge
autoscroll. `pointerup` is listened for on `window`, not the handle, because
re-inserting the row mid-drag can drop an element-scoped pointer capture.

---

## 4. Map decoration

- **Pin colouring**: markers only expose `position="lat,lng"`, so coordinates are
  matched from `tagCoords` (persisted by the interceptor), the snapshot's own
  coord, and the page's embedded deferred-state blob (for instant colouring on
  first paint). Painting targets the largest rounded, non-transparent element in
  the marker - full price pill *or* mini dot.
- **Archived pins hidden** on every render pass: Google Maps re-creates markers,
  so a one-shot hide gets wiped. Keyed by coordinate, never by title - Airbnb
  auto-names listings "<Type> in <Neighborhood>" ("Apartment in Villa Morra"), so
  the original title match hid *every* same-named pin and made any such popup
  vanish the moment you opened it.
- **Tagging from the map popup card**: the id comes from the card's `/rooms/<id>`
  link (reliable) rather than the pill's DOM (not). The popup card root is found
  by climbing until the box stops being card-sized (<460px).
- **Undo before write**: archiving from the map hides the card and marker
  immediately and only writes to storage when the 1.5 s toast expires
  un-cancelled.
- **Hover a panel row → its pin scales and outlines**, rebuilding the card↔pin
  link Airbnb lost when we replaced its cards.

---

## 5. Live price probing

A room page carries **no price at all** (verified, `scripts/recon_pdp.py`) but it
does carry a coordinate, and `/s/` server-renders prices. So:

```
saved /rooms/<id> link → room page (coordinate, host, house rules)
  → Airbnb search re-run, scoped to a ±0.0015° box around it (renders a price)
  → normalise → store
```

- **Normalisation** (`Filter.priceOf`) reduces all three shapes Airbnb quotes -
  a stay total ("$564 for 14 nights"), a nightly rate, and a monthly-search
  `DiscountedDisplayPriceLine` (no `price` field at all, `displayPriceStyle:
  MONTHLY`) - to one comparable **per-30-nights** figure, keeping `nightly`,
  `total`, `nights`, `original`, `basis`, and the currency symbol.
- **Money parsing** handles international separators (`$1,234.56`, `₲1.234.567`),
  with the last separator winning as the decimal point when ambiguous.
- **Only price-setting params** are carried into the probe (dates, occupancy,
  monthly mode, currency) - copying the user's *filters* would make a merely
  filtered-out listing look unavailable.
- **Neighbours are free**: one probe returns ~20 listings in its box, and every
  tracked one gets refreshed and marked as attempted.
- **Context stamping**: each price carries `{ctx, probedAt}`, where `ctx` is a
  signature of the price-setting params - so a cached price survives pans and
  zooms but is invalidated by a date/guest change.
- **Unavailable ≠ failure**: if Airbnb doesn't return the listing for these
  dates, that is "not bookable", so the row says so and keeps the last known
  figure in `lastMonthly`.
- **Free seeding**: listings already priced by the page you're on are read
  straight out of its deferred-state blob, with no fetch at all.
- **Guards**: 2 probes in flight, 8 per render, one attempt per listing per
  price-context per page load, 400 ms gap, 15-minute TTL.

---

## 6. Host, notes and the conversation bridge

### Host facts

One room-page fetch answers everything, and is deduped per listing
(`fetchListingPage`), throttled to 4 lookups per render - the page is ~600 KB.

- **Host name** (`Filter.hostFromHtml`): `PassportCardData`, with
  `Hosted by <name>` as a backstop. Search results never populate it (the field
  is present but null). Cached in `hosts` with the host id and the real listing
  name.
- **Pets** (`Filter.petsFromHtml`) rides along on the same fetch. Search results
  carry no amenity data at all, but the room page states the house rule as
  `{"title":"Pets allowed","icon":"SYSTEM_PETS"}` /
  `{"title":"No pets","icon":"SYSTEM_NO_PETS"}`. The **icon** is what's read -
  titles are localised, icons aren't - and `NO_PETS` wins over `PETS` so a page
  carrying both never reads as pet-friendly. **Collected but not displayed**: the
  row badge was dropped at the user's request (0.1.21); the data keeps accruing
  so a pets filter can be turned on later without a re-crawl.
- A page that *didn't* say must never overwrite what an earlier read *did* say,
  so the two facts are merged into one record rather than replacing it.

### Notes

A note is stored under `notes[id]`, independent of category and of order, so it
survives star ↔ maybe ↔ archive and re-tagging. Writes are debounced 400 ms.
The same note is editable from two places - the panel row and the bridge bar -
so both must avoid yanking text out from under active typing: the bridge bar only
re-reads the stored value when the listing changed or the field isn't focused,
and a note-only storage change never triggers a panel rebuild.

In the bridge bar the note is a one-line slot that **grows while focused** to
show every line typed, overlaying the conversation underneath rather than
clipping. Which way it grows decides the limit: the top-band bar is pinned by its
top so the box extends *down* (limit: bottom of the window), while the floating
bar is anchored to `bottom` so it extends *up* (limit: what's above it).
Measuring downward in the floating case left only the ~70px under the bar, which
looked exactly like "it stops expanding after two lines". `growNoteIfClipped()`
re-grows a focused note on the next decorate pass as a self-heal for any event
we failed to hook (paste variants, IME), and writes nothing when it already
fits - so it can't churn the MutationObserver that calls it.

### The embedded conversation

Verified with `scripts/recon_chat_iframe.py`: Airbnb serves `/guest/messages`
with `x-frame-options: SAMEORIGIN` and the panel **is** that origin, so the
thread is simply framed. At panel width Airbnb's own responsive layout collapses
its inbox sidebar and page header to zero and gives the column to the
conversation - nothing has to be cropped, and the frame carries a working
composer.

- **Lazy**: a frame is built only when its tab is first opened - booting Airbnb's
  message app once per row for a panel of forty would be ruinous. Once built it
  is never rebuilt; the hidden pane is hidden, never removed.
- Re-running `fillChat()` is free unless the pane's state genuinely changed,
  which is what upgrades "no conversation yet" into the real thread the moment
  one is learned.

### Thread learning and the bridge bar

`/contact_host/<id>/send_message` opens a **blank compose form**, not the
existing conversation (verified, `scripts/recon_contact.py`) - so the thread id
is the only way to link into a chat that already exists. Visiting a thread page
is the one moment that mapping is observable, so it's recorded in `threads`.

On a thread page the listing isn't in the URL. It's resolved as the **most
frequently linked** `/rooms/<id>` on the page, because the inbox sidebar links
every other conversation's listing too; the open thread's listing is the one that
recurs (header, card, CTA).

**Placement** on a thread page: **fixed in the blank strip above the
conversation** - Airbnb's own header band, empty across the middle (measured
81–97px tall at every width from 900–1500px,
`scripts/recon_thread_topband.py`). Being fixed, it takes *no* space from the
chat. `threadDock()` finds the conversation column by `data-testid` + computed
flex direction (never hashed class names) and `topBandSlot()` measures the free
width between Airbnb's logo and its nav, re-measured on resize. If the band is
too short (<52px) or too narrow (<280px free) it falls back to docking in the
flow above the host name. Floating it at the bottom - the original design - put
it straight over Airbnb's compose box. On a room page it still floats
bottom-centre; there is nothing to cover.

The bar is never moved or re-measured while it contains the focused element:
re-parenting a focused field takes the caret with it. Styles are only written
when the value actually changed, because an attribute set to the same value still
fires the MutationObserver this runs from.

---

## 7. Storage model

All in `browser.storage.local`, keyed by the **permanent** Airbnb room id (stable
across refresh, search change, and sessions - so "archive once, filtered forever"
is free). Never cleared, never re-keyed; the add-on id is fixed so every update
is an in-place upgrade.

| Key | Shape | Purpose |
|---|---|---|
| `starred` / `maybe` / `archived` | `{id: {title, price, url, thumbnail, coord, ts}}` | the rubric + a snapshot that renders without a refetch |
| `starredData` | `{id: <full search objects>}` | cached GraphQL objects (re-injection, currently unused) |
| `tagCoords` | `{id: {lat,lng}}` | pin colouring + viewport filtering |
| `images` | `{id: [url,…]}` | panel carousel |
| `prices` | `{id: {monthly, nightly, total, nights, symbol, original, basis, ctx, probedAt, unavailable, lastMonthly}}` | normalised price + freshness |
| `hosts` | `{id: {name, hostId, listingName, pets}}` | host line, bridge bar, pets (stored, not displayed) |
| `threads` | `{listingId: threadId}` | deep-link into an existing conversation |
| `notes` | `{id: text}` | per-listing note (category-independent) |
| `order` | `[id,…]` | panel drag order (category-independent) |
| `settings` | `{showArchived, showAllPlaces, rewriteDocuments, refPlace}` | toggles + the distance reference point |

Declared data collection: **none**. Permissions: `storage`, `webRequest`,
`webRequestBlocking`, `*://*.airbnb.com/*`. No backend, nothing leaves the
browser except requests to airbnb.com itself.

Both popup toggles read their state from `settings` on open and write through
`Store.setSetting`, so the background page picks the change up immediately via
`storage.onChanged` - no rebuild, no reload. The interceptor guards its own
re-entry (`refreshing`), since its persist writes re-fire `onChanged`.

---

## 8. Packaging & install

- `npm run sign` - AMO-signs on the **unlisted** channel (private
  self-distribution; not publicly listed or searchable). `sign:listed` exists but
  must never be used without an explicit request.
- `npm run bump` - version bump (AMO refuses to re-sign an existing version).
- **`npm run install:local -- --restart`** ([install_local.js](scripts/install_local.js))
  - drops the signed `.xpi` into `<profile>/extensions/<addon-id>.xpi` (the same
  "app-profile" location a manual Install-From-File uses), so no `about:addons`
  clicking. Guards that the artifact is AMO-signed and version-matched, and works
  around the running Firefox holding the file open (move-old-aside → move-new-in
  → unlink-old).
- **Restart without losing tabs or windows**: posts `WM_CLOSE` to *every*
  top-level Firefox window (never `/F`, nothing force-killed), waits for the
  session file to list every on-screen window before closing anything, arms
  `browser.sessionstore.resume_session_once`, then repairs
  `sessionstore.jsonlz4` - promoting windows Firefox filed under `_closedWindows`
  back into `state.windows`, since restore only replays the latter. Includes a
  dependency-free mozLz4 reader/writer ([lib/mozlz4.js](scripts/lib/mozlz4.js)).
- The `/update-extension` skill runs bump → lint → self-test → sign → install →
  **commit + push**. A ship ends in the remote, not at the signature:
  `extension/.amo-upload-uuid` is tracked and changes on every sign, so the repo
  and the add-on actually running would otherwise drift apart.
- **Subagents ship themselves**: a `SubagentStop` hook
  ([scripts/subagent_autoship_hook.js](scripts/subagent_autoship_hook.js), wired
  in `.claude/settings.json`) fires when a subagent finishes and anything under
  `extension/` is newer than the newest signed `.xpi`, and sends it back to run
  `/update-extension`. Deliberately *not* a `Stop` hook - the main loop is not
  asked to ship every turn. `.claude/skip-autoship` disables it.

---

## 9. Self-verification harness

Claude closes its own loop; see [docs/closing-the-loop.md](docs/closing-the-loop.md).

| Test | What it covers |
|---|---|
| `python scripts/test_decorator.py` | main regression - real Firefox on live Airbnb, `content.js` injected with a stubbed store; asserts panel, colouring, map tagging as **text** (screenshots are too token-expensive) |
| `python scripts/test_panel_geometry.py` | panel sizing vs. Airbnb's card column and top chrome |
| `python scripts/test_bridge.py` | room ↔ thread bridge bar |
| `python scripts/test_chat_tab.py` | the Note / Chat tabs on a row: switching, lazy loading, the empty state, and that an open conversation survives a re-render (stubbed, no login) |
| `python scripts/test_chat_live.py` | the Chat tab against a **real logged-in** conversation: the thread renders, scrolls, and has a working composer (profile copy) |
| `python scripts/test_thread_bar.py` | the bar in the blank band above a **real logged-in** thread: taking no space from the chat, covering neither composer nor nav, note growing while focused (profile copy) |
| `python scripts/test_restart.py` | 3-window Firefox restart loses nothing |
| `node scripts/test-filter.js` | archived ids removed from all three arrays |
| `node scripts/test-reinject.js` | starred re-injection + bounds logic |
| `node scripts/test-html-rewrite.js` | HTML blob rewriting / shape guard |
| `node scripts/test-should-filter.js` | which requests get filtered; documents opt-in, XHRs always |
| `python scripts/test_cached_load.py` | cold vs. cached vs. renavigated document loads |
| `python scripts/test_startup_load.py` | tabs whose requests race the add-on's startup |
| `python scripts/repro_broken_page.py` | drives a **copy** of the real profile, so the installed add-on's background script actually runs |
| `node scripts/test-price.js` | price normalisation across all quote shapes |
| `node scripts/test-distance.js` | reference-place parsing, haversine distance, formatting |
| `node scripts/test-pets.js` | reading the pets house rule off a room page |
| `node scripts/test-session-repair.js` | session repair branches, browser-free |
| `scripts/drive.py`, `recon_*.py`, `repro_*.py` | ad-hoc live DOM/JSON recon and one-off reproductions |

Known harness limit: Selenium's `install_addon` does **not** run the extension's
content/background scripts, so `content.js` is exercised by *injecting* it with a
stubbed store, and the rewrite logic is covered by the Node tests. The live
interceptor is reachable only by launching Firefox on a **copy of the real
profile** - where the add-on is already installed and enabled, so Firefox starts
it normally, background script and all. That is what `repro_broken_page.py`,
`test_cached_load.py`, and `test_startup_load.py` do. The same copy-the-profile
trick (`scripts/lib_profile.py`) is what lets the logged-in tests -
`test_chat_live.py`, `test_thread_bar.py` - reach `/guest/messages`. The original
profile is only ever read.

Headless Airbnb sometimes renders the map full-width or at odd offsets, so panel
*position/geometry* assertions are unreliable - assert behaviour and DOM
presence, not exact pixels.

---

## 10. Known technical limits

- **Firefox only** - `filterResponseData` is the whole mechanism and Chrome
  removed the equivalent.
- **No defensive coding against Airbnb schema changes** (D6): when
  `demandStayListing` and friends move, a couple of strings get updated.
- **Map re-injection is off** (see §2) - a starred listing Airbnb drops from a
  response won't get a pin back, though it stays in the panel.
- **Whole-page rewriting is opt-in, not missing** - see §2.
- **First install on a fresh profile** still needs one manual enable (Firefox 74+
  sideload policy); subsequent upgrades are silent.
