# AMO listed-channel submission: everything to paste into the Developer Hub

The first listed version is submitted with `npm run sign:listed`, then the listing
is completed at https://addons.mozilla.org/developers/ (Edit Product Page). This
file holds every field so it is a copy-paste job.

## Name (set by the manifest, shown here for reference)

    OneBNB: Airbnb Prices, Shortlist & Chat

## Summary (AMO limit: 250 chars; shown in search results, weighs heavily)

    Your whole Airbnb search on one screen: true nightly prices, hide the
    listings you've ruled out so they stop coming back, star and note the
    rest, and chat without leaving the results. Beta. Not affiliated with
    Airbnb, Inc.

(232 chars with newlines collapsed to spaces.)

## Description (the long field; AMO allows basic HTML)

Airbnb search makes you do the bookkeeping: prices that grow at checkout,
listings you already rejected coming back on every map pan, notes scattered in
your head, and a separate tab just to answer a host. OneBNB puts all of it on
one screen, inside the results page.

<b>True prices.</b> Every card shows what the stay actually costs per night,
fees included, so "sorted by price" finally means something.

<b>Hide, permanently.</b> Trash a listing and it is gone: out of the results,
off the map, and it stays gone on the next search. No more re-reading the same
bad options.

<b>Shortlist.</b> Star the contenders, mark the maybes, and keep a private note
on each one. Your shortlist lives in a panel next to the results and survives
across sessions.

<b>Chat in place.</b> Read and answer your conversation for a listing right in
its panel row, without leaving the search.

Everything is stored locally in your browser. No account, no server, no data
collection.

<i>Beta: under active development. Unofficial: this extension is not
affiliated with, endorsed by, or sponsored by Airbnb, Inc. "Airbnb" is a
trademark of Airbnb, Inc., used here only to describe compatibility.</i>

## Categories

- Primary: Shopping
- Secondary: Search Tools

## Tags / keywords (if the form offers them)

airbnb, price, total price, shortlist, hide listings, notes, travel, vacation rental

## Support email

salomonskinoam@gmail.com

## Homepage

https://github.com/noamzilo/airbnb_filter

## License

MIT (pick "MIT/X11 License" in the dropdown). NOTE: the repo has no LICENSE
file yet; add one before submitting so the listing and repo agree.

## Privacy policy (AMO requires one because the add-on touches web requests)

    OneBNB stores everything it knows (hidden listings, stars, maybes, notes,
    ordering) in your browser's local extension storage. Nothing is sent to
    the developer or to any third party. The extension has no server, no
    analytics, no accounts, and collects no personal data. It reads
    airbnb.com pages and Airbnb's own search responses solely to display
    prices and your saved state on your screen. Removing the extension
    deletes its data.

## Notes to Reviewer (IMPORTANT: this is what makes webRequestBlocking review go smoothly)

    This add-on uses webRequest/webRequestBlocking (filterResponseData) only
    on *.airbnb.com search API responses, to (1) read listing prices so the
    true per-night total can be shown, and (2) drop listings the user has
    explicitly archived so Airbnb's own UI does not re-render them. Nothing
    is injected into or read from any other site; no data leaves the browser.
    All code is unminified and human-readable in the package: the interceptor
    is extension/filter.js + extension/background.js, the UI is
    extension/content.js. The repository (with tests) is
    https://github.com/noamzilo/airbnb_filter.

## Screenshots (upload 2-4; 1280x800 or similar)

1. Search results with the panel open: true prices on cards, starred rows,
   a note being edited.
2. The map with archived listings gone / tagged.
3. A panel row with the chat tab open.

Captured PNGs live in web-ext-artifacts/screenshots/ (gitignored); regenerate
with the Selenium harness.

## Submission checklist (in order)

1. LICENSE file in repo (MIT) - matches the listing license.
2. `npm run lint:ext` clean; `python scripts/test_decorator.py` green.
3. `npm run bump`.
4. `set -a; . ./amo.env; set +a; npm run sign:listed` (explicit user go-ahead
   required; this is the public channel).
5. Developer Hub: fill listing from this file, upload icon
   (extension/icon-128.png) and screenshots, submit for review.
6. Expect a manual human review (webRequestBlocking + broad host permission);
   days to weeks. Respond to reviewer questions promptly.
7. After approval: the listed version becomes public at
   https://addons.mozilla.org/firefox/addon/<slug>/ and the user's sideloaded
   copy will auto-update from AMO from then on (same id, no update_url).
