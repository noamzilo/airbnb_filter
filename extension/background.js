// Airbnb Archiver — the interceptor (the make-or-break piece).
// Rewrites Airbnb's search data BEFORE the page renders it, so archived
// listings never appear (cards, map cards, or map pins) and never come back
// on pan/zoom. Firefox-only capability (filterResponseData). See PROJECT_LOG.md.

let archivedSet = new Set();
let showArchived = false;

async function refresh() {
  const { archived = {}, settings = {} } = await browser.storage.local.get(["archived", "settings"]);
  archivedSet = new Set(Object.keys(archived));
  showArchived = !!settings.showArchived;
}
refresh();
browser.storage.onChanged.addListener(refresh);

function concatChunks(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Rewrite a raw JSON response (the StaysSearch XHR).
function rewriteJson(text) {
  try {
    const { text: out, removed } = Filter.filterJsonText(text, archivedSet);
    if (removed) console.log(`[Archiver] removed ${removed} archived listing(s) from XHR`);
    return out;
  } catch (e) {
    console.warn("[Archiver] XHR JSON parse failed, passing through", e);
    return text;
  }
}

// Rewrite the initial HTML document: filter the JSON embedded in each
// <script id="data-deferred-state-N"> blob, then splice it back in.
function rewriteHtml(text) {
  return text.replace(
    /(<script id="data-deferred-state-\d+"[^>]*>)([\s\S]*?)(<\/script>)/g,
    (full, open, json, close) => {
      try {
        const { text: out, removed } = Filter.filterJsonText(json, archivedSet);
        if (removed) console.log(`[Archiver] removed ${removed} archived listing(s) from HTML blob`);
        return open + Filter.escapeForScript(out) + close;
      } catch (e) {
        console.warn("[Archiver] HTML blob parse failed, passing through", e);
        return full;
      }
    }
  );
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Nothing to do: let the response stream through untouched.
    if (showArchived || archivedSet.size === 0) return;

    const isDoc = details.type === "main_frame";
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];

    filter.ondata = (event) => chunks.push(new Uint8Array(event.data));
    filter.onstop = () => {
      const buf = concatChunks(chunks);
      try {
        const text = new TextDecoder("utf-8").decode(buf);
        const out = isDoc ? rewriteHtml(text) : rewriteJson(text);
        filter.write(new TextEncoder().encode(out));
      } catch (e) {
        console.warn("[Archiver] rewrite failed, passing original through", e);
        filter.write(buf);
      }
      filter.close();
    };
    filter.onerror = () => console.warn("[Archiver] stream filter error:", filter.error);
  },
  {
    urls: ["*://*.airbnb.com/s/*", "*://*.airbnb.com/api/v3/StaysSearch*"],
    types: ["main_frame", "xmlhttprequest"],
  },
  ["blocking"]
);

console.log("[Archiver] background interceptor registered");
