# CLAUDE.md — Airbnb Archiver

## Close the loop yourself — do NOT ask the user to paste screenshots
Verify changes by driving real Firefox with the Selenium harness and asserting
the DOM as **text** (screenshots are too token-expensive). Read
`docs/closing-the-loop.md` first. Tools:
- **`python scripts/test_decorator.py`** — main regression test: loads live
  Airbnb, injects `extension/content.js` with a stubbed store, asserts
  panel / colouring / map-tagging behavior. Run after any `content.js` change.
- **`node scripts/test-filter.js` / `test-reinject.js` / `test-html-rewrite.js`**
  — fast pure-logic tests for the interceptor (`filter.js`), no browser.
- **`scripts/drive.py` / `recon_map.py`** — ad-hoc live DOM recon (dump markup,
  click pins, print JSON) when you need to see real structure.

Gotchas:
- Selenium `install_addon` does NOT run the extension's content/background scripts
  here. Exercise `content.js` by *injecting* it with a stub (see
  `test_decorator.py`); cover the interceptor with the Node tests. You cannot
  e2e the live interceptor via Selenium.
- Headless sometimes renders Airbnb's map full-width or at odd offsets, so panel
  *position/geometry* assertions are unreliable — assert behavior/DOM presence,
  not exact pixels.
- Requirements: `pip install selenium` (geckodriver auto-fetched), Node ≥ 22.
- Also read `PROJECT_LOG.md` (decisions D1–D31) before starting.

## Publishing
- The extension is signed **unlisted** (private self-distribution) via
  `npm run sign` / the `/update-extension` skill. Unlisted uploads to AMO only to
  get signed; it is **NOT** publicly listed or searchable. This is the normal,
  fine way to produce an installable `.xpi`.
- **Never** publish to the public/listed channel (`npm run sign:listed` /
  `--channel=listed`) or otherwise make the add-on publicly searchable unless the
  user explicitly asks for public publishing.

## Data safety (see memory: preserve-user-data-on-update)
- Never change the add-on id (`airbnb-archiver@noam.local`) or call
  `storage.local.clear()`. The user's starred / maybe / archived / notes / order
  must survive every update (in-place upgrade, same id, stable keys).
