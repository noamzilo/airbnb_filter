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
| D29 | **Colour map pills by category:** starred → blue bubble, maybe → yellow, archived → hidden (unchanged), unsorted → default. Markers expose only `position`, so the interceptor persists `tagCoords` (id→lat/lng for starred+maybe) and the decorator matches a marker's position to colour the price bubble (the class-less `div` with border-radius ≥14, white bg). Re-applied each render. | User wants at-a-glance map status per rubric category. |
| D28 | **Always-show starred listings (built)** even when Airbnb drops them on map move: interceptor caches each starred listing's full result objects (`seen` session cache + persisted `starredData`, refreshed whenever seen) and **re-injects** them into the searchResults/mapSearchResults/staysInViewport arrays when missing but within the returned-results bounding box (+20% pad). Applies to both the HTML blob and XHR. Node-tested (`scripts/test-reinject.js`). | User: Airbnb prefilters the map and hides some listings; starred ones (map + list) should always appear. Caveats (accepted): stale info until re-seen; may show currently-unavailable listings; only works for listings cached at least once. |

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
