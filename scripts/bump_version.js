// Bump the patch version in extension/manifest.json. Prints the new version.
// AMO refuses to sign a version it has already signed, so every signed build
// needs a fresh version.
const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", "extension", "manifest.json");
const m = JSON.parse(fs.readFileSync(p, "utf8"));
const [a, b, c] = m.version.split(".").map((n) => parseInt(n, 10) || 0);
m.version = `${a}.${b}.${c + 1}`;
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
console.log(m.version);
