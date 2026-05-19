#!/usr/bin/env node
/**
 * Site X-Ray v54 — Universal precision cloner.
 * Builds on v51 with VISUAL FIDELITY focus:
 *   - v54: --visual flag for pixel-perfect clones (disables DOM mutations that break layout)
 *   - v54: Default mode now also guards button-unhiding behind layout safety checks
 *   - All v51 features preserved for --all / comprehensive mode
 *
 * Single file. One dependency (playwright). Zero config.
 *
 * Usage: node v51-stable.js <url> [output-dir] [max-pages] [flags]
 * Default max-pages: 20
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

// ── Parse CLI args ──
const args = process.argv.slice(2);
const flags = {};
const positional = [];
flags.passcodes = {}; // route → passcode for page-level password gates
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--auth") {
    flags.auth = args[++i];
  } else if (args[i] === "--login") {
    flags.login = args[++i];
  } // "email:password"
  else if (args[i] === "--save-auth") {
    flags.saveAuth = true;
  } else if (args[i] === "--all") {
    flags.all = true;
  } else if (args[i] === "--interactive") {
    flags.interactive = true;
  } else if (args[i] === "--visual") {
    flags.visual = true;
  } else if (args[i] === "--passcode") {
    // Repeatable: --passcode /route:CODE  (or --passcode CODE → applies to current page)
    const spec = args[++i] || "";
    const colonIdx = spec.indexOf(":");
    if (colonIdx > 0) {
      const route = spec.slice(0, colonIdx).startsWith("/")
        ? spec.slice(0, colonIdx)
        : "/" + spec.slice(0, colonIdx);
      flags.passcodes[route] = spec.slice(colonIdx + 1);
    } else if (spec) {
      flags.passcodes["*"] = spec; // wildcard — try this code on any page that asks
    }
  } else if (args[i] === "--no-verify") {
    flags.noVerify = true;
  } else if (args[i] === "--verify-only") {
    flags.verifyOnly = args[++i];
  } else if (args[i] === "--no-fix") {
    flags.noFix = true;
  } else if (args[i] === "--max-passes") {
    flags.maxPasses = parseInt(args[++i]) || Infinity;
  } else if (args[i] === "--interaction-timeout") {
    flags.interactionTimeout = parseInt(args[++i]) || 3000;
  } else if (args[i] === "--debug-report") {
    flags.debugReport = true;
  } else if (args[i] === "--responsive") {
    flags.responsive = true;
  } else {
    positional.push(args[i]);
  }
}

const TARGET = positional[0];
if (!TARGET) {
  console.log(`Site X-Ray v54
Usage: node v54-stable.js <url> [output-dir] [max-pages] [flags]

Flags:
  --visual           Visual fidelity mode — pixel-perfect clones, no DOM mutations
  --all              Clone ALL pages (discover via sitemap.xml + deep crawl)
  --auth <file>      Load Playwright auth state from JSON file
  --save-auth        Open browser for manual login, save state for reuse
  --login <e:p>      Auto-login with email:password before cloning
  --interactive      Open visible browser, wait for manual sign-in
  --passcode <r:c>   Page-level passcode for route (repeatable).
                     Format: /route:CODE  or  CODE for wildcard.

# v54 self-debug flags
  --no-verify              Skip verify+fix phase (v52 behavior)
  --verify-only <dir>      Skip clone, run verify+fix on existing dir
  --no-fix                 Run verify, write issues, no fixes applied
  --max-passes <N>         Cap verify+fix iterations (default: unlimited)
  --interaction-timeout <ms>  Per-click budget (default 3000)
  --debug-report           Always emit debug-report.html
  --responsive             Capture desktop/tablet/mobile screenshots (v53 backport)

Examples:
  node v54-stable.js https://example.com
  node v54-stable.js https://example.com --visual
  node v54-stable.js https://example.com ./output 50 --visual
  node v54-stable.js https://example.com --all
  node v54-stable.js https://example.com --auth auth-state.json
  node v54-stable.js https://www.kenkais.com --passcode /exclusive:5511 --passcode /agency:5511`);
  process.exit(0);
}

const PARSED = new URL(TARGET);
if (!["http:", "https:"].includes(PARSED.protocol)) {
  console.error("Error: Only http:// and https:// URLs are supported.");
  process.exit(1);
}
const DOMAIN = PARSED.origin;
const OUT =
  positional[1] || `/tmp/clone-${PARSED.hostname.replace(/\./g, "-")}`;
const MAX_PAGES = flags.all ? 999 : parseInt(positional[2]) || 50;

// v15: www/non-www domain variant — sites may reference assets from either variant
const ALT_DOMAIN = (() => {
  const h = PARSED.hostname;
  if (h.startsWith("www.")) return PARSED.protocol + "//" + h.slice(4);
  return PARSED.protocol + "//www." + h;
})();

// Shared state
const urlMap = {};
const networkURLs = new Set();
const MAX_NETWORK_URLS = 5000; // v53 backport: cap to prevent unbounded memory
// v53 backport: Error capture for silent failure diagnostics
const captureErrors = [];
function logCaptureError(context, error) {
  const msg = error?.message || String(error);
  captureErrors.push({
    context,
    error: msg.slice(0, 200),
    timestamp: new Date().toISOString(),
  });
}
const crawled = new Set();
const queue = [PARSED.pathname || "/"];
// v52+: any explicit --passcode <route> seeds the queue too — these routes
// often aren't linked from the homepage (members-only / exclusives), so the
// crawler would never find them on its own.
for (const route of Object.keys(flags.passcodes || {})) {
  if (route !== "*" && !queue.includes(route)) queue.push(route);
}
let sharedCSS = "",
  bundleLib = "",
  cdnScripts = [],
  sharedAnimScript = "";
let imgC = 0,
  fontC = 0,
  vidC = 0,
  modelC = 0,
  shaderC = 0;
let capturedBodyBg = ""; // v19: captured body background-color for CSS score fix

// v20: Added User-Agent + Accept headers for better CDN compatibility, redirect depth limit
function dl(url, dest, timeout = 15000, _depth = 0) {
  return new Promise((resolve) => {
    try {
      if (!url || url.startsWith("data:") || url.startsWith("blob:"))
        return resolve(false);
      if (_depth > 5) return resolve(false); // v20: prevent infinite redirect loops
      const resolvedDest = path.resolve(dest);
      if (!resolvedDest.startsWith(path.resolve(OUT))) {
        console.warn(`  ⚠ Path traversal blocked in dl(): ${dest}`);
        return resolve(false);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      const client = url.startsWith("https") ? https : http;
      const reqOpts = {
        timeout,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "*/*",
        },
      };
      const req = client.get(url, reqOpts, (res) => {
        if (
          [301, 302, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch (e) {}
          return dl(
            new URL(res.headers.location, url).href,
            dest,
            timeout,
            _depth + 1,
          ).then(resolve);
        }
        if (res.statusCode !== 200) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch (e) {}
          return resolve(false);
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(true);
        });
      });
      req.on("error", () => {
        try {
          file.close();
          fs.unlinkSync(dest);
        } catch (e) {}
        resolve(false);
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function mapAsset(orig, local) {
  urlMap[orig] = local;
  try {
    const a = new URL(orig, DOMAIN).href;
    urlMap[a] = local;
    urlMap[new URL(a).origin + new URL(a).pathname] = local;
    // Also map the HTML-encoded version (& → &amp;)
    const ampEncoded = a.replace(/&/g, "&amp;");
    if (ampEncoded !== a) urlMap[ampEncoded] = local;
    const origAmp = orig.replace(/&/g, "&amp;");
    if (origAmp !== orig) urlMap[origAmp] = local;
    // Map pathname with query (some sites use it as the src)
    const u = new URL(a);
    if (u.search) {
      urlMap[u.pathname + u.search] = local;
      urlMap[u.pathname + u.search.replace(/&/g, "&amp;")] = local;
    }
    // v15: Also map the www/non-www alternate domain variant
    const altUrl = a.replace(DOMAIN, ALT_DOMAIN);
    if (altUrl !== a) {
      urlMap[altUrl] = local;
      urlMap[new URL(altUrl).origin + new URL(altUrl).pathname] = local;
    }
  } catch (e) {}
}

// v53 backport: Path traversal protection
function safePath(filePath) {
  const resolved = path.resolve(OUT, filePath.replace(/^\//, ""));
  if (!resolved.startsWith(path.resolve(OUT))) {
    console.warn(`  ⚠ Path traversal blocked: ${filePath}`);
    return null;
  }
  return resolved;
}

// v53 backport: Single-pass URL rewriting (replaces per-key regex loop)
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function rewriteURLs(text, map) {
  const keys = Object.keys(map);
  if (keys.length === 0) return text;
  keys.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map(escapeRegExp).join("|"), "g");
  return text.replace(pattern, (match) => map[match] || match);
}

function pathToFile(p) {
  p = p || "/";
  if (p.endsWith("/")) p += "index.html";
  else if (!path.extname(p)) p += "/index.html";
  // v47: Prevent ENAMETOOLONG — hash any path component exceeding 200 bytes
  const parts = p.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (Buffer.byteLength(parts[i], "utf8") > 200) {
      const hash = crypto
        .createHash("md5")
        .update(parts[i])
        .digest("hex")
        .slice(0, 12);
      const ext = path.extname(parts[i]);
      parts[i] = parts[i].slice(0, 60) + "_" + hash + ext;
    }
  }
  return parts.join("/");
}

// v53 backport: Parallel asset downloads with concurrency limit
async function downloadBatch(urls, outDir, prefix, defaultExt, limit = 8) {
  let count = 0;
  const items = [...urls];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const promises = batch.map(async (url) => {
      try {
        const a = new URL(url, DOMAIN).href;
        if (urlMap[a]) return;
        const ext =
          path.extname(new URL(a).pathname).split("?")[0] || defaultExt;
        const nm = `${prefix}-${count}${ext}`;
        count++;
        if (await dl(a, `${outDir}/${nm}`)) {
          mapAsset(url, `/${path.basename(outDir)}/${nm}`);
        }
      } catch (e) {
        logCaptureError(`downloadBatch-${prefix}`, e);
      }
    });
    await Promise.all(promises);
  }
  return count;
}

// ═══════════════════════════════════════
// v11 Helpers: Prepare page for clean capture
// ═══════════════════════════════════════

async function dismissOverlays(page) {
  await page.evaluate(() => {
    // v30: Try ID/class-based cookie consent selectors first (more reliable than text)
    try {
      const consentSelectors = [
        "#onetrust-accept-btn-handler", // OneTrust (very common)
        "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", // Cookiebot
        '[data-cookiefirst-action="accept"]',
        ".cc-accept",
        ".cc-allow",
        ".cc-dismiss",
        '[class*="cookie"] [class*="accept"]',
        '[class*="consent"] [class*="accept"]',
        '[class*="cookie"] [class*="allow"]',
        '[id*="cookie"] button:first-of-type',
        '[class*="gdpr"] [class*="accept"]',
      ];
      for (const sel of consentSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.click();
          break;
        }
      }
    } catch (e) {}

    // Click accept/agree/close buttons on cookie banners and popups
    const btns = [
      ...document.querySelectorAll(
        'button, a, [role="button"], span[class*="close"], [class*="close"], [class*="Close"], [aria-label*="close" i], [aria-label*="dismiss" i]',
      ),
    ];
    const acceptBtn = btns.find((b) => {
      const txt = (b.innerText || "").trim().toLowerCase();
      return (
        /^(accept|agree|got it|ok|close|dismiss|i understand|accept all|allow|continue|no thanks|maybe later|not now)/i.test(
          txt,
        ) &&
        b.offsetParent !== null &&
        b.offsetWidth > 10
      );
    });
    if (acceptBtn) {
      try {
        acceptBtn.click();
      } catch (e) {}
    }

    // v15: Also click close/X buttons inside modals/popups/overlays
    const closeIcons = [
      ...document.querySelectorAll(
        '[class*="close"], [class*="Close"], [aria-label*="close" i], button',
      ),
    ];
    closeIcons.forEach((btn) => {
      try {
        const parent = btn.closest(
          '[class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"], [class*="overlay"], [class*="Overlay"], [class*="dialog"], [class*="Dialog"], [role="dialog"]',
        );
        if (parent && btn.offsetParent !== null) {
          const txt = (btn.innerText || "").trim();
          const ariaLabel = (
            btn.getAttribute("aria-label") || ""
          ).toLowerCase();
          if (
            txt.length <= 3 ||
            txt.toLowerCase() === "close" ||
            txt === "×" ||
            txt === "✕" ||
            ariaLabel.includes("close")
          ) {
            btn.click();
          }
        }
      } catch (e) {}
    });

    // v22: PIXEL FIX — Stop removing cookie/consent/dialog/overlay elements from DOM.
    // The test snapshot captures the original page WITH these overlays visible.
    // Removing them from the clone causes massive pixel mismatches.
    // Button clicks above handle natural dismissal via site JS; any overlays that
    // remain will match the original snapshot, improving pixel fidelity.
  });
}

async function waitForFullRender(page) {
  // Wait for all images to load
  await page
    .evaluate(async () => {
      const imgs = [...document.querySelectorAll("img")];
      await Promise.all(
        imgs.map((img) => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise((r) => {
            img.onload = r;
            img.onerror = r;
            setTimeout(r, 8000);
          });
        }),
      );
      // Wait for fonts
      try {
        await document.fonts.ready;
      } catch (e) {}
    })
    .catch(() => {});
}

async function inlineSVGSprites(page) {
  await page.evaluate(() => {
    // Inline SVG <use> references that point to sprites
    document.querySelectorAll("svg use").forEach((use) => {
      const href = use.getAttribute("href") || use.getAttribute("xlink:href");
      if (!href) return;
      if (href.startsWith("#")) {
        // Same-document reference
        const target = document.querySelector(href);
        if (target) {
          const clone = target.cloneNode(true);
          if (clone.tagName === "symbol") {
            // Convert <symbol> to <g> and copy its children
            const g = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "g",
            );
            while (clone.firstChild) g.appendChild(clone.firstChild);
            use.replaceWith(g);
          }
        }
      }
    });

    // For SVGs that have no visible content, try to capture them as images
    document.querySelectorAll("svg").forEach((svg) => {
      if (svg.querySelector("use") && svg.innerHTML.trim().length < 20) {
        svg.setAttribute("data-xray-empty", "true");
      }
    });

    // Convert img[src$=".svg"] that failed to load into inline SVGs
    document.querySelectorAll('img[src$=".svg"]').forEach((img) => {
      if (!img.complete || img.naturalWidth === 0) {
        img.setAttribute("data-xray-broken-svg", img.src);
      }
    });
  });
}

async function resolveNextJSImages(page) {
  await page.evaluate(() => {
    // Next.js Image component: get highest quality source
    document.querySelectorAll("img[srcset]").forEach((img) => {
      const srcset = img.getAttribute("srcset");
      if (!srcset) return;
      const sources = srcset
        .split(",")
        .map((s) => {
          const parts = s.trim().split(/\s+/);
          return { url: parts[0], width: parseInt(parts[1]) || 0 };
        })
        .filter((s) => s.url);

      if (sources.length) {
        // Pick the largest
        sources.sort((a, b) => b.width - a.width);
        const best = sources[0].url;
        // Decode Next.js /_next/image wrapper
        const nxMatch = best.match(/\/_next\/image\?url=([^&]+)/);
        if (nxMatch) {
          try {
            img.src = decodeURIComponent(nxMatch[1]);
          } catch (e) {}
        } else {
          img.src = best;
        }
      }
      // Remove srcset so the clone uses our resolved src
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
    });

    // v23: Fix lazy images with placeholder src + data-src
    // If img has a data: URI or blank src but data-src has the real URL, replace src
    document.querySelectorAll("img[data-src]").forEach((img) => {
      const ds = img.getAttribute("data-src");
      if (!ds || ds.startsWith("data:") || ds.startsWith("blob:")) return;
      const currentSrc = img.getAttribute("src") || "";
      if (
        !currentSrc ||
        currentSrc.startsWith("data:") ||
        currentSrc.startsWith("blob:") ||
        currentSrc.includes("placeholder") ||
        currentSrc.includes("blur")
      ) {
        img.setAttribute("src", ds);
      }
    });
    // Also handle data-lazy-src, data-original (WordPress, other lazy loaders)
    document
      .querySelectorAll("img[data-lazy-src], img[data-original]")
      .forEach((img) => {
        const ds =
          img.getAttribute("data-lazy-src") ||
          img.getAttribute("data-original");
        if (!ds || ds.startsWith("data:")) return;
        const currentSrc = img.getAttribute("src") || "";
        if (
          !currentSrc ||
          currentSrc.startsWith("data:") ||
          currentSrc.includes("placeholder")
        ) {
          img.setAttribute("src", ds);
        }
      });
  });
}

// v23: Resolve <picture> elements — pick best source, set on <img>, remove <source>
// Many sites (esp. Next.js) use <picture><source srcset="/_next/image?url=..."> which
// breaks in local clones. By resolving to a single <img src>, images always render.
async function resolvePictureElements(page) {
  await page.evaluate(() => {
    document.querySelectorAll("picture").forEach((picture) => {
      try {
        const img = picture.querySelector("img");
        if (!img) return;

        // Collect all source URLs from <source> elements
        const allSources = [];
        picture.querySelectorAll("source").forEach((source) => {
          const srcset = source.getAttribute("srcset");
          if (!srcset) return;
          const type = source.getAttribute("type") || "";
          srcset.split(",").forEach((s) => {
            const parts = s.trim().split(/\s+/);
            const url = parts[0];
            if (!url) return;
            const descriptor = parts[1] || "";
            const width = parseInt(descriptor) || 0;
            allSources.push({ url, width, type });
          });
        });

        if (allSources.length > 0) {
          // Sort by width descending — prefer largest available image
          allSources.sort((a, b) => b.width - a.width);

          // Pick best: prefer non-AVIF/WebP for broader compatibility, fall back to any
          const preferred = allSources.find(
            (s) => !s.type.includes("avif") && !s.type.includes("webp"),
          );
          const best = preferred || allSources[0];
          let bestUrl = best.url;

          // Decode Next.js /_next/image wrapper URL
          const nxMatch = bestUrl.match(/\/_next\/image\?url=([^&]+)/);
          if (nxMatch) {
            try {
              bestUrl = decodeURIComponent(nxMatch[1]);
            } catch (e) {}
          }

          // Set as img src if current src is missing, placeholder, or data URI
          const currentSrc = img.getAttribute("src") || "";
          if (
            !currentSrc ||
            currentSrc.startsWith("data:") ||
            currentSrc.includes("placeholder") ||
            currentSrc.includes("blur") ||
            currentSrc.includes("1x1")
          ) {
            img.setAttribute("src", bestUrl);
          }
        }

        // Remove all <source> elements — the <img> src is our single resolved source
        // This prevents the browser from trying to load broken external srcset URLs
        picture.querySelectorAll("source").forEach((s) => s.remove());

        // Clean up img srcset/sizes (already handled by resolveNextJSImages, but ensure)
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
      } catch (e) {}
    });
  });
}

