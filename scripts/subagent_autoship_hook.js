#!/usr/bin/env node
// SubagentStop hook: when a subagent finishes having changed something under
// extension/, send it back to run the update-extension skill (lint -> test ->
// bump -> sign -> install + restart Firefox) rather than leaving the ship for
// the user to trigger by hand.
//
// Deliberately NOT a Stop hook - the user does not want a ship attempt at the
// end of every main-loop turn, only when an agent declares a feature done.
//
// "Unshipped" == some file in extension/ is newer than the newest signed .xpi in
// web-ext-artifacts/. Signing writes a fresh .xpi, so a successful ship clears
// the condition and the hook goes quiet again. A subagent that only read or
// researched never trips it.
//
// Escape hatches:
//   - `stop_hook_active` in the hook input: the hook already fired once for this
//     subagent, so never fire twice in a row. If it decides not to ship (work
//     unfinished, test red) and finishes again, it is let go.
//   - `.claude/skip-autoship`: create this file to suppress auto-shipping.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const extDir = path.join(root, 'extension');
const artifactsDir = path.join(root, 'web-ext-artifacts');

function newestMtime(dir, filter) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, filter));
    } else if (!filter || filter(entry.name)) {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* raced with a delete; ignore */
      }
    }
  }
  return newest;
}

function quit() {
  process.exit(0);
}

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    /* no usable input; fall through to the file checks */
  }

  if (input.stop_hook_active) quit();
  if (fs.existsSync(path.join(root, '.claude', 'skip-autoship'))) quit();

  // Ignore dotfiles: signing drops `.amo-upload-uuid` into extension/, and that
  // bookkeeping is not a source change to ship.
  const changedAt = newestMtime(extDir, (name) => !name.startsWith('.'));
  if (!changedAt) quit();

  const shippedAt = newestMtime(artifactsDir, (name) => name.endsWith('.xpi'));
  if (changedAt <= shippedAt) quit();

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        'You changed extension/ but it has not been signed and installed yet ' +
        '(a file there is newer than the newest .xpi in web-ext-artifacts/).\n\n' +
        'Before you finish, ship it: invoke the `update-extension` skill and ' +
        'follow it end to end (lint, self-test, bump, sign, ' +
        '`npm run install:local -- --restart`), then include the installed ' +
        'version in what you return. Do not hand the ship back to the user.\n\n' +
        'If the feature is NOT actually done - the change is half-written, or a ' +
        'test is failing - do not ship. Say so in one line and finish; this hook ' +
        'will not fire again for you.',
    })
  );
  quit();
});
