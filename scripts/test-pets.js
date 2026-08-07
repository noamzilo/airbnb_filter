// Pure-logic test for Filter.petsFromHtml (no browser).
//   node scripts/test-pets.js
// Fixtures are the real shapes captured by scripts/recon_pets.py (a no-pets
// room) and scripts/recon_pets2.py (a pet-friendly one).

const path = require("path");
const { Filter } = require(path.join(__dirname, "..", "extension", "filter.js"));

let fails = 0;
function check(label, cond, extra = "") {
  if (!cond) fails++;
  console.log((cond ? "PASS" : "FAIL") + "  " + label + (extra ? "  " + extra : ""));
}

const ALLOWED = '{"__typename":"BasicListItem","title":"Pets allowed","subtitle":null,'
  + '"icon":"SYSTEM_PETS","loggingEventData":null,"html":null}';
const DENIED = '{"__typename":"BasicListItem","title":"No pets","subtitle":null,'
  + '"icon":"SYSTEM_NO_PETS","loggingEventData":null,"html":null}';
const RULES = '{"__typename":"BasicListItem","title":"4 guests maximum","icon":"SYSTEM_FAMILY"},';

check("pet-friendly room page", Filter.petsFromHtml("<html>" + RULES + ALLOWED + "</html>") === true);
check("no-pets room page", Filter.petsFromHtml("<html>" + RULES + DENIED + "</html>") === false);
check("page that never says", Filter.petsFromHtml("<html>" + RULES + "</html>") === null);
check("empty / missing input", Filter.petsFromHtml("") === null && Filter.petsFromHtml(null) === null);

// The rule is the icon, not the title: titles are localised, icons are not.
check("localised title still reads as allowed",
  Filter.petsFromHtml('{"title":"Se admiten mascotas","icon":"SYSTEM_PETS"}') === true);
check("localised title still reads as denied",
  Filter.petsFromHtml('{"title":"No se admiten mascotas","icon":"SYSTEM_NO_PETS"}') === false);

// SYSTEM_NO_PETS contains "PETS" -- a sloppy substring check would call a
// no-pets listing pet-friendly. It must not, in either order.
check("NO_PETS is not mistaken for PETS", Filter.petsFromHtml(DENIED) === false);
check("'no' wins when a page carries both (rule after)",
  Filter.petsFromHtml(ALLOWED + DENIED) === false, "allowed-then-denied");
check("'no' wins when a page carries both (rule first)",
  Filter.petsFromHtml(DENIED + ALLOWED) === false, "denied-then-allowed");

// Whitespace inside the JSON must not break the match.
check("tolerates spaced JSON", Filter.petsFromHtml('{ "icon" : "SYSTEM_PETS" }') === true);

// Prose about pets is not a house rule.
check("prose alone proves nothing",
  Filter.petsFromHtml("Service animals aren’t pets, so there’s no need to add them here.") === null);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
