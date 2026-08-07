# FEATURES — Airbnb Archiver

What the extension actually does, as built. Version `0.1.15`, Firefox-only
(MV2, `browser_specific_settings.gecko.id = airbnb-archiver@noam.local`), scoped
to `*://*.airbnb.com/*`. For *why* each of these exists see the decision table in
[PROJECT_LOG.md](PROJECT_LOG.md) (D1–D39); this file is the *what*.

---

## 1. The core idea

Airbnb's own results column and heart/wishlist are replaced by a private,
locally-stored workflow:

| Surface | Role |
|---|---|
| **The map** | discovery — you tag new places from pin popup cards |
| **The panel** (ours, covers Airbnb's card column) | your curated, reorderable, commentable list |
| **The interceptor** (background) | deletes archived listings from Airbnb's data *before the page renders it* |
| **The toolbar popup** | bulk review / un-tag, and settings |

Archived listings are removed at the **data** level, not hidden with CSS — so
they don't reappear on pan, zoom, or re-render.

---

## 2. Rubric: three mutually-exclusive categories

Every listing is in **at most one** bucket (see [store.js](extension/store.js),
`Store.setCategory` clears the other two):

- **★ starred** ("liked") — blue map pin, blue panel row.
- **? maybe** — yellow map pin, yellow panel row.
- **🗑 archived** — removed from search results and hidden on the map.

Setting one clears the others. Clicking the active one clears the tag entirely.
Available from three places: the **map popup card**, each **panel row**, and the
**toolbar popup** (remove/unarchive only).

**Archiving from the map** vanishes the popup card and its marker immediately,
then shows a bottom **undo toast** with a 1.5 s progress bar; the write to
storage only happens if you don't undo.

---

## 3. Data filtering (the interceptor)

[background.js](extension/background.js) + [filter.js](extension/filter.js), via
Firefox's `webRequest.filterResponseData` (a Chrome-impossible capability).

Watched: `*://*.airbnb.com/s/*` and `*://*.airbnb.com/api/v3/StaysSearch*`.

- **Removes archived listings** from all three listing arrays Airbnb returns —
  `searchResults`, `mapSearchResults`, `staysInViewport` — found by recursive
  walk, keyed by the permanent room id (base64 `DemandStayListing:<id>`, or a
  plain `listingId`).
- **Forces starred pins to `FULL_PIN`**, so Airbnb can't shrink a starred
  listing to an anonymous mini dot.
- **Harvests as it goes**: every response it parses feeds a session `seen` cache
  and persists photos, normalised prices, and coordinates for anything tagged —
  so a listing starred *right now* gets its carousel and price without waiting
  for the next search.
- **Never breaks the page**: a JSON parse failure passes the original bytes
  through; a rewritten HTML document is shipped only if `Filter.sameHtmlShape()`
  confirms the same script-tag skeleton and tail (a malformed document fails
  silently, painting raw JSON as class-name soup — hence the guard).
- **Skips its own price probes** (`archiver_probe=1` in the URL).
- **`showArchived` on** → the removal pass is skipped, so archived listings come
  back (greyed, with an Unarchive button).

**XHR vs. whole pages.** JSON XHRs are always rewritten. Rewriting the **search
HTML document** buffers ~1.6 MB and is opt-in behind the `rewriteDocuments`
setting (`Filter.shouldFilter`) — off by default, because the panel covers the
results column anyway and the content script hides archived pins itself.

> ⚠️ In the current working tree the `rewriteDocuments` checkbox exists in
> [popup.html](extension/popup.html) but is **not yet wired up** in
> [popup.js](extension/popup.js) — the setting is read by the background page,
> but nothing in the UI writes it.

**Disabled on purpose:** `Filter.injectStarredMap()` (re-injecting cached
starred listings Airbnb dropped) is implemented and Node-tested but *not called* —
splicing cached GraphQL objects into a live response blanked Airbnb's client.
The panel renders starred/maybe from snapshots instead.

---

## 4. The panel (replaces Airbnb's results column)

[content.js](extension/content.js) + [content.css](extension/content.css).

A fixed, opaque panel that **covers** Airbnb's card column (their cards are never
removed from the DOM — walking up to a card container risks hitting an ancestor
that contains the map and blanking the page).

