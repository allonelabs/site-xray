#!/usr/bin/env node
/**
 * xray-search-index.js — build an offline search index from any clone.
 *
 * Modern sites lose their search the moment they're cloned (Algolia,
 * Elasticsearch, custom backends — all live and gone). This tool walks
 * every .html in a clone, extracts title/description/visible-text/URL,
 * builds a small inverted-index, and writes:
 *
 *   data/search-index.json   — the index + per-doc metadata
 *   data/search-shim.js      — a 1KB JS that exposes window.xraySearch(q)
 *                              callable from any cloned page
 *
 * No UI is generated. Users wire the shim into their existing search
 * input via a one-line override:
 *
 *   <script src="/data/search-shim.js"></script>
 *   <script>
 *     document.querySelector('input[type=search]')
 *       .addEventListener('input', async (e) => {
 *         const results = await xraySearch(e.target.value);
 *         // render results in your existing UI
 *       });
 *   </script>
 *
 * Usage:
 *   node xray-search-index.js <clone-dir> [--max-docs N]
 *
 * Default --max-docs 5000 (covers all but the largest cloned sites).
 */

const fs = require("fs");
const path = require("path");

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "what",
  "which",
  "who",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "some",
  "any",
  "no",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "from",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "as",
  "also",
  "than",
  "such",
  "more",
]);

