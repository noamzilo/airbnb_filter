# Closing the loop: self-testing the extension

## Why
Iterating on this extension by hand — *Claude edits, the user clicks around on
Airbnb and reports what happened* — is slow and error-prone. The map behaviour in
particular depends on Airbnb's live, client-rendered DOM (obfuscated classes,
Google Maps web-component markers) that can't be reasoned about from source.

So Claude drives a **real Firefox** with Selenium, exercises the actual flows on
the live Airbnb page, and verifies outcomes **as text/JSON — never screenshots**
(screenshots are far too token-expensive). This lets Claude find and fix DOM
issues without the user in the loop.

## The harness
- `scripts/drive.py` — launch Firefox, open the search, run a JS probe, print
  compact JSON. (`--headed`, `--click-pill N`, or a `.js` probe file.)
- `scripts/probe.js` — generic DOM diagnostic (counts, map rect, price pills).
- `scripts/recon_map.py` — open a map marker's popup card and dump its structure.
- `scripts/test_decorator.py` — **the regression test.** Drives the real archive
  / star flows and asserts DOM outcomes. Run it after any `content.js` change:
  ```
  python scripts/test_decorator.py
  ```
- `scripts/test-filter.js` — Node unit test for the pure interceptor logic
  (`node scripts/test-filter.js`; needs `state.json` from recon).

Requirements: `pip install selenium` (geckodriver is auto-fetched by Selenium
Manager) and Node ≥ 22 (we run 24).

## How the decorator gets tested without the real extension
Selenium's `install_addon(temporary=True)` installs the add-on but **does not run
its content scripts** in this setup (verified even on example.com). So
`test_decorator.py` instead:
1. loads the live Airbnb search page (no extension),
2. injects a tiny in-memory `Store` / `browser` **stub** plus the real
   `extension/content.js` via `execute_script`,
3. drives the flows (star a card, click a map pin, click our trash) and asserts
   the DOM result (toolbars present, card hidden, marker hidden, toast shown,
   item committed to the stubbed store, marker stays hidden after a re-render).

The decorator logic is identical to what runs in the shipped extension; only the
storage/back­ground are stubbed. The real extension is still run normally via
`npm run dev` (web-ext), and the interceptor/filter is covered by the Node test.

## Key DOM facts this uncovered (see PROJECT_LOG.md §2.5)
- **Map markers are `<gmp-advanced-marker>` web components.** Their text contains
  the listing's *title + price*; there is **no `/rooms` link / id** on them. We
  match a marker to a listing by **title**.
- **The popup card renders *inside* the selected marker.** So our injected trash
  button lives inside the marker subtree — the marker-click capture listener must
  ignore clicks on our own UI, and marker-text parsing strips our glyphs.
- **Google Maps re-creates marker elements on render**, so a one-time
  `display:none` doesn't stick. `decorateAll()` re-hides archived markers on every
  mutation (`hideArchivedMarkers`), giving immediate *and* persistent removal,
  while the background interceptor removes them from the data on the next fetch.
- The map popup card's `<a>` wraps only the image; **title/price are siblings**,
  and several card-sized elements sit over the map (a carousel).

## Limitations
- Bot-detection: automated Firefox usually loads the search fine, but Airbnb could
  change that. If a probe returns 0 room links, it prints a page-text snippet.
- The interceptor (background `filterResponseData`) isn't exercised end-to-end via
  Selenium (no content/background scripts there); it's covered by the Node filter
  test plus manual `web-ext` runs.
