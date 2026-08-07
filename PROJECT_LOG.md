# Airbnb Archiver — Project Log

A running document. Newest entries go at the **bottom** of each section so the
narrative reads top-to-bottom in time. Keep it honest: log what we *wanted*,
what we *searched/researched*, what was *found* (and where), what was
*discussed*, and what was *decided and why*.

Maintained by: Noam (backend/ML, Python — not a frontend/fullstack dev) + Claude.
Started: 2026-06-13.

---

## 1. Goal / What we want

**The problem.** As a frequent Airbnb user, the search map shows the same
apartments over and over. There is no way to permanently dismiss a bad listing —
it keeps reappearing on the map every time you search or move the map.

**The feature.** A **Firefox extension** that lets you **"archive"** an
apartment so you never see it again (on the cards *or* the map), unless you
**"unarchive"** it.

**Explicit constraints / preferences from Noam:**
- "I want it to just work. If it breaks, it breaks." → No heavy defensive coding
  for Airbnb schema changes. When it breaks, fix the one or two strings.
- Noam is backend/ML Python — frontend/extension internals are jargon to him.
  Explanations should stay plain; Claude owns the plumbing (permissions, etc.).
- The killer requirement: **archived listings must NOT reappear** when you pan/
  zoom the map. (An existing extension fails exactly here — see §4.)

**Example search used for research:**
`https://www.airbnb.com/s/Asuncion--Paraguay/homes?...&ne_lat=-25.2835...&sw_lat=-25.2916...&zoom=16.73&search_by_map=true`
(Asunción, Paraguay; check-in 2026-07-03, check-out 2026-07-17, 1 adult.)

---

## 2. Research & findings (with sources)

### 2.1 How Airbnb's search/map loads listings (web research)
- Airbnb's site renders search via an internal **GraphQL `StaysSearch`**
  operation. It rides on the normal session — no special API key/auth beyond
  what's already in the page.
- Panning/zooming the map sends the map's bounding box (`ne_lat/ne_lng/
  sw_lat/sw_lng` + `zoom`, the same params seen in the example URL) and triggers
  a fresh `StaysSearch`, re-rendering cards + map pins. → This is *why* rejected
  listings keep coming back: there is no per-listing dismiss state.
- Sources:
  - The Lab #5 — Scraping Airbnb using GraphQL: https://substack.thewebscraping.club/p/the-lab-5-scraping-airbnbcom-using
    (confirms the GraphQL/StaysSearch concept; full details paywalled — not relied on)

### 2.2 Firefox can intercept & rewrite response bodies (the key capability)
- Firefox supports **`webRequest.filterResponseData()`** — an extension can read
  and **modify an HTTP response body before the page sees it**.
- **Chrome's Manifest V3 removed this**; Firefox deliberately kept blocking
  `webRequest`. → Firefox is the *ideal* browser for this feature; the approach
  would be much harder on Chrome.
- Permissions needed (Claude's plumbing): `storage`, `webRequest`,
  `webRequestBlocking`, `webRequestFilterResponse` (required since FF 110),
  host permission for `*://*.airbnb.com/*`.
- Sources:
  - MDN — filterResponseData(): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData
  - MDN — webRequest (Firefox retains blocking webRequest): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest

### 2.3 LIVE recon of the real data (most important — done 2026-06-13)
Fetched the example search page with `curl` (853 KB HTML). Airbnb
server-renders the initial results into a `<script id="data-deferred-state-0">`
JSON blob. Parsed it with Python.

**Data location:** `niobeClientData[0][1].data.presentation.staysSearch`

That `staysSearch` object contains **three lists, all keyed by the same numeric
listing ID**:

| List | Controls | Where the ID is | Count in sample |
|---|---|---|---|
| `results.searchResults` | the side **cards** | `demandStayListing.id` | 18 |
| `mapResults.mapSearchResults` | **map cards** (shown when a pin is clicked) | `demandStayListing.id` | 20 |
| `mapResults.staysInViewport` | the **map pins** themselves | `listingId` (plain) | 20 |

- `demandStayListing.id` is **base64** of `DemandStayListing:<numericId>`
  (e.g. decodes to `DemandStayListing:1399367828125524378`).
- `staysInViewport[]` items look like:
  `{"__typename":"ExploreStayMapInfo","listingId":"1399367828125524378","pinState":"FULL_PIN"}`

**Verified relationships (Python set math on the sample):**
- cards ⊆ map  (every card is also on the map)
- map cards == viewport pins  (same exact set of 20 IDs)
- 20 unique IDs total; one ID appears across all three lists.

**Implication / why this nails the feature:** archiving is just —
> keep a set of archived IDs; before the page renders, drop any entry whose ID
> is in that set from those three lists.

One ID removes the card, the map card, and the map pin simultaneously. Deleting
the data *before* render means there is nothing for a pan/zoom to bring back.