### Geometry
- Left edge of the map = the panel's width; runs to the bottom of the window.
- Top follows **Airbnb's own card column** (`[itemprop="itemListElement"]`, only
  those left of the map), clamped below the live top chrome — including the
  expanded search bar, which is `position:absolute` and overhangs the header.
- Re-placed on resize, on scroll, and on a 700 ms backstop timer (geometry can
  change with no DOM mutation to observe).

### Rows
Each row is photo-left / data-right:

- **Square photo carousel** over all of Airbnb's `contextualPictures` (‹ › nav,
  `n/N` counter, next-image prefetch). Carousel position survives re-renders.
- **30-night price as the headline** (it's also the link to `/rooms/<id>`),
  with per-night underneath and a sub-line for context
  (`Airbnb monthly rate · $564 for 14 nights · was $6,675`).
  Faded while stale, small and grey when `Unavailable`.
- **★ / ? / 🗑 buttons** to re-rubric in place.
- **Host line**: "Hosted by <name>", a **🏠 Property** link, and a
  **💬 Chat / 💬 Message** link (see §7).
- **A free-text note** (`<textarea>`, debounced save). Notes and order are stored
  independently of category, so they survive star ↔ maybe ↔ archive.
- **Drag handle** — pointer-event reordering (Airbnb swallows HTML5
  `dragstart`/`drop`), with live neighbour swapping and edge autoscroll.

### Viewport scoping
Only listings whose coordinate falls inside the map's **current** bounds are
listed — so Asunción listings don't show while you're looking at Jerusalem.
Bounds come from Airbnb's own `ne_lat/ne_lng/sw_lat/sw_lng` URL params (rewritten
on every pan/zoom), falling back to the bounding box of rendered pins +15% pad.

- Header reads **"N of M on this map"**; a **Show all** pill bypasses the filter.
- Listings with **no coordinate on record are always shown**, under a
  "N without a saved location" divider — silently hiding one would look like
  data loss.
- Off-screen ones are counted in a "N more elsewhere on the map" divider.
- **Reordering merges back into the full order**: a drop splices the visible
  sequence into the slots those rows occupied, leaving off-screen listings where
  they were.

### Re-render discipline
If the same listings are shown in the same order, the DOM is **patched, not
rebuilt** — a price landing or a category swap must not reset carousels or steal
focus from a note you're typing. Renders are also suppressed mid-drag.

---

## 5. Map decoration

- **Pin colouring**: starred → blue, maybe → yellow. Markers only expose
  `position="lat,lng"`, so coordinates are matched from `tagCoords` (persisted by
  the interceptor), the snapshot's own coord, and the page's embedded
  deferred-state blob (for instant colouring on first paint). Painting targets
  the largest rounded, non-transparent element in the marker — full price pill
  *or* mini dot.
- **Archived pins hidden** on every render pass (Google Maps re-creates markers,
  so a one-shot hide gets wiped).
- **Tag from the map popup card**: clicking a pill opens Airbnb's native popup;
  we add ☆ / ? / 🗑 buttons below its close "X". The id comes from the card's
  `/rooms/<id>` link (reliable) rather than the pill's DOM (not).
- **Archived cards** render greyed with an **↩ Unarchive** button when
  `showArchived` is on.
- **Hover a panel row → its map pin scales up and outlines** (rebuilding the
  card↔pin link Airbnb lost when we covered its cards).

---

## 6. Live price probing

The headline feature of the panel: a saved listing's price is **re-read from
Airbnb whenever it's rendered**, not frozen at tag time.

The chain (each step verified live — see `scripts/recon_pdp.py`,
`recon_probe.py`, `recon_price.py`):

```
saved /rooms/<id> link → room page (has NO price, but has a coordinate)
  → Airbnb search re-run, scoped to a ±0.0015° box around it (does render a price)
  → normalise → store
```