function tokenize(text) {
  // Lowercase, split on non-alphanumeric, drop short/stop tokens.
  const tokens = [];
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 2 || t.length > 32) continue;
    if (STOP_WORDS.has(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

function extractContent(html) {
  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
  // Meta description
  const descMatch = html.match(
    /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i,
  );
  const description = descMatch ? descMatch[1] : "";
  // Visible body text
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const noStyles = noScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const noHead = noStyles.replace(/<head[\s\S]*?<\/head>/i, " ");
  const text = noHead
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Snippet: first 240 chars of visible text after title
  const snippet = text.slice(0, 240);
  return { title, description, text, snippet };
}

function urlFromPath(filePath, cloneDir) {
  let rel = path.relative(cloneDir, filePath).replace(/\\/g, "/");
  rel = rel.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  if (!rel.startsWith("/")) rel = "/" + rel;
  return rel === "/" || rel === "" ? "/" : rel;
}

function buildIndex(docs) {
  const tokens = Object.create(null);
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    // Weight title 3×, description 2×, body 1×. Implement by repeating the
    // title/description tokens in the corpus.
    const corpus = [
      d.title,
      d.title,
      d.title,
      d.description,
      d.description,
      d.text,
    ].join(" ");
    const seen = new Set();
    for (const t of tokenize(corpus)) {
      if (seen.has(t)) continue;
      seen.add(t);
      (tokens[t] = tokens[t] || []).push(i);
    }
  }
  return tokens;
}

function writeShim(outDir) {
  const shim = `// site-xray search shim — loads data/search-index.json and exposes
// window.xraySearch(query) → [{url, title, description, snippet, score}].
(function () {
  var _idx;
  async function ensureLoaded() {
    if (_idx) return _idx;
    const res = await fetch("/data/search-index.json", { credentials: "omit" });
    if (!res.ok) throw new Error("search-index not reachable");
    _idx = await res.json();
    return _idx;
  }
  async function xraySearch(query, limit) {
    var idx = await ensureLoaded();
    if (!query || typeof query !== "string") return [];
    var tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(function (t) { return t.length >= 2 && t.length <= 32; });
    if (tokens.length === 0) return [];
    var scores = {};
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var hits = idx.tokens[t] || [];
      // Also try prefix matches (token starts with...)
      if (hits.length === 0) {
        for (var k in idx.tokens) {
          if (k.indexOf(t) === 0) {
            hits = hits.concat(idx.tokens[k]);
            break;
          }
        }
      }
      for (var j = 0; j < hits.length; j++) {
        var docId = hits[j];
        scores[docId] = (scores[docId] || 0) + 1;
      }
    }
    return Object.keys(scores)
      .map(function (id) { return [parseInt(id, 10), scores[id]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, limit || 20)
      .map(function (pair) {
        return Object.assign({}, idx.docs[pair[0]], { score: pair[1] });
      });
  }
  window.xraySearch = xraySearch;
})();
`;
  fs.writeFileSync(path.join(outDir, "data", "search-shim.js"), shim);
}

function main() {
  const args = process.argv.slice(2);
  const maxIdx = args.indexOf("--max-docs");
  const maxDocs = maxIdx >= 0 ? parseInt(args[maxIdx + 1]) || 5000 : 5000;
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--max-docs"),
  );
  if (positional.length < 1) {
    console.log(`xray-search-index — build an offline search index from a clone.

Usage: node xray-search-index.js <clone-dir> [--max-docs N]

Writes data/search-index.json + data/search-shim.js into the clone dir.`);
    process.exit(1);
  }
  const cloneDir = positional[0];
  if (!fs.existsSync(cloneDir)) {
    console.error(`clone dir not found: ${cloneDir}`);
    process.exit(1);
  }

  console.log(`\n🔍 xray-search-index`);
  console.log(`   clone: ${cloneDir}`);

  const t0 = Date.now();
  const docs = [];
  const SKIP_DIRS = new Set([
    "data",
    "node_modules",
    "images",
    "fonts",
    "videos",
    "models",
    "components",
    "css",
    "js",
    "api",
  ]);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (docs.length >= maxDocs) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(".html")) {
        const fullPath = path.join(dir, e.name);
        let html;
        try {
          html = fs.readFileSync(fullPath, "utf-8");
        } catch {
          continue;
        }
        const { title, description, text, snippet } = extractContent(html);
        if (!title && !text) continue;
        docs.push({
          url: urlFromPath(fullPath, cloneDir),
          title: title.slice(0, 200),
          description: description.slice(0, 280),
          snippet: snippet.slice(0, 240),
        });
      }
    }
  };
  walk(cloneDir);

  if (docs.length === 0) {
    console.log(`   no HTML content found`);
    process.exit(2);
  }

  // Build the inverted index using the full text (not just snippet)
  // — re-extract for indexing so we don't lose tokens past the snippet cap.
  console.log(`   indexing ${docs.length} pages...`);
  // Need full body for index. Re-walk to grab full text per doc.
  const fullDocs = docs.map((d, i) => {
    try {
      const filePath = d.url.endsWith("/")
        ? path.join(cloneDir, d.url.replace(/^\//, ""), "index.html")
        : path.join(cloneDir, d.url.replace(/^\//, "") + ".html");
      const html = fs.readFileSync(filePath, "utf-8");
      const c = extractContent(html);
      return Object.assign({}, d, { _text: c.text });
    } catch {
      return Object.assign({}, d, { _text: "" });
    }
  });
  const tokens = buildIndex(
    fullDocs.map((d) => ({
      title: d.title,
      description: d.description,
      text: d._text,
    })),
  );

  // Cleanse for output — drop _text and embed
  const indexOut = {
    builtAt: new Date().toISOString(),
    pageCount: docs.length,
    tokenCount: Object.keys(tokens).length,
    docs: docs.map((d) => ({
      url: d.url,
      title: d.title,
      description: d.description,
      snippet: d.snippet,
    })),
    tokens,
  };
  fs.mkdirSync(path.join(cloneDir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(cloneDir, "data", "search-index.json"),
    JSON.stringify(indexOut),
  );
  writeShim(cloneDir);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const indexSize = fs.statSync(
    path.join(cloneDir, "data", "search-index.json"),
  ).size;
  console.log(
    `   ✅ ${docs.length} pages · ${Object.keys(tokens).length} unique tokens · ${(indexSize / 1024).toFixed(0)}KB index · ${dt}s`,
  );
  console.log(`   → data/search-index.json`);
  console.log(`   → data/search-shim.js`);
  console.log("");
  console.log(`   Wire into your search input:`);
  console.log(`     <script src="/data/search-shim.js"></script>`);
  console.log(`     <script>`);
  console.log(`       input.addEventListener('input', async (e) => {`);
  console.log(`         const results = await xraySearch(e.target.value);`);
  console.log(`         // render results …`);
  console.log(`       });`);
  console.log(`     </script>\n`);
}

main();
