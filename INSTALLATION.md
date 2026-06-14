# Installing the Airbnb Archiver in normal Firefox

The extension is a self-distributed, Mozilla-signed add-on. Normal (release)
Firefox only installs **signed** add-ons permanently — which this is — so you can
install it like any `.xpi`.

## First install (one click, no restart)

1. Open **`about:addons`** in Firefox.
2. Click the **gear ⚙** (top-right) → **Install Add-on From File…**.
3. Select the latest signed file in `web-ext-artifacts/` — e.g.
   `web-ext-artifacts\4bed07c0cfd5440ebbe9-0.1.0.xpi`.
4. Click **Add** on the permission prompt.

It installs immediately into the running Firefox — no restart, tabs untouched.
Then **stop the dev runner** (`Ctrl+C` on `npm run dev`) so you don't have two
copies adding buttons.

> Tip: dragging the `.xpi` onto a Firefox window does the same thing.

## Updating

Updates are **not** automatic for a self-distributed add-on (see "Auto-updates"
below). To ship a change:

1. Run the skill **`/update-extension`** (or ask Claude to "update the
   extension"). It bumps the version, lints, self-tests, AMO-signs, and prints
   the path of the new `.xpi`.
2. Install that new `.xpi` exactly like the first install (Install Add-on From
   File). It **upgrades in place** — same add-on id (`airbnb-archiver@noam.local`),
   so your archived/liked lists are preserved.

## Your data

Archived and liked listings live in the extension's `browser.storage.local`,
keyed by the permanent Airbnb room id. They persist across restarts and across
in-place upgrades (same add-on id).

## Auto-updates (optional, not set up yet)

A self-distributed add-on can auto-update if we host an **update manifest** and
the signed `.xpi` at stable URLs and add an `update_url` to the manifest. Then
Firefox checks for updates on startup and ~daily and pulls new versions silently
("push and auto-pull"). Options:

- **GitHub Releases** host the `.xpi` + an `updates.json`; `update_url` points at
  the raw `updates.json`. Stays private (unlisted), fully automatic.
- **Listed on AMO** (public, searchable) — Firefox auto-updates from AMO with no
  hosting, but the add-on becomes publicly listed.

Ask Claude to set up the GitHub auto-update flow if you want zero-click updates.

## Re-signing details (for maintainers)

- Requires `amo.env` in the project root (gitignored) with `WEB_EXT_API_KEY` and
  `WEB_EXT_API_SECRET` from https://addons.mozilla.org/developers/addon/api/key/.
- `npm run sign` signs via AMO (channel `unlisted`) and downloads to
  `web-ext-artifacts/`. AMO refuses to re-sign an existing version, so bump first
  (`npm run bump`). The `/update-extension` skill does all of this.
