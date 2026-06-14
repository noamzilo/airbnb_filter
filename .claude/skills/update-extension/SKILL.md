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

6. **Report.** Give the user the absolute path of the new `.xpi`
   (`realpath web-ext-artifacts/*.xpi` → newest) and the install reminder:
   - `about:addons` → gear ⚙ → **Install Add-on From File…** → pick the `.xpi`
     (or drag the `.xpi` onto Firefox). It upgrades in place; data is kept.
   - If the dev runner (`npm run dev`) is running, stop it so there aren't two
     copies adding buttons.

7. **Commit (ask first).** Offer to commit the version bump + any code changes.
   Do NOT commit `amo.env` or `web-ext-artifacts/` (both gitignored).

## Notes
- Updates are NOT automatic for unlisted add-ons unless an `update_url` feed is
  hosted. If the user wants zero-touch updates, that's a separate setup
  (host the `.xpi` + an update manifest on GitHub Releases).
- Node ≥ 22 is required for `web-ext` (the project runs Node 24).