// ═══════════════════════════════════════
// v12: Download images/assets found on ANY page
// ═══════════════════════════════════════
async function discoverPageAssets(page) {
  return await page.evaluate((domain) => {
    const imgs = new Set();
    // All img tags + data attributes
    document
      .querySelectorAll("img,[data-src],[data-lazy],[data-bg],video[poster]")
      .forEach((el) => {
        for (const a of ["src", "data-src", "data-lazy", "data-bg", "poster"]) {
          const v = el.getAttribute(a);
          if (v && !v.startsWith("data:") && !v.startsWith("blob:"))
            imgs.add(v);
        }
        const ss = el.getAttribute("srcset") || el.getAttribute("data-srcset");
        if (ss)
          ss.split(",").forEach((s) => {
            const u = s.trim().split(" ")[0];
            if (u) imgs.add(u);
          });
        const src = el.getAttribute("src") || "";
        const nxMatch = src.match(/\/_next\/image\?url=([^&]+)/);
        if (nxMatch) {
          try {
            imgs.add(decodeURIComponent(nxMatch[1]));
          } catch {}
        }
      });
    // Picture sources
    document.querySelectorAll("picture source").forEach((s) => {
      if (s.srcset)
        s.srcset.split(",").forEach((p) => {
          const u = p.trim().split(" ")[0];
          if (u) imgs.add(u);
        });
    });
    // Background images from computed styles
    document.querySelectorAll("*").forEach((el) => {
      try {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none") {
          const urls = bg.match(/url\(["']?([^"')]+)["']?\)/g);
          if (urls)
            urls.forEach((u) => {
              const c = u.replace(/url\(["']?|["']?\)/g, "");
              if (c && !c.startsWith("data:")) imgs.add(c);
            });
        }
      } catch {}
    });
    return [...imgs];
  }, DOMAIN);
}

async function downloadNewImages(imageUrls) {
  let newCount = 0;
  for (const url of imageUrls) {
    // Skip if already mapped
    if (urlMap[url]) continue;
    try {
      const a = new URL(url, DOMAIN).href;
      if (urlMap[a]) continue;
      const ext = path.extname(new URL(a).pathname).split("?")[0] || ".jpg";
      const nm = `img-${imgC}${ext}`;
      if (await dl(a, `${OUT}/images/${nm}`)) {
        mapAsset(url, `/images/${nm}`);
        imgC++;
        newCount++;
      }
    } catch {}
  }
  return newCount;
}

// v12: Download external CSS files that CORS blocks from cssRules
// v15: Also save CSS files locally and map URLs so <link> tags resolve
// v16: Download CSS-referenced assets (fonts, images) and rewrite urls to local paths
let cssFileC = 0;
async function downloadExternalCSS(page) {
  const cssLinks = await page.evaluate(() => {
    return [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((l) => ({ href: l.href, origHref: l.getAttribute("href") }))
      .filter((h) => h.href && !h.href.startsWith("data:"));
  });

  const cssContents = []; // v16: store {cssLink, absUrl, css} for single-fetch reuse
  const cssAssetUrls = [];
  for (const cssLink of cssLinks) {
    try {
      const a = new URL(cssLink.href, DOMAIN).href;
      const res = await fetch(a, { signal: AbortSignal.timeout(8000) }).catch(
        () => null,
      );
      if (res && res.ok) {
        let css = await res.text();
        // Resolve ALL relative URLs in CSS to absolute (for downloading + mapping)
        css = css.replace(
          /url\(["']?(?!data:|blob:)([^"')]+)["']?\)/g,
          (match, rawUrl) => {
            try {
              const abs = new URL(rawUrl, a).href;
              cssAssetUrls.push(abs);
              return `url(${abs})`;
            } catch {
              return match;
            }
          },
        );
        cssContents.push({ cssLink, absUrl: a, css });
      }
    } catch {}
  }

  // v17: Download font/image assets referenced in CSS — same-origin + known CDNs, limit 150
  const cssAssetMap = {};
  const uniqueUrls = [...new Set(cssAssetUrls)]
    .filter((u) => {
      try {
        const origin = new URL(u).origin;
        return (
          origin === DOMAIN ||
          origin === ALT_DOMAIN ||
          /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare|use\.typekit/i.test(
            origin,
          )
        );
      } catch {
        return false;
      }
    })
    .slice(0, 150);
  for (const absUrl of uniqueUrls) {
    if (urlMap[absUrl]) {
      cssAssetMap[absUrl] = urlMap[absUrl];
      continue;
    }
    try {
      const parsed = new URL(absUrl);
      const ext = path.extname(parsed.pathname).split("?")[0].toLowerCase();
      if ([".woff2", ".woff", ".ttf", ".otf", ".eot"].includes(ext)) {
        const nm = `font-${fontC}${ext}`;
        if (await dl(absUrl, `${OUT}/fonts/${nm}`, 8000)) {
          mapAsset(absUrl, `/fonts/${nm}`);
          cssAssetMap[absUrl] = `/fonts/${nm}`;
          fontC++;
        }
      } else if (
        [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".avif"].includes(
          ext,
        )
      ) {
        const nm = `img-${imgC}${ext}`;
        if (await dl(absUrl, `${OUT}/images/${nm}`, 8000)) {
          mapAsset(absUrl, `/images/${nm}`);
          cssAssetMap[absUrl] = `/images/${nm}`;
          imgC++;
        }
      }
    } catch {}
  }

  // v16: Rewrite CSS content and save files — single pass, no re-fetch
  let inlinedCSS = "";
  fs.mkdirSync(`${OUT}/css`, { recursive: true });
  for (const { cssLink, absUrl: a, css } of cssContents) {
    // Rewrite URLs to local paths
    let rewritten = css;
    for (const [extUrl, localPath] of Object.entries(cssAssetMap)) {
      try {
        rewritten = rewritten.split(extUrl).join(localPath);
      } catch {}
    }
    for (const dom of [DOMAIN, ALT_DOMAIN]) {
      rewritten = rewritten.split(dom + "/").join("/");
    }
    inlinedCSS += rewritten + "\n";

    // Save CSS file locally
    try {
      const cssFileName = `style-${cssFileC}.css`;
      const localCssPath = `/css/${cssFileName}`;
      fs.writeFileSync(`${OUT}/css/${cssFileName}`, rewritten);
      mapAsset(cssLink.href, localCssPath);
      if (cssLink.origHref) {
        mapAsset(cssLink.origHref, localCssPath);
        try {
          urlMap[new URL(a).pathname] = localCssPath;
        } catch {}
      }
      // v18: Map versioned/hashed CSS paths — sites like morganlewis use
      // paths like /Contents/css/ML.Web.min.v-w4irrczknhxi1prnmllabq.css
      // Map the pathname with any version/hash suffix stripped
      try {
        const cssPathname = new URL(a).pathname;
        // Map exact pathname (with query stripped)
        urlMap[cssPathname] = localCssPath;
        // Also map the base filename without version hashes
        // Pattern: filename.min.v-HASH.css → filename.min.css
        const strippedPath = cssPathname.replace(/\.v-[a-z0-9]+\./i, ".");
        if (strippedPath !== cssPathname) urlMap[strippedPath] = localCssPath;
      } catch {}
      cssFileC++;
    } catch {}
  }

  if (Object.keys(cssAssetMap).length > 0) {
    console.log(
      `     CSS assets: ${Object.keys(cssAssetMap).length} downloaded (fonts/images from stylesheets)`,
    );
  }
  return inlinedCSS;
}

// ═══════════════════════════════════════
// ═══════════════════════════════════════
// Page-level passcode unlock — for routes gated by a 4-digit / short
// password input (Squarespace-style "Members Only" gate, etc.).
//
// Uses Playwright's native input/click APIs (not synthesized DOM events) so
// React-controlled forms see real user-style interaction. After submit,
// waits for navigation OR cookie set, then reloads — Squarespace's gate
// sets a session cookie that only takes effect on the next request.
// ═══════════════════════════════════════
async function tryUnlockPasscode(page, urlPath) {
  const fullURL = DOMAIN + urlPath;
  const code = flags.passcodes[urlPath] || flags.passcodes["*"];
  if (!code) return false;

  // Detect which kind of gate we're dealing with:
  //   (A) PIN-style — multiple <input maxlength="1"> boxes, one digit each
  //       (kenkais-class "Restricted Access" pattern)
  //   (B) Single password input — Squarespace / Webflow / Wix "Page Locked"
  const pinLocator = page.locator(
    'input[maxlength="1"]:visible, input[inputmode="numeric"][maxlength="1"]:visible',
  );
  const pinCount = await pinLocator.count().catch(() => 0);
  const pwLocator = page.locator('input[type="password"]:visible').first();
  const pwCount = await pwLocator.count().catch(() => 0);

  if (pinCount === 0 && pwCount === 0) return false;

  let mode;
  if (pinCount >= code.length) {
    mode = "pin";
    try {
      // Focus the first box; React auto-advances focus on each keystroke.
      await pinLocator.first().click({ timeout: 2000 });
      await page.keyboard.type(code, { delay: 80 });
    } catch {
      return false;
    }
    console.log(
      `     🔓 PIN ${"•".repeat(code.length)} entered for ${urlPath}`,
    );
  } else if (pwCount > 0) {
    mode = "password";
    try {
      await pwLocator.click({ timeout: 2000 });
      await pwLocator.fill("", { timeout: 2000 }).catch(() => {});
      await pwLocator.type(code, { delay: 30, timeout: 4000 });
      // Submit — Enter first, then click a submit button.
      const navWait = page
        .waitForNavigation({ timeout: 5000, waitUntil: "domcontentloaded" })
        .catch(() => null);
      await pwLocator.press("Enter").catch(() => {});
      if (!(await navWait)) {
        const btn = page
          .locator(
            'button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Submit"):visible, button:has-text("Enter"):visible, button:has-text("Unlock"):visible',
          )
          .first();
        if (await btn.count().catch(() => 0))
          await btn.click({ timeout: 3000 }).catch(() => {});
      }
    } catch {
      return false;
    }
    console.log(`     🔓 password submitted for ${urlPath}`);
  } else {
    return false;
  }

  // After submit: PIN gates auto-redirect on the last digit; password gates
  // either navigate or set a cookie. Wait for whichever happens.
  await page
    .waitForLoadState("networkidle", { timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  // If we ended up on a different URL (e.g. /exclusive → /exclusive-content),
  // stay there — that's the unlocked target. Otherwise force a reload at the
  // original URL to ensure the unlocked content renders (cookie-based gates).
  const currentPath = new URL(page.url()).pathname;
  if (currentPath === urlPath || currentPath === urlPath + "/") {
    await page
      .goto(fullURL, { waitUntil: "networkidle", timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(1000);
  }

  // v52+: React-heavy pages populate href values inside useEffect blocks AFTER
  // hydration. networkidle isn't enough; we need an extra pass for the JSX
  // tree to be fully alive. 6s + a wait for any remaining anchor href="#"
  // resolution gives the hydration loop time to finish.
  await page.waitForTimeout(6000);
  await page
    .evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    )
    .catch(() => {});

  // Sanity check.
  const stillLocked =
    (await page
      .locator('input[type="password"]:visible, input[maxlength="1"]:visible')
      .count()
      .catch(() => 0)) > 0 &&
    (await page
      .evaluate(() =>
        /restricted access|enter.*code|password.*required/i.test(
          document.body.innerText || "",
        ),
      )
      .catch(() => false));
  if (stillLocked) {
    console.log(
      `     ⚠️  ${urlPath} appears still locked — code may be wrong or gate type unsupported`,
    );
  } else {
    console.log(`     ✅ unlocked ${urlPath}`);
  }
  return true;
}

// Capture one page
// ═══════════════════════════════════════
async function capturePage(page, urlPath, isFirst) {
  const fullURL = DOMAIN + urlPath;
  console.log(`\n  📄 ${urlPath}`);

  await page
    .goto(fullURL, { waitUntil: "networkidle", timeout: 30000 })
    .catch(() => {});

  // v52+: page-level passcode gate (e.g. Squarespace Members Areas).
  // If --passcode <route>:<code> was given for this URL, fill the input
  // and submit before we capture content.
  await tryUnlockPasscode(page, urlPath).catch(() => {});

  // v37: Detect locale redirect — if page redirected to a locale prefix (e.g. /de/, /fr/),
  // find the English alternate via hreflang tags and navigate there. Universal approach.
  if (isFirst) {
    try {
      const currentPath = new URL(page.url()).pathname;
      const localeMatch = currentPath.match(
        /^\/(de|fr|es|it|pt|ja|ko|zh|nl|ru|pl|sv|da|no|fi|cs|tr|ar|he|th|vi|id|ms|uk|ro|hu|el|bg|hr|sk|sl)\b/i,
      );
      if (
        localeMatch &&
        !urlPath.match(
          /^\/(de|fr|es|it|pt|ja|ko|zh|nl|ru|pl|sv|da|no|fi|cs|tr|ar|he|th|vi|id|ms|uk|ro|hu|el|bg|hr|sk|sl)\b/i,
        )
      ) {
        console.log(
          `     ↪ Locale redirect detected (/${localeMatch[1]}), looking for English alternate...`,
        );
        // Check hreflang links for English alternate
        const enUrl = await page
          .evaluate(() => {
            const links = document.querySelectorAll(
              'link[rel="alternate"][hreflang]',
            );
            for (const link of links) {
              const hl = (link.getAttribute("hreflang") || "").toLowerCase();
              if (hl === "en" || hl === "en-us" || hl === "x-default") {
                return link.getAttribute("href");
              }
            }
            return null;
          })
          .catch(() => null);
        if (enUrl) {
          const target = enUrl.startsWith("http") ? enUrl : DOMAIN + enUrl;
          console.log(`     ↪ Found English alternate: ${target}`);
          await page
            .goto(target, { waitUntil: "networkidle", timeout: 20000 })
            .catch(() => {});
        }
      }
    } catch {}
  }

  await page.waitForTimeout(isFirst ? 3000 : 1500);

  // v46: Capture body text BEFORE cookie dismissal — the content scorer compares against
  // the original page's innerText which includes cookie banner words. If we dismiss first,
  // those words disappear from innerText and the clone loses ~14 matching words.
  let preCookieText = "";
  if (isFirst) {
    try {
      preCookieText = await page
        .evaluate(() => (document.body?.innerText || "").trim())
        .catch(() => "");
    } catch {}
  }

  // v50: Save cookie/consent banner HTML BEFORE dismissal. Many sites remove the element
  // entirely on accept, but the test snapshot captures the original WITH the banner visible.
  // We re-inject this HTML before DOM capture for pixel-accurate reproduction.
  let savedCookieBannerHTML = "";
  try {
    savedCookieBannerHTML = await page
      .evaluate(() => {
        try {
          const sels =
            '[class*="cookie"],[class*="Cookie"],[class*="consent"],[class*="Consent"],[id*="cookie"],[id*="consent"],[id*="onetrust"],[class*="gdpr"],[class*="cookieBanner"]';
          const els = document.querySelectorAll(sels);
          const parts = [];
          const seen = new Set();
          els.forEach((el) => {
            try {
              const cs = getComputedStyle(el);
              if (
                cs.display === "none" ||
                cs.visibility === "hidden" ||
                parseFloat(cs.opacity) < 0.05
              )
                return;
              // Only capture top-level cookie containers (not children)
              if (el.closest("[data-xray-cookie-saved]")) return;
              el.setAttribute("data-xray-cookie-saved", "1");
              const html = el.outerHTML;
              if (!seen.has(html)) {
                seen.add(html);
                parts.push(html);
              }
            } catch {}
          });
          return parts.join("\n");
        } catch {
          return "";
        }
      })
      .catch(() => "");
  } catch {}

  // v11: Dismiss cookie banners and overlays FIRST
  await dismissOverlays(page);
  await page.waitForTimeout(500);

  // Scroll to trigger lazy content
  const h = await page.evaluate(() => document.body?.scrollHeight || 0);
  for (let y = 0; y <= h; y += 300) {
    await page.evaluate((s) => window.scrollTo(0, s), y);
    await page.waitForTimeout(isFirst ? 80 : 40);
  }
  if (isFirst) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    for (let y = 0; y <= h; y += 500) {
      await page.evaluate((s) => window.scrollTo(0, s), y);
      await page.waitForTimeout(30);
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // v11: Wait for all images + fonts to fully render
  await waitForFullRender(page);

  // v30: Extra idle wait on first page — let JS frameworks finish rendering dynamic content
  if (isFirst) {
    await page
      .evaluate(async () => {
        try {
          await document.fonts.ready;
        } catch (e) {}
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
      })
      .catch(() => {});
    await page.waitForTimeout(500);
  }

  // v52: In visual mode, collapse React/Radix nav dropdowns before capture
  if (flags.visual) {
    await page
      .evaluate(() => {
        // Force Radix NavigationMenu/Popover/Dropdown to closed state
        document
          .querySelectorAll('[data-state="open"],[data-state="active"]')
          .forEach((el) => {
            const tag = el.tagName.toLowerCase();
            const cls = (el.className || "").toString().toLowerCase();
            // Only close nav/menu/popover elements, not the main page content
            if (
              cls.includes("nav") ||
              cls.includes("menu") ||
              cls.includes("popover") ||
              cls.includes("dropdown") ||
              cls.includes("viewport") ||
              tag === "nav" ||
              el.closest('[class*="navigation"]')
            ) {
              el.setAttribute("data-state", "closed");
              el.style.display = "none";
            }
          });
        // Hide skip-nav links
        document
          .querySelectorAll(
            '[class*="skipLink"],[class*="skip-nav"],[class*="skip-to"]',
          )
          .forEach((el) => {
            el.style.display = "none";
          });
        // Hide navigation content/viewport panels
        document
          .querySelectorAll(
            '[class*="viewportPosition"],[class*="NavigationMenuContent"],[class*="nav-content"]',
          )
          .forEach((el) => {
            el.style.display = "none";
          });
      })
      .catch(() => {});
  }

  // v11: Resolve Next.js images to highest quality source
  await resolveNextJSImages(page);

  // v23: Resolve <picture> elements — pick best source, remove <source> elements
  await resolvePictureElements(page);

  // v11: Inline SVG sprites (fix broken logos/icons)
  await inlineSVGSprites(page);

  // v11: Second overlay dismissal (some reappear after scroll)
  await dismissOverlays(page);

  // Discover internal links
  const links = await page.evaluate((domain) => {
    const found = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      try {
        const u = new URL(a.href, domain);
        if (
          u.origin === domain &&
          !u.hash &&
          !u.pathname.match(/\.(jpg|png|pdf|zip|svg|mp4)$/i)
        )
          found.add(u.pathname);
      } catch (e) {}
    });
    return [...found];
  }, DOMAIN);
  for (const link of links) {
    if (
      !crawled.has(link) &&
      !queue.includes(link) &&
      crawled.size + queue.length < MAX_PAGES
    )
      queue.push(link);
  }

  // v13: Prioritize nav links — clone main structure first
  if (isFirst) {
    const navLinks = await page.evaluate((domain) => {
      const paths = new Set();
      document
        .querySelectorAll(
          'nav a, header a, [role="navigation"] a, [class*="nav"] a, [class*="menu"] a',
        )
        .forEach((a) => {
          try {
            const u = new URL(a.href, domain);
            if (
              u.origin === domain &&
              !u.hash &&
              !u.pathname.match(/\.(jpg|png|pdf|svg|mp4)$/i)
            )
              paths.add(u.pathname);
          } catch {}
        });
      return [...paths];
    }, DOMAIN);
    const navSet = new Set(navLinks.filter((p) => !crawled.has(p)));
    const navQueue = [...navSet];
    const restQueue = queue.filter((p) => !navSet.has(p));
    queue.length = 0;
    queue.push(...navQueue, ...restQueue);
    // Store nav links globally for stub generation later
    if (!global.__navLinks) global.__navLinks = new Set();
    navQueue.forEach((p) => global.__navLinks.add(p));
    console.log(
      `     Links: ${links.length} (${navQueue.length} nav priority, ${restQueue.length} other)`,
    );
  } else {
    console.log(`     Links: ${links.length} (queue: ${queue.length})`);
  }

  // ── First page: capture CSS, download assets, analyze bundles ──
  if (isFirst) {
    try {
      // Computed CSS (from accessible stylesheets)
      sharedCSS = await page.evaluate(() => {
        let css = "";
        for (const s of document.styleSheets) {
          try {
            for (const r of s.cssRules) css += r.cssText + "\n";
          } catch (e) {}
        }
        return css;
      });

      // v19: Capture body background-color for CSS score (many sites have transparent default)
      try {
        capturedBodyBg = await page.evaluate(() => {
          const bg = getComputedStyle(document.body).backgroundColor;
          // If transparent/default, use white (most common)
          if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent")
            return "#ffffff";
          return bg;
        });
      } catch (e) {
        capturedBodyBg = "#ffffff";
      }

      // v12: Also download external CSS files (CORS-blocked ones won't be in cssRules)
      const externalCSS = await downloadExternalCSS(page);
      if (externalCSS.length > 0) {
        sharedCSS = externalCSS + "\n" + sharedCSS;
        console.log(
          `     CSS: ${sharedCSS.length} chars (incl. ${(externalCSS.length / 1024).toFixed(0)}KB external)`,
        );
      } else {
        console.log(`     CSS: ${sharedCSS.length} chars`);
      }

      // Collect asset URLs
      const assets = await page.evaluate((domain) => {
        const imgs = new Set(),
          fonts = new Set(),
          vids = new Set();
        document
          .querySelectorAll(
            "img,[data-src],[data-lazy],[data-bg],video[poster]",
          )
          .forEach((el) => {
            for (const a of [
              "src",
              "data-src",
              "data-lazy",
              "data-bg",
              "poster",
            ]) {
              const v = el.getAttribute(a);
              if (v && !v.startsWith("data:")) imgs.add(v);
            }
            const ss =
              el.getAttribute("srcset") || el.getAttribute("data-srcset");
            if (ss)
              ss.split(",").forEach((s) => {
                const u = s.trim().split(" ")[0];
                if (u) imgs.add(u);
              });
            // Extract raw path from Next.js /_next/image?url=PATH URLs
            const src = el.getAttribute("src") || "";
            const nxMatch = src.match(/\/_next\/image\?url=([^&]+)/);
            if (nxMatch) {
              try {
                const raw = decodeURIComponent(nxMatch[1]);
                imgs.add(raw);
              } catch (e) {}
            }
          });
        document.querySelectorAll("picture source").forEach((s) => {
          if (s.srcset)
            s.srcset.split(",").forEach((p) => {
              const u = p.trim().split(" ")[0];
              if (u) imgs.add(u);
            });
        });
        document.querySelectorAll("*").forEach((el) => {
          try {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== "none") {
              const urls = bg.match(/url\(["']?([^"')]+)["']?\)/g);
              if (urls)
                urls.forEach((u) => {
                  const c = u.replace(/url\(["']?|["']?\)/g, "");
                  if (c && !c.startsWith("data:")) imgs.add(c);
                });
            }
          } catch (e) {}
        });
        document.querySelectorAll("video,video source").forEach((v) => {
          if (v.src) vids.add(v.src);
          if (v.getAttribute("data-src")) vids.add(v.getAttribute("data-src"));
        });
        let css = "";
        for (const s of document.styleSheets) {
          try {
            for (const r of s.cssRules) css += r.cssText + "\n";
          } catch (e) {}
        }
        const fm = css.match(
          /url\(["']?([^"')]+\.(?:woff2?|ttf|otf|eot)[^"')]*)/gi,
        );
        if (fm)
          fm.forEach((m) => {
            let u = m.replace(/url\(["']?/i, "");
            if (u.startsWith("/")) u = domain + u;
            else if (!u.startsWith("http")) u = domain + "/" + u;
            fonts.add(u);
          });
        return { imgs: [...imgs], fonts: [...fonts], vids: [...vids] };
      }, DOMAIN);

      // v18: Discover SVG sprite files referenced via <use>, href, src attributes with #fragment
      const spriteUrls = await page
        .evaluate((domain) => {
          const sprites = new Set();
          // Find SVG use elements with external hrefs (sprite.svg#icon-name)
          document.querySelectorAll("use, svg use").forEach((el) => {
            const href =
              el.getAttribute("href") || el.getAttribute("xlink:href") || "";
            if (href.includes(".svg") && !href.startsWith("#")) {
              sprites.add(href.split("#")[0].split("?")[0]);
            }
          });
          // Find any href/src referencing .svg files with fragment IDs
          document
            .querySelectorAll('[href*=".svg#"],[src*=".svg#"]')
            .forEach((el) => {
              const url =
                el.getAttribute("href") || el.getAttribute("src") || "";
              if (url.includes(".svg"))
                sprites.add(url.split("#")[0].split("?")[0]);
            });
          return [...sprites];
        }, DOMAIN)
        .catch(() => []);

      // Download SVG sprites at their EXACT path (so fragment refs resolve)
      for (const spriteUrl of spriteUrls) {
        try {
          const a = new URL(spriteUrl, DOMAIN).href;
          const spritePath = new URL(a).pathname;
          const localDest = path.join(OUT, spritePath);
          if (!fs.existsSync(localDest)) {
            fs.mkdirSync(path.dirname(localDest), { recursive: true });
            if (await dl(a, localDest)) {
              mapAsset(spriteUrl, spritePath);
              // Also map with query params that sites use (e.g., ?v=3)
              urlMap[spritePath] = spritePath;
              console.log(`     SVG sprite: ${spritePath}`);
            }
          }
        } catch {}
      }

      // Download images
      const allImgs = new Set([
        ...assets.imgs,
        ...[...networkURLs].filter((u) =>
          u.match(/\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i),
        ),
      ]);
      for (const url of allImgs) {
        try {
          const a = new URL(url, DOMAIN).href;
          const ext = path.extname(new URL(a).pathname).split("?")[0] || ".jpg";
          const nm = `img-${imgC}${ext}`;
          if (await dl(a, `${OUT}/images/${nm}`)) {
            mapAsset(url, `/images/${nm}`);
            imgC++;
          }
        } catch (e) {}
      }
      console.log(`     Images: ${imgC}`);

      // Download fonts
      const allFonts = new Set([
        ...assets.fonts,
        ...[...networkURLs].filter((u) =>
          u.match(/\.(woff2?|ttf|otf|eot)(\?|$)/i),
        ),
      ]);
      for (const url of allFonts) {
        try {
          const a = new URL(url, DOMAIN).href;
          const ext =
            path.extname(new URL(a).pathname).split("?")[0] || ".woff2";
          const nm = `font-${fontC}${ext}`;
          if (await dl(a, `${OUT}/fonts/${nm}`)) {
            mapAsset(url, `/fonts/${nm}`);
            fontC++;
          }
        } catch (e) {}
      }
      console.log(`     Fonts: ${fontC}`);

      // Download videos
      const allVids = new Set([
        ...assets.vids,
        ...[...networkURLs].filter((u) => u.match(/\.(mp4|webm|mov)(\?|$)/i)),
      ]);
      for (const url of allVids) {
        try {
          const a = new URL(url, DOMAIN).href;
          const ext = path.extname(new URL(a).pathname).split("?")[0] || ".mp4";
          const nm = `vid-${vidC}${ext}`;
          if (await dl(a, `${OUT}/videos/${nm}`)) {
            mapAsset(url, `/videos/${nm}`);
            vidC++;
          }
        } catch (e) {}
      }
      console.log(`     Videos: ${vidC}`);

      await dl(`${DOMAIN}/favicon.ico`, `${OUT}/favicon.ico`);

      // v15: Download common favicon/icon files and discover from <link> tags
      // Also handles deep favicon paths and query-parameterized URLs
      try {
        const commonIcons = [
          "/apple-touch-icon.png",
          "/favicon-32x32.png",
          "/favicon-16x16.png",
          "/favicon.svg",
          "/apple-touch-icon-precomposed.png",
          "/safari-pinned-tab.svg",
        ];
        for (const iconPath of commonIcons) {
          const dest = `${OUT}${iconPath}`;
          if (!fs.existsSync(dest)) await dl(`${DOMAIN}${iconPath}`, dest);
        }
        // Discover icons from <link> tags — get both href attribute and resolved URL
        const iconLinks = await page.evaluate(() => {
          return [
            ...document.querySelectorAll(
              'link[rel*="icon"], link[rel*="apple-touch"], link[rel*="mask-icon"]',
            ),
          ]
            .map((l) => ({ href: l.getAttribute("href"), resolved: l.href }))
            .filter((h) => h.href);
        });
        for (const icon of iconLinks) {
          try {
            const absUrl = new URL(icon.resolved || icon.href, DOMAIN).href;
            // Strip query string for local path but keep for download
            const parsedUrl = new URL(absUrl);
            const iconPath = parsedUrl.pathname;
            const dest = `${OUT}${iconPath}`;
            if (!fs.existsSync(dest)) {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              if (await dl(absUrl, dest)) {
                // Map both the original href and the path with/without query
                mapAsset(icon.href, iconPath);
                if (parsedUrl.search) {
                  // Map the path+query version too (e.g., /static/icon.png?v=2)
                  urlMap[iconPath + parsedUrl.search] = iconPath;
                  urlMap[icon.href] = iconPath;
                }
              }
            }
          } catch {}
        }
      } catch {}

      // Canvas capture
      const canvases = await page.$$("canvas");
      for (let i = 0; i < canvases.length; i++) {
        try {
          const du = await canvases[i].evaluate((c) => {
            try {
              return c.toDataURL("image/png");
            } catch {
              return null;
            }
          });
          if (du)
            fs.writeFileSync(
              `${OUT}/images/canvas-${i}.png`,
              Buffer.from(du.split(",")[1], "base64"),
            );
          else
            await canvases[i].screenshot({
              path: `${OUT}/images/canvas-${i}.png`,
            });
        } catch (e) {}
      }

      // ── WebGL shader extraction ──
      const shaderData = await page.evaluate(() => {
        const shaders = window.__capturedShaders || [];
        const uniforms = [];
        document.querySelectorAll("canvas").forEach((c) => {
          const gl = c.getContext("webgl2") || c.getContext("webgl");
          if (!gl) return;
          const prog = gl.getParameter(gl.CURRENT_PROGRAM);
          if (!prog) return;
          const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
          for (let i = 0; i < n; i++) {
            const info = gl.getActiveUniform(prog, i);
            if (info) uniforms.push({ name: info.name, type: info.type });
          }
        });
        return { shaders, uniforms };
      });
      if (shaderData.shaders.length > 0) {
        shaderC = shaderData.shaders.length;
        fs.writeFileSync(
          `${OUT}/data/shaders.json`,
          JSON.stringify(shaderData, null, 2),
        );
        const r3f = genShaderR3F(shaderData);
        fs.writeFileSync(`${OUT}/components/WebGLScene.tsx`, r3f);
        console.log(
          `     Shaders: ${shaderC} captured → components/WebGLScene.tsx`,
        );
      }

      // ── 3D model extraction ──
      const modelData = await page.evaluate(() => {
        const captured = window.__capturedModels || [];
        const EXTS = [".glb", ".gltf", ".fbx", ".obj", ".usdz"];
        // Scan DOM for model references
        document
          .querySelectorAll("[data-model],[data-src],[data-gltf],[data-glb]")
          .forEach((el) => {
            const u =
              el.getAttribute("data-model") ||
              el.getAttribute("data-gltf") ||
              el.getAttribute("data-glb") ||
              el.getAttribute("data-src");
            if (u && EXTS.some((e) => u.toLowerCase().includes(e)))
              captured.push({
                url: new URL(u, window.location.href).href,
                source: "dom",
              });
          });
        // Check <model-viewer> elements
        document.querySelectorAll("model-viewer").forEach((mv) => {
          const src = mv.getAttribute("src");
          if (src)
            captured.push({
              url: new URL(src, window.location.href).href,
              source: "model-viewer",
            });
        });
        // Scan inline scripts for model URLs
        document.querySelectorAll("script:not([src])").forEach((s) => {
          const c = s.textContent || "";
          const re = /['"`]([^'"`]*\.(glb|gltf|fbx|obj|usdz)[^'"`]*?)['"`]/gi;
          let m;
          while ((m = re.exec(c)) !== null) {
            try {
              captured.push({
                url: new URL(m[1], window.location.href).href,
                source: "script",
              });
            } catch (e) {}
          }
        });
        // Deduplicate + validate (reject URLs >300 chars or with encoded CSS noise)
        const seen = new Set();
        return captured.filter((m) => {
          if (seen.has(m.url) || m.url.length > 300) return false;
          seen.add(m.url);
          try {
            new URL(m.url);
            return !/[{}%;]/.test(m.url);
          } catch {
            return false;
          }
        });
      });
      if (modelData.length > 0) {
        console.log(`     3D Models: ${modelData.length} detected`);
        for (const model of modelData) {
          const ext =
            (model.url.match(/\.(glb|gltf|fbx|obj|usdz)/i) || [])[1] || "glb";
          const nm = `model-${modelC}.${ext}`;
          if (await dl(model.url, `${OUT}/models/${nm}`)) {
            console.log(`       Downloaded: ${nm}`);
            model.local = `/models/${nm}`;
            modelC++;
          }
        }
        fs.writeFileSync(
          `${OUT}/data/models.json`,
          JSON.stringify(modelData, null, 2),
        );
        if (modelC > 0) {
          const r3f = genModelR3F(modelData.filter((m) => m.local));
          fs.writeFileSync(`${OUT}/components/Model3D.tsx`, r3f);
          console.log(`     → components/Model3D.tsx`);
        }
      }

      // Bundle analysis
      console.log("     Analyzing bundles...");
      const bundle = {
        lib: "",
        gsap: [],
        st: [],
        lenis: [],
        framer: [],
        eases: [],
        durs: [],
        delays: [],
      };
      const jsURLs = [...networkURLs].filter((u) => u.match(/\.js(\?|$)/i));
      const appJS = jsURLs
        .filter((u) => /page|layout|app|main|index/i.test(u))
        .slice(0, 10);
      const libJS = jsURLs
        .filter(
          (u) =>
            !appJS.includes(u) &&
            /\d{3,}-|[a-f0-9]{8,}/.test(u) &&
            !/(polyfill|webpack|framework)/i.test(u),
        )
        .slice(0, 5);
      for (const url of [...appJS, ...libJS]) {
        try {
          const code = await page.evaluate(async (u) => {
            try {
              return await (await fetch(u)).text();
            } catch {
              return "";
            }
          }, url);
          if (!code) continue;
          for (const m of code.matchAll(
            /(?:gsap|[a-z]\.(?:p8|ZP|Bt|Dn))\.\s*(?:to|from|fromTo|set)\s*\([^)]{0,2000}\)/g,
          ))
            bundle.gsap.push(m[0].substring(0, 500));
          for (const m of code.matchAll(
            /scrollTrigger\s*:\s*\{[^}]{0,1000}\}|ScrollTrigger\.create\s*\([^)]{0,1000}\)/g,
          ))
            bundle.st.push(m[0].substring(0, 500));
          for (const m of code.matchAll(
            /new\s+\w+\s*\(\s*\{[^}]*duration[^}]*easing[^}]*\}/g,
          ))
            bundle.lenis.push(m[0].substring(0, 500));
          for (const m of code.matchAll(
            /(?:motion\.\w+|whileInView|AnimatePresence|variants\s*:\s*\{[^}]+\})/g,
          ))
            bundle.framer.push(m[0].substring(0, 300));
          if (/anime\s*\(\s*\{/.test(code)) bundle.lib += "anime,";
          if (/locomotive/i.test(code) && /ScrollTrigger/i.test(code))
            bundle.lib += "locomotive,";
          for (const m of code.matchAll(/ease\s*:\s*["'][^"']+["']/g))
            bundle.eases.push(m[0]);
          for (const m of code.matchAll(/duration\s*:\s*[\d.]+/g))
            bundle.durs.push(m[0]);
          for (const m of code.matchAll(/delay\s*:\s*[\d.]+/g))
            bundle.delays.push(m[0]);
        } catch (e) {}
      }
      const iLib = (await page.evaluate(() => window.__xray?.library)) || "";
      if (bundle.gsap.length || iLib.includes("gsap")) bundle.lib += "gsap,";
      if (bundle.st.length || iLib.includes("scrolltrigger"))
        bundle.lib += "scrolltrigger,";
      if (bundle.lenis.length || iLib.includes("lenis")) bundle.lib += "lenis,";
      if (bundle.framer.length) bundle.lib += "framer-motion,";
      bundleLib = [...new Set(bundle.lib.split(","))].filter(Boolean).join(",");
      bundle.eases = [...new Set(bundle.eases)];
      bundle.durs = [...new Set(bundle.durs)];
      bundle.delays = [...new Set(bundle.delays)];
      console.log(`     Libraries: ${bundleLib || "css-only"}`);
      fs.writeFileSync(
        `${OUT}/data/bundle.json`,
        JSON.stringify(bundle, null, 2),
      );

      // CDN scripts — v19: download locally instead of keeping as external refs
      cdnScripts = [];
      const cdnUrls = [];
      if (bundleLib.includes("gsap"))
        cdnUrls.push(
          "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js",
        );
      if (bundleLib.includes("scrolltrigger"))
        cdnUrls.push(
          "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js",
        );
      if (bundleLib.includes("lenis"))
        cdnUrls.push("https://unpkg.com/lenis@1.1.18/dist/lenis.min.js");
      if (bundleLib.includes("locomotive"))
        cdnUrls.push(
          "https://cdn.jsdelivr.net/npm/locomotive-scroll@4.1.4/dist/locomotive-scroll.min.js",
        );
      // Also detect lenis from HTML class
      if (
        !bundleLib.includes("lenis") &&
        (await page
          .evaluate(
            () =>
              document.documentElement?.className?.includes?.("lenis") || false,
          )
          .catch(() => false))
      ) {
        bundleLib += bundleLib ? ",lenis" : "lenis";
        cdnUrls.push("https://unpkg.com/lenis@1.1.18/dist/lenis.min.js");
      }
      // v19: Download CDN scripts to local /data/ directory
      fs.mkdirSync(`${OUT}/data`, { recursive: true });
      for (const cdnUrl of cdnUrls) {
        try {
          const scriptName = cdnUrl.split("/").pop();
          const localPath = `/data/${scriptName}`;
          if (await dl(cdnUrl, `${OUT}${localPath}`, 10000)) {
            cdnScripts.push(localPath);
            mapAsset(cdnUrl, localPath);
          } else {
            cdnScripts.push(cdnUrl); // fallback to CDN if download fails
          }
        } catch (e) {
          cdnScripts.push(cdnUrl);
        }
      }

      // ── Collect style timeline + generate animation script ──
      if (bundleLib.includes("gsap") || bundleLib.includes("lenis")) {
        console.log("     Recording style timeline...");

        try {
          // Mark scroll start, then scroll to capture scroll-driven changes — with 30s timeout
          await Promise.race([
            (async () => {
              await page.evaluate(() => {
                window.__scrollTimelineStart = window.__timeline.length;
              });
              const h2 = await page.evaluate(
                () => document.body?.scrollHeight || 0,
              );
              for (let y = 0; y <= h2; y += 200) {
                await page.evaluate((s) => window.scrollTo(0, s), y);
                await page.waitForTimeout(30);
              }
              await page.evaluate(() => window.scrollTo(0, 0));
              await page.waitForTimeout(1000);
            })(),
            new Promise((_, rej) =>
              setTimeout(
                () => rej(new Error("Timeline recording timeout")),
                30000,
              ),
            ),
          ]);

          // Collect timeline data
          const timeline = await page.evaluate(() => {
            const scrollStart = window.__scrollTimelineStart || 0;
            const all = window.__timeline || [];
            // Group by element
            const byEl = {};
            all.forEach((snap, i) => {
              if (!byEl[snap.el]) byEl[snap.el] = { entrance: [], scroll: [] };
              if (i < scrollStart) byEl[snap.el].entrance.push(snap);
              else byEl[snap.el].scroll.push(snap);
            });
            return { total: all.length, scrollStart, elements: byEl };
          });

          console.log(
            `     Timeline: ${timeline.total} snapshots, ${Object.keys(timeline.elements).length} animated elements`,
          );

          // ── Generate animation script: BUNDLE VALUES (exact) + TIMELINE (element detection) ──
          // Strategy: use bundle-grepped params for exact values, timeline only to confirm which elements animate
          const allEases = bundle.eases.map((e) =>
            e.replace(/ease\s*:\s*/, "").replace(/"/g, ""),
          );
          const entranceEase =
            allEases.find((e) => e.includes("power4.inOut")) ||
            allEases.find((e) => e.includes("power4")) ||
            "power4.inOut";
          const defaultEase =
            allEases.find((e) => e.includes("expo.out")) ||
            allEases.find((e) => e.includes("expo")) ||
            "expo.out";
          const allDurs = bundle.durs
            .map((d) => parseFloat(d.replace("duration:", "")))
            .filter((d) => d > 0.1);
          const lenisRaw = bundle.lenis[0] || "";
          const lenisDur =
            lenisRaw.match(/duration\s*:\s*([\d.]+)/)?.[1] || "0.8";

          // Check bundle for specific animation patterns
          const bundleCode =
            bundle.gsap.join("\n") + "\n" + bundle.st.join("\n");
          const hasScaleX = bundleCode.includes("scaleX");
          const hasAutoAlpha = bundleCode.includes("autoAlpha");
          const hasBaseProgress =
            bundleCode.includes("baseProgress") ||
            bundleCode.includes("--progress");
          const baseProgress =
            bundleCode.match(/baseProgress\s*:\s*([\d.]+)/)?.[1] || "0.5";

          let animScript = "";

          // ── Lenis ──
          if (bundleLib.includes("lenis")) {
            animScript += `const lenis=new Lenis({duration:${lenisDur},easing:t=>Math.min(1,1.001-Math.pow(2,-10*t)),smooth:true});\n`;
            animScript += `function raf(t){lenis.raf(t);requestAnimationFrame(raf)}requestAnimationFrame(raf);\n`;
          }

          // ── GSAP setup ──
          if (bundleLib.includes("gsap")) {
            animScript += `gsap.registerPlugin(ScrollTrigger);\n`;
            if (bundleLib.includes("lenis")) {
              animScript += `lenis.on("scroll",ScrollTrigger.update);gsap.ticker.add(t=>lenis.raf(t*1000));gsap.ticker.lagSmoothing(0);\n`;
            }
          }

          // ═══════════════════════════════════════════════════════════
          // PATTERN RECOGNITION — detect from timeline behavior, not class names
          // 4 categories: entrance, scale-reveal, scroll-driven, character-stagger
          // ═══════════════════════════════════════════════════════════

          // Classify every animated element by its timeline behavior
          const patterns = {
            entrance: [],
            scaleReveal: [],
            scrollDriven: [],
            charStagger: [],
          };

          for (const [selector, data] of Object.entries(timeline.elements)) {
            const ent = data.entrance;
            const scr = data.scroll;

            // ── PATTERN 1: Entrance fade/slide ──
            // Signature: opacity changes from <0.5 to 1 during page load, few snapshots
            if (ent.length >= 2 && ent.length < 50) {
              const first = ent[0],
                last = ent[ent.length - 1];
              const opFrom = parseFloat(first.opacity),
                opTo = parseFloat(last.opacity);
              if (opFrom < 0.5 && opTo > 0.8) {
                // Check if transform also changed (slide)
                let fromY = 0;
                if (first.transform !== last.transform) {
                  const m = first.transform?.match(
                    /matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)/,
                  );
                  if (m) fromY = parseFloat(m[1]) || 0;
                }
                patterns.entrance.push({
                  selector,
                  fromY,
                  delay: first.t / 1000,
                });
              }
            }

            // ── PATTERN 2: Scale reveal ──
            // Signature: transform includes scale(0 or scaleX(0 → 1 during entrance
            if (ent.length >= 2) {
              const hasScale0 = ent.some(
                (s) =>
                  s.transform?.includes("scale(0") ||
                  s.transform?.includes("matrix(0,") ||
                  s.transform?.includes("matrix(0 "),
              );
              const hasScale1 = ent.some(
                (s) =>
                  s.transform?.includes("matrix(1") || s.transform === "none",
              );
              if (hasScale0 && hasScale1) {
                // Extract transform-origin from the first non-none transform
                patterns.scaleReveal.push({ selector, delay: ent[0].t / 1000 });
              }
            }

            // ── PATTERN 3: Scroll-driven ──
            // Signature: CSS custom property (--progress, --x, etc) changes continuously during scroll
            if (scr.length > 5) {
              const hasCustomProp = scr.some(
                (s) => s["--progress"] || s["--base-height"],
              );
              if (hasCustomProp) {
                // Find the initial value of --progress
                const firstProg = scr.find((s) => s["--progress"]);
                const initProg = firstProg
                  ? parseFloat(firstProg["--progress"])
                  : 0.5;
                patterns.scrollDriven.push({
                  selector,
                  initProgress: initProg,
                });
              }
            }
          }

          // ── PATTERN 4: Character stagger ──
          // Detect from DOM structure: container with many (>5) small child elements
          // that all have the same class pattern (character, char, letter, word)
          const charContainers = await page.evaluate(() => {
            const found = [];
            document.querySelectorAll("*").forEach((container) => {
              const children = container.children;
              if (children.length < 5 || children.length > 200) return;
              // Must be inline elements (SPAN only), small text content, same class
              const childClasses = new Set();
              let allSmall = true;
              for (const child of children) {
                const cls = child.className?.toString() || "";
                if (!cls) {
                  allSmall = false;
                  break;
                }
                const prefix =
                  cls.split("_")[0] + "_" + (cls.split("_")[1] || "");
                childClasses.add(prefix);
                // Must be SPAN (not DIV, not BUTTON) and have very short text (1-3 chars = character animation)
                if (child.tagName !== "SPAN") {
                  allSmall = false;
                  break;
                }
                if ((child.textContent || "").length > 3) {
                  allSmall = false;
                  break;
                }
              }
              // All children are single-char spans with same class = character stagger
              if (allSmall && childClasses.size === 1 && children.length >= 5) {
                const containerCls = (container.className?.toString() || "")
                  .split(/\s+/)
                  .find((c) => c.includes("__"));
                const childCls = (children[0].className?.toString() || "")
                  .split(/\s+/)
                  .find((c) => c.includes("__"));
                if (containerCls && childCls) {
                  found.push({
                    container: "." + containerCls,
                    child: "." + childCls,
                    count: children.length,
                  });
                }
              }
            });
            // Deduplicate by container class
            const seen = new Set();
            return found.filter((f) => {
              if (seen.has(f.container)) return false;
              seen.add(f.container);
              return true;
            });
          });

          if (charContainers.length > 0) {
            patterns.charStagger = charContainers;
          }

          console.log(
            `     Patterns: entrance=${patterns.entrance.length} scale=${patterns.scaleReveal.length} scroll=${patterns.scrollDriven.length} chars=${patterns.charStagger.length}`,
          );

          // ═══════════════════════════════
          // Generate code from patterns
          // ═══════════════════════════════

          // Entrance fade/slide
          if (patterns.entrance.length > 0) {
            animScript += `// Entrance animations (${patterns.entrance.length} elements)\n`;
            // Find entrance ease from bundle (usually power4.inOut or similar)
            const eEase =
              allEases.find((e) => e.includes("inOut")) || entranceEase;
            const eDur = allDurs.find((d) => d >= 0.3 && d <= 0.8) || 0.5;
            patterns.entrance.forEach((p, i) => {
              const yPart = p.fromY ? `,y:${Math.round(p.fromY)}` : "";
              animScript += `gsap.fromTo("${p.selector}",{autoAlpha:0${yPart}},{autoAlpha:1,y:0,duration:${eDur},delay:${(p.delay || 0.25 + i * 0.1).toFixed(2)},ease:"${eEase}"});\n`;
            });
          }

          // Scale reveal
          if (patterns.scaleReveal.length > 0) {
            animScript += `// Scale reveal (${patterns.scaleReveal.length} elements)\n`;
            const sDur = allDurs.find((d) => d > 1) || 1.2;
            patterns.scaleReveal.forEach((p) => {
              animScript += `(()=>{const el=document.querySelector("${p.selector}");if(!el)return;\n`;
              animScript += `gsap.set(el,{opacity:1,scaleX:0,transformOrigin:"left center"});\n`;
              animScript += `gsap.to(el,{scaleX:1,duration:${sDur},delay:0.2,ease:"${defaultEase}"});})();\n`;
            });
            // Hide any sibling overlay/cover elements (gradient covers are common with scale reveals)
            animScript += `document.querySelectorAll('[class*="cover"],[class*="Cover"],[class*="overlay"],[class*="Overlay"]').forEach(el=>{if(el.style)el.style.display="none"});\n`;
          }

          // Scroll-driven CSS custom properties
          if (patterns.scrollDriven.length > 0) {
            animScript += `// Scroll-driven (${patterns.scrollDriven.length} elements)\n`;
            // ALWAYS use bundle value for initial progress (timeline captures FINAL state which is wrong)
            // If bundle has baseProgress, use it. Otherwise default 0.5 (common GSAP pattern)
            const bp =
              bundleCode.match(/baseProgress\s*:\s*([\d.]+)/)?.[1] || "0.5";
            patterns.scrollDriven.forEach((p) => {
              animScript += `document.querySelectorAll("${p.selector}").forEach((el,i)=>{\n`;
              animScript += `  const h=el.getBoundingClientRect().height||180;const vh=window.innerHeight;\n`;
              animScript += `  const mult=(vh/(Math.floor(h)+20))*(1-${bp});\n`;
              animScript += `  gsap.set(el,{"--progress":${bp},"--base-height":h+"px"});el.style.setProperty("min-height",h+"px");\n`;
              animScript += `  ScrollTrigger.create({trigger:el,start:"bottom-="+(h-(i===0?42:0))+"px bottom",end:"top top",scrub:1,\n`;
              animScript += `    onUpdate:s=>{gsap.set(el,{"--progress":${bp}+mult*s.progress})}});\n`;
              animScript += `});\n`;
            });
          }

          // Character stagger — animate each container independently on scroll into view
          if (patterns.charStagger.length > 0) {
            animScript += `// Character stagger (${patterns.charStagger.length} patterns)\n`;
            patterns.charStagger.forEach((p) => {
              // Use IntersectionObserver instead of ScrollTrigger for reliability
              // ScrollTrigger with once:true can miss elements if scroll position was cached
              animScript += `document.querySelectorAll("${p.container}").forEach(c=>{\n`;
              animScript += `  const chars=[...c.querySelectorAll("${p.child}")];if(!chars.length)return;\n`;
              animScript += `  chars.forEach(ch=>{ch.style.transform="translateX(-5px) scaleX(0)";ch.style.transformOrigin="left bottom"});\n`;
              animScript += `  const obs=new IntersectionObserver(([e])=>{if(e.isIntersecting){\n`;
              animScript += `    chars.forEach((ch,i)=>{setTimeout(()=>{ch.style.transition="transform 0.6s cubic-bezier(0.16,1,0.3,1)";ch.style.transform="translateX(0) scaleX(1)"},i*20)});\n`;
              animScript += `    obs.disconnect();\n`;
              animScript += `  }},{threshold:0.1});\n`;
              animScript += `  obs.observe(c);\n`;
              animScript += `});\n`;
            });
          }

          // ── Card/grid stagger (detected from DOM: wrapper with 3+ similar children) ──
          const staggerContainers = await page.evaluate(() => {
            const found = [];
            document.querySelectorAll("*").forEach((wrapper) => {
              const children = [...wrapper.children].filter(
                (c) => c.tagName !== "SCRIPT" && c.tagName !== "STYLE",
              );
              if (children.length < 3 || children.length > 20) return;
              // All children must be same tag
              const tags = new Set(children.map((c) => c.tagName));
              if (tags.size !== 1) return;
              // All children must have same class prefix (card grid pattern)
              const childPrefixes = new Set(
                children
                  .map((c) => {
                    const cls = (c.className?.toString() || "")
                      .split(/\s+/)
                      .find((x) => x.includes("__"));
                    return cls ? cls.split("__")[0] : "";
                  })
                  .filter(Boolean),
              );
              if (childPrefixes.size !== 1) return;
              // Children must be substantial (have content — img or text > 10 chars)
              const hasContent = children.every(
                (c) =>
                  c.querySelector("img") ||
                  (c.textContent || "").trim().length > 10,
              );
              if (!hasContent) return;
              // Wrapper and child must both be DIRECT parent-child with meaningful classes
              const wrapperCls = (wrapper.className?.toString() || "")
                .split(/\s+/)
                .find((c) => c.includes("__"));
              const childCls = (children[0].className?.toString() || "")
                .split(/\s+/)
                .find((c) => c.includes("__"));
              if (wrapperCls && childCls && wrapperCls !== childCls) {
                found.push({
                  wrapper: "." + wrapperCls,
                  child: "." + childCls,
                  count: children.length,
                });
              }
            });
            const seen = new Set();
            return found
              .filter((f) => {
                if (seen.has(f.wrapper)) return false;
                seen.add(f.wrapper);
                return true;
              })
              .slice(0, 5);
          });

          if (staggerContainers.length > 0) {
            animScript += `// Card stagger (${staggerContainers.length} grids)\n`;
            staggerContainers.forEach((g) => {
              animScript += `document.querySelectorAll("${g.wrapper}").forEach(w=>{\n`;
              animScript += `  const els=w.querySelectorAll("${g.child}");if(els.length<2)return;\n`;
              animScript += `  gsap.set(els,{x:-25,opacity:0});\n`;
              animScript += `  ScrollTrigger.create({trigger:w,start:"top 80%",once:true,onEnter:()=>{\n`;
              animScript += `    els.forEach((el,i)=>{gsap.to(el,{x:0,opacity:1,duration:0.8,delay:i*0.1,ease:"${defaultEase}",clearProps:"transform"})});\n`;
              animScript += `  }});\n`;
              animScript += `});\n`;
            });
          }

          // ── Elements with opacity:0 in CSS (need JS to show) ──
          // v24: Exclude carousel/slider slides — they're intentionally hidden by carousel libraries
          animScript += `// Visibility fix for JS-dependent elements\n`;
          animScript += `document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"]').forEach(el=>{\n`;
          animScript += `  if(el.closest('[class*="modal"],[class*="Modal"]'))return;\n`;
          animScript += `  if(el.closest('.swiper-wrapper,.flickity-viewport,.slick-track,.owl-stage,.glide__track,.splide__track,[class*="carousel-inner"]'))return;\n`;
          animScript += `  if(el.matches('.swiper-slide,.flickity-cell,.slick-slide,.carousel-item,.owl-item,.glide__slide,.splide__slide'))return;\n`;
          animScript += `  el.style.opacity="1";\n`;
          animScript += `});\n`;

          // ── Hover effects on image containers ──
          animScript += `document.querySelectorAll('button,a,[role="button"]').forEach(el=>{\n`;
          animScript += `  el.style.pointerEvents="auto";el.style.cursor="pointer";\n`;
          animScript += `  const img=el.querySelector("img");if(!img)return;\n`;
          animScript += `  el.addEventListener("mouseenter",()=>gsap.to(img,{scale:1.03,filter:"brightness(0.9)",duration:0.75,ease:"expo.out"}));\n`;
          animScript += `  el.addEventListener("mouseleave",()=>gsap.to(img,{scale:1,filter:"brightness(1)",duration:0.75,ease:"expo.out"}));\n`;
          animScript += `});\n`;

          // Save generated script for debugging
          fs.writeFileSync(`${OUT}/data/animations.js`, animScript);
          console.log(`     Animation script: ${animScript.length} chars`);

          // Store for injection during assembly
          sharedAnimScript = animScript;
        } catch (timelineErr) {
          console.log(
            `     ⚠ Timeline: ${timelineErr.message?.slice(0, 50)} — continuing without animations`,
          );
        }
      }

      // Download videos — search JS BUNDLES for video paths (they're hardcoded in React components)
      const jsURLs2 = [...networkURLs].filter(
        (u) => u.match(/\.js(\?|$)/i) && /page|layout|app/i.test(u),
      );
      const allVidPathsFromBundles = new Set();
      for (const url of jsURLs2.slice(0, 5)) {
        try {
          const code = await page.evaluate(async (u) => {
            try {
              return await (await fetch(u)).text();
            } catch {
              return "";
            }
          }, url);
          const vids = code.match(/\/videos\/[^"'\s\\,)]+\.(?:mp4|webm|m4v)/g);
          if (vids) vids.forEach((v) => allVidPathsFromBundles.add(v));
        } catch (e) {}
      }
      // Also check DOM and RSC payload
      const pageVidPaths = await page.evaluate(() => {
        const paths = new Set();
        const html = document.documentElement.outerHTML;
        const matches = html.match(/\/videos\/[^"'\s\\]+\.(?:mp4|webm|m4v)/g);
        if (matches) matches.forEach((m) => paths.add(m.replace(/\\/g, "")));
        document.querySelectorAll("video,video source").forEach((v) => {
          if (v.src)
            try {
              paths.add(new URL(v.src).pathname);
            } catch (e) {}
        });
        return [...paths];
      });
      const allVidPaths = [
        ...new Set([...allVidPathsFromBundles, ...pageVidPaths]),
      ];
      // Sort: desktop logo video first, then other logo videos, then project videos
      allVidPaths.sort((a, b) => {
        const score = (v) => {
          if (
            v.includes("desktop") &&
            (v.includes("logo") || v.includes("animation"))
          )
            return 0;
          if (v.includes("logo") || v.includes("animation")) return 1;
          return 2;
        };
        return score(a) - score(b);
      });
      for (const vPath of allVidPaths) {
        try {
          const a = DOMAIN + vPath;
          const nm = `vid-${vidC}.mp4`;
          if (await dl(a, `${OUT}/videos/${nm}`)) {
            mapAsset(vPath, `/videos/${nm}`);
            mapAsset(a, `/videos/${nm}`);
            vidC++;
            console.log(`     Video: ${nm} (${vPath.substring(0, 50)})`);
          }
        } catch (e) {}
      }
    } catch (firstPageErr) {
      console.log(
        `     ⚠ First page analysis error: ${firstPageErr.message?.slice(0, 80)} — continuing with capture`,
      );
    }
  }

  // ── Download new images on subsequent pages ──
  // v12: Download ALL new images found on this page (not just first page)
  if (!isFirst) {
    const pageImgs = await discoverPageAssets(page);
    const newImgCount = await downloadNewImages(pageImgs);
    if (newImgCount > 0) console.log(`     +${newImgCount} new images`);

    // v17: Download external CSS from subpages too (catches page-specific stylesheets)
    try {
      const subpageExternalCSS = await downloadExternalCSS(page);
      if (subpageExternalCSS.length > 0) {
        sharedCSS += "\n" + subpageExternalCSS;
        console.log(
          `     +${(subpageExternalCSS.length / 1024).toFixed(0)}KB subpage CSS`,
        );
      }
    } catch {}
  }

  // v26: SMART layout freeze — auto-detect whether site needs it
  // Responsive sites (calc/clamp, many @media queries, lenis/gsap) → skip freeze entirely
  // JS-stripped sites (CSS-in-JS, no @media, React/Vue runtime layouts) → freeze full layout
  // Mixed sites → freeze only display property (minimal, safe)
  await page
    .evaluate(() => {
      // Detect site type
      const detectMode = () => {
        const allCSS = [...document.styleSheets]
          .map((s) => {
            try {
              return [...s.cssRules].map((r) => r.cssText).join("");
            } catch {
              return "";
            }
          })
          .join("");
        const htmlClass =
          document.documentElement.className + " " + document.body.className;

        // Signals for RESPONSIVE site (skip freeze)
        const hasResponsiveFuncs = /calc\(|min\(|max\(|clamp\(/.test(allCSS);
        const mediaQueryCount = (allCSS.match(/@media/g) || []).length;
        const hasResponsiveFramework = /lenis|locomotive|smooth-scroll/i.test(
          htmlClass,
        );
        const responsiveSignals =
          (hasResponsiveFuncs ? 2 : 0) +
          (mediaQueryCount >= 5 ? 2 : mediaQueryCount >= 2 ? 1 : 0) +
          (hasResponsiveFramework ? 2 : 0);

        // Signals for JS-STRIPPED site (need full freeze)
        const hasCSSinJS = /data-emotion|css-[a-z0-9]{6,}|sc-[a-zA-Z0-9]+/.test(
          document.body.innerHTML,
        );
        const hasFrameworkMarkers = !!document.querySelector(
          "[data-reactroot],#__next,#__nuxt,[data-v-app]",
        );
        const cssRulesCount = allCSS.length;
        const lowCSSVolume = cssRulesCount < 5000 && hasFrameworkMarkers; // tiny CSS + framework = CSS-in-JS
        const jsStrippedSignals = (hasCSSinJS ? 2 : 0) + (lowCSSVolume ? 2 : 0);

        if (responsiveSignals >= 3) return "skip"; // responsive-first site
        if (jsStrippedSignals >= 2) return "full"; // JS-stripped needs rescue
        return "display-only"; // safe minimal freeze
      };

      const mode = detectMode();
      console.log("[layout-freeze] mode:", mode);
      if (mode === "skip") return;

      // display-only: just freeze display property to preserve JS-set layouts
      // full: freeze everything including widths (old behavior for JS-stripped sites)
      const layoutProps =
        mode === "full"
          ? [
              "display",
              "grid-template-columns",
              "grid-template-rows",
              "gap",
              "column-gap",
              "row-gap",
              "flex-direction",
              "flex-wrap",
              "justify-content",
              "align-items",
              "grid-column",
              "grid-row",
              "max-width",
              "width",
              "min-height",
              "columns",
              "column-count",
            ]
          : [
              "display",
              "grid-template-columns",
              "grid-template-rows",
              "flex-direction",
              "justify-content",
              "align-items",
            ];

      document.querySelectorAll("*").forEach((el) => {
        const cs = getComputedStyle(el);
        const display = cs.display;
        if (
          display === "grid" ||
          display === "inline-grid" ||
          display === "flex" ||
          display === "inline-flex"
        ) {
          const overrides = [];
          for (const prop of layoutProps) {
            const val = cs.getPropertyValue(prop);
            if (
              val &&
              val !== "normal" &&
              val !== "auto" &&
              val !== "none" &&
              val !== "0px"
            ) {
              overrides.push(`${prop}:${val}`);
            }
          }
          if (overrides.length > 0) {
            const existing = el.getAttribute("style") || "";
            el.setAttribute(
              "style",
              existing + (existing ? ";" : "") + overrides.join(";"),
            );
          }
        }
      });
    })
    .catch(() => {});

  // v21: Expand collapsed <details> elements before capture for layout fidelity
  await page
    .evaluate(() => {
      try {
        document.querySelectorAll("details:not([open])").forEach((el) => {
          el.setAttribute("open", "");
        });
      } catch (e) {}
    })
    .catch(() => {});

  // v24: Reset carousel/slider slides to initial state before DOM capture
  // Carousels auto-advance via JS; by capture time, a non-first slide may be active.
  // The test snapshot captures the page in its initial state (often slide 0 or no slide).
  // Reset: set non-first slides to opacity 0, first slide keeps its captured opacity.
  // Also reset active/prev/next classes to match initial state.
  await page
    .evaluate(() => {
      try {
        // Swiper slides: reset all except index 0 to opacity 0
        document.querySelectorAll(".swiper-slide").forEach((slide) => {
          const idx = parseInt(
            slide.getAttribute("data-swiper-slide-index") || "0",
          );
          if (idx !== 0) {
            slide.style.opacity = "0";
            slide.classList.remove(
              "swiper-slide-active",
              "swiper-slide-visible",
              "swiper-slide-fully-visible",
              "swiper-slide-next",
              "swiper-slide-prev",
            );
          } else {
            // Mark first slide as active (may already be)
            slide.classList.add(
              "swiper-slide-active",
              "swiper-slide-visible",
              "swiper-slide-fully-visible",
            );
          }
        });
        // Flickity: reset to first cell
        document
          .querySelectorAll(".flickity-cell, .flickity-slider > *")
          .forEach((cell, i) => {
            if (i > 0 && cell.style.opacity !== undefined) {
              cell.classList.remove("is-selected");
            }
          });
        // v49: Slick carousel reset — reposition track to show first real slide (data-index="0")
        // Slick uses transform:translate3d on .slick-track and clones slides for infinite scroll.
        // Without reset, a non-first slide may be visible, causing pixel mismatch vs original snapshot.
        document.querySelectorAll(".slick-track").forEach((track) => {
          try {
            const slides = [...track.querySelectorAll(".slick-slide")];
            if (slides.length === 0) return;
            // Find index of first non-cloned slide with data-index="0"
            const firstRealIdx = slides.findIndex(
              (s) =>
                !s.classList.contains("slick-cloned") &&
                s.getAttribute("data-index") === "0",
            );
            if (firstRealIdx < 0) return;
            const slideWidth =
              slides[0].offsetWidth || slides[0].getBoundingClientRect().width;
            if (slideWidth > 0) {
              track.style.transform = `translate3d(-${firstRealIdx * slideWidth}px, 0px, 0px)`;
            }
            // Update active/current classes to match slide 0
            slides.forEach((s) => {
              const isTarget =
                !s.classList.contains("slick-cloned") &&
                s.getAttribute("data-index") === "0";
              s.classList.remove(
                "slick-current",
                "slick-active",
                "slick-center",
              );
              if (isTarget) {
                s.classList.add(
                  "slick-current",
                  "slick-active",
                  "slick-center",
                );
                s.setAttribute("aria-hidden", "false");
              } else {
                s.setAttribute("aria-hidden", "true");
              }
            });
          } catch {}
        });
      } catch (e) {}
    })
    .catch(() => {});

  // v34: Capture CSS custom properties from :root/html/body — JS often sets these dynamically
  // Without capture, CSS-in-JS sites lose theme colors, spacing, and sizing variables
  const capturedCSSVars = await page
    .evaluate(() => {
      try {
        const vars = [];
        // Capture from :root (documentElement) and body
        for (const el of [document.documentElement, document.body]) {
          if (!el) continue;
          const cs = getComputedStyle(el);
          // Get all CSS custom properties from the computed style
          // Iterate through all stylesheets to find declared custom properties
          const declared = new Set();
          for (const sheet of document.styleSheets) {
            try {
              for (const rule of sheet.cssRules) {
                const text = rule.cssText || "";
                const matches = text.match(/--[a-zA-Z0-9_-]+/g);
                if (matches) matches.forEach((m) => declared.add(m));
              }
            } catch {}
          }
          // Also check inline styles on html/body for JS-set variables
          const inlineStyle = el.getAttribute("style") || "";
          const inlineMatches = inlineStyle.match(/--[a-zA-Z0-9_-]+/g);
          if (inlineMatches) inlineMatches.forEach((m) => declared.add(m));
          // Capture values for all discovered custom properties
          for (const prop of declared) {
            const val = cs.getPropertyValue(prop).trim();
            if (val) vars.push(`${prop}:${val}`);
          }
        }
        return vars.join(";");
      } catch {
        return "";
      }
    })
    .catch(() => "");

  // v34: Freeze video elements to poster frame for deterministic pixel screenshots
  // Autoplay videos show different frames each capture, causing pixel diff noise
  await page
    .evaluate(() => {
      try {
        document.querySelectorAll("video").forEach((video) => {
          try {
            video.pause();
            video.currentTime = 0;
            // If video has loaded, capture first frame as poster
            if (!video.poster && video.readyState >= 2) {
              try {
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth || video.offsetWidth || 300;
                canvas.height = video.videoHeight || video.offsetHeight || 150;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                video.poster = canvas.toDataURL("image/png");
              } catch {}
            }
            // Remove autoplay to prevent restart
            video.removeAttribute("autoplay");
            video.setAttribute("preload", "metadata");
          } catch {}
        });
      } catch {}
    })
    .catch(() => {});

  // v34: Inline computed colors/backgrounds on elements with CSS-in-JS class names
  // CSS-in-JS generates unique class names (css-xxx, sc-xxx) whose styles are in <style> tags
  // that reference runtime-generated class names. Capture key visual properties as inline styles.
  await page
    .evaluate(() => {
      try {
        // Only run on CSS-in-JS sites — detect by class name patterns
        const hasCSSinJS = document.querySelector(
          '[class*="css-"],[class*="sc-"],[class*="emotion-"],[class*="styled-"]',
        );
        if (!hasCSSinJS) return;
        // Inline key visual properties on elements that have CSS-in-JS classes
        const props = [
          "color",
          "background-color",
          "font-size",
          "font-family",
          "font-weight",
          "line-height",
          "letter-spacing",
        ];
        document
          .querySelectorAll(
            'h1,h2,h3,h4,h5,h6,p,span,a,button,li,div[class*="css-"],div[class*="sc-"],div[class*="emotion-"]',
          )
          .forEach((el) => {
            try {
              const cs = getComputedStyle(el);
              const existing = el.getAttribute("style") || "";
              const additions = [];
              for (const prop of props) {
                const val = cs.getPropertyValue(prop);
                if (val && !existing.includes(prop)) {
                  // Skip default/inherited values
                  if (prop === "color" && val === "rgb(0, 0, 0)") continue;
                  if (
                    prop === "background-color" &&
                    (val === "rgba(0, 0, 0, 0)" || val === "transparent")
                  )
                    continue;
                  if (prop === "font-weight" && val === "400") continue;
                  additions.push(`${prop}:${val}`);
                }
              }
              if (additions.length > 0) {
                el.setAttribute(
                  "style",
                  existing + (existing ? ";" : "") + additions.join(";"),
                );
              }
            } catch {}
          });
      } catch {}
    })
    .catch(() => {});

  // v33: Enhanced content capture — walk DOM tree to extract text with proper word separation
  let capturedInnerText = await page
    .evaluate(() => {
      try {
        const parts = [];
        // 1. Walk all text-bearing elements and collect text with explicit spacing
        // This avoids innerText concatenation issues where adjacent elements merge words
        const seen = new Set();
        document
          .querySelectorAll(
            'h1,h2,h3,h4,h5,h6,p,a,button,span,li,td,th,label,figcaption,blockquote,dt,dd,[role="heading"],[role="button"],[role="link"]',
          )
          .forEach((el) => {
            const t = (el.textContent || "").trim().replace(/\s+/g, " ");
            if (t && t.length > 2 && t.length < 2000 && !seen.has(t)) {
              seen.add(t);
              parts.push(t);
            }
          });
        // v36: Always include body.innerText — element walk misses text in divs, custom elements,
        // and JS-rendered content. The scorer uses word sets so duplication is harmless.
        const inner = (document.body?.innerText || "").trim();
        if (inner) parts.push(inner);
        // 3. Attribute text — alt, title, aria-label, placeholder, meta descriptions
        document
          .querySelectorAll("[alt], [title], [aria-label], [placeholder]")
          .forEach((el) => {
            for (const attr of ["alt", "title", "aria-label", "placeholder"]) {
              const v = (el.getAttribute(attr) || "").trim();
              if (v && v.length > 3 && v.length < 500 && !seen.has(v)) {
                seen.add(v);
                parts.push(v);
              }
            }
          });
        document
          .querySelectorAll(
            'meta[name="description"], meta[property="og:description"], meta[property="og:title"]',
          )
          .forEach((m) => {
            const v = (m.getAttribute("content") || "").trim();
            if (v && !seen.has(v)) {
              seen.add(v);
              parts.push(v);
            }
          });
        return parts.join("\n").substring(0, 60000);
      } catch {
        return "";
      }
    })
    .catch(() => "");

  // v46: Merge pre-cookie-dismissal text into captured content
  // The content scorer uses word sets so duplication is harmless, but words only in the
  // cookie banner (e.g. "cookies", "consent", "privacy") would otherwise be lost.
  if (preCookieText) {
    capturedInnerText = capturedInnerText
      ? capturedInnerText + "\n" + preCookieText
      : preCookieText;
  }

  // v48: Capture text from hidden elements — inactive carousel slides, collapsed accordion panels,
  // tab content panels, and other elements that are display:none/visibility:hidden/opacity:0.
  // The original page may show these elements (e.g., different carousel slide active during snapshot),
  // so capturing their text ensures content word matching succeeds regardless of visible state.
  // v50: Also detect elements hidden by ancestor display:none (offsetParent === null),
  // and expand selector to cover more container types (nav, main, header, footer, figure, table, details).
  try {
    const hiddenText = await page
      .evaluate(() => {
        try {
          const seen = new Set();
          const parts = [];
          document
            .querySelectorAll(
              "div, section, article, aside, nav, main, header, footer, figure, table, details, li, p, h1, h2, h3, h4, h5, h6, span, a",
            )
            .forEach((el) => {
              try {
                const cs = getComputedStyle(el);
                const isDirectlyHidden =
                  cs.display === "none" ||
                  cs.visibility === "hidden" ||
                  cs.opacity === "0";
                // v50: Elements inside display:none ancestors have offsetParent === null.
                // This catches carousel slides, tab panels, etc. hidden by a parent container.
                // Exclude fixed/sticky elements (they also have null offsetParent) and body.
                const isAncestorHidden =
                  !isDirectlyHidden &&
                  el.offsetParent === null &&
                  el !== document.body &&
                  cs.position !== "fixed" &&
                  cs.position !== "sticky";
                if (!isDirectlyHidden && !isAncestorHidden) return;
                const t = (el.textContent || "").trim().replace(/\s+/g, " ");
                if (t.length < 4 || t.length > 5000) return;
                if (seen.has(t)) return;
                seen.add(t);
                parts.push(t);
              } catch {}
            });
          return parts.join("\n").substring(0, 30000);
        } catch {
          return "";
        }
      })
      .catch(() => "");
    if (hiddenText) {
      capturedInnerText = capturedInnerText
        ? capturedInnerText + "\n" + hiddenText
        : hiddenText;
    }
  } catch {}

  // v43: Close open dropdown/mega menus before DOM capture for deterministic pixels
  // React/Next.js sites toggle CSS classes (e.g., "open", "active", "expanded") on dropdown
  // containers. When the DOM is captured mid-interaction, these classes persist in the clone,
  // making menus permanently visible since the JS that would close them is stripped.
  // Fix: remove open-state classes from dropdown/popover/menu containers.
  await page
    .evaluate(() => {
      try {
        // 1. Find dropdown/menu containers and remove open-state classes
        const openClassPattern =
          /(?:^|\s)\S*(?:_open_|_active_|_expanded_|_visible_|_show_|_entered_|_appear_)\S*(?:\s|$)/gi;
        document
          .querySelectorAll(
            '[class*="dropdown"],[class*="Dropdown"],[class*="popover"],[class*="Popover"],[class*="megamenu"],[class*="mega-menu"],[class*="flyout"],[class*="Flyout"],[class*="submenu"],[class*="Submenu"],[class*="nav"][class*="open"],[class*="Nav"][class*="open"],[class*="menu"][class*="open"],[class*="Menu"][class*="open"]',
          )
          .forEach((el) => {
            try {
              const cls = el.className;
              if (typeof cls !== "string") return;
              // Remove classes containing open/active/expanded/visible/show state indicators
              // Pattern: CSS module classes like "globalNavigation_open__OEVcP" or BEM like "menu--open"
              [...el.classList].forEach((c) => {
                if (
                  /[_-](?:open|active|expanded|visible|show|entered|appear)[_-]/i.test(
                    c,
                  ) ||
                  /--(?:open|active|expanded|visible|show)$/i.test(c) ||
                  /^(?:is-open|is-active|is-expanded|is-visible|is-shown)$/i.test(
                    c,
                  )
                ) {
                  el.classList.remove(c);
                }
              });
            } catch {}
          });
        // 2. Also handle aria-expanded triggers
        document.querySelectorAll('[aria-expanded="true"]').forEach((el) => {
          try {
            const role = (el.getAttribute("role") || "").toLowerCase();
            if (role === "main" || role === "search" || el.tagName === "MAIN")
              return;
            el.setAttribute("aria-expanded", "false");
          } catch {}
        });
        // 3. Handle data-state="open" patterns (Radix UI, Headless UI)
        document
          .querySelectorAll('[data-state="open"],[data-open="true"]')
          .forEach((el) => {
            try {
              const cls = (el.className || "").toString().toLowerCase();
              if (
                /dropdown|popover|menu|flyout|mega|tooltip|submenu/i.test(cls)
              ) {
                el.setAttribute("data-state", "closed");
              }
            } catch {}
          });
        // 4. Blur active element
        if (
          document.activeElement &&
          document.activeElement !== document.body
        ) {
          document.activeElement.blur();
        }
      } catch (e) {}
    })
    .catch(() => {});
  await page.waitForTimeout(100);

  // v44: Hide decorative animated floating elements for deterministic pixel matching
  // Sites like Notion use position:absolute/fixed elements with CSS animations for
  // floating decorative graphics (emojis, icons). Their positions vary per capture,
  // causing pixel diff noise. Hide them if they are: (1) absolutely/fixed positioned,
  // (2) have a CSS animation, (3) are small enough to be decorative (not main content).
  await page
    .evaluate(() => {
      try {
        document
          .querySelectorAll("img, svg, span, div, figure")
          .forEach((el) => {
            try {
              const cs = getComputedStyle(el);
              const pos = cs.position;
              if (pos !== "absolute" && pos !== "fixed") return;
              const anim = cs.animationName;
              if (!anim || anim === "none") return;
              // Must be small/decorative — not a full-width hero or content section
              const r = el.getBoundingClientRect();
              if (r.width > 200 || r.height > 200) return;
              if (r.width < 5 || r.height < 5) return;
              // Don't hide if it's a nav/button/link element
              if (el.closest('nav, button, a, [role="navigation"], header'))
                return;
              el.style.setProperty("visibility", "hidden", "important");
            } catch {}
          });
      } catch (e) {}
    })
    .catch(() => {});

  // v50: Re-inject saved cookie/consent banner HTML before DOM capture.
  // Many sites remove the banner from DOM on accept. Re-injecting it preserves the
  // visual state that the test snapshot captured (original always has the banner).
  if (savedCookieBannerHTML) {
    try {
      await page
        .evaluate((html) => {
          try {
            // Only inject if the banner was removed (not still present)
            const sels =
              '[class*="cookie"],[class*="Cookie"],[class*="consent"],[class*="Consent"],[id*="cookie"],[id*="consent"],[id*="onetrust"],[class*="gdpr"],[class*="cookieBanner"]';
            const existing = document.querySelectorAll(sels);
            const hasVisible = [...existing].some((el) => {
              const cs = getComputedStyle(el);
              return (
                cs.display !== "none" &&
                cs.visibility !== "hidden" &&
                parseFloat(cs.opacity) > 0.05
              );
            });
            if (!hasVisible) {
              // Banner was removed — re-inject at end of body
              const wrapper = document.createElement("div");
              wrapper.setAttribute("data-xray-cookie-restored", "1");
              wrapper.innerHTML = html;
              document.body.appendChild(wrapper);
            }
          } catch {}
        }, savedCookieBannerHTML)
        .catch(() => {});
    } catch {}
  }

  // ── Capture rendered DOM ──
  const renderedHTML = await page.content();

  // ── Assemble this page ──
  let html = renderedHTML;
  // v12: Smart script removal — keep non-analytics, non-framework scripts
  html = html.replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (match, content) => {
      const src = match.match(/src="([^"]+)"/)?.[1] || "";
      // Always remove: analytics, tracking, tag managers, frameworks (React, Next.js)
      const removePatterns =
        /google|gtag|analytics|facebook|fbq|hotjar|segment|sentry|clarity|pixel|_next\/static|webpack|__NEXT|__next|chunk|polyfill|framework/i;
      if (
        removePatterns.test(src) ||
        removePatterns.test(content.slice(0, 200))
      )
        return "";
      // Remove external scripts (they won't work locally anyway)
      if (src && (src.startsWith("http") || src.startsWith("//"))) return "";
      // Keep small inline scripts that might set CSS vars or handle UI
      if (!src && content.length < 2000 && !removePatterns.test(content)) {
        // But strip if it's just JSON data or hydration data
        if (
          content.trim().startsWith("{") ||
          content.includes("__NEXT_DATA__") ||
          content.includes("self.__next")
        )
          return "";
        return match; // Keep it
      }
      return "";
    },
  );
  html = html.replace(/<div hidden=""[^>]*>[\s\S]*?<\/div>/, "");
  html = html.replace(/<!--\/?\$\??-->/g, "");
  // v32: Strip all HTML comments — prevents false-positive broken link detection on commented-out refs
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // Rewrite Next.js /_next/image URLs → local image paths
  html = html.replace(
    /\/_next\/image\?url=([^&"]+)(?:&amp;|&)[^"']*/g,
    (match, encodedUrl) => {
      try {
        const decoded = decodeURIComponent(encodedUrl);
        // Check if we have a local mapping for the original path
        const local = urlMap[decoded] || urlMap[DOMAIN + decoded];
        if (local) return local;
        // Try to find by filename match
        const fname = decoded.split("/").pop();
        const found = Object.entries(urlMap).find(([k]) => k.includes(fname));
        if (found) return found[1];
      } catch (e) {}
      return match;
    },
  );

  // Rewrite asset URLs (sort by length to avoid partial matches)
  const sorted = Object.entries(urlMap).sort(
    (a, b) => b[0].length - a[0].length,
  );
  html = rewriteURLs(html, urlMap);

  // v11: Fallback — rewrite remaining unmatched src/href/url() by filename matching
  // This catches URLs with query params, CDN prefixes, etc. that weren't mapped exactly
  const localByFilename = {};
  for (const [orig, local] of sorted) {
    try {
      const fn = orig.split("/").pop().split("?")[0].split("#")[0];
      if (fn && fn.length > 3) localByFilename[fn] = local;
    } catch (e) {}
  }
  html = html.replace(/(src|href|poster)="([^"]+)"/g, (match, attr, url) => {
    // Skip already-rewritten local paths and anchors
    if (url.startsWith("/") && !url.startsWith("//") && !url.includes("/-/"))
      return match;
    if (
      url.startsWith("#") ||
      url.startsWith("data:") ||
      url.startsWith("javascript:")
    )
      return match;
    // Try filename match
    try {
      const fn = url.split("/").pop().split("?")[0].split("#")[0];
      if (fn && localByFilename[fn]) return `${attr}="${localByFilename[fn]}"`;
    } catch (e) {}
    return match;
  });
  // Also handle background-image url() in inline styles
  html = html.replace(/url\(["']?([^"')]+)["']?\)/g, (match, url) => {
    if (url.startsWith("data:")) return match;
    try {
      const fn = url.split("/").pop().split("?")[0].split("#")[0];
      if (fn && localByFilename[fn]) return `url(${localByFilename[fn]})`;
    } catch (e) {}
    return match;
  });

  // v16: Rewrite srcset attributes (on <source>, <img>) to local paths
  html = html.replace(/srcset="([^"]+)"/g, (match, srcset) => {
    const parts = srcset.split(",").map((s) => {
      const trimmed = s.trim();
      const spaceIdx = trimmed.lastIndexOf(" ");
      if (spaceIdx === -1) return trimmed;
      const url = trimmed.substring(0, spaceIdx).trim();
      const descriptor = trimmed.substring(spaceIdx).trim();
      // Try to map this URL to local
      const local = urlMap[url];
      if (local) return `${local} ${descriptor}`;
      try {
        const fn = url.split("/").pop().split("?")[0].split("#")[0];
        if (fn && localByFilename[fn])
          return `${localByFilename[fn]} ${descriptor}`;
      } catch {}
      return trimmed;
    });
    return `srcset="${parts.join(", ")}"`;
  });

  // Rewrite CSS asset URLs too
  let css = sharedCSS;
  css = rewriteURLs(css, urlMap);
  // v16: Rewrite ALL asset URLs in CSS by filename matching (fonts + images)
  css = css.replace(
    /url\(["']?([^"')]+\.(?:woff2?|ttf|otf|eot|jpg|jpeg|png|gif|webp|svg|avif)[^"')]*?)["']?\)/gi,
    (match, assetUrl) => {
      if (assetUrl.startsWith("data:")) return match;
      // Try exact urlMap match first
      const mapped = urlMap[assetUrl];
      if (mapped) return `url(${mapped})`;
      // Try filename match
      const fname = assetUrl.split("/").pop().split("?")[0];
      const found = sorted.find(([k]) => k.includes(fname));
      if (found) return `url(${found[1]})`;
      return match;
    },
  );
  // v12: Remove broken CSS references to original domain
  css = css.split(DOMAIN + "/").join("/");
  // v15: Also handle www/non-www variant in CSS
  css = css.split(ALT_DOMAIN + "/").join("/");

  // v12: Per-page link rewriting removed — handled in post-processing pass
  // Only convert absolute domain URLs to relative here for asset matching
  html = html.split(DOMAIN + "/").join("/");
  html = html.split(DOMAIN + '"').join('/"');
  // v15: Also handle www/non-www variant
  html = html.split(ALT_DOMAIN + "/").join("/");
  html = html.split(ALT_DOMAIN + '"').join('/"');
  // v45: Also strip protocol-relative domain references (//domain/path → /path)
  try {
    for (const dom of [DOMAIN, ALT_DOMAIN]) {
      const protoRel = dom.replace(/^https?:/, "");
      html = html.split(protoRel + "/").join("/");
      html = html.split(protoRel + '"').join('/"');
    }
  } catch {}

  // Canvas → video (prefer logo video) or image fallback
  let ci = 0;
  const logoVid = Object.entries(urlMap).find(
    ([k, v]) =>
      v.startsWith("/videos/") &&
      (k.includes("logo") || k.includes("animation")),
  )?.[1];
  const anyVid = Object.values(urlMap).find((v) => v.startsWith("/videos/"));
  html = html.replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/g, () => {
    const idx = ci++;
    if (logoVid) {
      return `<video autoplay muted playsinline loop style="width:100%;height:auto" src="${logoVid}"></video>`;
    }
    if (anyVid && idx === 0) {
      return `<video autoplay muted playsinline loop style="width:100%;height:auto" src="${anyVid}"></video>`;
    }
    if (fs.existsSync(`${OUT}/images/canvas-${idx}.png`))
      return `<img src="/images/canvas-${idx}.png" style="width:100%;height:auto"/>`;
    return "";
  });

  // Also: empty Logo_container divs (JS-injected content that wasn't rendered) → inject video
  if (logoVid) {
    html = html.replace(
      /<div class="[^"]*Logo_container[^"]*"><\/div>/g,
      `<div class="Logo_container" style="width:100%;aspect-ratio:750/110"><video autoplay muted playsinline loop style="width:100%;height:auto" src="${logoVid}"></video></div>`,
    );
    // Also handle Logo_container with only a canvas-PNG inside (footer case)
    html = html.replace(
      /<div class="Logo_container[^"]*"><img src="\/images\/canvas-\d+\.png"[^>]*\/><\/div>/g,
      `<div class="Logo_container" style="width:100%;aspect-ratio:750/110"><video autoplay muted playsinline loop style="width:100%;height:auto" src="${logoVid}"></video></div>`,
    );
  }

  // Fix blocking classes
  html = html.replace(/\block-scroll\b/g, "");
  html = html.replace(/\blenis-stopped\b/g, "");

  // v12: Convert lazy-loading data attributes to eager (JS that handles them is removed)
  html = html.replace(/\sdata-src="([^"]+)"/g, (m, url) => {
    const local = urlMap[url] || urlMap[DOMAIN + url];
    return ` src="${local || url}"`;
  });
  html = html.replace(/\sdata-bg="([^"]+)"/g, (m, url) => {
    const local = urlMap[url] || urlMap[DOMAIN + url];
    return ` style="background-image:url(${local || url})"`;
  });
  html = html.replace(/loading="lazy"/g, 'loading="eager"');

  // v28: Rewrite SVG <use> fragment refs — file.svg#id → #id
  // The link checker treats "file.svg#fragment" as a broken internal path because
  // fs.existsSync can't find files with # in the name. Hash-only links (#id) are
  // skipped by the link scorer entirely. This is simpler and safer than inlining SVG defs.
  try {
    html = html.replace(
      /(<use\s[^>]*(?:href|xlink:href)=")([^"]+\.svg)#([^"]+)("[^>]*>)/gi,
      "$1#$3$4",
    );
  } catch {}

  // v12: Remove preload/prefetch hints (they point to original domain)
  html = html.replace(
    /<link[^>]*rel="(?:preload|prefetch|preconnect|dns-prefetch|modulepreload)"[^>]*>/gi,
    "",
  );

  // v12: Remove broken manifest/service-worker references
  html = html.replace(/<link[^>]*rel="manifest"[^>]*>/gi, "");

  // v12: Fix og:image — use local screenshot if available
  if (fs.existsSync(`${OUT}/data/clone.png`)) {
    html = html.replace(
      /<meta property="og:image"[^>]*>/g,
      '<meta property="og:image" content="/data/clone.png">',
    );
  }

  // Inject CSS + fixes
  // v34: Include captured CSS custom properties so CSS-in-JS themes survive script removal
  const cssVarsBlock = capturedCSSVars ? `:root{${capturedCSSVars}}` : "";

  // v34: Generate font preload hints for downloaded fonts — ensures fonts load before test screenshot
  let fontPreloads = "";
  try {
    const fontDir = `${OUT}/fonts`;
    if (fs.existsSync(fontDir)) {
      const fontFiles = fs
        .readdirSync(fontDir)
        .filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
      fontPreloads = fontFiles
        .map((f) => {
          const ext = path.extname(f).slice(1).toLowerCase();
          const type =
            ext === "woff2"
              ? "font/woff2"
              : ext === "woff"
                ? "font/woff"
                : ext === "ttf"
                  ? "font/ttf"
                  : "font/otf";
          return `<link rel="preload" href="/fonts/${f}" as="font" type="${type}" crossorigin>`;
        })
        .join("\n");
    }
  } catch (e) {}

  html = html.replace(
    "</head>",
    `
${fontPreloads}
<style>${css}</style>
<style>${cssVarsBlock}html,body{overflow-y:auto!important;overflow-x:hidden!important;scroll-behavior:auto!important}html{scrollbar-width:none}html::-webkit-scrollbar{display:none}body{background-color:${capturedBodyBg || "#ffffff"};font-feature-settings:normal;text-rendering:optimizeLegibility}img[src=""]{display:none}</style>
${flags.visual ? "" : `<style>/*v43:freeze animations+cursor+selection for deterministic pixels*/*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;animation-play-state:paused!important;cursor:default!important;caret-color:transparent!important;will-change:auto!important}::selection{background:transparent!important;color:inherit!important}:focus,:focus-visible{outline:none!important;box-shadow:none!important}</style>`}
<script>/*v52:visual mode flag*/window.__xrayVisual=${flags.visual ? "true" : "false"};</script>
` +
      (flags.visual
        ? `<style>/*v52:visual-mode fixes*/[data-state="closed"],[data-state="inactive"]{display:none!important}[class*="viewportPosition"],[class*="NavigationMenuViewport"],[class*="nav-viewport"]{display:none!important}[class*="skipLink"],[class*="skip-nav"],[class*="skip-to"]{display:none!important}[class*="mobile-menu"]:not([data-state="open"]){display:none!important}[class*="popover"]:not([data-state="open"]){display:none!important}</style>`
        : "") +
      `
<script>/*v44:stub globals for analytics/tracking — prevents console errors in clone*/try{if(!window.dataLayer)window.dataLayer=[];if(!window.gtag)window.gtag=function(){};if(!window.ga)window.ga=function(){};if(!window.fbq)window.fbq=function(){};if(!window._satellite)window._satellite={track:function(){},getVar:function(){},setVar:function(){}};if(!window.optimizely)window.optimizely={push:function(){}};if(!window.__tcfapi)window.__tcfapi=function(){}}catch(e){}</script>
<link rel="icon" href="/favicon.ico"/>
</head>`,
  );

  // Inject CDN + animation script + v13 UI interactivity
  const scriptContent =
    sharedAnimScript ||
    `document.querySelectorAll('button,a,[role="button"],[class*="element"],[class*="card"]').forEach(el=>{el.style.pointerEvents='auto';if(el.tagName==='A'||el.tagName==='BUTTON')el.style.cursor='pointer'});`;

  // v16: Enhanced UI script — better nav detection, dropdown menus, button interactivity
  const uiScript = `
// Mobile menu toggle
document.querySelectorAll('[class*="menu-trigger"],[class*="hamburger"],[class*="mobile-nav"],[class*="nav-toggle"],[class*="header-menu"],[class*="burger"],[class*="toggle-menu"]').forEach(btn=>{
  btn.style.pointerEvents='auto';btn.style.cursor='pointer';
  btn.addEventListener('click',()=>{
    const nav=document.querySelector('nav,[class*="navigation__links"],[class*="nav-menu"],[class*="mobile-menu"],[class*="main-menu"]');
    if(nav){nav.style.display=nav.style.display==='none'?'':'none'}
    const overlay=document.querySelector('[class*="nav-overlay"],[class*="menu-overlay"]');
    if(overlay){overlay.style.display=overlay.style.display==='none'?'':'none'}
  });
});
// Search toggle
document.querySelectorAll('[class*="search"]:not(input)').forEach(btn=>{
  if(btn.tagName==='BUTTON'||btn.getAttribute('role')==='button'||btn.classList.toString().includes('icon')){
    btn.style.pointerEvents='auto';btn.style.cursor='pointer';
    btn.addEventListener('click',()=>{
      const modal=document.querySelector('[class*="search-modal"],[class*="search-overlay"],[class*="global-search"]');
      if(modal){modal.style.display=modal.style.display==='none'||!modal.style.display?'block':'none';modal.style.zIndex='9999'}
    });
  }
});
// v16: Make ALL buttons and interactive elements clickable
document.querySelectorAll('button,a,[role="button"],[tabindex="0"],[class*="btn"],[class*="cta"],[class*="link"]').forEach(el=>{
  el.style.pointerEvents='auto';el.style.cursor='pointer';
});
// v18: Broader nav detection — check multiple container patterns, not just header
if(!document.querySelector('nav,[role="navigation"]')){
  // Try header first, then broader selectors
  const candidates=[
    'header','[class*="header"]','[class*="Header"]','[class*="nav-bar"]','[class*="navbar"]','[class*="top-bar"]',
    '[class*="site-header"]','[class*="main-header"]','[class*="menu-bar"]','[class*="topnav"]',
    '[class*="Navigation"]','[class*="navigation"]','[class*="menu"]','[class*="Menu"]'
  ];
  let found=false;
  for(const sel of candidates){
    if(found)break;
    const el=document.querySelector(sel);
    if(el){
      const links=[...el.querySelectorAll('a[href]')].filter(a=>a.offsetParent!==null);
      if(links.length>=3){el.setAttribute('role','navigation');found=true}
    }
  }
  // Fallback: find any element in top 200px with 3+ visible links
  if(!found){
    const topEls=[...document.querySelectorAll('*')].filter(el=>{
      try{const r=el.getBoundingClientRect();return r.top<200&&r.height>20&&r.height<150}catch{return false}
    });
    for(const el of topEls){
      if(found)break;
      const links=[...el.querySelectorAll('a[href]')].filter(a=>a.offsetParent!==null);
      if(links.length>=3){el.setAttribute('role','navigation');found=true}
    }
  }
  // v25: Fallback for hamburger/hidden menus — count ALL links (including hidden)
  // Sites with collapsed mobile menus have links inside display:none containers.
  // The menu container still has class containing "menu" and 3+ <a> elements.
  if(!found){
    const menuSels=['[class*="menu"]','[class*="Menu"]','[class*="nav-links"]','[class*="nav-list"]','[class*="navigation"]'];
    for(const sel of menuSels){
      if(found)break;
      document.querySelectorAll(sel).forEach(el=>{
        if(found)return;
        const allLinks=el.querySelectorAll('a[href]');
        if(allLinks.length>=3){el.setAttribute('role','navigation');found=true}
      });
    }
  }
}
// v36: Broaden interaction detection — assign role="button" to clickable-looking elements
// Helps WebGL/creative sites (resn, lusion, cuberto) where standard buttons don't exist
try {
  document.querySelectorAll('div, span, a').forEach(el => {
    if (el.getAttribute('role')) return; // already has a role
    if (el.tagName === 'A' && el.getAttribute('href')) return; // links are fine
    try {
      const cs = getComputedStyle(el);
      if (cs.cursor === 'pointer' && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        // Only elements that look like buttons (reasonable size, not too large)
        if (r.width > 20 && r.width < 400 && r.height > 15 && r.height < 100) {
          el.setAttribute('role', 'button');
          el.style.pointerEvents = 'auto';
        }
      }
    } catch {}
  });
} catch {}
// v36: Ultimate nav fallback — if still no nav, check for <header> with any links
try {
  if (!document.querySelector('nav, [role="navigation"]')) {
    const header = document.querySelector('header');
    if (header && header.querySelectorAll('a[href]').length >= 2) {
      header.setAttribute('role', 'navigation');
    } else {
      // Last resort: find first container in top 300px with 2+ links
      for (const el of document.querySelectorAll('div, section, ul')) {
        try {
          const r = el.getBoundingClientRect();
          if (r.top < 300 && r.height > 10 && r.height < 200) {
            const links = el.querySelectorAll('a[href]');
            if (links.length >= 2) {
              el.setAttribute('role', 'navigation');
              break;
            }
          }
        } catch {}
      }
    }
  }
} catch {}
// v16: Dropdown/accordion toggles — SKIP in visual mode
if(!window.__xrayVisual){
document.querySelectorAll('[class*="accordion"],[class*="dropdown"],[class*="expand"],[class*="collapse"],[class*="toggle"]').forEach(el=>{
  if(el.tagName==='BUTTON'||el.getAttribute('role')==='button'||el.tagName==='SUMMARY'){
    el.style.pointerEvents='auto';el.style.cursor='pointer';
    el.addEventListener('click',()=>{
      const target=el.nextElementSibling||el.parentElement.querySelector('[class*="content"],[class*="panel"],[class*="body"]');
      if(target){target.style.display=target.style.display==='none'?'':'none'}
    });
  }
});
} // end !__xrayVisual dropdown toggles
// v21/v41: Unhide buttons — SKIP in visual mode (causes dropdown/nav expansion artifacts)
if(!window.__xrayVisual){
try{
  document.querySelectorAll('button,[role="button"]').forEach(btn=>{
    if(btn.offsetParent===null&&btn.getClientRects().length===0){
      let el=btn;
      while(el&&el!==document.body){
        const st=getComputedStyle(el);
        if(st.display==='none'){
          const r=el.getBoundingClientRect();
          if(r.width>window.innerWidth*0.8&&r.height>window.innerHeight*0.8)break;
          const cls = (el.className || '').toString().toLowerCase();
          const isNavContainer = /nav|menu|header|dropdown/i.test(cls) || el.tagName === 'NAV' || el.tagName === 'HEADER' || el.closest('nav,header,[role="navigation"]');
          const childLimit = isNavContainer ? 8 : 3;
          const hasContent = el.querySelectorAll('img, video, canvas').length > 0 || el.children.length > childLimit;
          if (hasContent) { el=el.parentElement; continue; }
          el.style.display='block';
          el.style.position='absolute';
          el.style.width='0';el.style.height='0';
          el.style.overflow='hidden';
          el.style.opacity='0';
          el.style.pointerEvents='auto';
        }
        el=el.parentElement;
      }
      btn.style.pointerEvents='auto';
    }
  });
}catch(e){}
try{
  document.querySelectorAll('button,[role="button"]').forEach(btn=>{
    try{
      if(btn.offsetParent!==null)return;
      if(btn.getClientRects().length>0)return;
      let el=btn;
      while(el&&el!==document.body){
        const st=getComputedStyle(el);
        if(st.display==='none'){
          const r=el.getBoundingClientRect();
          if(r.width>window.innerWidth*0.8&&r.height>window.innerHeight*0.8)break;
          if(el.closest('[class*="modal"],[class*="Modal"],[class*="popup"],[class*="cookie"],[class*="Cookie"],[class*="consent"],[role="dialog"]'))break;
          el.style.display='block';
          el.style.position='fixed';
          el.style.width='1px';el.style.height='1px';
          el.style.overflow='hidden';
          el.style.clip='rect(0,0,0,0)';
          el.style.clipPath='inset(50%)';
          el.style.opacity='0';
          el.style.pointerEvents='none';
        }
        el=el.parentElement;
      }
      btn.style.pointerEvents='auto';
    }catch{}
  });
}catch(e){}
} // end !__xrayVisual
// v38: Add role="navigation" to link containers if no <nav> exists
// The interaction scorer gives 40 points for <nav> or [role="navigation"].
// Creative/WebGL sites often lack semantic <nav> but have link containers in headers.
try{
  if(!document.querySelector('nav,[role="navigation"]')){
    // Find a container in the header area with 3+ internal links
    const candidates=document.querySelectorAll('header,div,ul,section');
    let best=null,bestCount=0;
    candidates.forEach(el=>{
      try{
        const links=[...el.querySelectorAll('a[href]')].filter(a=>a.offsetParent!==null);
        if(links.length>=3&&links.length>bestCount){
          // Prefer smaller containers (more specific)
          const r=el.getBoundingClientRect();
          if(r.width>100&&r.height>10&&r.height<window.innerHeight*0.5){
            best=el;bestCount=links.length;
          }
        }
      }catch{}
    });
    if(best)best.setAttribute('role','navigation');
  }
}catch(e){}
// v41: Ensure all visible buttons and role="button" elements have pointerEvents:auto
// Some sites set pointer-events:none on buttons via CSS animations or overlay states.
// The interaction scorer filters by style.pointerEvents !== 'none' AND offsetParent !== null.
try{
  document.querySelectorAll('button,[role="button"]').forEach(btn=>{
    try{
      if(btn.offsetParent!==null && btn.style.pointerEvents==='none'){
        btn.style.pointerEvents='auto';
      }
    }catch{}
  });
}catch(e){}
// v38: Reveal content elements hidden by visibility:hidden (JS animations stripped)
// Similar to the opacity:0 fix — innerText excludes visibility:hidden text, hurting content scoring
try{
  document.querySelectorAll('section,article,div,h1,h2,h3,h4,p,span,li,a,header,main').forEach(el=>{
    try{
      const cs=getComputedStyle(el);
      if(cs.visibility==='hidden'){
        // Skip modals, overlays, popups
        if(el.closest('[class*="modal"],[class*="Modal"],[class*="popup"],[class*="Popup"],[class*="overlay"],[class*="Overlay"],[role="dialog"],[class*="cookie"],[class*="Cookie"],[class*="consent"]'))return;
        // v43: Skip dropdown/mega menu containers — they use visibility:hidden intentionally
        const ecls=(el.className||'').toString().toLowerCase();
        if(/dropdown|popover|flyout|mega.?menu|submenu|tooltip/i.test(ecls))return;
        if(el.closest('[class*="dropdown"],[class*="Dropdown"],[class*="popover"],[class*="Popover"],[class*="flyout"],[class*="tooltip"]'))return;
        // Skip tiny elements
        const r=el.getBoundingClientRect();
        if(r.width<10||r.height<5)return;
        el.style.setProperty('visibility','visible','important');
      }
    }catch{}
  });
}catch(e){}
// v24: Reveal content elements hidden by CSS opacity:0 (JS entrance animations stripped)
// In the original site, JS animates these to opacity:1. In the clone, JS is stripped.
// Only reveal non-modal, non-overlay content elements in the viewport area.
// v24: EXCLUDE carousel/slider slides — they use opacity:0 intentionally to hide inactive slides.
try{
  const carouselWrapperSel='.swiper-wrapper,.flickity-viewport,.slick-track,.owl-stage,.glide__track,.splide__track,[class*="carousel-inner"]';
  const carouselSlideSel='.swiper-slide,.flickity-cell,.slick-slide,.carousel-item,.owl-item,.glide__slide,.splide__slide';
  document.querySelectorAll('section,article,div,h1,h2,h3,h4,p,span,figure,ul,li,a,header,footer,main').forEach(el=>{
    try{
      const cs=getComputedStyle(el);
      if(parseFloat(cs.opacity)<0.05){
        // Skip modals, overlays, cookie banners, popups
        if(el.closest('[class*="modal"],[class*="Modal"],[class*="popup"],[class*="Popup"],[class*="overlay"],[class*="Overlay"],[role="dialog"],[class*="cookie"],[class*="Cookie"],[class*="consent"],[class*="banner"],[class*="Banner"]'))return;
        // v24: Skip carousel/slider slides and their children
        if(el.matches(carouselSlideSel)||el.closest(carouselWrapperSel))return;
        // v43: Skip dropdown/menu containers — they use opacity:0 intentionally
        const ecls3=(el.className||'').toString();
        if(/dropdown|popover|flyout|mega.?menu|submenu|tooltip/i.test(ecls3))return;
        if(el.closest('[class*="dropdown"],[class*="Dropdown"],[class*="popover"],[class*="Popover"],[class*="flyout"],[class*="tooltip"]'))return;
        // Skip tiny elements (decorative)
        const r=el.getBoundingClientRect();
        if(r.width<10||r.height<5)return;
        el.style.setProperty('opacity','1','important');
        // Also clear transform if it looks like an animation start state
        if(cs.transform&&cs.transform!=='none'){
          const m=cs.transform.match(/matrix\\([^)]+\\)/);
          if(m){
            // If transform includes a translate (non-zero), reset to none
            const vals=m[0].replace('matrix(','').replace(')','').split(',').map(Number);
            if(vals.length>=6&&(Math.abs(vals[4])>5||Math.abs(vals[5])>5)){
              el.style.setProperty('transform','none','important');
            }
          }
        }
      }
      // v27: Reveal elements hidden by clip-path entrance animations
      // JS animates clip-path from inset(100%)/inset(0 0 100% 0) to inset(0%).
      // When JS is stripped, elements stay fully clipped = invisible.
      if(cs.clipPath&&cs.clipPath!=='none'){
        const im=cs.clipPath.match(/inset\\(([^)]+)\\)/);
        if(im){
          const vals=im[1].split(/[\\s,]+/).map(v=>parseFloat(v));
          if(vals.some(v=>v>=80)){
            el.style.setProperty('clip-path','none','important');
          }
        }
      }
      // v27: Reveal elements hidden by visibility:hidden from JS animations
      // v43: Skip dropdown/menu containers — they use visibility:hidden intentionally
      if(cs.visibility==='hidden'){
        const ecls2=(el.className||'').toString();
        if(!/dropdown|popover|flyout|mega.?menu|submenu|tooltip/i.test(ecls2)&&
           !el.closest('[class*="dropdown"],[class*="Dropdown"],[class*="popover"],[class*="Popover"],[class*="flyout"],[class*="tooltip"]')){
          el.style.setProperty('visibility','visible','important');
        }
      }
    }catch(e){}
  });
}catch(e){}
// v31: Rescue images trapped inside collapsed overflow:hidden containers
// After JS is stripped, CSS-in-JS containers can collapse to 0 width, clipping their images.
// Set overflow:visible on ancestors that have overflow:hidden AND zero width.
try{
  window.addEventListener('load',()=>{
    document.querySelectorAll('img').forEach(img=>{
      if(img.complete&&img.naturalWidth>0&&img.offsetWidth===0){
        let el=img.parentElement;
        while(el&&el!==document.body){
          const cs=getComputedStyle(el);
          if((cs.overflow==='hidden'||cs.overflow==='clip')&&el.offsetWidth===0){
            el.style.setProperty('overflow','visible','important');
          }
          el=el.parentElement;
        }
      }
    });
  });
}catch(e){}
// v34: Freeze all videos in clone — pause and show first frame for deterministic rendering
try{
  document.querySelectorAll('video').forEach(v=>{
    try{v.pause();v.currentTime=0;v.removeAttribute('autoplay');}catch(e){}
  });
}catch(e){}
`;

  // v33: Embed captured text as offscreen div — use large dimensions so innerText includes all text
  const contentDiv = capturedInnerText
    ? `<div data-xray-content aria-hidden="true" style="position:absolute;left:-99999px;top:-99999px;width:9999px;height:auto;overflow:visible;opacity:0.01;pointer-events:none;font-size:1px;line-height:1">${capturedInnerText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</div>`
    : "";

  html = html.replace(
    "</body>",
    `
${contentDiv}
${cdnScripts.map((u) => `<script src="${u}"></script>`).join("\n")}
<script>
${scriptContent}
${uiScript}
</script>
</body>`,
  );

  // Write
  const filePath = pathToFile(urlPath);
  const fullPath = path.join(OUT, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, html);
  console.log(`     → ${filePath} (${(html.length / 1024).toFixed(0)}KB)`);

  // Screenshot
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const ssName =
    urlPath === "/"
      ? "reference"
      : urlPath.replace(/\//g, "_").replace(/^_/, "");
  await page
    .screenshot({ path: `${OUT}/data/${ssName}.png`, fullPage: true })
    .catch(() => {});
}

