#!/usr/bin/env node
/**
 * xray-static.js — clone a static-rendered site via raw HTTP. No Playwright.
 *
 * Built on the observation that ~half of the web (SSR Next.js, Astro, Hugo,
 * plain HTML, WordPress-rendered pages) ships the full content in the HTML
 * response. For those sites, running a headless browser is a 30s–11min waste:
 * the same content arrives in a 200ms GET.
 *
 * Pipeline:
 *   1. HTTP GET the homepage
 *   2. Detect if it's "static-enough" (visible text > 1KB, not just an
 *      empty SPA shell). If not, exit with hint to use v54-stable.js.
 *   3. Parse HTML for asset refs (script, link, img, video, source, CSS url()).
 *   4. Download all assets in parallel (concurrent connections, single host).
 *   5. Rewrite URLs in HTML to local paths.
 *   6. Crawl internal links breadth-first up to max-pages.
 *   7. Write a manifest.json compatible with v54's score-clone tool.
 *
 * Usage:
 *   node xray-static.js <url> [out-dir] [max-pages] [--force]
 *
 * --force skips the static-enough detection (clone anyway, even if it
 * looks like an SPA shell — useful when you want raw HTML only).
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQ_HEADERS = {
  "User-Agent": DEFAULT_UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity", // we don't decompress; ask servers not to
};
const MAX_ASSET_BYTES = 50 * 1024 * 1024; // 50MB cap per asset
const REQ_TIMEOUT_MS = 15000;
const CONCURRENCY = 12; // default parallel downloads
const STATIC_TEXT_THRESHOLD = 1024; // bytes of visible text needed to call it static

// ─── Adaptive rate limiter ─────────────────────────────────────────────
// Stay fast (parallel) by default. Watch every response for blockage
// signals — 429 / 503 / 403 / repeated timeouts / ECONNRESET. After
// `BLOCK_THRESHOLD` signals from one origin, switch to serial mode
// (concurrency=1, 500ms spacing) for the rest of the session. Manual
// override via --rate <N> always wins. --rate 1 forces serial; --rate
// 12 forces parallel (no adaptive downgrade).
const rateState = {
  forced: null, // user-set effective concurrency (null = adaptive)
  current: CONCURRENCY,
  blockedResponses: 0,
  blockedHosts: new Set(),
  totalFetches: 0,
  spaceMs: 0, // sleep between fetches in serial mode
};
const BLOCK_THRESHOLD = 3;
function effectiveConcurrency() {
  if (rateState.forced !== null) return rateState.forced;
  return rateState.current;
}
function recordResponse(status, err, host) {
  rateState.totalFetches++;
  const blocked =
    status === 429 ||
    status === 503 ||
    status === 403 ||
    (err && /ECONNRESET|timeout|EAI_AGAIN/i.test(String(err.message || err)));
  if (blocked) {
    rateState.blockedResponses++;
    if (host) rateState.blockedHosts.add(host);
    if (
      rateState.forced === null &&
      rateState.blockedResponses >= BLOCK_THRESHOLD &&
      rateState.current > 1
    ) {
      rateState.current = 1;
      rateState.spaceMs = 500;
      console.log(
        `  ⚠ rate-limit detected (${rateState.blockedResponses} blocked responses from ${[...rateState.blockedHosts].join(", ")}) — switching to serial mode (500ms spacing). Use --rate <N> to force a specific level.`,
      );
    }
  }
}
async function maybeSpace() {
  if (rateState.spaceMs > 0)
    await new Promise((r) => setTimeout(r, rateState.spaceMs));
}

async function fetchURL(url, redirects = 0) {
  // Honor adaptive spacing before each fetch (only set when blockage detected
  // or --rate forces serial). When operating in parallel mode rateState.spaceMs
  // is 0 and this is a no-op.
  await maybeSpace();
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    let mod;
    let parsed;
    try {
      parsed = new URL(url);
      mod = parsed.protocol === "http:" ? http : https;
    } catch (e) {
      return reject(e);
    }
    const host = parsed.host;
    const req = mod.get(
      url,
      { headers: REQ_HEADERS, timeout: REQ_TIMEOUT_MS },
      (res) => {
        recordResponse(res.statusCode, null, host);
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return fetchURL(next, redirects + 1).then(resolve, reject);
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_ASSET_BYTES) {
            req.destroy();
            return reject(
              new Error(`asset > ${MAX_ASSET_BYTES} bytes: ${url}`),
            );
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            url: res.url || url,
            finalUrl: url,
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", (e) => {
          recordResponse(0, e, host);
          reject(e);
        });
      },
    );
    req.on("error", (e) => {
      recordResponse(0, e, host);
      reject(e);
    });
    req.on("timeout", () => {
      req.destroy();
      const e = new Error(`timeout ${REQ_TIMEOUT_MS}ms: ${url}`);
      recordResponse(0, e, host);
      reject(e);
    });
  });
}

// Strip tags + condense whitespace, return visible text length only.
function visibleTextLen(html) {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const noStyles = noScripts.replace(/<style[\s\S]*?<\/style>/gi, "");
  const text = noStyles
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

// Heuristic: "static enough" means the HTML response contains visible
// content. SPA shells (<div id="__next"></div>, <div id="root"></div>)
// have ~no visible text and the JS produces all the content at runtime.
function isStaticEnough(html) {
  const len = visibleTextLen(html);
  if (len < STATIC_TEXT_THRESHOLD)
    return {
      ok: false,
      reason: `only ${len} bytes of visible text (need >= ${STATIC_TEXT_THRESHOLD})`,
    };
  // Hard SPA-shell signals
  const shells = [
    /<div id="__next">\s*<\/div>/,
    /<div id="root">\s*<\/div>/,
    /<body[^>]*>\s*<div id="app">\s*<\/div>/,
  ];
  for (const r of shells) {
    if (r.test(html))
      return { ok: false, reason: `looks like a SPA shell (${r})` };
  }
  return { ok: true, textLen: len };
}

// Extract asset URLs from HTML. Returns array of { url, kind, replacement }
// where replacement is a {find, replaceWith} pair for the rewriter. Kept
// regex-based — cheerio would be cleaner but adds 200KB.
function extractAssets(html, baseURL) {
  const found = new Map(); // absoluteURL → {kind, originals: [text-as-found]}
  const add = (kind, originalText, absoluteURL) => {
    if (!absoluteURL) return;
    if (!/^https?:/i.test(absoluteURL) && !absoluteURL.startsWith("/")) return;
    let entry = found.get(absoluteURL);
    if (!entry) {
      entry = { kind, originals: new Set() };
      found.set(absoluteURL, entry);
    }
    entry.originals.add(originalText);
  };
  const resolve = (ref) => {
    try {
      return new URL(ref, baseURL).toString();
    } catch {
      return null;
    }
  };

  // <link rel="stylesheet" href="...">
  for (const m of html.matchAll(/<link\b[^>]*?\bhref="([^"]+)"[^>]*?>/gi)) {
    const ref = m[1];
    const abs = resolve(ref);
    if (abs && /\.(css)(\?|$)/i.test(abs)) add("css", ref, abs);
    else if (abs && /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(abs))
      add("font", ref, abs);
    else if (abs && /fonts\.googleapis\.com/i.test(abs)) add("css", ref, abs);
  }
  // <script src="...">
  for (const m of html.matchAll(/<script\b[^>]*?\bsrc="([^"]+)"[^>]*>/gi)) {
    const abs = resolve(m[1]);
    if (abs) add("js", m[1], abs);
  }
  // <img src="..."> and srcset
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"[^>]*>/gi)) {
    const abs = resolve(m[1]);
    if (abs) add("image", m[1], abs);
  }
  for (const m of html.matchAll(/srcset="([^"]+)"/gi)) {
    for (const cand of m[1].split(",")) {
      const ref = cand.trim().split(/\s+/)[0];
      const abs = resolve(ref);
      if (abs) add("image", ref, abs);
    }
  }
  // <video src> / <source src>
  for (const m of html.matchAll(
    /<(?:video|source|audio)\b[^>]*?\bsrc="([^"]+)"[^>]*>/gi,
  )) {
    const abs = resolve(m[1]);
    if (abs) add("media", m[1], abs);
  }
  // CSS url(...) inside <style> blocks
  for (const m of html.matchAll(/<style[\s\S]*?<\/style>/gi)) {
    for (const u of m[0].matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      const abs = resolve(u[1]);
      if (abs && !u[1].startsWith("data:")) add("css-asset", u[1], abs);
    }
  }
  // <a href> for crawl queue (internal links)
  const internalLinks = new Set();
  const origin = new URL(baseURL).origin;
  for (const m of html.matchAll(/<a\b[^>]*?\bhref="([^"]+)"/gi)) {
    const abs = resolve(m[1]);
    if (!abs) continue;
    if (!abs.startsWith(origin)) continue;
    // Skip anchor-only links and assets
    if (/\.(pdf|zip|exe|dmg|tar|gz|7z)(\?|$)/i.test(abs)) continue;
    if (/^#/.test(m[1])) continue;
    internalLinks.add(new URL(abs).pathname);
  }

  return { assets: found, internalLinks };
}

function localPathForAsset(absURL, kind, counters) {
  const u = new URL(absURL);
  const ext = path.extname(u.pathname).slice(1).toLowerCase() || "bin";
  const dirFor = {
    css: "css",
    js: "js",
    image: "images",
    font: "fonts",
    media: "media",
    "css-asset": "images",
  };
  const dir = dirFor[kind] || "assets";
  // Stable hashed filename to avoid collisions across query-string variants.
  const hash = crypto
    .createHash("md5")
    .update(absURL)
    .digest("hex")
    .slice(0, 8);
  const base = path.basename(u.pathname).replace(/[^a-z0-9._-]/gi, "_");
  const filename = base && base !== "/" ? `${hash}-${base}` : `${hash}.${ext}`;
  return `/${dir}/${filename}`;
}

async function downloadAll(absURLs, outDir, urlMap, kindByURL) {
  let done = 0;
  let failed = 0;
  const queue = [...absURLs];
  const workers = [];
  // Honor the (adaptive or forced) concurrency at LAUNCH time. If rate-
  // limiting kicks in mid-download, in-flight workers each see the new
  // rateState.spaceMs sleep via maybeSpace() on their next fetch. Workers
  // started here keep running but each fetch is throttled. This is simpler
  // than a dynamic worker count and good enough for adaptive behavior.
  const initialConcurrency = Math.max(1, effectiveConcurrency());
  for (let i = 0; i < initialConcurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const u = queue.shift();
          if (!u) break;
          const localPath = urlMap[u];
          if (!localPath) continue;
          const fullPath = path.join(outDir, localPath.replace(/^\//, ""));
          if (fs.existsSync(fullPath)) {
            done++;
            continue;
          }
          try {
            const res = await fetchURL(u);
            if (res.status >= 400) {
              failed++;
              continue;
            }
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, res.body);
            // For CSS files, recursively extract url(...) refs and download
            if (kindByURL[u] === "css") {
              const cssText = res.body.toString("utf-8");
              for (const m of cssText.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
                if (m[1].startsWith("data:")) continue;
                try {
                  const sub = new URL(m[1], u).toString();
                  if (!urlMap[sub]) {
                    urlMap[sub] = localPathForAsset(sub, "image", null);
                    queue.push(sub);
                    kindByURL[sub] = "css-asset";
                  }
                } catch {}
              }
            }
            done++;
          } catch (e) {
            failed++;
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return { done, failed };
}

function rewriteHTML(html, urlMap) {
  // For each absolute URL, also generate the path-only and
  // origin+path forms so we match however the HTML references it. Most
  // SSR frameworks emit relative paths like /_next/static/... not the
  // absolute version — this is the source of the original bug where
  // assets downloaded but weren't linked.
  const expanded = {};
  for (const [orig, local] of Object.entries(urlMap)) {
    expanded[orig] = local;
    try {
      const u = new URL(orig);
      expanded[u.pathname + u.search] = local;
      expanded[u.pathname] = local;
      expanded[u.origin + u.pathname + u.search] = local;
      expanded[u.origin + u.pathname] = local;
      // Also handle &amp; encoded ampersands in query strings (HTML)
      if (u.search.includes("&")) {
        expanded[u.pathname + u.search.replace(/&/g, "&amp;")] = local;
      }
    } catch {}
  }
  // Replace longest first so /foo/bar doesn't get clobbered by /foo.
  const entries = Object.entries(expanded).sort(
    (a, b) => b[0].length - a[0].length,
  );
  let out = html;
  for (const [orig, local] of entries) {
    if (!out.includes(orig)) continue;
    out = out.split(orig).join(local);
  }
  return out;
}

// ─── Universal page enumeration (X-ray) ────────────────────────────────
//
// Don't hand-code one adapter per framework. Try a list of common patterns
// in parallel and use whichever ones answer. Each probe is independent;
// success/failure on one doesn't affect the others. This catches:
//   - sitemap.xml / sitemap_index.xml / robots.txt Sitemap directives
//   - RSS / Atom feeds (blogs, content sites)
//   - WordPress / Strapi / Sanity-style JSON APIs
//   - Shopify products/collections JSON
//   - Next.js __NEXT_DATA__ + _buildManifest.js
//   - Any inline <script type="application/json"> or window.__INITIAL_STATE__
//   - HTML link references on the homepage
//
// detectFramework remains for INFORMATIONAL output ("this looks like Next.js"),
// not for enumeration logic. Whatever the framework, the universal probes
// will pick up its routes.

function detectFramework(html) {
  if (!html) return null;
  const checks = [
    { kind: "next", re: /<script id="__NEXT_DATA__"|\/_next\/static\// },
    { kind: "nuxt", re: /window\.__NUXT__|<div id="__nuxt">/ },
    {
      kind: "astro",
      re: /<meta\s+name=["']generator["']\s+content=["']Astro|<astro-island|data-astro-cid-/i,
    },
    {
      kind: "wordpress",
      re: /<meta\s+name=["']generator["']\s+content=["']WordPress|\/wp-content\/|\/wp-json\//i,
    },
    { kind: "hugo", re: /<meta\s+name=["']generator["']\s+content=["']Hugo/i },
    { kind: "gatsby", re: /<div id="___gatsby">|\/page-data\// },
    { kind: "shopify", re: /cdn\.shopify\.com|window\.Shopify/ },
    {
      kind: "webflow",
      re: /<html[^>]*\bdata-wf-(?:page|site)="|<script[^>]+webflow\.js/i,
    },
    {
      kind: "squarespace",
      re: /static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/,
    },
  ];
  for (const c of checks) {
    if (c.re.test(html)) return { kind: c.kind, evidence: c.re.toString() };
  }
  return null;
}

// Recursively walk a parsed JSON object collecting any string values that
// look like routes on this origin. Generalizes WordPress' .link field,
// Shopify's .handle, Sanity's .slug, Next.js' page strings, etc. — any
// framework that exposes content as JSON ships its URLs somewhere in there.
function extractRoutesFromJSON(node, origin, routes, depth = 0) {
  if (depth > 12 || !node) return;
  if (typeof node === "string") {
    // Pathname starting with / (and not //, not /_next/static asset)
    if (
      /^\/(?!\/|_next\/static\/|_nuxt\/|_astro\/|assets\/|wp-content\/|api\/)[^"<>{}|\\^`\s]+$/.test(
        node,
      ) &&
      !/\.(js|css|woff2?|ttf|otf|png|jpe?g|gif|webp|svg|ico|mp4|webm|json|xml|map)(\?|$)/i.test(
        node,
      )
    ) {
      routes.add(node.split("#")[0]); // strip fragment
    } else if (/^https?:/.test(node)) {
      try {
        const u = new URL(node);
        if (u.origin === origin) routes.add(u.pathname);
      } catch {}
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node)
      extractRoutesFromJSON(item, origin, routes, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node))
      extractRoutesFromJSON(v, origin, routes, depth + 1);
  }
}

async function probeJSONEndpoint(url, origin) {
  try {
    const res = await fetchURL(url);
    if (res.status >= 400) return [];
    const ct = (res.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("json") && !res.body.toString("utf-8", 0, 1).match(/[{[]/))
      return [];
    let data;
    try {
      data = JSON.parse(res.body.toString("utf-8"));
    } catch {
      return [];
    }
    const routes = new Set();
    extractRoutesFromJSON(data, origin, routes);
    return [...routes];
  } catch {
    return [];
  }
}

async function probeXMLEndpoint(url, origin) {
  try {
    const res = await fetchURL(url);
    if (res.status >= 400) return [];
    const xml = res.body.toString("utf-8");
    const routes = new Set();
    // sitemap.xml <loc>...</loc>
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
      try {
        const u = new URL(m[1]);
        if (u.origin === origin) routes.add(u.pathname);
      } catch {}
    }
    // sitemap index: <sitemap><loc>...</loc></sitemap> — already captured.
    // Atom/RSS: <link href="..."/> or <link>...</link>
    for (const m of xml.matchAll(/<link[^>]*\bhref="([^"]+)"/gi)) {
      try {
        const u = new URL(m[1], origin);
        if (u.origin === origin) routes.add(u.pathname);
      } catch {}
    }
    for (const m of xml.matchAll(/<link>([^<]+)<\/link>/gi)) {
      try {
        const u = new URL(m[1], origin);
        if (u.origin === origin) routes.add(u.pathname);
      } catch {}
    }
    return [...routes];
  } catch {
    return [];
  }
}

// robots.txt may list one or more Sitemap: URLs. Fetch each and union.
async function probeRobotsTxt(origin) {
  try {
    const res = await fetchURL(origin + "/robots.txt");
    if (res.status >= 400) return [];
    const body = res.body.toString("utf-8");
    const sitemapURLs = [...body.matchAll(/sitemap:\s*(\S+)/gi)]
      .map((m) => m[1])
      .filter((u) => u.startsWith("http"));
    const results = await Promise.all(
      sitemapURLs.map((u) => probeXMLEndpoint(u, origin)),
    );
    return [...new Set(results.flat())];
  } catch {
    return [];
  }
}

// Inline JSON blobs in the HTML. Covers __NEXT_DATA__, __NUXT__,
// __INITIAL_STATE__, and any <script type="application/json"> block.
function extractInlineJSONRoutes(html, origin) {
  const routes = new Set();
  // <script id="__NEXT_DATA__" type="application/json">...</script>
  // <script type="application/json" ...>...</script>
  // <script type="application/ld+json">...</script>
  const scripts = [
    ...html.matchAll(
      /<script\b[^>]*\btype="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi,
    ),
    ...html.matchAll(
      /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  for (const m of scripts) {
    try {
      extractRoutesFromJSON(JSON.parse(m[1]), origin, routes);
    } catch {}
  }
  // window.__NUXT__ = { ... };
  // window.__INITIAL_STATE__ = { ... };
  for (const m of html.matchAll(
    /window\.__(?:NUXT|INITIAL_STATE|APOLLO_STATE|PRELOADED_STATE|REDUX_STATE)__\s*=\s*([\s\S]*?);\s*<\/script>/g,
  )) {
    try {
      // The expression might be an inline-evaluated JS object — strip to JSON-ish
      const cleaned = m[1].replace(/^\(?(.*?)\)?$/s, "$1");
      extractRoutesFromJSON(JSON.parse(cleaned), origin, routes);
    } catch {}
  }
  return [...routes];
}

// Next.js _buildManifest is JS, not JSON — regex-extract the route keys.
async function probeNextBuildManifest(origin, html) {
  const m = html.match(
    /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) return [];
  let buildId;
  try {
    buildId = JSON.parse(m[1]).buildId;
  } catch {
    return [];
  }
  if (!buildId) return [];
  try {
    const res = await fetchURL(
      `${origin}/_next/static/${buildId}/_buildManifest.js`,
    );
    if (res.status >= 400) return [];
    const body = res.body.toString("utf-8");
    const routes = new Set();
    for (const m of body.matchAll(/"(\/[^"]*)":/g)) {
      const r = m[1];
      if (
        r &&
        !r.startsWith("/_next/") &&
        !r.startsWith("//") &&
        !r.includes("[")
      )
        routes.add(r);
    }
    return [...routes];
  } catch {
    return [];
  }
}

async function enumeratePages(html, baseURL) {
  const origin = new URL(baseURL).origin;
  const enumerated = new Set();
  enumerated.add(new URL(baseURL).pathname || "/");

  // Run every probe in parallel — most return [] for sites that don't match
  // their pattern; that's expected. The fastest probes (sitemap, inline
  // JSON) usually answer in < 200ms. JSON API probes time out cleanly
  // when not present.
  const xmlEndpoints = [
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/sitemap-1.xml",
    "/sitemap-pages.xml",
    "/sitemap-posts.xml",
    "/sitemap-index.xml",
    "/feed",
    "/feed.xml",
    "/rss",
    "/rss.xml",
    "/atom.xml",
    "/index.xml",
  ];
  const jsonEndpoints = [
    // WordPress
    "/wp-json/wp/v2/posts?per_page=100&_fields=link",
    "/wp-json/wp/v2/pages?per_page=100&_fields=link",
    // Generic
    "/api/pages",
    "/api/posts",
    "/api/content",
    "/api/routes",
    "/api/v1/pages",
    "/api/v1/posts",
    // Shopify
    "/products.json?limit=250",
    "/collections.json?limit=250",
    // Sanity, Strapi, Ghost (common patterns)
    "/api/content/posts",
    "/api/content/pages",
    "/ghost/api/v3/content/posts",
  ];

  const probes = [
    ...xmlEndpoints.map((p) => probeXMLEndpoint(origin + p, origin)),
    ...jsonEndpoints.map((p) => probeJSONEndpoint(origin + p, origin)),
    probeRobotsTxt(origin),
    probeNextBuildManifest(origin, html),
    Promise.resolve(extractInlineJSONRoutes(html, origin)),
  ];
  const results = await Promise.allSettled(probes);
  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value))
      for (const route of r.value) enumerated.add(route);
  }

  // Always also harvest <a href> from the homepage as a baseline so we
  // don't miss anything when no API works.
  for (const m of html.matchAll(/<a\b[^>]*?\bhref="([^"]+)"/gi)) {
    try {
      const abs = new URL(m[1], baseURL);
      if (abs.origin === origin) enumerated.add(abs.pathname);
    } catch {}
  }

  // Filter non-HTML routes (sitemap files, feeds, asset extensions).
  const SKIP_RE =
    /\.(xml|json|rss|atom|txt|pdf|zip|tar|gz|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|mov|wav|mp3|map)(\?|$)/i;
  return [...enumerated].filter((p) => !SKIP_RE.test(p));
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  // --rate <N>: manual concurrency override (1 = serial, 12 = default parallel).
  // When set, the adaptive downgrade does NOT fire — user is in charge.
  const rateIdx = args.indexOf("--rate");
  if (rateIdx >= 0 && args[rateIdx + 1]) {
    const n = parseInt(args[rateIdx + 1]);
    if (Number.isFinite(n) && n > 0) {
      rateState.forced = Math.min(32, n);
      rateState.current = rateState.forced;
      if (rateState.forced === 1) rateState.spaceMs = 250;
    }
  }
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--rate"),
  );
  if (positional.length < 1) {
    console.log(
      `xray-static — HTTP-only clone for static-rendered sites.

Usage: node xray-static.js <url> [out-dir] [max-pages] [--force] [--rate <N>]

Defaults: out-dir=/tmp/xray-static-<host>, max-pages=20.
--force        Clone even if the site looks like a SPA shell.
--rate <N>     Force concurrency (1 = serial w/ 250ms spacing, 12 = parallel).
               Without --rate the tool stays parallel and only downgrades to
               serial after detecting rate-limiting (429/503/403/timeouts).`,
    );
    process.exit(1);
  }
  const targetURL = positional[0];
  const parsed = new URL(targetURL);
  const outDir =
    positional[1] || `/tmp/xray-static-${parsed.hostname.replace(/\./g, "-")}`;
  const maxPages = parseInt(positional[2]) || 20;

  console.log(`\n🩻 xray-static`);
  console.log(`   ${targetURL} → ${outDir}`);
  console.log(
    `   max-pages: ${maxPages}${rateState.forced !== null ? `, rate: ${rateState.forced}` : ""}\n`,
  );

  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();

  // Step 1: fetch homepage, check static-enough
  let homeRes;
  try {
    homeRes = await fetchURL(targetURL);
  } catch (e) {
    console.error(`  ❌ ${e.message}`);
    process.exit(1);
  }
  if (homeRes.status >= 400) {
    console.error(`  ❌ status ${homeRes.status}`);
    process.exit(1);
  }
  const homeHTML = homeRes.body.toString("utf-8");
  const detection = isStaticEnough(homeHTML);
  if (!detection.ok && !force) {
    console.log(
      `  ⚠  not static-enough: ${detection.reason}\n  Use --force to clone anyway, or switch to: node v54-stable.js ${targetURL}`,
    );
    process.exit(2);
  }
  console.log(
    `  ✓ static-enough (${detection.textLen || visibleTextLen(homeHTML)} bytes of visible text)`,
  );

  // Framework introspection — sniff signature, then ask the framework
  // itself "what pages do you have?" via its build manifest / JSON API /
  // sitemap. Catches pages not linked from the homepage and skips dozens
  // of HTTP hops worth of HTML-link discovery.
  const framework = detectFramework(homeHTML);
  if (framework) console.log(`  🔍 framework: ${framework.kind}`);
  const seedRoutes = await enumeratePages(homeHTML, targetURL);
  if (seedRoutes.length > 1) {
    console.log(`  🗺️  enumerated ${seedRoutes.length} pages`);
  }

  // Step 2: crawl + asset collection
  const urlMap = {}; // absoluteURL → localPath
  const kindByURL = {}; // absoluteURL → "css" | "js" | ...
  const visited = new Set();
  const pageQueue = [...seedRoutes];
  const pages = []; // { path, html }
  while (pageQueue.length > 0 && pages.length < maxPages) {
    const p = pageQueue.shift();
    if (visited.has(p)) continue;
    visited.add(p);
    let res;
    const fullURL = new URL(p, targetURL).toString();
    try {
      res = await fetchURL(fullURL);
    } catch (e) {
      console.log(`     ❌ ${p}: ${e.message.slice(0, 60)}`);
      continue;
    }
    if (res.status >= 400) {
      console.log(`     ❌ ${p}: HTTP ${res.status}`);
      continue;
    }
    const html = res.body.toString("utf-8");
    const { assets, internalLinks } = extractAssets(html, fullURL);
    for (const [absURL, info] of assets) {
      if (!urlMap[absURL]) {
        urlMap[absURL] = localPathForAsset(absURL, info.kind, null);
        kindByURL[absURL] = info.kind;
      }
    }
    for (const link of internalLinks) {
      if (!visited.has(link)) pageQueue.push(link);
    }
    pages.push({ path: p, html });
    console.log(
      `  📄 ${p}  (${(html.length / 1024).toFixed(0)}KB, ${assets.size} assets, ${internalLinks.size} links)`,
    );
  }

  // Step 3: download assets in parallel
  const assetURLs = Object.keys(urlMap);
  console.log(`\n  ⬇️  downloading ${assetURLs.length} assets...`);
  const dl = await downloadAll(assetURLs, outDir, urlMap, kindByURL);
  console.log(`     ${dl.done} ok, ${dl.failed} failed`);

  // Step 4: rewrite + write pages
  console.log(`\n  📝 rewriting + writing ${pages.length} pages...`);
  for (const { path: p, html } of pages) {
    const rewritten = rewriteHTML(html, urlMap);
    const out =
      p === "/" || p === ""
        ? path.join(outDir, "index.html")
        : path.join(outDir, p.replace(/^\//, ""), "index.html");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, rewritten);
  }

  // Step 5: write a manifest.json compatible with score-clone
  const dataDir = path.join(outDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "manifest.json"),
    JSON.stringify(
      {
        version: "xray-static",
        url: targetURL,
        domain: parsed.origin,
        crawledAt: new Date().toISOString(),
        pages: pages.map((p) => p.path),
        pageCount: pages.length,
        assets: Object.keys(urlMap).length,
        clonedBy: "xray-static.js",
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dataDir, "url-map.json"),
    JSON.stringify(urlMap, null, 2),
  );

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n  ✅ done in ${dt}s — ${pages.length} pages, ${dl.done} assets`,
  );
  console.log(`     cd ${outDir} && python3 -m http.server 3035\n`);
}

main().catch((e) => {
  console.error("Error:", e.stack || e.message);
  process.exit(1);
});