- **Normalisation** (`Filter.priceOf`) reduces all three shapes Airbnb quotes —
  a stay total ("$564 for 14 nights"), a nightly rate, and a monthly-search
  `DiscountedDisplayPriceLine` (no `price` field at all, `displayPriceStyle:
  MONTHLY`) — to one comparable **per-30-nights** figure, keeping `nightly`,
  `total`, `nights`, `original`, `basis`, and the currency symbol.
- **Money parsing** handles international separators (`$1,234.56`, `₲1.234.567`).
- **Only price-setting params** are carried into the probe (dates, occupancy,
  monthly mode, currency) — copying the user's *filters* would make a merely
  filtered-out listing look unavailable.
- **Neighbours are free**: one probe returns ~20 listings in its box, and every
  tracked one gets refreshed.
- **Context stamping**: each price carries `{ctx, probedAt}`, where `ctx` is a
  signature of the price-setting params — so a cached price survives pans and
  zooms but is invalidated by a date/guest change.
- **"Unavailable"**: if Airbnb won't quote the listing for these dates, the row
  says so and keeps the last known figure ("last seen $4,883 / 30 nights").
- **Free seeding**: listings already priced by the page you're on are read
  straight out of its deferred-state blob, with no fetch at all.
- **Guards**: 2 probes in flight, 8 per render, one attempt per listing per
  price-context per page load, 400 ms gap, 15-minute TTL.

---

## 7. Host + conversation bridge

- **Host name** is fetched once per listing from the room page
  (`Filter.hostFromHtml` — `PassportCardData`, with `Hosted by <name>` as a
  backstop; search results never populate it). Cached in `hosts`, along with the
  real listing name and host id. Throttled to 4 lookups per render — the room
  page is ~600 KB.