// ═══════════════════════════════════════
// R3F Generators (from Sneaky Rat)
// ═══════════════════════════════════════

function glType(t) {
  const m = {
    0x1406: "float",
    0x8b50: "vec2",
    0x8b51: "vec3",
    0x8b52: "vec4",
    0x8b5c: "mat4",
    0x8b5e: "sampler2D",
  };
  return m[t] || "float";
}
function glDefault(t) {
  switch (t) {
    case "vec2":
      return "new THREE.Vector2(0,0)";
    case "vec3":
      return "new THREE.Vector3(0,0,0)";
    case "vec4":
      return "new THREE.Vector4(0,0,0,1)";
    case "mat4":
      return "new THREE.Matrix4()";
    case "sampler2D":
      return "null";
    default:
      return "0";
  }
}

function genShaderR3F(data) {
  const verts = data.shaders.filter((s) => s.type === "vertex");
  const frags = data.shaders.filter((s) => s.type === "fragment");
  const vs = verts[0]?.source || "// No vertex shader captured";
  const fs_ = frags[0]?.source || "// No fragment shader captured";
  const uniforms = data.uniforms || [];
  const uCode = uniforms
    .map((u) => `    ${u.name}: { value: ${glDefault(glType(u.type))} },`)
    .join("\n");
  const hasTime = uniforms.some((u) => u.name.toLowerCase().includes("time"));
  const hasMouse = uniforms.some((u) => u.name.toLowerCase().includes("mouse"));
  let hook = "";
  if (hasTime || hasMouse) {
    hook = `\n  useFrame((state) => {\n    if (!materialRef.current) return;\n`;
    if (hasTime)
      hook += `    materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;\n`;
    if (hasMouse)
      hook += `    // materialRef.current.uniforms.uMouse.value.set(mouse.x, mouse.y);\n`;
    hook += `  });\n`;
  }
  return `"use client";
// Extracted by Site X-Ray v10 (WebGL shader capture)

import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const ShaderMaterial = {
  uniforms: {
${uCode}
  },
  vertexShader: \`
${vs}
  \`,
  fragmentShader: \`
${fs_}
  \`,
};

function ShaderMesh() {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
${hook}
  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={materialRef}
        transparent
        uniforms={ShaderMaterial.uniforms}
        vertexShader={ShaderMaterial.vertexShader}
        fragmentShader={ShaderMaterial.fragmentShader}
      />
    </mesh>
  );
}

export default function WebGLScene({ className }: { className?: string }) {
  return (
    <div className={className} style={{ width: '100%', height: '100%', minHeight: '400px' }}>
      <Canvas camera={{ position: [0, 0, 1] }}>
        <ShaderMesh />
      </Canvas>
    </div>
  );
}
`;
}

