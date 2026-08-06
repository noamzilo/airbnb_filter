---
name: update-extension
description: Build, AMO-sign, and package a new version of the Airbnb Archiver Firefox extension so it can be installed permanently in normal Firefox. Use when the user wants to ship/update the installed extension (e.g. "update the extension", "rebuild and sign", "/update-extension").
---

# Update (build + sign) the Airbnb Archiver extension

Goal: produce a fresh Mozilla-signed `.xpi` the user can install in normal
Firefox, and tell them where it is. The signed add-on is **unlisted**
(self-distributed); installing the new `.xpi` upgrades in place and preserves the
user's archived/liked data (same add-on id `airbnb-archiver@noam.local`).

Run all commands from the project root (`c:\Users\noams\src\airbnb_filter`).

## Steps

0. **Channel guard (see CLAUDE.md).** Sign **unlisted** only (`npm run sign`) —
   that's private/self-distribution and fine. NEVER use the public/listed channel
   (`sign:listed` / `--channel=listed`) unless the user explicitly asks to publish
   publicly.

1. **Preflight.** Confirm `amo.env` exists (it's gitignored and holds
   `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`). If it's missing, stop and ask the
   user to create it (see `docs/closing-the-loop.md` / the AMO key steps) — signing
   can't proceed without it. Never print the secret.

2. **Lint.** `npm run lint:ext` — must be 0 errors before signing.

3. **Self-test (recommended).** If `content.js` changed this session, run
   `python scripts/test_decorator.py` and confirm all checks pass. It drives real
   Firefox and asserts DOM behavior (no screenshots). If it fails, fix before
   shipping. Skip only for non-behavioral changes (docs, manifest metadata).

4. **Bump the version.** `npm run bump` (prints the new version). AMO refuses to
   sign a version it has already signed, so this is required every time.

5. **Sign.** Load the credentials and sign in one shot (don't echo the secret):
   ```
   set -a; . ./amo.env; set +a; npm run sign 2>&1 | grep -viE 'SECRET'
   ```
   On success it prints `Signed xpi downloaded: web-ext-artifacts/<name>-<version>.xpi`.
   If AMO validation fails, report the validation errors and stop.

6. **Install it and restart Firefox — automatically. Do NOT ask the user to click
   through `about:addons`, and do NOT ask them to restart Firefox.** Run:
   ```
   npm run install:local -- --restart
   ```
   This copies the newest signed `.xpi` into the real Firefox profile
   (`<profile>/extensions/airbnb-archiver@noam.local.xpi`) — the same place a
   manual "Install Add-on From File…" puts it — so it's an in-place upgrade:
   same add-on id, same storage keys, starred/maybe/archived/notes/order all kept.
   It refuses to run if the newest artifact isn't the version in `manifest.json`
   or isn't AMO-signed.

   A running Firefox keeps the old copy open, so the new version only goes live on
   a restart — `--restart` does that **without losing tabs**: it closes Firefox
   gracefully (`taskkill` on the parent PID, never `/F`, so Firefox writes its
   session), waits for exit, arms
   `browser.sessionstore.resume_session_once` — the one-shot pref Firefox itself
   uses when it restarts for an update — and reopens. Windows, tabs, scroll and
   form state all come back. Verified end-to-end on a throwaway profile: 3 tabs in,
   3 tabs out, add-on 0.1.6 → 0.1.7 in the same cycle.

   It only ever closes Firefox parent processes, and if `--profile` was passed it
   closes only the instance running that profile. If Firefox has no window
   (headless) or doesn't exit within 45s (a `beforeunload` dialog blocking
   shutdown), it forces nothing and just reports — the new version then loads on
   the user's own next restart.

   If Firefox isn't running at all, there's nothing to restart; it loads on next
   launch. Drop `--restart` only if the user asks you not to touch their browser.

7. **Report.** Tell the user the version installed and whether it's live yet.
   If the dev runner (`npm run dev`) is running, remind them to stop it so there
   aren't two copies adding buttons.

8. **Commit (ask first).** Offer to commit the version bump + any code changes.
   Do NOT commit `amo.env` or `web-ext-artifacts/` (both gitignored).

## Notes
- **The auto-install only upgrades an add-on that is already installed and
  enabled** in that profile (which is the case here — it was originally installed
  by hand). Verified on a throwaway profile: swapping the `.xpi` took an enabled
  add-on 0.1.6 → 0.1.7 on restart, still enabled, no prompt. But a *newly
  discovered* profile sideload lands `userDisabled: true` — Firefox 74+ requires a
  one-time manual enable in `about:addons`. So on a fresh profile (or if the
  add-on was removed), the first install is still manual: `about:addons` → gear ⚙
  → **Install Add-on From File…**. After that, `npm run install:local` handles
  every update.
- **There is no way to restart just the extension from outside the browser.**
  `about:debugging`'s Reload only works on *temporarily* loaded add-ons, and the
  remote-debugging `installTemporaryAddon` route needs Firefox launched with a
  debugger server and installs a temporary shadow copy that vanishes on restart.
  The only genuine no-restart path is an `update_url` feed (Firefox applies add-on
  updates live), which needs the `.xpi` + `updates.json` on https hosting and only
  lands on Firefox's own check interval — see D37. Restarting with session restore
  is the cheaper equivalent.
- Useful flags: `--restart`, `--xpi=<path>` (install a specific build),
  `--profile=<name|path>` (default: this Firefox install's default profile from
  `profiles.ini`), `--force` (skip the version-match guard).
- Updates are NOT automatic for unlisted add-ons unless an `update_url` feed is
  hosted. If the user wants zero-touch updates, that's a separate setup
  (host the `.xpi` + an update manifest on GitHub Releases).
- Node ≥ 22 is required for `web-ext` (the project runs Node 24).
