# CLAUDE.md — Airbnb Archiver

## ⛔ Do NOT submit/upload the extension to Mozilla (AMO) without explicit consent
The user does **not** want this extension submitted to Mozilla until they
explicitly say so.

- **Signing uploads to AMO.** `npm run sign`, `npm run sign:listed`, and the
  `/update-extension` skill all UPLOAD the add-on to Mozilla's servers to get it
  signed. Even the **unlisted** channel uploads it (it just isn't publicly
  listed/searchable) and can trigger Mozilla "review / tentatively approved"
  emails.
- **Require explicit, in-the-moment consent** before running ANY signing/upload
  step. The user must say something like "sign it", "ship it", or "submit it" in
  that request. A general "update the extension" or "make this change" is **not**
  consent to upload — ask first.
- **Never** use the listed/public channel (`sign:listed` / `--channel=listed`)
  unless the user explicitly asks to publish publicly.
- **No-upload alternatives** (prefer these unless the user asks to sign):
  - `npm run dev` — web-ext, loads a temporary copy, no upload.
  - Firefox Developer Edition — install an unsigned `.xpi` permanently, no upload.
  - `npm run build` — produce an unsigned package locally (no upload).

## Data safety (see memory: preserve-user-data-on-update)
- Never change the add-on id (`airbnb-archiver@noam.local`) or call
  `storage.local.clear()`. The user's starred / maybe / archived / notes / order
  must survive every update (in-place upgrade, same id, stable keys).
