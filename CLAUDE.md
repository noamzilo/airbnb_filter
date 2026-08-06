# CLAUDE.md — Airbnb Archiver

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