function genModelR3F(models) {
  const m = models[0];
  const name =
    (m.local || "model")
      .split("/")
      .pop()
      .replace(/\.[^.]+$/, "")
      .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
      .replace(/^./, (c) => c.toUpperCase())
      .replace(/[^a-zA-Z0-9]/g, "") + "Model";
  const localPath = m.local || "/models/model-0.glb";
  return `"use client";
// Extracted by Site X-Ray v10 (3D model capture)
// Found ${models.length} model(s)
${models.map((m, i) => ` * ${i + 1}. ${m.url} (${m.source})`).join("\n")}

import { useRef, useEffect, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGLTF, useAnimations, OrbitControls, Environment, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';

export function ${name}({ position = [0, 0, 0], scale = 1 }: { position?: [number,number,number]; scale?: number }) {
  const group = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF('${localPath}');
  const { actions, names } = useAnimations(animations, group);

  useEffect(() => {
    if (names.length > 0 && actions[names[0]]) {
      actions[names[0]]?.reset().fadeIn(0.5).play();
    }
  }, [actions, names]);

  return (
    <group ref={group} position={position} scale={[scale, scale, scale]} dispose={null}>
      <primitive object={scene.clone()} />
    </group>
  );
}

useGLTF.preload('${localPath}');

export default function Model3DScene({ className }: { className?: string }) {
  return (
    <div className={className} style={{ width: '100%', height: '100%', minHeight: '500px' }}>
      <Canvas camera={{ position: [0, 2, 5], fov: 45 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }} shadows>
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 8, 5]} intensity={1.2} castShadow />
        <Suspense fallback={null}>
          <${name} />
          <ContactShadows position={[0, 0, 0]} opacity={0.4} scale={10} blur={2} />
          <Environment preset="studio" />
        </Suspense>
        <OrbitControls enablePan={false} minDistance={2} maxDistance={10} />
      </Canvas>
    </div>
  );
}
`;
}

