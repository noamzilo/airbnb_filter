// Which requests does the interceptor touch? Documents are opt-in, because a
// document handed back wrong breaks the page silently; XHRs are always filtered,
// because that is what actually keeps archived listings gone.
const { Filter } = require("../extension/filter.js");

let ok = true;
function check(name, got, want) {
  const pass = got === want;
  if (!pass) ok = false;
  console.log((pass ? "PASS  " : "FAIL  ") + name + `  got=${got} want=${want}`);
}

const OFF = { rewriteDocuments: false };
const ON = { rewriteDocuments: true };
const doc = { type: "main_frame", url: "https://www.airbnb.com/s/Jerusalem-District--Israel/homes?x=1" };
const xhr = { type: "xmlhttprequest", url: "https://www.airbnb.com/api/v3/StaysSearch?operationName=StaysSearch" };
const probeDoc = { type: "main_frame", url: "https://www.airbnb.com/s/x/homes?archiver_probe=1" };
const probeXhr = { type: "xmlhttprequest", url: "https://www.airbnb.com/api/v3/StaysSearch?archiver_probe=1" };

// The default must be the safe one: a fresh install never rewrites documents.
check("default settings leave documents alone", Filter.shouldFilter(doc, {}), false);
check("missing settings object leaves documents alone", Filter.shouldFilter(doc, undefined), false);
check("documents skipped when off", Filter.shouldFilter(doc, OFF), false);
check("documents filtered when explicitly on", Filter.shouldFilter(doc, ON), true);

// The XHR path is the one that does the real work - never gate it on the flag.
check("XHR filtered when documents are off", Filter.shouldFilter(xhr, OFF), true);
check("XHR filtered when documents are on", Filter.shouldFilter(xhr, ON), true);

// Our own price probes are parsed by the content script; buffering them here
// would rewrite the very response it is waiting to read.
check("our price probe never filtered (doc)", Filter.shouldFilter(probeDoc, ON), false);
check("our price probe never filtered (xhr)", Filter.shouldFilter(probeXhr, ON), false);

console.log(ok ? "\nSHOULD-FILTER OK" : "\nSHOULD-FILTER FAILED");
process.exit(ok ? 0 : 1);
