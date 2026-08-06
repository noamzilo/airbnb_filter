// Does the interceptor's HTML-document rewrite keep the deferred-state blob
// valid (so the page still hydrates)? Reproduces background.js rewriteHtml.
const fs = require("fs");
const path = require("path");
const { Filter } = require("../extension/filter.js");

const html = fs.readFileSync(path.join(__dirname, "..", "search.html"), "utf-8");

// Pick a real listing id from the first blob to "archive".
const first = html.match(/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/);
const root0 = JSON.parse(first[1]);
let victim = null;
(function w(n) { if (victim) return; if (Array.isArray(n)) return n.forEach(w);
  if (n && typeof n === "object") { if (n.demandStayListing && n.demandStayListing.id) { const id = Filter.decodeId(n.demandStayListing.id); if (id) victim = id; } for (const k in n) w(n[k]); } })(root0);
console.log("archiving victim:", victim);

const archivedSet = new Set([victim]);
function processJson(text) {
  const root = JSON.parse(text);
  Filter.filterNode(root, archivedSet);
  Filter.forceFullPins(root, new Set());
  return JSON.stringify(root);
}
function rewriteHtml(text) {
  return text.replace(/(<script id="data-deferred-state-\d+"[^>]*>)([\s\S]*?)(<\/script>)/g,
    (full, open, json, close) => { try { return open + Filter.escapeForScript(processJson(json)) + close; } catch (e) { console.log("rewrite threw:", e.message); return full; } });
}

const out = rewriteHtml(html);

let ok = true;
// How many deferred-state blobs and do they all re-parse?
const re = /<script id="data-deferred-state-\d+"[^>]*>([\s\S]*?)<\/script>/g;
let m, n = 0;
while ((m = re.exec(out))) {
  n++;
  try { JSON.parse(m[1]); } catch (e) { ok = false; console.log(`BLOB ${n} CORRUPT:`, e.message.slice(0, 120)); }
}
console.log("blobs found:", n, "| all parse:", ok);
console.log("output length delta:", out.length - html.length);
// victim gone?
const after = JSON.parse(out.match(/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/)[1]);
let present = false;
(function w(nn){ if(present) return; if(Array.isArray(nn)) return nn.forEach(w); if(nn&&typeof nn==="object"){ if(nn.demandStayListing&&Filter.decodeId(nn.demandStayListing.id)===victim) present=true; for(const k in nn) w(nn[k]); } })(after);
console.log("victim still present after rewrite:", present);
// sanity: does output still contain other critical scripts / same script count?
console.log("script tags before/after:", (html.match(/<script/g)||[]).length, (out.match(/<script/g)||[]).length);

// The shape guard. A malformed document does not fail loudly in Firefox: the
// parser loses sync, swallows markup to the next </script>, and paints a later
// application/json payload on screen as class-name soup. Rewrites must keep the
// tag skeleton identical, and a rewrite that doesn't must be rejected outright.
if (!Filter.sameHtmlShape(html, out)) { ok = false; console.log("SHAPE GUARD: real rewrite failed its own check"); }
else console.log("shape guard: real rewrite passes");

const corrupt = [
  ["script tag destroyed",   html.replace('<script id="aphrodite-classes"', '<scrpt id="aphrodite-classes"')],
  ["unbalanced </script>",   html.replace("</script>", "")],
  ["truncated document",     html.slice(0, Math.floor(html.length * 0.6))],
  ["breakout in a blob",     html.replace(/(<script id="data-deferred-state-0"[^>]*>)/, "$1</script><b>x</b>")],
];
for (const [name, bad] of corrupt) {
  if (Filter.sameHtmlShape(html, bad)) { ok = false; console.log(`SHAPE GUARD MISSED: ${name}`); }
  else console.log(`shape guard catches: ${name}`);
}

console.log(ok ? "\nHTML REWRITE OK" : "\nHTML REWRITE CORRUPTS BLOB");
process.exit(ok ? 0 : 1);