### 2.4 The listing ID is permanent — persistence is free (verified 2026-06-13)
Question from Noam: must survive refresh / window close / changing the search
term — *is that doable because IDs are static?* **Yes.**
- Verified the archive ID **is the permanent listing/room ID**: the card's
  base64 `demandStayListing.id` decodes to `DemandStayListing:<num>`, and that
  `<num>` is exactly the `airbnb.com/rooms/<num>` URL id; the map pin's plain
  `listingId` is the same number. (Older listings have short ids like `51309774`;
  newer ones are long — both are still the permanent room id.)
- This ID is a property of **the apartment, not the search** → unchanged across
  refresh, window close, different search terms, dates, guests, price filters,
  panning, or coming back days later.
- Persistence store = **`browser.storage.local`**, which survives refresh, window
  close, and full browser restart.
- **Caveat (logged, not a concern):** if a host *deletes and re-creates* a
  listing, Airbnb issues a new id and it would reappear as "new." Rare, outside
  our control, accepted under D6 ("if it breaks it breaks").

### 2.5 Live-DOM recon via Selenium (done 2026-06-14)
To stop guessing at the map DOM (and to let Claude self-test instead of the user
hand-testing), we drive real Firefox with **Selenium** (geckodriver auto-fetched
by Selenium Manager). Findings against the live page:
- **Map markers are `<gmp-advanced-marker>` web components** (Google Advanced
  Markers), NOT `div/span/button`. Each marker's `textContent` contains the
  listing's **title + price**; it has a `position="lat,lng"` attr but **no
  `/rooms` link / listing id**. → To remove an archived listing's pin we match
  the marker by **title** (fallback: price), then hide it.
- The map **popup card** (shown on marker click) has the reliable `/rooms/<id>`
  link, but that link wraps only the image — **title/price are siblings**, so the
  snapshot reads `container.innerText` (line 0 = title, first currency line =
  price). There is also a `button[aria-label="Close"]` and several card-sized
  elements over the map (a carousel), so "close" is done by hiding the
  geometry-derived card root, not by "first /rooms link over map".
- **Selenium `install_addon(temporary=True)` does NOT run content scripts** in
  this setup (tested on example.com too). So the extension is exercised by
  **injecting `content.js` with a stubbed `Store`/`browser`** onto the live page
  (`scripts/test_decorator.py`) and asserting DOM outcomes — no screenshots
  (token-cheap). The real extension is still loaded normally via `web-ext`.

---

## 3. Discussion

- **"Why hybrid? What does the DOM approach (A) even give us?"** (Noam)
  Answer: the two pieces do *different jobs*, not two ways of hiding.
  - **Interceptor (the real feature):** deletes archived listings from the data
    on the way in → they never render, on first load and on every pan/zoom.
  - **Button (the only thing the DOM part is for):** a small "Archive" button on
    each card. It's the only way for you to *tell* the extension which apartment
    to archive. The interceptor can hide data but can't read your intent.
  So "hybrid" = (delete data) + (a button to choose what to delete). It is NOT
  "two competing hiding methods."

- **Why the existing extension is useless:** it lets Airbnb render everything,
  then hides pixels in the DOM. Every map move re-renders, so archived pins
  reappear (whack-a-mole). We avoid this by deleting at the data layer.

### 3.1 Button UX (discussed 2026-06-13)
Noam's spec: put the control **on each map listing pin**. Split it —
**left two-thirds = green = open**, **right third = red = trash** — with a
**small undo delay**. The **price must still show**.

Clarifying answers from Noam:
- **Visual style:** "I don't care — make all information clearly visible, use
  something standard." → exact styling is an implementation detail; constraint is
  *price + all info stay clearly legible*, clean/standard look.
- **What "open" (green) does:** **Airbnb's default popover** — i.e. the normal
  thing a pin click already does. **Important consequence:** we do NOT build an
  "open" action. The green/left area simply means *don't interfere with Airbnb's
  native click there*. We are only *adding* a trash zone on the right.
- **Scope:** **map pins AND side-panel cards** both get a trash control (the map
  pin gets the green/red split; the card gets a trash control too).

Process note: **plan first, then build.** Noam wants a written plan before any
implementation.

---

## 4. Decisions (and why)

