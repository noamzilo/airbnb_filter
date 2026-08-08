#!/usr/bin/env node
// PreToolUse hook: refuse to write an em dash (U+2014) anywhere in this repo.
//
// The user does not want them in the prose, the docs, or the code comments, and
// asking a model to remember a punctuation preference across a long session does
// not hold. So enforce it at the only place it can be enforced: the write.
//
// Only NEW text is inspected - Write.content, Edit.new_string,
// NotebookEdit.new_source. Edit.old_string is deliberately ignored: matching an
// em dash that is already on disk is how you would remove one, and blocking that
// would make legacy text uneditable.
//
// Escape hatch: create `.claude/allow-em-dash` to switch this off.

const fs = require('fs');
const path = require('path');

// Built from its code point on purpose. With the literal character sitting in
// this file, the hook would refuse every future edit to itself.
const EM_DASH = String.fromCharCode(8212);
const root = path.resolve(__dirname, '..');

// The fields that carry text the model is about to put on disk.
const NEW_TEXT_FIELDS = ['content', 'new_string', 'new_source'];

function allow() {
  process.exit(0);
}

// A short quote of the offence, so the fix is obvious without a re-read.
function sample(text) {
  const i = text.indexOf(EM_DASH);
  const from = Math.max(0, i - 40);
  const to = Math.min(text.length, i + 40);
  return (from > 0 ? '...' : '') + text.slice(from, to).replace(/\n/g, ' ') + (to < text.length ? '...' : '');
}

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  if (fs.existsSync(path.join(root, '.claude', 'allow-em-dash'))) allow();

  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    allow(); // unparseable input is not a reason to block a write
  }

  const ti = input.tool_input || {};
  const offenders = [];
  for (const field of NEW_TEXT_FIELDS) {
    const v = ti[field];
    if (typeof v === 'string' && v.includes(EM_DASH)) offenders.push({ field, text: v });
  }
  // Edit's multi-edit form carries its own array of edits.
  for (const e of Array.isArray(ti.edits) ? ti.edits : []) {
    if (e && typeof e.new_string === 'string' && e.new_string.includes(EM_DASH)) {
      offenders.push({ field: 'edits[].new_string', text: e.new_string });
    }
  }
  if (!offenders.length) allow();

  const where = offenders
    .map((o) => `  ${o.field}: ${sample(o.text)}`)
    .join('\n');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked: this write contains an em dash (${EM_DASH}). This project does not use them ` +
          `anywhere - prose, docs, or code comments.\n\n${where}\n\n` +
          'Rewrite the sentence with a comma, a colon, parentheses, or two sentences. ' +
          'A plain hyphen "-" is fine when a dash is genuinely wanted. ' +
          'Then retry the write.',
      },
    })
  );
  allow();
});
