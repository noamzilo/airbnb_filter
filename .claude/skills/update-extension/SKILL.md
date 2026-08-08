---
name: update-extension
description: Build, AMO-sign, install, and commit+push a new version of the Airbnb Archiver Firefox extension so it can be installed permanently in normal Firefox. Use when the user wants to ship/update the installed extension (e.g. "update the extension", "rebuild and sign", "/update-extension").
---

# Update (build + sign) the Airbnb Archiver extension

Goal: produce a fresh Mozilla-signed `.xpi`, install it in the user's real
Firefox, and **commit and push** the result. The signed add-on is **unlisted**
(self-distributed); installing the new `.xpi` upgrades in place and preserves the
user's archived/liked data (same add-on id `airbnb-archiver@noam.local`).

A ship isn't done at the signature: it ends with the new version installed
(step 6) and committed to the remote (step 8), so the repo and the add-on the
user is actually running never drift apart.

Run all commands from the project root (`c:\Users\noams\src\airbnb_filter`).

## Steps

0. **Channel guard (see CLAUDE.md).** Sign **unlisted** only (`npm run sign`) -
   that's private/self-distribution and fine. NEVER use the public/listed channel
   (`sign:listed` / `--channel=listed`) unless the user explicitly asks to publish
   publicly.

1. **Preflight.** Confirm `amo.env` exists (it's gitignored and holds
   `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`). If it's missing, stop and ask the
   user to create it (see `docs/closing-the-loop.md` / the AMO key steps) - signing
   can't proceed without it. Never print the secret.

2. **Lint.** `npm run lint:ext` - must be 0 errors before signing.

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

6. **Install it and restart Firefox - automatically. Do NOT ask the user to click
   through `about:addons`, and do NOT ask them to restart Firefox.** Run:
   ```
   npm run install:local -- --restart
   ```
   This copies the newest signed `.xpi` into the real Firefox profile
   (`<profile>/extensions/airbnb-archiver@noam.local.xpi`) - the same place a
   manual "Install Add-on From File…" puts it - so it's an in-place upgrade:
   same add-on id, same storage keys, starred/maybe/archived/notes/order all kept.
   It refuses to run if the newest artifact isn't the version in `manifest.json`
   or isn't AMO-signed.

   A running Firefox keeps the old copy open, so the new version only goes live on
   a restart - `--restart` does that **without losing windows or tabs**. Three
   things have to be right, and each one cost a real window before it was:

   - **Wait for Firefox to persist its session first.** Firefox writes the session
     on a timer (`browser.sessionstore.interval`, 15s). A window it has not written
     yet cannot be restored by anything - measured at ~21s for a fresh window. The
     script polls until the saved session lists as many windows as are on screen,
     and warns instead of guessing if it never catches up.
   - **Close every top-level window, not the process.** `taskkill /PID` reaches
     only the *main* window, so a multi-window Firefox lost one window and stayed
     running with the update unapplied.
   - **Put back what Firefox files as "recently closed".** Closing windows one at a
     time is not a quit: a window that closes while others are open goes into
     `_closedWindows`, and restore only brings back `state.windows`. That is how a
     3-window browser came back as 1. After shutdown the script promotes those
     back, falling back to the pre-close snapshot if they are not there.

   Then it arms `browser.sessionstore.resume_session_once` - the one-shot pref
   Firefox itself uses when it restarts for an update - and reopens.

   Tests, both of which must pass after touching any of this:
   - `node scripts/test-session-repair.js` - fast, no browser. Covers every repair
     branch, including the exact 3-windows-came-back-as-1 case.
   - `python scripts/test_restart.py` - drives real Firefox with three windows and
     fails if any window does not come back. Its pages must be **real** files:
     Firefox does not track closed windows whose tabs are all `about:` pages, so an
     `about:`-based harness silently tests nothing.

   It only ever closes Firefox parent processes, and if `--profile` was passed it
   closes only the instance running that profile. If Firefox has no window
   (headless) or doesn't exit within 45s (a `beforeunload` dialog blocking
   shutdown), it forces nothing and just reports - the new version then loads on
   the user's own next restart.

   If Firefox isn't running at all, there's nothing to restart; it loads on next
   launch. Drop `--restart` only if the user asks you not to touch their browser.

7. **Report.** Tell the user the version installed and whether it's live yet.
   If the dev runner (`npm run dev`) is running, remind them to stop it so there
   aren't two copies adding buttons.

8. **Commit and push - do it, don't ask.** Anything that was worth signing and
   installing is worth having in the remote, and a shipped version that exists
   only on this machine is how the repo and the installed add-on drift apart.

   ```
   git add -A
   git commit -F- <<'EOF'
   <subject line, ending with (<version>)>

   <what changed and why>

   Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
   EOF
   git push
   ```

   - `amo.env` and `web-ext-artifacts/` are gitignored - check `git status`
     before committing rather than trusting that.
   - `extension/.amo-upload-uuid` **is** tracked and changes on every sign; it
     belongs in the commit.
   - Put the version in the subject (e.g. `… (0.1.24)`), matching the existing
     history.
   - If the current branch has no upstream, `git push -u origin <branch>`.
   - Only skip this if the user explicitly said not to commit. If the push
     fails (no network, rejected, protected branch), say so plainly - the
     extension is still installed and live either way.
   - Don't open a PR unless the user asks; if the branch isn't `main`, mention
     that a PR is available.

## Notes
- **The auto-install only upgrades an add-on that is already installed and
  enabled** in that profile (which is the case here - it was originally installed
  by hand). Verified on a throwaway profile: swapping the `.xpi` took an enabled
  add-on 0.1.6 → 0.1.7 on restart, still enabled, no prompt. But a *newly
  discovered* profile sideload lands `userDisabled: true` - Firefox 74+ requires a
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
  lands on Firefox's own check interval - see D37. Restarting with session restore
  is the cheaper equivalent.
- Useful flags: `--restart`, `--xpi=<path>` (install a specific build),
  `--profile=<name|path>` (default: this Firefox install's default profile from
  `profiles.ini`), `--force` (skip the version-match guard).
- Updates are NOT automatic for unlisted add-ons unless an `update_url` feed is
  hosted. If the user wants zero-touch updates, that's a separate setup
  (host the `.xpi` + an update manifest on GitHub Releases).
- Node ≥ 22 is required for `web-ext` (the project runs Node 24).