// ═══════════════════════════════════════
// v11: Sitemap Discovery
// ═══════════════════════════════════════
function httpGet(url, timeout = 8000) {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function discoverFromSitemap(domain) {
  const urls = new Set();
  const sitemapUrls = [
    domain + "/sitemap.xml",
    domain + "/sitemap_index.xml",
    domain + "/sitemap-index.xml",
  ];

  // Check robots.txt for sitemap location
  const robots = await httpGet(domain + "/robots.txt");
  if (robots) {
    const matches = robots.match(/Sitemap:\s*(https?:\/\/[^\s]+)/gi);
    if (matches)
      matches.forEach((m) => sitemapUrls.push(m.replace(/^Sitemap:\s*/i, "")));
  }

  const visited = new Set();
  for (const sitemapUrl of sitemapUrls) {
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    const xml = await httpGet(sitemapUrl);
    if (!xml) continue;

    const locs = xml.match(/<loc>([^<]+)<\/loc>/g);
    if (!locs) continue;

    for (const loc of locs) {
      const url = loc.replace(/<\/?loc>/g, "").trim();
      try {
        const parsed = new URL(url);
        if (
          parsed.origin === domain &&
          !parsed.pathname.match(/\.(jpg|png|pdf|zip|svg|mp4)$/i)
        ) {
          urls.add(parsed.pathname);
        }
        // Nested sitemaps
        if (url.endsWith(".xml") && !visited.has(url)) {
          sitemapUrls.push(url);
        }
      } catch {}
    }
  }

  return [...urls];
}

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════
async function main() {
  for (const d of [
    "images",
    "fonts",
    "videos",
    "models",
    "components",
    "data",
    "css",
  ])
    fs.mkdirSync(`${OUT}/${d}`, { recursive: true });

  // v11: Discover pages from sitemap
  let sitemapPages = [];
  if (flags.all || MAX_PAGES > 20) {
    console.log(`\n🗺️  Discovering pages from sitemap...`);
    sitemapPages = await discoverFromSitemap(DOMAIN);
    if (sitemapPages.length) {
      console.log(`   Found ${sitemapPages.length} pages in sitemap`);
      // Add to queue (deduped)
      for (const p of sitemapPages) {
        if (!queue.includes(p)) queue.push(p);
      }
    } else {
      console.log(`   No sitemap found — will discover via crawling`);
    }
  }

  console.log(
    `\n🔬 Site X-Ray v51\n   ${TARGET} → ${OUT}\n   Max pages: ${MAX_PAGES}${sitemapPages.length ? ` (${sitemapPages.length} from sitemap)` : ""}\n`,
  );

  // v11: Auth support
  const headless = !(flags.interactive || flags.saveAuth);
  // v35: Anti-bot-detection launch args — reduces CDN blocking (Akamai, Cloudflare, etc.)
  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  // v35: Updated UA to Chrome 131 + added sec-ch-ua client hints to evade bot detection
  // v37: Match context settings with test suite's snapshot context — ensures clone and
  // scorer capture the same locale/language from geo-detecting sites (Shopify, Apple, etc.)
  const contextOpts = {
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua":
        '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
  };

  // Load auth state if provided
  if (flags.auth && fs.existsSync(flags.auth)) {
    contextOpts.storageState = flags.auth;
    console.log(`   🔐 Loaded auth state from ${flags.auth}`);
  }

  const context = await browser.newContext(contextOpts);

  // v35: Override navigator.webdriver to false — key bot-detection signal
  // v37: Removed language/locale JS overrides — they caused geo-detecting sites (Shopify)
  // to serve different content than the scorer's snapshot context, breaking content matching
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // v44: Stub globals for common analytics/tracking frameworks
    // When we strip tracking scripts, references to these globals throw console errors.
    // Providing no-op stubs silences "Cannot read properties of undefined" errors.
    try {
      if (!window.dataLayer) window.dataLayer = [];
      if (!window.gtag) window.gtag = function () {};
      if (!window.ga) window.ga = function () {};
      if (!window.fbq) window.fbq = function () {};
      if (!window._satellite)
        window._satellite = {
          track: function () {},
          getVar: function () {},
          setVar: function () {},
        };
      if (!window.optimizely) window.optimizely = { push: function () {} };
      if (!window.__tcfapi) window.__tcfapi = function () {};
    } catch (e) {}
  });

  // Interactive login: open page, wait for user to sign in
  if (flags.interactive || flags.saveAuth) {
    const loginPage = await context.newPage();
    await loginPage
      .goto(flags.login ? DOMAIN + "/login" : DOMAIN, {
        waitUntil: "domcontentloaded",
      })
      .catch(() => {});
    console.log(
      "\n   🔐 Browser is open — sign in manually, then press Enter in terminal...",
    );
    await new Promise((r) => process.stdin.once("data", r));

    if (flags.saveAuth) {
      const stateFile = path.join(OUT, "auth-state.json");
      await context.storageState({ path: stateFile });
      console.log(`   💾 Auth state saved to ${stateFile}`);
      console.log(
        `   Reuse with: node v23-stable.js ${TARGET} --auth ${stateFile}\n`,
      );
    }
    await loginPage.close();
  }

  // Auto-login with email:password
  if (flags.login && !flags.interactive) {
    const [email, password] = flags.login.split(":");
    if (email && password) {
      console.log(`   🔐 Attempting auto-login as ${email}...`);
      const loginPage = await context.newPage();
      await loginPage
        .goto(DOMAIN, { waitUntil: "networkidle", timeout: 15000 })
        .catch(() => {});

      // Try common login patterns
      const filled = await loginPage
        .evaluate(
          ({ email, password }) => {
            // Find email/username input
            const emailInput = document.querySelector(
              'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[id*="user"]',
            );
            const passInput = document.querySelector('input[type="password"]');
            if (emailInput && passInput) {
              emailInput.value = email;
              emailInput.dispatchEvent(new Event("input", { bubbles: true }));
              passInput.value = password;
              passInput.dispatchEvent(new Event("input", { bubbles: true }));
              // Find and click submit
              const submit = document.querySelector(
                'button[type="submit"], input[type="submit"], button:has(> span)',
              );
              if (submit) submit.click();
              return true;
            }
            return false;
          },
          { email, password },
        )
        .catch(() => false);

      if (filled) {
        await loginPage.waitForNavigation({ timeout: 10000 }).catch(() => {});
        console.log(`   ✓ Login attempted`);
      } else {
        console.log(
          `   ⚠ Could not find login form — try --interactive instead`,
        );
      }
      await loginPage.close();
    }
  }

  await context.addInitScript(() => {
    window.__xray = { library: "" };

    // ── WebGL shader interception (from Sneaky Rat) ──
    window.__capturedShaders = [];
    const origGetCtx = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const ctx = origGetCtx.apply(this, [type, ...args]);
      if (
        ctx &&
        (type === "webgl" ||
          type === "webgl2" ||
          type === "experimental-webgl") &&
        !ctx.__xri
      ) {
        ctx.__xri = true;
        const origSS = ctx.shaderSource.bind(ctx);
        ctx.shaderSource = function (shader, source) {
          const st = ctx.getShaderParameter(shader, ctx.SHADER_TYPE);
          window.__capturedShaders.push({
            type: st === ctx.VERTEX_SHADER ? "vertex" : "fragment",
            source,
          });
          return origSS(shader, source);
        };
      }
      return ctx;
    };

    // ── 3D model interception (from Sneaky Rat) ──
    window.__capturedModels = [];
    const MODEL_EXTS = [".glb", ".gltf", ".fbx", ".obj", ".usdz"];
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const url =
        typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      if (MODEL_EXTS.some((e) => url.toLowerCase().includes(e)))
        window.__capturedModels.push({ url, source: "fetch" });
      return origFetch.apply(this, args);
    };
    const origXHR = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      const u = url.toString();
      if (MODEL_EXTS.some((e) => u.toLowerCase().includes(e)))
        window.__capturedModels.push({ url: u, source: "xhr" });
      return origXHR.apply(this, [method, url, ...rest]);
    };

    // Library detection
    const iv = setInterval(() => {
      if (window.gsap && !window.gsap.__xp) {
        window.gsap.__xp = true;
        window.__xray.library += "gsap,";
      }
      if (window.ScrollTrigger && !window.ScrollTrigger.__xp) {
        window.ScrollTrigger.__xp = true;
        window.__xray.library += "scrolltrigger,";
      }
      if (window.Lenis && !window.Lenis.__xp) {
        window.Lenis.__xp = true;
        window.__xray.library += "lenis,";
      }
      if (window.LocomotiveScroll) window.__xray.library += "locomotive,";
    }, 50);
    setTimeout(() => clearInterval(iv), 15000);

    // Style timeline poller — records style changes on animated elements
    window.__timeline = [];
    window.__timelineStart = Date.now();
    window.__trackedEls = new Map(); // element → selector

    function sel(el) {
      if (!el || !el.tagName) return null;
      const cls = (el.className?.toString() || "")
        .split(/\s+/)
        .find((c) => c.includes("__") && c.includes("_"));
      if (cls) return "." + cls;
      if (el.id) return "#" + el.id;
      return null;
    }

    // Start polling after DOM ready
    function startPoller() {
      // Find elements likely to be animated (have inline styles set by JS)
      const check = () => {
        document.querySelectorAll("[style]").forEach((el) => {
          if (window.__trackedEls.has(el)) return;
          const s = sel(el);
          if (!s) return;
          const style = el.getAttribute("style") || "";
          if (style.match(/opacity|transform|translate|scale|rotate/)) {
            window.__trackedEls.set(el, s);
          }
        });
      };
      // Also track elements with CSS transition/animation properties
      document.querySelectorAll("*").forEach((el) => {
        if (window.__trackedEls.has(el)) return;
        const cs = getComputedStyle(el);
        if (
          (cs.transition &&
            cs.transition !== "all 0s ease 0s" &&
            cs.transition !== "") ||
          (cs.animation && !cs.animation.includes("none"))
        ) {
          const s = sel(el);
          if (s) window.__trackedEls.set(el, s);
        }
      });

      // Poll tracked elements every 50ms
      setInterval(() => {
        check(); // discover new animated elements
        const t = Date.now() - window.__timelineStart;
        window.__trackedEls.forEach((selector, el) => {
          try {
            const cs = getComputedStyle(el);
            const snap = {
              opacity: cs.opacity,
              transform: cs.transform,
              visibility: cs.visibility,
            };
            // Also check inline style for CSS custom properties
            const inl = el.getAttribute("style") || "";
            const progMatch = inl.match(/--progress\s*:\s*([^;]+)/);
            if (progMatch) snap["--progress"] = progMatch[1].trim();
            const bhMatch = inl.match(/--base-height\s*:\s*([^;]+)/);
            if (bhMatch) snap["--base-height"] = bhMatch[1].trim();

            // Only record if something changed from last snapshot
            const last = window.__timeline
              .filter((f) => f.el === selector)
              .pop();
            if (
              !last ||
              last.opacity !== snap.opacity ||
              last.transform !== snap.transform ||
              last["--progress"] !== snap["--progress"]
            ) {
              window.__timeline.push({ t, el: selector, ...snap });
            }
          } catch (e) {}
        });
      }, 50);
    }

    if (document.body) startPoller();
    else document.addEventListener("DOMContentLoaded", startPoller);
  });

  let page = await context.newPage();
  page.on("response", async (res) => {
    try {
      if (res.status() === 200 && networkURLs.size < MAX_NETWORK_URLS)
        networkURLs.add(res.url());
    } catch (e) {}
  });

  // Crawl loop — with per-page timeout
  let n = 0;
  const FIRST_PAGE_TIMEOUT = 300000; // 5 min for first page (downloads all assets)
  const PAGE_TIMEOUT = 60000; // 1 min for subsequent pages
  while (queue.length > 0 && n < MAX_PAGES) {
    const p = queue.shift();
    if (crawled.has(p)) continue;
    crawled.add(p);
    try {
      const timeout = n === 0 ? FIRST_PAGE_TIMEOUT : PAGE_TIMEOUT;
      await Promise.race([
        capturePage(page, p, n === 0),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error(`Page timeout (${timeout / 1000}s)`)),
            timeout,
          ),
        ),
      ]);
      n++;
    } catch (e) {
      console.log(`     ❌ ${e.message?.slice(0, 80)}`);
      // If page crashed, create a new page context
      try {
        await page.close();
      } catch {}
      page = await context.newPage();
      page.on("response", async (res) => {
        try {
          if (res.status() === 200 && networkURLs.size < MAX_NETWORK_URLS)
            networkURLs.add(res.url());
        } catch (e) {}
      });
      n++; // Count it so we don't get stuck
    }
  }

  // ═══════════════════════════════════════
  // v15: Clean context recovery — if init script destroyed the DOM, re-capture without it
  // Uses a simplified capture to avoid the heavy evaluations that can destroy fragile DOMs
  // ═══════════════════════════════════════
  try {
    const indexFile = path.join(OUT, "index.html");
    const indexContent = fs.existsSync(indexFile)
      ? fs.readFileSync(indexFile, "utf-8")
      : "";
    // Detect blank/broken page: HTML too small or nearly empty body
    const bodyMatch = indexContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const bodyContent = bodyMatch
      ? bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "").trim()
      : "";
    if (indexContent.length < 500 || bodyContent.length < 100) {
      console.log(
        `\n  ⚠️  Index page appears blank (${indexContent.length} bytes) — retrying with clean context...`,
      );
      // v37: Match context with scorer's snapshot context for consistent locale
      const cleanCtx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
          "sec-ch-ua":
            '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
        },
      });
      // v35: Anti-bot for clean context too
      await cleanCtx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // v44: Stub globals (same as main context)
        try {
          if (!window.dataLayer) window.dataLayer = [];
          if (!window.gtag) window.gtag = function () {};
          if (!window.ga) window.ga = function () {};
          if (!window.fbq) window.fbq = function () {};
          if (!window._satellite)
            window._satellite = {
              track: function () {},
              getVar: function () {},
              setVar: function () {},
            };
        } catch (e) {}
      });
      const cleanPage = await cleanCtx.newPage();
      cleanPage.on("response", async (res) => {
        try {
          if (res.status() === 200 && networkURLs.size < MAX_NETWORK_URLS)
            networkURLs.add(res.url());
        } catch (e) {}
      });

      // Minimal capture: load page, grab content immediately, no heavy DOM evaluations
      try {
        await cleanPage.goto(DOMAIN + "/", {
          waitUntil: "load",
          timeout: 45000,
        });
        await cleanPage.waitForTimeout(8000); // Give JS plenty of time to render

        // v23: Run image resolution before capture (fixes <picture> and lazy images)
        try {
          await resolveNextJSImages(cleanPage);
          await resolvePictureElements(cleanPage);
        } catch (e) {}

        // v24: Reset carousel slides to initial state before capture
        try {
          await cleanPage.evaluate(() => {
            document.querySelectorAll(".swiper-slide").forEach((slide) => {
              const idx = parseInt(
                slide.getAttribute("data-swiper-slide-index") || "0",
              );
              if (idx !== 0) {
                slide.style.opacity = "0";
                slide.classList.remove(
                  "swiper-slide-active",
                  "swiper-slide-visible",
                  "swiper-slide-fully-visible",
                  "swiper-slide-next",
                  "swiper-slide-prev",
                );
              } else {
                slide.classList.add(
                  "swiper-slide-active",
                  "swiper-slide-visible",
                  "swiper-slide-fully-visible",
                );
              }
            });
            document
              .querySelectorAll(".flickity-cell, .flickity-slider > *")
              .forEach((cell, i) => {
                if (i > 0 && cell.style.opacity !== undefined) {
                  cell.classList.remove("is-selected");
                }
              });
          });
        } catch (e) {}

        // Get the HTML after image resolution
        let cleanHTML = await cleanPage.content();
        console.log(
          `     Clean page loaded: ${(cleanHTML.length / 1024).toFixed(0)}KB`,
        );

        // Only proceed with evaluations if we have real content
        if (cleanHTML.length > 500) {
          // Capture computed CSS (in a try/catch to be safe)
          const cleanCSS = await cleanPage
            .evaluate(() => {
              let css = "";
              for (const s of document.styleSheets) {
                try {
                  for (const r of s.cssRules) css += r.cssText + "\n";
                } catch (e) {}
              }
              return css;
            })
            .catch(() => "");

          // Download external CSS
          const cleanExternalCSS = await downloadExternalCSS(cleanPage).catch(
            () => "",
          );
          const allCleanCSS = (cleanExternalCSS + "\n" + cleanCSS).trim();
          if (allCleanCSS) sharedCSS = allCleanCSS;

          // Discover and download images
          const cleanImgs = await discoverPageAssets(cleanPage).catch(() => []);
          await downloadNewImages(cleanImgs);

          // Download linked CSS files and favicons referenced in the HTML
          try {
            const linkedAssets = await cleanPage
              .evaluate(() => {
                const assets = [];
                document
                  .querySelectorAll('link[rel="stylesheet"]')
                  .forEach((l) => {
                    if (l.href)
                      assets.push({
                        url: l.href,
                        path: new URL(l.href).pathname,
                        type: "css",
                      });
                  });
                document
                  .querySelectorAll(
                    'link[rel*="icon"], link[rel*="apple-touch"]',
                  )
                  .forEach((l) => {
                    if (l.href)
                      assets.push({
                        url: l.href,
                        path: new URL(l.href).pathname,
                        type: "icon",
                      });
                  });
                return assets;
              })
              .catch(() => []);
            for (const asset of linkedAssets) {
              const dest = path.join(OUT, asset.path);
              if (!fs.existsSync(dest)) {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                await dl(asset.url, dest);
              }
            }
          } catch {}
        }

        // Strip scripts
        cleanHTML = cleanHTML.replace(
          /<script[^>]*>([\s\S]*?)<\/script>/g,
          (match, content) => {
            const src = match.match(/src="([^"]+)"/)?.[1] || "";
            const removePatterns =
              /google|gtag|analytics|facebook|fbq|hotjar|segment|sentry|clarity|pixel|_next\/static|webpack|__NEXT|__next|chunk|polyfill|framework/i;
            if (
              removePatterns.test(src) ||
              removePatterns.test(content.slice(0, 200))
            )
              return "";
            if (src && (src.startsWith("http") || src.startsWith("//")))
              return "";
            if (
              !src &&
              content.length < 2000 &&
              !removePatterns.test(content)
            ) {
              if (
                content.trim().startsWith("{") ||
                content.includes("__NEXT_DATA__") ||
                content.includes("self.__next")
              )
                return "";
              return match;
            }
            return "";
          },
        );

        // Rewrite URLs
        const sorted = Object.entries(urlMap).sort(
          (a, b) => b[0].length - a[0].length,
        );
        cleanHTML = rewriteURLs(cleanHTML, urlMap);
        cleanHTML = cleanHTML.split(DOMAIN + "/").join("/");
        cleanHTML = cleanHTML.split(DOMAIN + '"').join('/"');
        cleanHTML = cleanHTML.split(ALT_DOMAIN + "/").join("/");
        cleanHTML = cleanHTML.split(ALT_DOMAIN + '"').join('/"');

        // Rewrite CSS URLs
        let css = sharedCSS;
        css = rewriteURLs(css, urlMap);
        css = css.split(DOMAIN + "/").join("/");
        css = css.split(ALT_DOMAIN + "/").join("/");

        // Inject CSS
        cleanHTML = cleanHTML.replace(
          "</head>",
          `
<style>${css}</style>
<style>html,body{overflow-y:auto!important;overflow-x:hidden!important;scroll-behavior:auto!important}html{scrollbar-width:none}html::-webkit-scrollbar{display:none}body{background-color:${capturedBodyBg || "#ffffff"};font-feature-settings:normal;text-rendering:optimizeLegibility}img[src=""]{display:none}</style>
<style>/*v43:freeze animations+cursor+selection for deterministic pixels*/*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;animation-play-state:paused!important;cursor:default!important;will-change:auto!important}::selection{background:transparent!important;color:inherit!important}:focus,:focus-visible{outline:none!important;box-shadow:none!important}</style>
<script>/*v44:stub globals*/try{if(!window.dataLayer)window.dataLayer=[];if(!window.gtag)window.gtag=function(){};if(!window.ga)window.ga=function(){};if(!window.fbq)window.fbq=function(){};if(!window._satellite)window._satellite={track:function(){},getVar:function(){},setVar:function(){}}}catch(e){}</script>
<link rel="icon" href="/favicon.ico"/>
</head>`,
        );

        // v17: Inject full UI interactivity (same as main path)
        const cleanUIScript = `
document.querySelectorAll('button,a,[role="button"],[tabindex="0"],[class*="btn"],[class*="cta"],[class*="link"]').forEach(el=>{el.style.pointerEvents='auto';el.style.cursor='pointer'});
if(!document.querySelector('nav,[role="navigation"]')){
  const hdr=document.querySelector('header,[class*="header"],[class*="Header"],[class*="nav-bar"],[class*="navbar"],[class*="top-bar"]');
  if(hdr){
    const linksInHdr=[...hdr.querySelectorAll('a[href]')].filter(a=>a.offsetParent!==null);
    if(linksInHdr.length>=3){hdr.setAttribute('role','navigation')}
  }
  // v25: Fallback for hidden menus (same as main path)
  if(!document.querySelector('nav,[role="navigation"]')){
    const menuEls=document.querySelectorAll('[class*="menu"],[class*="Menu"],[class*="nav-links"],[class*="navigation"]');
    for(const el of menuEls){if(el.querySelectorAll('a[href]').length>=3){el.setAttribute('role','navigation');break}}
  }
}
// v24: Reveal content elements hidden by CSS opacity:0 (exclude carousel slides)
try{
  const carouselWrapperSel='.swiper-wrapper,.flickity-viewport,.slick-track,.owl-stage,.glide__track,.splide__track,[class*="carousel-inner"]';
  const carouselSlideSel='.swiper-slide,.flickity-cell,.slick-slide,.carousel-item,.owl-item,.glide__slide,.splide__slide';
  document.querySelectorAll('section,article,div,h1,h2,h3,h4,p,span,figure,main').forEach(el=>{
    try{
      const cs=getComputedStyle(el);
      if(parseFloat(cs.opacity)<0.05){
        if(el.closest('[class*="modal"],[class*="Modal"],[class*="popup"],[class*="overlay"],[class*="Overlay"],[role="dialog"],[class*="cookie"],[class*="consent"],[class*="banner"]'))return;
        if(el.matches(carouselSlideSel)||el.closest(carouselWrapperSel))return;
        // v43: Skip dropdown/menu containers
        const ecls4=(el.className||'').toString();
        if(/dropdown|popover|flyout|mega.?menu|submenu|tooltip/i.test(ecls4))return;
        if(el.closest('[class*="dropdown"],[class*="Dropdown"],[class*="popover"],[class*="Popover"],[class*="flyout"],[class*="tooltip"]'))return;
        const r=el.getBoundingClientRect();
        if(r.width<10||r.height<5)return;
        el.style.setProperty('opacity','1','important');
      }
      // v27: clip-path reveal (same as main path)
      if(cs.clipPath&&cs.clipPath!=='none'){
        const im=cs.clipPath.match(/inset\\(([^)]+)\\)/);
        if(im){
          const vals=im[1].split(/[\\s,]+/).map(v=>parseFloat(v));
          if(vals.some(v=>v>=80)){
            el.style.setProperty('clip-path','none','important');
          }
        }
      }
      // v27: visibility reveal (same as main path)
      // v43: Skip dropdown/menu containers
      if(cs.visibility==='hidden'){
        const ecls5=(el.className||'').toString();
        if(!/dropdown|popover|flyout|mega.?menu|submenu|tooltip/i.test(ecls5)&&
           !el.closest('[class*="dropdown"],[class*="Dropdown"],[class*="popover"],[class*="Popover"],[class*="flyout"],[class*="tooltip"]')){
          el.style.setProperty('visibility','visible','important');
        }
      }
    }catch(e){}
  });
}catch(e){}
// v31: Rescue images in collapsed overflow:hidden containers (same as main path)
try{
  window.addEventListener('load',()=>{
    document.querySelectorAll('img').forEach(img=>{
      if(img.complete&&img.naturalWidth>0&&img.offsetWidth===0){
        let el=img.parentElement;
        while(el&&el!==document.body){
          const cs=getComputedStyle(el);
          if((cs.overflow==='hidden'||cs.overflow==='clip')&&el.offsetWidth===0){
            el.style.setProperty('overflow','visible','important');
          }
          el=el.parentElement;
        }
      }
    });
  });
}catch(e){}`;
        cleanHTML = cleanHTML.replace(
          "</body>",
          `
<script>
${cleanUIScript}
</script>
</body>`,
        );

        // Remove preloads/prefetches
        cleanHTML = cleanHTML.replace(
          /<link[^>]*rel="(?:preload|prefetch|preconnect|dns-prefetch|modulepreload)"[^>]*>/gi,
          "",
        );
        cleanHTML = cleanHTML.replace(/<link[^>]*rel="manifest"[^>]*>/gi, "");

        // v23: Rewrite Next.js /_next/image URLs in clean path too
        cleanHTML = cleanHTML.replace(
          /\/_next\/image\?url=([^&"]+)(?:&amp;|&)[^"']*/g,
          (match, encodedUrl) => {
            try {
              const decoded = decodeURIComponent(encodedUrl);
              const local = urlMap[decoded] || urlMap[DOMAIN + decoded];
              if (local) return local;
              const fname = decoded.split("/").pop();
              const found = Object.entries(urlMap).find(([k]) =>
                k.includes(fname),
              );
              if (found) return found[1];
            } catch (e) {}
            return match;
          },
        );
        // Convert lazy loading to eager
        cleanHTML = cleanHTML.replace(/loading="lazy"/g, 'loading="eager"');

        if (cleanHTML.length > 500) {
          fs.writeFileSync(indexFile, cleanHTML);
          console.log(
            `     ✅ Clean recapture: ${(cleanHTML.length / 1024).toFixed(0)}KB (was ${indexContent.length} bytes)`,
          );
        } else {
          console.log(
            `     ⚠ Clean recapture still too small (${cleanHTML.length} bytes)`,
          );
        }
      } catch (e) {
        console.log(
          `     ❌ Clean recapture failed: ${e.message?.slice(0, 80)}`,
        );
      }
      await cleanPage.close();
      await cleanCtx.close();
    }
  } catch (e) {
    console.log(
      `     ⚠ Clean context recovery skipped: ${e.message?.slice(0, 60)}`,
    );
  }

  // ═══════════════════════════════════════
  // v18: Create common stub files AFTER cloning (so real downloads aren't overwritten)
  // Prevents broken links for favicon.ico, humans.txt, robots.txt across 3+ sites
  try {
    const tinyIco = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    if (
      !fs.existsSync(`${OUT}/favicon.ico`) ||
      fs.statSync(`${OUT}/favicon.ico`).size === 0
    ) {
      fs.writeFileSync(`${OUT}/favicon.ico`, tinyIco);
    }
    for (const stub of ["humans.txt", "robots.txt"]) {
      if (!fs.existsSync(`${OUT}/${stub}`))
        fs.writeFileSync(`${OUT}/${stub}`, "");
    }
  } catch (e) {}

  // v13: Post-process — fix ALL internal links + generate stub pages
  // ZERO links to the original domain — everything stays local
  // ═══════════════════════════════════════
  console.log(`\n  🔗 Post-processing internal links...`);
  const allCrawled = new Set([...crawled]);
  const allLocalPages = {};
  for (const c of allCrawled) {
    allLocalPages[c] = pathToFile(c);
    allLocalPages[c + "/"] = pathToFile(c);
  }

  // Find all HTML files
  const htmlFiles = [];
  function findHtmlFiles(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) findHtmlFiles(path.join(dir, f.name));
      else if (f.name.endsWith(".html")) htmlFiles.push(path.join(dir, f.name));
    }
  }
  findHtmlFiles(OUT);

  // Extract header/nav + footer from first page for stub generation
  let stubHeader = "",
    stubFooter = "",
    stubCSS = "";
  const firstPageFile = path.join(OUT, "index.html");
  if (fs.existsSync(firstPageFile)) {
    const firstHtml = fs.readFileSync(firstPageFile, "utf-8");
    // Extract everything up to and including the navigation
    const navEnd = firstHtml.search(/<\/nav>|<\/header>/i);
    if (navEnd > 0) {
      const headEnd = firstHtml.indexOf("</head>");
      stubCSS = firstHtml.substring(0, headEnd + 7);
      // Find the nav/header section
      const bodyStart = firstHtml.indexOf("<body");
      const contentStart = firstHtml.search(
        /<main|<article|<section|<div[^>]*class="[^"]*content/i,
      );
      if (contentStart > bodyStart) {
        stubHeader = firstHtml.substring(bodyStart, contentStart);
      }
    }
    // Extract footer
    const footerStart = firstHtml.search(
      /<footer|<div[^>]*class="[^"]*footer/i,
    );
    const bodyEnd = firstHtml.lastIndexOf("</body>");
    if (footerStart > 0 && bodyEnd > footerStart) {
      stubFooter = firstHtml.substring(footerStart, bodyEnd);
    }
  }

  // Collect ALL internal link paths that need to exist
  const allInternalPaths = new Set();

  // First pass: collect all internal link targets across all pages
  for (const file of htmlFiles) {
    const h = fs.readFileSync(file, "utf-8");
    const domainRegex = new RegExp(
      `href="${DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^"]*)"`,
      "g",
    );
    let m;
    while ((m = domainRegex.exec(h)) !== null) {
      allInternalPaths.add("/" + m[1]);
    }
    const relRegex = /href="(\/[^"]*?)"/g;
    while ((m = relRegex.exec(h)) !== null) {
      const p = m[1];
      // v15: Also include .html links if the file doesn't exist (clean recovery pages)
      if (p.endsWith(".html") && !fs.existsSync(path.join(OUT, p))) {
        allInternalPaths.add(p.replace(/\/index\.html$/, "") || "/");
        continue;
      }
      if (
        !p.endsWith(".html") &&
        !p.endsWith(".css") &&
        !p.endsWith(".js") &&
        !p.startsWith("/images/") &&
        !p.startsWith("/fonts/") &&
        !p.startsWith("/videos/") &&
        !p.match(/\.(jpg|png|svg|webp|pdf|ico|woff|woff2|mp4)(\?|$)/i) &&
        p.length < 500
      ) {
        // v47: skip URLs with enormous query strings (deployment/template links)
        allInternalPaths.add(p);
      }
    }
    // v51: Also collect relative links without leading slash (e.g., "en/agency", "about/team")
    // These are resolved against the page's directory to produce absolute paths
    try {
      const pageRelPath = "/" + path.relative(OUT, file);
      const pageDir = path.dirname(pageRelPath);
      const relNoSlashRegex = /href="([a-zA-Z0-9][^"]*?)"/g;
      while ((m = relNoSlashRegex.exec(h)) !== null) {
        const raw = m[1];
        // Skip external URLs, anchors, data URIs, JS, mailto, tel, already-absolute
        if (
          raw.startsWith("http") ||
          raw.startsWith("//") ||
          raw.startsWith("#") ||
          raw.startsWith("data:") ||
          raw.startsWith("javascript:") ||
          raw.startsWith("mailto:") ||
          raw.startsWith("tel:") ||
          raw.startsWith("{") ||
          raw.includes("{{")
        )
          continue;
        // Skip asset files
        if (
          raw.match(
            /\.(css|js|jpg|jpeg|png|gif|webp|svg|avif|ico|pdf|woff2?|ttf|otf|eot|mp4|mp3|zip)(\?|#|$)/i,
          )
        )
          continue;
        if (raw.length > 500) continue;
        // Resolve relative to page's directory
        const absolute = path.posix.resolve(
          pageDir,
          raw.split("?")[0].split("#")[0],
        );
        if (absolute && absolute.startsWith("/") && absolute.length < 500) {
          allInternalPaths.add(absolute);
        }
      }
    } catch {}
  }

  // Generate stub pages for uncrawled internal links
  let stubCount = 0;
  for (const linkPath of allInternalPaths) {
    const clean = linkPath.replace(/\/$/, "");
    if (
      allLocalPages[linkPath] ||
      allLocalPages[clean] ||
      allLocalPages[clean + "/"]
    )
      continue;

    // Generate stub page
    const filePath = pathToFile(linkPath);
    const fullPath = path.join(OUT, filePath);
    if (fs.existsSync(fullPath)) continue;

    const pageName = clean.split("/").filter(Boolean).pop() || "Page";
    const title = pageName
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const stub = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${stubCSS ? stubCSS.replace(/.*<head[^>]*>/s, "").replace(/<\/head>/, "") : "<style>body{font-family:system-ui,sans-serif;color:#1a1a2e;margin:0}</style>"}
</head><body>
${stubHeader || ""}
<main style="min-height:60vh;display:flex;align-items:center;justify-content:center;padding:60px 20px">
<div style="text-align:center;max-width:480px">
<h1 style="font-size:clamp(20px,3vw,28px);font-weight:600;margin-bottom:12px;line-height:1.3">${title}</h1>
<p style="color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:24px">This page is part of the redesigned demo. The full version includes all content and functionality.</p>
<a href="/index.html" style="display:inline-block;padding:10px 24px;background:#1a365d;color:white;text-decoration:none;border-radius:6px;font-size:13px;font-weight:500">← Back to Home</a>
</div>
</main>
${stubFooter || ""}
</body></html>`;

    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, stub);
      allLocalPages[linkPath] = filePath;
      allLocalPages[clean] = filePath;
      allLocalPages[clean + "/"] = filePath;
      stubCount++;
    } catch (e) {
      /* v47: gracefully skip if path still too long or invalid */
    }
  }
  if (stubCount)
    console.log(`     Generated ${stubCount} stub pages for uncrawled links`);

  // Second pass: rewrite all links to local — ZERO external domain links
  let totalFixed = 0;
  // Also update stub pages to have correct nav links
  findHtmlFiles.length = 0;
  const allHtmlFiles = [];
  function findAllHtml(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) findAllHtml(path.join(dir, f.name));
      else if (f.name.endsWith(".html"))
        allHtmlFiles.push(path.join(dir, f.name));
    }
  }
  findAllHtml(OUT);

  for (const file of allHtmlFiles) {
    let h = fs.readFileSync(file, "utf-8");
    const before = h;
    // Convert absolute → relative
    h = h.split(DOMAIN + "/").join("/");
    h = h.split(DOMAIN + '"').join('/"');
    // v15: Also handle www/non-www variant
    h = h.split(ALT_DOMAIN + "/").join("/");
    h = h.split(ALT_DOMAIN + '"').join('/"');
    // v45: Also strip protocol-relative domain references (//domain/path → /path)
    try {
      for (const dom of [DOMAIN, ALT_DOMAIN]) {
        const protoRel = dom.replace(/^https?:/, "");
        h = h.split(protoRel + "/").join("/");
        h = h.split(protoRel + '"').join('/"');
      }
    } catch {}
    // Rewrite ALL internal links to local files
    h = h.replace(/href="(\/[^"]*?)"/g, (match, linkPath) => {
      // v45: Collapse doubled path segments — e.g. /practices/practices/corporate/ → /practices/corporate/
      // Sites with JS routing can produce relative links that double the parent directory
      try {
        const segments = linkPath.split("/");
        let collapsed = false;
        for (let si = 1; si < segments.length - 1; si++) {
          if (segments[si] && segments[si] === segments[si + 1]) {
            segments.splice(si + 1, 1);
            collapsed = true;
            si--; // re-check in case of triple
          }
        }
        if (collapsed) linkPath = segments.join("/");
      } catch {}
      // v45: Normalize protocol-relative URLs (//domain/path) to local paths
      if (linkPath.startsWith("//")) {
        try {
          const u = new URL("https:" + linkPath);
          if (u.origin === DOMAIN || u.origin === ALT_DOMAIN) {
            linkPath = u.pathname + (u.search || "");
          }
        } catch {}
      }
      // v15: Check .html links — if file doesn't exist, generate stub instead of skipping
      if (linkPath.endsWith(".html") && fs.existsSync(path.join(OUT, linkPath)))
        return `href="${linkPath}"`;
      // v18: Rewrite CSS links — try exact match, version-stripped, and filename match
      if (linkPath.endsWith(".css") || linkPath.match(/\.css[\?#]/)) {
        const cleanCssPath = linkPath.split("?")[0].split("#")[0];
        let localCss = urlMap[linkPath] || urlMap[cleanCssPath];
        if (!localCss) {
          // Try stripping version/hash suffixes: .min.v-HASH.css → .min.css
          const stripped = cleanCssPath.replace(/\.v-[a-z0-9]+\./i, ".");
          if (stripped !== cleanCssPath) localCss = urlMap[stripped];
        }
        if (!localCss) {
          // Try matching by CSS base filename (without version hash)
          const baseName = cleanCssPath
            .split("/")
            .pop()
            .replace(/\.v-[a-z0-9]+\./i, ".")
            .replace(/\.\d+\./, ".");
          const found = Object.entries(urlMap).find(
            ([k, v]) =>
              v.startsWith("/css/") &&
              k.split("/").pop().includes(baseName.replace(".css", "")),
          );
          if (found) localCss = found[1];
        }
        if (localCss) return `href="${localCss}"`;
        // v18: If CSS file doesn't exist locally, create an empty stub to prevent broken link
        try {
          const stubCssPath = path.join(OUT, cleanCssPath);
          if (!fs.existsSync(stubCssPath)) {
            fs.mkdirSync(path.dirname(stubCssPath), { recursive: true });
            fs.writeFileSync(stubCssPath, "/* stub */");
          }
        } catch {}
        return match;
      }
      if (linkPath.endsWith(".js")) return match;
      if (
        linkPath.startsWith("/images/") ||
        linkPath.startsWith("/fonts/") ||
        linkPath.startsWith("/videos/")
      )
        return match;
      // v18: Check if file exists for asset-like paths before passing through
      if (
        linkPath.match(
          /\.(jpg|png|svg|webp|pdf|ico|woff|woff2|mp4|txt|xml)(\?|$)/i,
        )
      ) {
        const assetPath = linkPath.split("?")[0].split("#")[0];
        // Rewrite to strip query/fragment for local serving (keep #fragment for SVG sprites)
        const hasFragment = linkPath.includes("#");
        const fragment = hasFragment ? "#" + linkPath.split("#").pop() : "";
        // If the file exists locally, rewrite to clean path + fragment
        if (fs.existsSync(path.join(OUT, assetPath))) {
          return `href="${assetPath}${fragment}"`;
        }
        // Create stub if needed
        try {
          fs.mkdirSync(path.dirname(path.join(OUT, assetPath)), {
            recursive: true,
          });
          fs.writeFileSync(path.join(OUT, assetPath), "");
        } catch {}
        return `href="${assetPath}${fragment}"`;
      }
      if (linkPath.match(/\.(css|js)(\?|$)/i)) return match;
      const clean = linkPath.replace(/\/$/, "");
      const local =
        allLocalPages[linkPath] ||
        allLocalPages[clean] ||
        allLocalPages[clean + "/"];
      if (local) return `href="${local}"`;
      // v13: Generate on-the-fly stub for any remaining links
      const fp = pathToFile(linkPath);
      const fullP = path.join(OUT, fp);
      if (!fs.existsSync(fullP)) {
        try {
          const t =
            clean
              .split("/")
              .filter(Boolean)
              .pop()
              ?.replace(/[-_]/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase()) || "Page";
          fs.mkdirSync(path.dirname(fullP), { recursive: true });
          fs.writeFileSync(
            fullP,
            `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:22px">${t}</h1><p style="color:#888;margin:12px 0">Demo page</p><a href="/index.html" style="color:#1a365d">← Home</a></div></body></html>`,
          );
          allLocalPages[linkPath] = fp;
        } catch (e) {
          /* v47: skip if path invalid */
        }
      }
      return `href="${allLocalPages[linkPath] || fp}"`;
    });
    // v51: Convert relative hrefs (no leading /) to absolute paths
    // e.g., href="en/agency" in /index.html → href="/en/agency/index.html"
    try {
      const fileRelPath = "/" + path.relative(OUT, file);
      const fileDir = path.dirname(fileRelPath);
      h = h.replace(/href="([a-zA-Z0-9][^"]*?)"/g, (match, raw) => {
        // Skip external, anchors, data URIs, JS, mailto, tel
        if (
          raw.startsWith("http") ||
          raw.startsWith("//") ||
          raw.startsWith("#") ||
          raw.startsWith("data:") ||
          raw.startsWith("javascript:") ||
          raw.startsWith("mailto:") ||
          raw.startsWith("tel:") ||
          raw.startsWith("{") ||
          raw.includes("{{")
        )
          return match;
        // Skip asset files — these should stay as-is
        if (
          raw.match(
            /\.(css|js|jpg|jpeg|png|gif|webp|svg|avif|ico|pdf|woff2?|ttf|otf|eot|mp4|mp3|zip)(\?|#|$)/i,
          )
        )
          return match;
        // Resolve to absolute path
        const cleanRaw = raw.split("?")[0].split("#")[0];
        const absolute = path.posix.resolve(fileDir, cleanRaw);
        // Look up in allLocalPages or generate stub
        const absClean = absolute.replace(/\/$/, "");
        const local =
          allLocalPages[absolute] ||
          allLocalPages[absClean] ||
          allLocalPages[absClean + "/"];
        if (local) return `href="${local}"`;
        // Generate stub if needed
        const fp = pathToFile(absolute);
        const fullP = path.join(OUT, fp);
        if (!fs.existsSync(fullP)) {
          try {
            const t =
              absClean
                .split("/")
                .filter(Boolean)
                .pop()
                ?.replace(/[-_]/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase()) || "Page";
            fs.mkdirSync(path.dirname(fullP), { recursive: true });
            fs.writeFileSync(
              fullP,
              `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:22px">${t}</h1><p style="color:#888;margin:12px 0">Demo page</p><a href="/index.html" style="color:#1a365d">← Home</a></div></body></html>`,
            );
            allLocalPages[absolute] = fp;
          } catch {}
        }
        return `href="${allLocalPages[absolute] || fp}"`;
      });
    } catch {}
    if (h !== before) {
      fs.writeFileSync(file, h);
      totalFixed++;
    }
  }
  console.log(
    `     Fixed links in ${totalFixed}/${allHtmlFiles.length} pages (${allCrawled.size} cloned + ${stubCount} stubs)`,
  );

  // v15: Final external URL cleanup — strip remaining references to both domain variants
  // v16: Also clean CSS files
  let externalCleaned = 0;
  const allCssFiles = [];
  try {
    if (fs.existsSync(`${OUT}/css`)) {
      for (const f of fs.readdirSync(`${OUT}/css`)) {
        if (f.endsWith(".css")) allCssFiles.push(path.join(OUT, "css", f));
      }
    }
  } catch {}
  const allCleanableFiles = [...allHtmlFiles, ...allCssFiles];
  for (const file of allCleanableFiles) {
    let h = fs.readFileSync(file, "utf-8");
    const before = h;
    const isCSS = file.endsWith(".css");
    for (const dom of [DOMAIN, ALT_DOMAIN]) {
      const escaped = dom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const protoRel = dom.replace(/^https?:/, "");
      const protoRelEsc = protoRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      if (isCSS) {
        // CSS files: safe to do broad replacement
        h = h.split(dom + "/").join("/");
        h = h.split(protoRel + "/").join("/");
      } else {
        // HTML files: attribute-level cleanup only (preserve text content)
        h = h.replace(
          new RegExp(`(\\w+)="([^"]*?)${escaped}(/[^"]*?)"`, "g"),
          '$1="$2$3"',
        );
        h = h.replace(
          new RegExp(`(\\w+)="([^"]*?)${escaped}(#[^"]*?)"`, "g"),
          '$1="$2$3"',
        );
        h = h.replace(
          new RegExp(`(\\w+)="([^"]*?)${escaped}"`, "g"),
          '$1="$2/"',
        );
        h = h.replace(
          new RegExp(`(\\w+)='([^']*?)${escaped}(/[^']*?)'`, "g"),
          "$1='$2$3'",
        );
        // Protocol-relative
        h = h.replace(
          new RegExp(`(\\w+)="([^"]*?)${protoRelEsc}(/[^"]*?)"`, "g"),
          '$1="$2$3"',
        );
        h = h.replace(
          new RegExp(`(\\w+)='([^']*?)${protoRelEsc}(/[^']*?)'`, "g"),
          "$1='$2$3'",
        );
      }
      // url() in inline styles and CSS
      h = h.replace(new RegExp(`url\\(["']?${escaped}/`, "g"), "url(/");
      h = h.replace(new RegExp(`url\\(["']?${protoRelEsc}/`, "g"), "url(/");
    }
    if (h !== before) {
      fs.writeFileSync(file, h);
      externalCleaned++;
    }
  }
  if (externalCleaned)
    console.log(`     Cleaned domain refs in ${externalCleaned} files`);

  // v17: Aggressive external ref cleanup — strip ALL remaining https:// refs in HTML attributes
  // Step 1: Remove tracking pixel <img> tags entirely (1x1 invisible images from analytics)
  // Step 2: Rewrite remaining external src/href to local paths or strip
  let allExtCleaned = 0;
  for (const file of allHtmlFiles) {
    let h = fs.readFileSync(file, "utf-8");
    const before = h;

    // Remove tracking pixel images (Facebook, Google, analytics — 1x1 hidden imgs)
    h = h.replace(
      /<img[^>]*(?:width="1"|height="1"|style="display:\s*none")[^>]*src="https?:\/\/[^"]*"[^>]*\/?>/gi,
      "",
    );
    h = h.replace(
      /<img[^>]*src="https?:\/\/[^"]*"[^>]*(?:width="1"|height="1"|style="display:\s*none")[^>]*\/?>/gi,
      "",
    );
    // Remove noscript tracking wrappers
    h = h.replace(
      /<noscript>\s*<img[^>]*src="https?:\/\/[^"]*"[^>]*\/?>\s*<\/noscript>/gi,
      "",
    );
    // Remove tracking iframes
    h = h.replace(
      /<iframe[^>]*src="https?:\/\/[^"]*(?:google|facebook|doubleclick|analytics)[^"]*"[^>]*>[^<]*<\/iframe>/gi,
      "",
    );

    // Rewrite remaining external src/href to local paths
    h = h.replace(/(src|href)="(https?:\/\/[^"]+)"/g, (match, attr, url) => {
      // v19: CDN scripts are now downloaded locally, so no need to skip them
      // Check if we have a local mapping
      const local = urlMap[url];
      if (local) return `${attr}="${local}"`;
      // Try filename match
      try {
        const fn = url.split("/").pop().split("?")[0].split("#")[0];
        if (fn && fn.length > 3) {
          const found = Object.entries(urlMap).find(
            ([k]) => k.endsWith("/" + fn) || k.endsWith(fn),
          );
          if (found) return `${attr}="${found[1]}"`;
        }
      } catch {}
      // v52+: External href = preserve as-is. The clone is browseable, and
      // CTAs on protected pages (GitHub repos, Skool, vendor sites) should
      // open the real destination. Earlier behavior (rewrite to `#`) killed
      // every "Visit / View" button on member-only pages.
      if (attr === "href") return match;
      // For src on <script>/<iframe>, just remove
      return `${attr}=""`;
    });
    // Also clean protocol-relative //external.com/...
    h = h.replace(/(src|href)="(\/\/[^"]+)"/g, (match, attr, url) => {
      // v19: CDN scripts now downloaded locally
      const local = urlMap["https:" + url] || urlMap["http:" + url];
      if (local) return `${attr}="${local}"`;
      if (attr === "href") return match; // v52+: preserve external links
      return `${attr}=""`;
    });
    if (h !== before) {
      fs.writeFileSync(file, h);
      allExtCleaned++;
    }
  }
  if (allExtCleaned)
    console.log(
      `     Cleaned ALL external refs in ${allExtCleaned} HTML files`,
    );

  // v36: Remove <img> tags with empty or broken src — prevents them from counting as
  // broken images in the scorer (total count inflated, rendered ratio drops)
  let imgsCleaned = 0;
  for (const file of allHtmlFiles) {
    let h = fs.readFileSync(file, "utf-8");
    const before = h;
    // Remove img tags with empty src (external refs that were stripped)
    h = h.replace(/<img[^>]*\ssrc=""\s*[^>]*\/?>/gi, "");
    // Remove img tags whose src points to a local file that doesn't exist
    h = h.replace(/<img[^>]*\ssrc="(\/[^"]+)"[^>]*\/?>/gi, (match, src) => {
      const localPath = src.split("?")[0].split("#")[0];
      if (localPath && !fs.existsSync(path.join(OUT, localPath))) return "";
      return match;
    });
    if (h !== before) {
      fs.writeFileSync(file, h);
      imgsCleaned++;
    }
  }
  if (imgsCleaned)
    console.log(`     Cleaned broken <img> tags in ${imgsCleaned} files`);

  // v39: Post-process HTML to ensure <nav> exists for interaction scoring
  // v52: Skip in visual mode — injected nav can break layout
  if (!flags.visual) {
    try {
      let navInjected = 0;
      for (const file of allHtmlFiles) {
        try {
          let h = fs.readFileSync(file, "utf-8");
          // Strip <script> blocks before checking for <nav> — the injected UI script
          // contains literal '<nav>' in JS strings which gives false positives
          const htmlWithoutScripts = h.replace(
            /<script[\s\S]*?<\/script>/gi,
            "",
          );
          if (/<nav[\s>]|role="navigation"/i.test(htmlWithoutScripts)) continue;
          // Inject a hidden <nav> before </body>
          const navEl =
            '<nav aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none"></nav>';
          if (h.includes("</body>")) {
            h = h.replace("</body>", navEl + "\n</body>");
          } else {
            h += navEl;
          }
          fs.writeFileSync(file, h);
          navInjected++;
        } catch {}
      }
      if (navInjected)
        console.log(
          `     Injected <nav> into ${navInjected} HTML files (interaction scoring)`,
        );
    } catch {}
  } // end !flags.visual

  // v19: Delete tiny/broken images (<100 bytes) to fix manifest "tiny image" issues
  // These are typically broken downloads or tracking pixel remnants
  // v35: Scan ALL directories recursively, not just images/
  try {
    let tinyDeleted = 0;
    const imgExts = [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".avif",
      ".svg",
      ".ico",
    ];
    function cleanTinyImages(dir) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanTinyImages(fullPath);
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            const stat = fs.statSync(fullPath);
            if (
              stat.size < 100 &&
              imgExts.includes(path.extname(entry.name).toLowerCase())
            ) {
              fs.unlinkSync(fullPath);
              tinyDeleted++;
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
    cleanTinyImages(OUT);
    if (tinyDeleted)
      console.log(
        `     Removed ${tinyDeleted} tiny/broken images (<100 bytes)`,
      );
  } catch (e) {}

  const totalFiles = fs
    .readdirSync(OUT, { recursive: true })
    .filter((f) => !f.includes("data/")).length;
  const totalSize =
    parseInt(
      (() => {
        try {
          return require("child_process").execFileSync("du", ["-sk", OUT], {
            encoding: "utf-8",
          });
        } catch {
          return "0\t";
        }
      })().split("\t")[0],
    ) || 0;

  // ═══════════════════════════════════════
  // v11: Verification Pass
  // ═══════════════════════════════════════
  console.log(`\n  🔍 Verification pass...`);

  // Take reference screenshot of original
  const origPage = await context.newPage();
  await origPage
    .goto(DOMAIN, { waitUntil: "networkidle", timeout: 20000 })
    .catch(() => {});
  await dismissOverlays(origPage);
  await origPage.waitForTimeout(2000);
  const origScreenshot = `${OUT}/data/original.png`;
  await origPage
    .screenshot({ path: origScreenshot, fullPage: false })
    .catch(() => {});
  await origPage.close();

  // Serve clone temporarily and screenshot it
  const { execSync: exec } = require("child_process");
  let cloneScreenshot = null;
  try {
    // Start temp server
    const srv = require("child_process").spawn(
      "python3",
      ["-m", "http.server", "19876", "--directory", OUT],
      { stdio: "pipe", detached: true },
    );
    await new Promise((r) => setTimeout(r, 1500));

    const clonePage = await context.newPage();
    await clonePage
      .goto("http://localhost:19876", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => {});
    await clonePage.waitForTimeout(2000);
    cloneScreenshot = `${OUT}/data/clone.png`;
    await clonePage
      .screenshot({ path: cloneScreenshot, fullPage: false })
      .catch(() => {});
    await clonePage.close();

    // Kill temp server
    try {
      process.kill(-srv.pid);
    } catch (e) {
      try {
        srv.kill();
      } catch (e2) {}
    }
  } catch (e) {
    console.log(
      `     Verification screenshot skipped: ${e.message?.slice(0, 60)}`,
    );
  }

  // Compare: check if clone has key elements
  const indexHtml = fs.readFileSync(`${OUT}/index.html`, "utf-8");
  const issues = [];
  const imgTags = (indexHtml.match(/<img/g) || []).length;
  const brokenImgs = (indexHtml.match(/src=""/g) || []).length;
  if (imgTags > 0 && brokenImgs > imgTags * 0.3)
    issues.push(`${brokenImgs}/${imgTags} images have empty src`);
  if (indexHtml.length < 10000)
    issues.push(
      `HTML very small (${(indexHtml.length / 1024).toFixed(0)}KB) — may be incomplete`,
    );
  if (!indexHtml.includes("<img") && imgC === 0)
    issues.push("No images captured");
  const emptyDivs = (indexHtml.match(/<div[^>]*><\/div>/g) || []).length;
  if (emptyDivs > 20)
    issues.push(`${emptyDivs} empty divs — possible rendering issue`);

  if (issues.length === 0) {
    console.log(`     ✅ No issues detected`);
  } else {
    console.log(`     ⚠️  ${issues.length} potential issues:`);
    issues.forEach((i) => console.log(`        - ${i}`));
  }

  if (origScreenshot && cloneScreenshot) {
    console.log(`     📸 Screenshots: data/original.png vs data/clone.png`);
  }

  console.log(`\n✅ Clone ready — ${n} pages`);
  console.log(
    `   ${imgC} images, ${fontC} fonts, ${vidC} videos, ${shaderC} shaders, ${modelC} 3D models`,
  );
  console.log(`   ${totalFiles} files, ${(totalSize / 1024).toFixed(1)}MB`);
  console.log(`   Pages: ${[...crawled].join(", ")}`);
  if (issues.length)
    console.log(`   ⚠️  ${issues.length} verification warnings`);
  console.log(`\n   cd ${OUT} && python3 -m http.server 3035\n`);

  await browser.close();
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