| # | Decision | Why |
|---|---|---|
| D1 | Target **Firefox**, not Chrome | Only Firefox still allows rewriting response bodies (`filterResponseData`); it's the whole mechanism. |
| D2 | **Hide by deleting data, not DOM pixels** | The re-render/whack-a-mole bug that makes the existing extension useless is avoided entirely. |
| D3 | Keep a **set of archived listing IDs** as the source of truth | One ID controls cards + map cards + map pins (verified in §2.3). |
| D4 | Add a small **"Archive" button per card**; manage/"unarchive" via the extension popup | Need a way to capture intent and to reverse it. |
| D5 | Store archived IDs **locally in the browser** | Simple, private, no backend. |
| D6 | **No defensive coding** for Airbnb schema changes | Noam: "if it breaks it breaks." When `demandStayListing`/paths change, update a couple of strings. |
| D7 | Trash control on **both map pins and side cards** | Noam wants to archive from either place. |
| D8 | **Don't implement "open"**; green/left = leave Airbnb's native click alone (its default popover) | Noam chose "Airbnb's default popover" → no custom open needed; green is just a visual cue + click pass-through. |
| D9 | Map pin = **split pill**: left ~2/3 green (pass-through/open), right ~1/3 red (trash) | Matches Noam's spec. |
| D10 | **Price + all info stay clearly visible**; standard/clean visual; exact styling deferred | Noam: "don't care, just make it clearly visible, something standard." |
| D11 | Trash uses a **small undo delay** before the archive is committed | Noam's spec; lets you take back a misclick. Exact mechanism (toast vs inline, duration) is a plan detail. |
| D12 | Decorate pins/cards by **attaching our zones inside each element**, re-applied on re-render via observer | Pins/cards redraw on pan/zoom; this is re-*decorating* (fine), not re-*hiding* (the broken pattern). |
| D13 | Trash = **optimistic vanish + small "Archived — Undo" toast** | Noam's choice; the spot clears immediately, feels snappy. |
| D14 | Undo window **~3 seconds**; the ID is committed to storage only after it elapses | Noam's choice; quick, out of the way. Misclick is recoverable within the window. |
| D15 | Unarchive via **toolbar popup list AND an on-map "show archived" toggle** | Noam's choice; popup for bulk review, on-map toggle to unarchive in context (archived pins reappear greyed). |
| D16 | The **interceptor is toggle-aware**: default → delete archived from the data; when "show archived" is ON → keep them but **flag** them so the decorator greys them + shows unarchive | Required to make D15's on-map toggle work; you can't grey what was deleted. |
| D17 | Store a **small snapshot per archived listing** (id, title, thumbnail, price, room URL, archivedAt), not just the ID | The popup list must render archived listings even when they're not in the current search (so it can't refetch them). |
| D18 | Persist the archived set in **`browser.storage.local`**, keyed by the permanent room id | The room id is static across refresh/close/search-change (§2.4), and local storage survives restarts → "archive once, filtered forever" works for free. |
| D19 | **Supersedes D8/D9.** Do NOT decorate map price pills. Clicking a pill opens Airbnb's native popup card; you **trash from that popup card** (positioned below its close "X"). Side-list cards keep their trash. | Pin→listing-id can't be reliably read from the pill DOM (pins are client-rendered on a Google Map; id lives in React state). The popup card *has* a `/rooms/<id>` link, so id resolution is reliable there. User accepted opening pills natively + trashing from the popup. The map still gets cleaned because the interceptor removes archived ids from map data. |
| D20 | Add a **⭐ Star ("Liked") feature**: a star button left of the trash on each card; starred listings go to the user's own "Liked" list (separate from Airbnb's heart). Starring does not hide. | User wants their own favourites list because Airbnb's heart/wishlist is "inconsistent." |
| D21 | **Undo UX:** map trash → close the popup (Escape) and animate the matching **price pill** with a left→right progress bar + "Undo", then it disappears; **best-effort** (pill matched by visible price), falls back to a bottom **toast** with the same progress bar. Side-card trash uses the toast. Window = 3s. | Matches the user's desired "animate the price tag" feel; archiving itself is always reliable (interceptor), only the pill targeting is heuristic. |
| D22 | Popup has **two tabs: ★ Liked and 🗑 Archived** (Archived keeps the show-archived toggle). Added an **SVG toolbar icon** for discoverability. | User couldn't find where archived listings live; they're in the toolbar popup. |
| D23 | **Claude self-tests** by driving real Firefox with Selenium and asserting DOM outcomes as text (`scripts/test_decorator.py`), no screenshots. See `docs/closing-the-loop.md`. | User: "the fact that I have to be the one clicking … is a real issue. close the loop yourself." Screenshots are too token-expensive, so verification is text-only. |
| D24 | **Immediate + persistent map feedback.** On trash we hide the exact clicked marker now AND re-hide archived markers on every render (`hideArchivedMarkers` in `decorateAll`), because Google Maps re-creates markers (a one-shot hide gets wiped). The popup card renders *inside* the selected marker, so a reliable title/price comes from the clicked marker's own text (glyph-stripped), and the marker-click capture listener ignores our own UI. | User: pin "doesn't immediately disappear from view" though it's gone after a zoom (interceptor). Needed instant feedback, not just on refetch. |
| D25 | **Key markers by `position="lat,lng"`, NOT title.** Archived snapshots store the clicked marker's `coord`; immediate hide uses the exact clicked element, persistence matches by coord. | Airbnb auto-names listings "<Type> in <Neighborhood>" — titles are NOT unique, so title-matching hid unrelated pins and made freshly-opened popups vanish instantly. Coordinates are unique per listing. |
| D26 | **3-way rubric, mutually exclusive: ★ star / ? maybe / 🗑 trash.** Each card has all three; setting one clears the others (`Store.setCategory`). Only trash hides (with 1.5s undo); star/maybe are tags shown in popup tabs. Undo window shortened to 1.5s. | User wants a "maybe" bucket between liked and trashed. A listing has one rating at a time. |
| D27 | **Publish publicly on AMO as "Beta"** (name "Airbnb Archiver (Beta)", description flags testing) to get free Firefox auto-updates with no self-hosting. | User: "i do want it public searchable, just call it beta … no one will download." Listed AMO add-ons auto-update via Firefox; avoids hosting an update feed. |
| D31 | **Replace Airbnb's results column with our own panel.** A fixed, opaque panel (sized to the map's left edge) renders ALL starred+maybe from stored snapshots as one combined, **drag-reorderable** list with **per-listing inline comments** and blue/maybe-yellow row backgrounds. Tagging happens from the map; the panel is the curated list. New storage: `notes` (id→text), `order` (id[]), both category-independent. **Gray-pill fix:** coords now persisted promptly + read from the page's deferred-state for instant colouring, and we paint the largest rounded marker element (full pill *or* mini dot), so starred pins are reliably blue. Interceptor no longer injects into the list (panel owns it); still injects starred pins on the map + forces FULL_PIN. | User: "I never use Airbnb's cards — replace them with my own reorderable, commentable list; stars must always be blue." Supersedes D30 (side-card hiding) and D28's list-injection. |
| D32 | **Panel rows are photo-left / data-right, headlined by a 30-night price.** Each row is a flex pair: left half = square (1:1) working carousel over all of Airbnb's `contextualPictures`, right half = price + rubric buttons + note. The **title is gone** — auto-titles like "Listing 1690766845873031195" carried no information. In its place, `Filter.priceOf()` normalises whatever Airbnb quotes (a 14-night stay total, a nightly rate, with or without long-stay discounts) to **price per 30 nights**, with the raw `$x/night · $y for N nights` on a sub-line; the price is the link to `/rooms/<id>`. Reordering moved from HTML5 drag-and-drop to **pointer events** (Airbnb's handlers swallow `dragstart`/`drop`; this also gives live reordering + edge autoscroll). Hovering a row **highlights that listing's map pin** — Airbnb's own card→pin link died when the panel replaced its cards. New storage key: `prices`. | User: dragging didn't work, the carousel didn't work, rows should be photo-left/data-right like Airbnb's own crops, the title is irrelevant, hover no longer shows the pin, and the list wouldn't scroll. |
| D33 | **Three latent layout/data bugs found by the harness, all root-caused:** (a) the list wouldn't scroll because `positionPanel` set `display:block` **inline**, beating the stylesheet's `display:flex` — the list stopped being a flex item and grew past the clipped panel (also added `min-height:0`, the standard flex-child fix, and clamped the panel's bottom to the viewport since Airbnb's map container can be taller than the window); (b) the carousel only ever had one photo because the background harvested images **only for already-tagged ids on the next response** — `refresh()` now re-harvests from `seen` the moment something is tagged, and the interceptor no longer early-returns when nothing is tagged, so the very first star has photos; (c) `test_decorator.py` never injected **`content.css`**, so no geometry or scroll behaviour had ever been tested. | The harness is only as good as what it loads — (a) and (c) were invisible without it. |
| D34 | **The panel is scoped to the map's current viewport.** Only starred/maybe listings whose coordinate falls inside the map's live bounds are listed — Asunción listings no longer show while you're looking at Jerusalem, and zooming in drops what's now off-screen. Bounds come from Airbnb's own `ne_lat/ne_lng/sw_lat/sw_lng` URL params, which it rewrites on every pan and zoom (verified live in `scripts/recon_bounds.py`); a search URL without map params falls back to the bounding box of the rendered pins, padded 15%. The header reads "N of M on this map" and a **"Show all"** pill in the header bypasses the filter. Listings with **no coordinate on record are always shown**, under a "N without a saved location" divider — silently hiding a listing whose location we never learned would look like data loss. Coordinates are now also written at tag time (`Store.setMedia(..., coord)`), not only by the interceptor. | User: "I don't want Asuncion things to show up when I am in Jerusalem, and I don't want things out of the current zoomed part of the map to show." |
| D35 | **Reordering merges back into the full order.** Since the panel now shows a subset, persisting the dropped DOM order verbatim would wipe the ordering of every off-screen listing. `commitOrder()` splices the new visible sequence back into the slots those rows occupied, leaving hidden listings exactly where they were. | Caught by the harness the moment viewport filtering landed — a silent data-loss bug. |
| D36 | **Handle Airbnb's monthly-stay price shape.** A monthly search returns `primaryLine.__typename = "DiscountedDisplayPriceLine"` with **no `price` field at all** — just `discountedPrice` / `originalPrice`, `qualifier: "monthly"`, `displayPriceStyle: "MONTHLY"` (e.g. `"$4,883 monthly, originally $6,675"`). `priceOf()` read `pl.price` and looked for nights, found neither, and every row said "price not captured yet". Now: take `discountedPrice` (what you'd actually pay, not the struck-through original), treat a monthly quote as the 30-night figure directly (a calendar month is within ~1.5% of 30 nights), and keep `original` + `basis` so the sub-line can show "Airbnb monthly rate · was $6,675". Verified 38/38 on a live monthly Jerusalem search and 18/18 on the original nightly recon blob (`scripts/recon_price.py` reports coverage). | User: "getting price not captured yet but clearly there is a price." Airbnb quotes cards three different ways depending on the search; only two were handled. |
| D37 | **Installing the signed `.xpi` is automated (`npm run install:local`), no more `about:addons` clicking.** Firefox installs whatever sits at `<profile>/extensions/<addon-id>.xpi` ("app-profile" location — exactly where a manual Install-Add-on-From-File ends up), so `scripts/install_local.js` resolves the default profile from `profiles.ini`, checks the artifact is AMO-signed *and* matches `manifest.json`'s version, and drops it in. A running Firefox holds that file open, so it can't be overwritten (`rename`-onto fails `EPERM`) but it *can* be renamed aside (Firefox opens it `FILE_SHARE_DELETE`) — hence move-old-aside → move-new-in → unlink-old. New version activates at the next Firefox restart, so `--restart` **restarts Firefox without losing tabs**: graceful `taskkill` on the *parent* PID only (never `/F`, so Firefox writes its session), wait for exit, then arm `browser.sessionstore.resume_session_once` -- the one-shot pref Firefox itself sets when it restarts for an update -- and relaunch. That pref matters: this profile has no `browser.startup.page`, i.e. the default "show home page", so a naive kill+relaunch really would have dropped every tab. Verified end-to-end on a throwaway profile: 3 tabs in, the same 3 tabs out, add-on 0.1.6 -> 0.1.7 in the same cycle, pref consumed by Firefox. Two shutdown quirks found and handled: `taskkill` posts `WM_CLOSE` to windows, so a **headless** Firefox never exits (detected via `MainWindowHandle`, reported instead of hung), and Firefox runs a launcher stub plus the real browser process (both look like parents). Nothing is ever forced: no window, or no exit within 45s (a `beforeunload` dialog), means report and leave it alone. **Restarting only the extension is not possible from outside the browser** -- `about:debugging`'s Reload is temporary-add-ons only, and remote-debugging `installTemporaryAddon` needs a debugger-enabled launch and installs a temporary shadow copy that dies on restart. **Caveat, verified on a throwaway profile:** this upgrades an already-enabled add-on silently (0.1.6 → 0.1.7, still `active`, no prompt), but a *newly discovered* profile sideload lands `userDisabled: true` per Firefox 74+ sideload policy — so the very first install on a fresh profile is still one manual enable. | User: "the update-extension skill has an annoying manual step i have to install myself every time." Rejected the `update_url` + GitHub-Releases feed alternative -- the one path that updates the add-on live with **no** browser restart -- because it needs the `.xpi` + `updates.json` on public https hosting (`gh` isn't even installed here), a re-sign with `update_url` in the manifest, one manual install to switch over, and it still only lands on Firefox's check interval (default daily). Session-restore restart gets the same result locally and instantly. Revisit if restarts ever become annoying. |
| D38 | **Keeping every window across the auto-restart took three fixes, each found by losing a window.** (a) `taskkill /PID` posts `WM_CLOSE` to a process's *main* window only, so a multi-window Firefox lost one window and kept running with the update unapplied -- now `WM_CLOSE` goes to every top-level window. (b) Firefox persists the session on a timer (`browser.sessionstore.interval`, 15s; a fresh window took ~21s to appear), and a window it has not written **cannot** be restored by anything -- so the script now waits for the saved session to list as many windows as are on screen before closing anything. (c) Closing windows one at a time is not a quit: Firefox files a window that closes while others are open under `_closedWindows`, and restore only replays `state.windows` -- which is exactly how the user's 3 windows (19 tabs + 6 tabs + 1) came back as 1. After shutdown the script promotes the windows it closed back into `state.windows`, falling back to the pre-close snapshot (marked `session.state="stopped"`, or Firefox reads it as a crash). Needed a pure-JS mozLz4 reader/writer for `sessionstore.jsonlz4` (`scripts/lib/mozlz4.js`; writing uses an all-literals LZ4 block, which is valid and ~20 lines). Repair logic lives in `scripts/lib/session.js` so `scripts/test-session-repair.js` can cover every branch browser-free; `scripts/test_restart.py` drives real Firefox with 3 windows and fails if any goes missing. **Harness gotcha:** it must open real pages -- Firefox does not track closed windows whose tabs are all `about:` pages, so an `about:`-based harness passes while testing nothing. | User: "it restarts now but it closed all the firefox windows and tabs. i had 3 active windows, now i have 1." The lost windows were still in `_closedWindows`, i.e. recoverable via History > Recently Closed Windows -- which is what made the cause obvious. |
| D38 | **Prices are probed live from each saved listing's own link, on render.** Every saved listing keeps its `/rooms/<id>` link (always derivable from the permanent id, so nothing needs backfilling). **Finding: the room page carries NO price at all** — Airbnb loads PDP prices client-side (556 KB fetched, zero price fields, `scripts/recon_pdp.py`) — **but it does carry the listing's coordinate**. So the probe re-runs Airbnb's *own search* scoped to a ±0.0015° box around that coordinate, which does server-render a price (`scripts/recon_probe.py`; probe returned `$4,883 monthly` — byte-identical to the live search). The link is therefore still the root of the chain: link → coordinate → scoped search → price. Only price-setting params are carried into the probe (dates, occupancy, monthly mode, currency) — **copying the user's filters would make a merely filtered-out listing look "Unavailable"**. Each probe returns ~20 listings in its box, so neighbours get refreshed for free. Guards: 2 in flight, 8 per render, one attempt per listing per price-context per page load, 15-min TTL, and listings already priced by the current page are seeded without any fetch. A listing Airbnb won't quote renders **"Unavailable"** with its last known figure. New: `prices` entries are stamped `{ctx, probedAt}` where `ctx` is a signature of the price-setting params — so a cached price survives pans and zooms but not a date change. | User: "each listing saved should always have its link saved so prices can be probed live and updated when rendered." |
| D39 | **`--restart` must close EVERY Firefox window, not `taskkill /PID`.** Found the hard way on the user's own browser: `taskkill` without `/F` posts `WM_CLOSE` to a process's **main window only**, so on a multi-window Firefox it destroyed the window that happened to be main (the one with the Airbnb tab), left the browser running, then timed out at 45s reporting a "blocking dialog" that didn't exist — and never relaunched. Now the script enumerates all owner-less visible top-level windows for the target pids (EnumWindows via P/Invoke) and posts `WM_CLOSE` to each, which is exactly "click X on every window" — Firefox shuts down cleanly and session restore brings it all back. `scripts/test_restart.py` pins it on a **throwaway profile** (never the user's browser): 2 windows in → both close → the *original pid* is gone → reopened. Also fixed: `firefoxExe()`'s fallback paths were written as `"C:\Program Files\..."` in a JS string, where `\P`/`\M` silently lose the backslash and `\f` is a formfeed — they evaluated to `"C:Program FilesMozilla Firefox\firefox.exe"` and never matched. If it closes a window and still can't exit, it now tells the user Ctrl+Shift+N reopens it. | User: "you closed one of them with the airbnb tab and the others remained open but then it didn't start the closed one and i have no airbnb tab now." |
| D40 | **Hide Airbnb's pager along with the grid the panel replaces.** Since D31/0.1.17 the panel takes the card grid's place, but Airbnb's `1 2 3 4 5` pager is a *sibling* of the grid, so it survived — a panel showing one row sat above "5 pages", and clicking a page reloaded the same one-row panel (their pager walks THEIR 18-per-page results; ours is one scroll over every saved listing on this map, so there is nothing to page). `findPager()` matches it **structurally** — a `<nav>` in the results column (left of the map) holding ≥2 numbered links that point at search URLs — rather than by its English `aria-label="Search results pagination"`; hidden whenever the panel is mounted in flow, restored whenever it isn't (overlay fallback, or no map). Re-hidden every render like the grid, because Airbnb clears the inline style back. Covered in `test_decorator.py` (skips if the live page renders no pager). | User: "there are 5 pages in the list view for only a single list item … no pages, just a single scroll and only for relevant ones." |
| D41 | **"Pets allowed" comes off the room page, on the host fetch — not a second request, and not from search.** Airbnb's search JSON carries no amenity data whatsoever (checked every listing object on a live search page, `scripts/recon_pets.py`), so the filter chip you can tick in the UI has no per-listing counterpart to read. The **room page does** carry it, as a house rule: `{"title":"Pets allowed","icon":"SYSTEM_PETS"}` / `{"title":"No pets","icon":"SYSTEM_NO_PETS"}` (both shapes confirmed live on real listings of each kind, `scripts/recon_pets2.py`). We already fetch that page per listing for the host name (D38-era), so `Filter.petsFromHtml` rides along on it and the flag is cached in the same `hosts` record. **The icon is the signal, not the title** — titles are localised, icons aren't — and `NO_PETS` is tested first so a page carrying both never reads as pet-friendly. Unknown renders **nothing**: a guessed "no pets" is worse than no badge. | User asked to see pets on each row. Alternative considered and rejected: re-run the price probe with `amenities[]` set and infer allowed-ness from whether the listing comes back — that's an extra request per listing, and a listing missing for any other reason (dates, availability) would silently read as "no pets". |
| D42 | **The thread-page bridge bar is docked in the flow, not floated.** It was `position: fixed; bottom: 18px` and landed exactly on Airbnb's compose box — the user couldn't see the message being typed. Recon of the real logged-in thread page (`scripts/recon_thread_layout.py`, driven on a read-only copy of the real profile because /guest/messages redirects to /login) showed the column is `section[data-testid="orbital-panel-thread"]`, and inside it a **flex column** holds the host-name header above the message pane + composer. `threadDock()` walks up from the message list to that flex column and inserts the bar before the header, so the pane just shrinks and nothing is covered. Anchored on `data-testid`s and **computed flex direction**, never Airbnb's hashed class names; it skips our own bar when looking for the header, or every pass would re-insert it and churn the page forever. Falls back to the floating bar when the dock isn't found (room pages, layout change) — there it covers nothing. Verified as geometry on the real page: `scripts/test_thread_bar.py`. | User: "the current 'go to property' is hiding the chat window — put it instead in the white empty area above the name of the property owner." |
| D43 | **The thread bar goes in the blank band ABOVE the conversation, fixed — not docked in its flow.** D42 inserted it into the thread's flex column, which fixed the overlap but pushed the whole chat down; the user's point was that the space at the top is *already* blank, so nothing should be taken from the conversation at all. Measured on the real page at 900–1500px (`scripts/recon_thread_topband.py`): the strip between the top of the window and the host-name header is **81–97px tall at every width**, holding only Airbnb's logo (left) and nav (right), leaving 400–500px free across the middle. `topBandSlot()` measures that free run — clamping to whatever `header a/button/img/svg, nav a/button` actually occupies, so it survives Airbnb moving things — and the bar is positioned `fixed` inside it, one compact row (text · note · button). Because it never enters the flow, the header and composer stay at exactly the pixel they were at (asserted against a pre-injection baseline in `scripts/test_thread_bar.py`). Falls back to D42's in-flow dock when the band is under 52px tall or the free run under 280px. Styles are only written when the value actually changes: this runs from the MutationObserver, and an attribute set to the same value still fires it — writing unconditionally churns the page forever. | User: "not what i meant. i meant ABOVE the name, in the huge blank space at the top, without cutting into the space of the chat." |
| D44 | **Pets: keep reading it, stop showing it.** The 🐾/🚫 badge on each panel row (D41) is gone; `Filter.petsFromHtml` and the `pets` flag on the `hosts` record stay, so every room-page fetch keeps recording it. Reinstating a badge — or filtering the panel by it — is then a render-only change against data already collected, with no re-crawl. | User: "remove the pets indicator, it's not important anymore. the filters mechanism should stay, just dont show the pets badge in the view." |
| D45 | **The bridge note grows while focused, and the bar freezes while you type in it.** In the top-band bar (D43) the note is a 32px slot, which is right when idle and useless for a real note. On focus/input it is sized to `scrollHeight` **plus its borders** (scrollHeight is the content box, the style is the border box — without that the last line sits clipped behind a scrollbar), capped at the bottom of the window; on blur the inline height is cleared and CSS takes it back to one line. The extra height goes *downward* over the conversation, which is fine: the bar is `fixed` with a high z-index. Two things this forced: `mountBridge()` returns early when focus is inside the bar (it would otherwise re-measure a deliberately over-tall bar and move it, taking the caret with it), and the value is never written back into a focused textarea. Asserted live: 32→96px, `scrollHeight == clientHeight`, bar top unchanged at 42 throughout, back to 32px with the text intact on blur (`scripts/test_thread_bar.py`). | User: "when writing a note and going to more lines, i want the box to grow and cover the things below it if needed. when unfocusing from it, it should go back to normal. the box should always be fully shown with all text when focused." |
| D46 | **The note's growth limit has to follow the direction it grows.** D45 always measured room as `innerHeight - note.top - 16` — right for the top-band bar (pinned by its top, grows down), badly wrong for the floating bar, which is anchored to `bottom` and therefore grows UP: the limit it measured was the ~70px between the bar and the window edge it was already sitting on, so six lines were capped at 59px with `scrollHeight` 111 — text you are typing, invisible. `noteRoom()` now picks the limit from the anchor: down to the window bottom for `--top`, up from the note's bottom edge for the floating bar, full height in the flow. Reproduced and fixed on a live room page (`scripts/test_bridge.py`: 46→113px, `scrollHeight == clientHeight`, top edge rises while the bottom stays put). Added `growNoteIfClipped()` as a self-heal — on keyup and on every decorate pass, a focused note that doesn't fit is re-grown — so a missed event can never leave you typing into a box you can't read; it writes nothing when the text already fits, so it can't churn the observer that calls it. NOTE: the reported symptom was on the *top-band* bar, and five typing patterns (paced, burst, wrapped-no-newlines, refocus, append) against the shipped 0.1.22 could not reproduce clipping there — `scripts/repro_note_growth.py --real-ext`. Most likely that tab was still running the pre-0.1.22 content script. | User: "it's not expanding the text box when more lines are added.. in the image are 2 lines, in the box are more than 2." |
| D47 | **The panel row's note slot became two tabs: Note (default) and the host conversation, embedded live.** The 💬 button only ever took you *away* to the thread; the ask was chat access without leaving the map. Airbnb serves `/guest/messages` with `x-frame-options: SAMEORIGIN`, and the panel *is* that origin, so the thread can simply be framed — verified end to end on a real logged-in conversation (`scripts/recon_chat_iframe.py`, then `scripts/test_chat_live.py`): the frame renders the real messages, scrolls (318px of a 1530px thread), and carries a working composer, so you can reply from the panel. **No cropping was needed**: at panel width Airbnb's own responsive layout collapses its inbox sidebar and page header to zero width and gives the whole column to `orbital-panel-thread`. Rejected the alternative of fetching the thread and painting our own bubbles — it needs recon of an undocumented endpoint, and it would be read-only. Loading is **lazy** (a frame is built only when its tab is first opened — forty rows each booting Airbnb's message app would be ruinous) and thereafter **never rebuilt**: the hidden pane is hidden, not removed. Tabs are per row and independent, kept in `tabAt` like `carouselAt`. A listing you have never messaged has no thread to frame, so its Chat tab shows an empty state pointing at the compose form, which upgrades itself into the real conversation the moment visiting a thread teaches us the mapping. | User: "i want two modes for the area where the note is … direct access to chat right from the map/list view screen." |
| D48 | **`renderPanel` now reconciles the list by key instead of emptying it — forced by the embedded chat.** It used to do `list.textContent = ""` and re-create every row whenever the set of listings changed, i.e. on every map pan. That is fatal to D47: removing an iframe from the DOM ends its browsing context, and *moving* one does too, so an open conversation would reload from the top each time you nudged the map. `syncList()` matches wanted items against what is on screen by a `data-key` (`r:<id>` / `d:<text>` / `e:<text>`), moving only what actually changed position and removing only what left — so rows that keep their relative order are never touched. Panning a couple of listings out of view now leaves an open chat (and a carousel position, and a note caret) completely undisturbed. Reused rows are refreshed via the existing `updateRow`, so nothing renders stale. Pinned by `scripts/test_chat_tab.py`, which stamps a live frame and asserts it survives a price landing, a tab flip, a row being dropped, and a reorder. | Fell out of D47: the panel's rebuild-everything render was cheap when rows were inert DOM and is not once a row holds live state. |
| D30 | **Side list is a curated view: show ONLY starred + maybe cards** (hide unsorted "unseen" and archived). Empty in untouched areas. The **map stays the discovery surface** — you tag new places from pins/popup cards. To make the list reliable, the interceptor injects **maybe into the list** (searchResults only) as well as starred (map+list). | User: "I never use Airbnb's built-in cards. Replace the displayed cards with only the starred and maybe cards." |
| D29 | **Colour map pills by category:** starred → blue bubble, maybe → yellow, archived → hidden (unchanged), unsorted → default. Markers expose only `position`, so the interceptor persists `tagCoords` (id→lat/lng for starred+maybe) and the decorator matches a marker's position to colour the price bubble (the class-less `div` with border-radius ≥14, white bg). Re-applied each render. | User wants at-a-glance map status per rubric category. |
| D28 | **Always-show starred listings (built)** even when Airbnb drops them on map move: interceptor caches each starred listing's full result objects (`seen` session cache + persisted `starredData`, refreshed whenever seen) and **re-injects** them into the searchResults/mapSearchResults/staysInViewport arrays when missing but within the returned-results bounding box (+20% pad). Applies to both the HTML blob and XHR. Node-tested (`scripts/test-reinject.js`). Also **forces starred pins to `FULL_PIN`** (Airbnb shrinks arbitrary pins to `MINI_PIN` dots) so starred listings always render as full price pills. | User: Airbnb prefilters the map and hides some listings (and shrinks others to dots); starred ones (map + list) should always appear, full-size. Caveats (accepted): stale info until re-seen; may show currently-unavailable listings; only works for listings cached at least once. |

**Resolved (2026-06-13):** The **first paint is fully baked into the HTML
document** — the embedded `data-deferred-state-0` blob already contains all 18
cards + 20 map cards + 20 pins (verified by count). The GraphQL endpoint path is
NOT in the HTML (built in JS bundles), so pan/zoom/pagination go out as separate
**`StaysSearch` XHR** calls with the same `...presentation.staysSearch` shape.
→ The interceptor must rewrite **two kinds of response**:
1. the **initial HTML document** (edit the JSON inside the `data-deferred-state-0`
   `<script>` tag — parse, filter, splice back into the HTML string);
2. each subsequent **`StaysSearch` XHR** (clean JSON — filter directly).
Both are interceptable via Firefox `filterResponseData`.

**Open / to-confirm later (during implementation):**
- Exact live `StaysSearch` XHR URL + how to recognize it (confirm via Network tab).
- DOM selectors for the map pins + side cards (Airbnb uses obfuscated classes).

---

## 5. Status / next steps

- [x] Feasibility confirmed against **live** data (§2.3).
- [x] Initial-load vs XHR interception detail resolved (§4 "Resolved").
- [x] Button UX + undo + unarchive decisions settled (D7–D18).
- [x] Milestone 0 (hello-world + `web-ext` live-reload) built & committed.
- [x] **Interceptor + filter logic** built; filter proven against real data
      (`scripts/test-filter.js`: archive 2 ids → removed from all 3 arrays).
- [x] **Store, popup (list + unarchive + show-archived toggle)** built.
- [x] **Decorator**: side-card trash (id from `/rooms/<id>` link), undo toast,
      defensive hide, greying — built.
- [x] **Map trashing reworked per D19**: pills open natively; trash from the
      map popup card (reliable id via its `/rooms/<id>` link), placed below the
      card's close "X". Pin-pill decoration removed.
- [ ] Pick the permanent-install path (AMO sign vs Developer Edition).

---

## Appendix — research scratch files
- `search.html` — raw 853 KB page fetched for recon (gitignored if large).
- `state.json` — extracted `data-deferred-state-0` JSON blob used for analysis.