- **A bridge bar** appears on two kinds of page:
  - **On `/rooms/<id>`** — names the place and its host, with a
    "💬 Chat with <name>" button into the conversation.
  - **On `/guest/messages/<threadId>`** — names the apartment the conversation is
    about (resolved by the *most frequently linked* `/rooms/<id>` on the page,
    because the inbox sidebar links every other conversation's listing too), with
    a "🏠 Open the apartment" button.
  - Both carry an **editable note** for that listing, writing to the same store
    the panel reads.
- **Thread learning**: visiting a thread page is the one moment the
  listing↔conversation mapping is observable, so it's recorded in `threads`.
  Once known, panel and bridge link **straight into the existing conversation**;
  before that they fall back to `/contact_host/<id>/send_message` (Airbnb's blank
  compose form) and the button is greyed and labelled "Message", not "Chat".

---

## 8. Toolbar popup

[popup.html](extension/popup.html) / [popup.js](extension/popup.js) — three
tabs with live counts:

- **★ Liked**, **? Maybe**, **🗑 Archived** — thumbnail, title, price, link to
  the listing, and a Remove/Unarchive button per row, newest first.
- **"Show archived on map (greyed)"** toggle.
- **"Rewrite search pages too (advanced)"** toggle *(present in markup, not yet
  wired — see §3)*.
- Version number in the header; re-renders live on any storage change.

---

## 9. Storage model

All in `browser.storage.local`, keyed by the **permanent** Airbnb room id (stable
across refresh, search change, and sessions — so "archive once, filtered forever"
is free). Never cleared, never re-keyed; the add-on id is fixed so every update
is an in-place upgrade.

| Key | Shape | Purpose |
|---|---|---|
| `starred` / `maybe` / `archived` | `{id: {title, price, url, thumbnail, coord, ts}}` | the rubric + a snapshot that renders without a refetch |
| `starredData` | `{id: <full search objects>}` | cached GraphQL objects (re-injection, currently unused) |
| `tagCoords` | `{id: {lat,lng}}` | pin colouring + viewport filtering |
| `images` | `{id: [url,…]}` | panel carousel |
| `prices` | `{id: {monthly, nightly, total, nights, symbol, original, basis, ctx, probedAt, unavailable, lastMonthly}}` | normalised price + freshness |
| `hosts` | `{id: {name, hostId, listingName}}` | host line, bridge bar |
| `threads` | `{listingId: threadId}` | deep-link into an existing conversation |
| `notes` | `{id: text}` | per-listing comment (category-independent) |
| `order` | `[id,…]` | panel drag order (category-independent) |
| `settings` | `{showArchived, showAllPlaces, rewriteDocuments}` | toggles |

Declared data collection: **none**. Permissions: `storage`, `webRequest`,
`webRequestBlocking`, `*://*.airbnb.com/*`. No backend, nothing leaves the
browser except requests to airbnb.com itself.

---

## 10. Packaging & install

- `npm run sign` — AMO-signs on the **unlisted** channel (private
  self-distribution; not publicly listed or searchable). `sign:listed` exists but
  must never be used without an explicit request.
- `npm run bump` — version bump (AMO refuses to re-sign an existing version).
- **`npm run install:local -- --restart`** ([install_local.js](scripts/install_local.js))
  — drops the signed `.xpi` into `<profile>/extensions/<addon-id>.xpi` (the same
  "app-profile" location a manual Install-From-File uses), so no `about:addons`
  clicking. Guards that the artifact is AMO-signed and version-matched, and works
  around the running Firefox holding the file open (move-old-aside → move-new-in
  → unlink-old).
- **Restart without losing tabs or windows**: posts `WM_CLOSE` to *every*
  top-level Firefox window (never `/F`, nothing force-killed), waits for the
  session file to list every on-screen window before closing anything, arms
  `browser.sessionstore.resume_session_once`, then repairs
  `sessionstore.jsonlz4` — promoting windows Firefox filed under `_closedWindows`
  back into `state.windows`, since restore only replays the latter. Includes a
  dependency-free mozLz4 reader/writer ([lib/mozlz4.js](scripts/lib/mozlz4.js)).
- The `/update-extension` skill runs bump → lint → self-test → sign → install.

---

## 11. Self-verification harness

Claude closes its own loop; see [docs/closing-the-loop.md](docs/closing-the-loop.md).

| Test | What it covers |
|---|---|
| `python scripts/test_decorator.py` | main regression — real Firefox on live Airbnb, `content.js` injected with a stubbed store; asserts panel, colouring, map tagging as **text** (screenshots are too token-expensive) |
| `python scripts/test_panel_geometry.py` | panel sizing vs. Airbnb's card column and top chrome |
| `python scripts/test_bridge.py` | room ↔ thread bridge bar |
| `python scripts/test_restart.py` | 3-window Firefox restart loses nothing |
| `node scripts/test-filter.js` | archived ids removed from all three arrays |
| `node scripts/test-reinject.js` | starred re-injection + bounds logic |
| `node scripts/test-html-rewrite.js` | HTML blob rewriting / shape guard |
| `node scripts/test-price.js` | price normalisation across all quote shapes |
| `node scripts/test-session-repair.js` | session repair branches, browser-free |
| `scripts/drive.py`, `recon_*.py` | ad-hoc live DOM/JSON recon |

Known harness limit: Selenium's `install_addon` does **not** run the extension's
content/background scripts here, so `content.js` is exercised by injection and
the interceptor is covered by the Node tests — the live interceptor cannot be
e2e'd via Selenium.

---

## 12. Known limits

- **Firefox only** — `filterResponseData` is the whole mechanism and Chrome
  removed the equivalent.
- **No defensive coding against Airbnb schema changes** (D6): when
  `demandStayListing` and friends move, a couple of strings get updated.
- **Headless geometry is unreliable** — Airbnb sometimes renders the map
  full-width, so panel position/pixel assertions aren't trustworthy in tests.
- **First install on a fresh profile** still needs one manual enable (Firefox 74+
  sideload policy); subsequent upgrades are silent.
- **Map re-injection is off** (see §3) — a starred listing Airbnb drops from a
  response won't get a pin back, though it stays in the panel.
