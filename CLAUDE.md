# CLAUDE.md - Airbnb Archiver

## Close the loop yourself - do NOT ask the user to paste screenshots
Verify changes by driving real Firefox with the Selenium harness and asserting
the DOM as **text** (screenshots are too token-expensive). Read
`docs/closing-the-loop.md` first. Tools:
- **`python scripts/test_decorator.py`** - main regression test: loads live
  Airbnb, injects `extension/content.js` with a stubbed store, asserts
  panel / colouring / map-tagging behavior. Run after any `content.js` change.
- **`node scripts/test-filter.js` / `test-reinject.js` / `test-html-rewrite.js` /
  `test-price.js` / `test-pets.js` / `test-distance.js` /
  `test-session-repair.js` / `test-marker-id.js`** - fast pure-logic
  tests (no browser): archiving, re-injection, HTML blob rewriting, price
  normalisation, reading the pets house rule off a room page, the session
  repair that keeps every Firefox window across a restart, and the measurement
  behind D49 (real searches contain listings at coordinates too close to tell
  apart, so a map pin needs its price to be identified).
- **`python scripts/test_chat_tab.py`** - the Note / Chat tabs on each panel row:
  tab switching, lazy loading, the empty state, and that an open conversation is
  never re-created by a re-render (stub-based, no login).
- **`python scripts/test_chat_live.py`** - the same tab against a **real
  logged-in** conversation: the embedded thread really renders, scrolls, and has
  a composer. Uses a read-only profile copy. Run it if Airbnb ever changes its
  framing headers or its narrow-width layout.
- **`python scripts/test_thread_bar.py`** - the bridge bar on a **real logged-in**
  message thread: in the blank band above the host name, taking no space from the
  chat and covering neither the composer nor Airbnb's nav, with its note growing
  while focused. `/guest/messages` needs a login, so it (and `recon_thread_*.py`,
  `repro_note_growth.py`) drive a read-only **copy** of the real profile via
  `scripts/lib_profile.py`.
- **`python scripts/test_restart.py`** - drives real Firefox with three windows
  and fails if the auto-restart loses any. Run after touching the `--restart`
  path in `scripts/install_local.js` (see D38).
- **`scripts/drive.py` / `recon_map.py`** - ad-hoc live DOM recon (dump markup,
  click pins, print JSON) when you need to see real structure.

Gotchas:
- Selenium `install_addon` does NOT run the extension's content/background scripts
  here. Exercise `content.js` by *injecting* it with a stub (see
  `test_decorator.py`); cover the interceptor with the Node tests. You cannot
  e2e the live interceptor via Selenium.
- Headless sometimes renders Airbnb's map full-width or at odd offsets, so panel
  *position/geometry* assertions are unreliable - assert behavior/DOM presence,
  not exact pixels.
- Requirements: `pip install selenium` (geckodriver auto-fetched), Node ≥ 22.
- Also read `PROJECT_LOG.md` (decisions D1–D48) before starting.

## The three docs - keep them apart
- **`FEATURES.md`** is for the user: what the add-on does for them, in their
  words. No file names, no function names, no mechanism. Update it when the
  user-visible behaviour changes.
- **`DESIGN.md`** is the *how and why*: architecture, the interceptor, panel
  geometry, price probing, storage shape, packaging, the harness. Everything
  technical goes here, not in FEATURES.md.
- **`PROJECT_LOG.md`** is the chronological decision table (D1-D48).

## Writing style: no em dashes
Never write an em dash. Not in the docs, not in commit messages, not in code
comments, not in UI strings. Use a comma, a colon, parentheses, or two
sentences; a plain hyphen "-" is fine when a dash is genuinely wanted.
This is enforced, not remembered: a `PreToolUse` hook
(`scripts/no_em_dash_hook.js`, wired in `.claude/settings.json`) rejects any
Write or Edit whose new text contains one, and tells you to rewrite the
sentence. Editing an em dash that is already on disk still works, so old text
can be cleaned up. Create `.claude/allow-em-dash` to disable it.

## Publishing
- The extension is signed **unlisted** (private self-distribution) via
  `npm run sign` / the `/update-extension` skill. Unlisted uploads to AMO only to
  get signed; it is **NOT** publicly listed or searchable. This is the normal,
  fine way to produce an installable `.xpi`.
- After signing, install it with **`npm run install:local -- --restart`**: copies
  the signed `.xpi` into the real profile and restarts Firefox **without losing
  tabs** (graceful close + `browser.sessionstore.resume_session_once`). Never make
  the user click through `about:addons`, and never ask them to restart - see D37.
- **Then commit and push, without asking.** A ship ends in the remote, not at the
  signature - otherwise the repo and the add-on the user is running drift apart.
  `extension/.amo-upload-uuid` is tracked and changes on every sign, so it belongs
  in the commit; `amo.env` and `web-ext-artifacts/` are gitignored.
- Shipping is **automatic for subagents**: a `SubagentStop` hook
  (`.claude/settings.json` → `scripts/subagent_autoship_hook.js`) fires when a
  subagent finishes and something under `extension/` is newer than the newest
  signed `.xpi`, and sends it back to run `/update-extension` itself. It is
  deliberately not a `Stop` hook - the main loop is not asked to ship every turn.
  Don't ship half-finished work: if the change is incomplete or a test is red,
  say so and finish; the hook won't re-fire for you. Create
  `.claude/skip-autoship` to disable it entirely.
- **Never** publish to the public/listed channel (`npm run sign:listed` /
  `--channel=listed`) or otherwise make the add-on publicly searchable unless the
  user explicitly asks for public publishing.

## Data safety (see memory: preserve-user-data-on-update)
- Never change the add-on id (`airbnb-archiver@noam.local`) or call
  `storage.local.clear()`. The user's starred / maybe / archived / notes / order
  must survive every update (in-place upgrade, same id, stable keys).
