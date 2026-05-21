#!/usr/bin/env node
/**
 * score-clone.js — site-xray accuracy measurement.
 *
 * Renders a live URL and a clone directory side-by-side, scores accuracy
 * across five dimensions, prints a readable summary and writes JSON.
 *
 * Usage: node score-clone.js <live-url> <clone-dir> [--out <json-path>] [--page <route>]
 *
 * Dimensions (weights default but adjustable):
 *   visual       (35%)  pixel-diff ratio between full-page screenshots
 *   structural   (15%)  DOM node counts, visible elements, links/buttons/forms
 *   errors       (15%)  console.error count parity
 *   assets       (15%)  count of 200-OK network responses
 *   interactive  (20%)  click-behavior parity on up to 20 candidates
 *
 * Each dimension is 0–100. Overall is the weighted average.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");

const WEIGHTS = {
  visual: 0.35,
  structural: 0.15,
  errors: 0.15,
  assets: 0.15,
  interactive: 0.2,
};

function parseArgs(argv) {
  const args = { positional: [], out: null, page: "/" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--page") args.page = argv[++i];
    else args.positional.push(argv[i]);
  }
  return args;
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    setTimeout(() => {
      s.destroy();
      resolve(false);
    }, 250);
  });
}

async function startLocalServer(dir) {
  // Try ports 3050..3099 until one accepts
  for (let port = 3050; port < 3100; port++) {
    if (await probePort(port)) continue;
    const srv = spawn("python3", ["-m", "http.server", String(port)], {
      cwd: dir,
      stdio: "ignore",
    });
    const start = Date.now();
    while (Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 80));
      if (await probePort(port)) {
        return {
          url: `http://localhost:${port}`,
          kill: () => {
            try {
              srv.kill();
            } catch {}
          },
        };
      }
    }
    srv.kill();
    throw new Error(`could not start local server on port ${port}`);
  }
  throw new Error("no free port in 3050..3099");
}

function parityScore(a, b) {
  if (a === 0 && b === 0) return 100;
  if (a === 0 || b === 0) return 0;
  return Math.round(Math.min(a / b, b / a) * 100);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// ─── visual ──────────────────────────────────────────────────────────────
// Take full-page screenshots, downsample to 512px wide on a canvas in the
// browser, compute mean-absolute-difference per pixel. Returns ratio 0..1
// where 0 = identical.
async function probeVisual(origPage, clonePage) {
  const [a, b] = await Promise.all([
    origPage.screenshot({ fullPage: true }),
    clonePage.screenshot({ fullPage: true }),
  ]);
  const ratio = await origPage.evaluate(
    async ({ aDataUrl, bDataUrl }) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(aDataUrl), load(bDataUrl)]);
      const W = 512;
      const ar = ia.naturalHeight / ia.naturalWidth;
      const br = ib.naturalHeight / ib.naturalWidth;
      const H = Math.round(W * Math.max(ar, br));
      const make = (img) => {
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, W, H);
        const scaledH = Math.round(W * (img.naturalHeight / img.naturalWidth));
        ctx.drawImage(img, 0, 0, W, scaledH);
        return ctx.getImageData(0, 0, W, H).data;
      };
      const da = make(ia);
      const db = make(ib);
      let sum = 0;
      const n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        sum +=
          Math.abs(da[i] - db[i]) +
          Math.abs(da[i + 1] - db[i + 1]) +
          Math.abs(da[i + 2] - db[i + 2]);
      }
      return sum / (n * 3 * 255);
    },
    {
      aDataUrl: "data:image/png;base64," + a.toString("base64"),
      bDataUrl: "data:image/png;base64," + b.toString("base64"),
    },
  );
  return {
    score: Math.round((1 - clamp01(ratio)) * 100),
    ratio: Math.round(ratio * 10000) / 10000,
  };
}

// ─── structural ──────────────────────────────────────────────────────────
async function probeStructural(origPage, clonePage) {
  const snap = (page) =>
    page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
      };
      const countVisible = (sel) => {
        let n = 0;
        for (const el of document.querySelectorAll(sel)) if (visible(el)) n++;
        return n;
      };
      const all = document.querySelectorAll("*");
      let visibleCount = 0;
      for (const el of all) if (visible(el)) visibleCount++;
      // innerText already excludes display:none. Use it for "visible text".
      return {
        total: all.length,
        visible: visibleCount,
        links: countVisible("a[href]"),
        buttons: countVisible(
          'button, [role="button"], input[type="button"], input[type="submit"]',
        ),
        forms: countVisible("form"),
        images: countVisible("img"),
        text: document.body
          ? document.body.innerText.replace(/\s+/g, " ").trim().length
          : 0,
      };
    });
  const a = await snap(origPage);
  const b = await snap(clonePage);
  // Drop raw "total" gross node count — frameworks render internal nodes
  // the clone doesn't need. What a user can perceive is visible elements,
  // text content, and interactive affordances.
  const breakdown = {
    visible: parityScore(a.visible, b.visible),
    links: parityScore(a.links, b.links),
    buttons: parityScore(a.buttons, b.buttons),
    forms: parityScore(a.forms, b.forms),
    images: parityScore(a.images, b.images),
    text: parityScore(a.text, b.text),
  };
  const values = Object.values(breakdown);
  return {
    score: Math.round(values.reduce((x, y) => x + y, 0) / values.length),
    breakdown,
    orig: a,
    clone: b,
  };
}

// ─── errors ──────────────────────────────────────────────────────────────
function attachErrorCounter(page) {
  const state = { count: 0, samples: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      state.count++;
      if (state.samples.length < 5)
        state.samples.push(msg.text().slice(0, 120));
    }
  });
  page.on("pageerror", (err) => {
    state.count++;
    if (state.samples.length < 5)
      state.samples.push("pageerror: " + (err.message || "").slice(0, 100));
  });
  return state;
}

function scoreErrors(origState, cloneState) {
  // Clone shouldn't introduce errors beyond what the live site has.
  const extra = Math.max(0, cloneState.count - origState.count);
  return Math.max(0, 100 - extra * 10);
}

// ─── assets ──────────────────────────────────────────────────────────────
// Classify a URL into a "category" that maps to what a user perceives. JS
// bundles and analytics requests are *deliberately* dropped by site-xray's
// --visual mode (the clone is a static snapshot) — counting them would
// penalize the clone for behaving correctly. Score only categories that
// affect what the user sees.
function classifyURL(u) {
  if (
    /googletagmanager|google-analytics|googleads|doubleclick|facebook\.net|fbq|hotjar|segment|mixpanel|amplitude|posthog|datadog|sentry|fullstory|cookiebot|onetrust|clarity\.ms/i.test(
      u,
    )
  )
    return "analytics";
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(u)) return "font";
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(u)) return "image";
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u)) return "video";
  if (/\.(css)(\?|$)|fonts\.googleapis\.com\/css/i.test(u)) return "css";
  if (/\.(js|mjs)(\?|$)/i.test(u)) return "js";
  return "doc";
}

function attachAssetCounter(page) {
  const state = { counts: {}, urls: [] };
  page.on("response", (res) => {
    const status = res.status();
    if (status < 200 || status >= 300) return;
    const cat = classifyURL(res.url());
    state.counts[cat] = (state.counts[cat] || 0) + 1;
    state.urls.push({ url: res.url(), cat });
  });
  return state;
}

function scoreAssets(origState, cloneState) {
  // Categories that affect the visual/content experience. JS and analytics
  // are intentionally skipped — visual-mode clones don't need them.
  const cats = ["doc", "css", "image", "font", "video"];
  const components = cats.map((c) =>
    parityScore(origState.counts[c] || 0, cloneState.counts[c] || 0),
  );
  return {
    score: Math.round(
      components.reduce((x, y) => x + y, 0) / components.length,
    ),
    perCategory: Object.fromEntries(cats.map((c, i) => [c, components[i]])),
  };
}

// ─── interactive ─────────────────────────────────────────────────────────
// On both pages, click up to 20 candidate elements (same selectors). Classify
// each click's behavior into a bucket (no-act, dom-act, panel-open, navigate).
// Score = pages where buckets match / total tested * 100.
async function probeInteractive(origPage, clonePage) {
  const candidates = await origPage.evaluate(() => {
    const sel =
      'button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"]';
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.top > window.innerHeight * 3) continue;
      let s = null;
      if (el.id) s = "#" + CSS.escape(el.id);
      else {
        let cur = el;
        const parts = [];
        for (let i = 0; cur && i < 4; i++) {
          let part = cur.tagName.toLowerCase();
          const p = cur.parentElement;
          if (p) {
            const sibs = Array.from(p.children).filter(
              (s) => s.tagName === cur.tagName,
            );
            if (sibs.length > 1)
              part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
          }
          parts.unshift(part);
          cur = p;
        }
        s = parts.join(" > ");
      }
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
      if (out.length >= 20) break;
    }
    return out;
  });

  const clickAndClassify = async (page, selector) => {
    return await page.evaluate(async (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { missing: true };
      const beforeURL = location.href;
      const beforeBytes = document.body.innerHTML.length;
      const openBefore = document.querySelectorAll(
        '[aria-expanded="true"], [data-state="open"]',
      ).length;
      let mutations = 0;
      const obs = new MutationObserver((r) => {
        mutations += r.length;
      });
      obs.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
      try {
        el.click();
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
      obs.disconnect();
      const openAfter = document.querySelectorAll(
        '[aria-expanded="true"], [data-state="open"]',
      ).length;
      const afterBytes = document.body.innerHTML.length;
      const byteDelta = Math.abs(afterBytes - beforeBytes);
      const navigated = location.href !== beforeURL;
      // Classify on multiple signals — frameworks like React batch many DOM
      // changes into one MutationRecord, and snapshot-style fixes do exactly
      // one childList swap. Treat large body-byte deltas as evidence of
      // meaningful action even with low mutation counts.
      let bucket = "no-act";
      if (navigated) bucket = "navigate";
      else if (openAfter > openBefore) bucket = "panel-open";
      else if (mutations >= 10 || byteDelta >= 2000) bucket = "dom-act";
      return {
        missing: false,
        bucket,
        mutations,
        byteDelta,
        navigated,
      };
    }, selector);
  };

  let matched = 0;
  let tested = 0;
  const samples = [];
  const safeClick = async (page, sel) => {
    try {
      return await clickAndClassify(page, sel);
    } catch (e) {
      // Most common cause: navigation in flight destroys the evaluate ctx.
      // Treat as a successful navigate — the click clearly did something.
      const msg = e.message || "";
      if (/Execution context was destroyed|navigation/i.test(msg))
        return {
          missing: false,
          bucket: "navigate",
          mutations: 0,
          byteDelta: 0,
          navigated: true,
        };
      return { missing: true };
    }
  };
  for (const sel of candidates) {
    const a = await safeClick(origPage, sel);
    const b = await safeClick(clonePage, sel);
    if (a.missing || b.missing) continue;
    tested++;
    const ok = a.bucket === b.bucket;
    if (ok) matched++;
    if (samples.length < 6)
      samples.push({
        sel: sel.slice(0, 60),
        orig: a.bucket,
        clone: b.bucket,
        ok,
      });
    // After a navigate, the next click on the same page would target a
    // different DOM — stop on navigation so the run stays comparable.
    if (a.bucket === "navigate" || b.bucket === "navigate") break;
  }
  return {
    score: tested === 0 ? 100 : Math.round((matched / tested) * 100),
    tested,
    matched,
    samples,
  };
}

// ─── main ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.length < 2) {
    console.log(`Usage: node score-clone.js <live-url> <clone-dir> [--out file.json] [--page /route]

Scores a site-xray clone against its live origin across five dimensions.
Default page is "/". Use --page to score a specific subpage.

Output is printed to stdout. Pass --out to also write JSON.`);
    process.exit(1);
  }
  const [liveURL, cloneDir] = args.positional;
  if (!fs.existsSync(cloneDir)) {
    console.error(`clone dir does not exist: ${cloneDir}`);
    process.exit(1);
  }

  const liveTarget = new URL(args.page || "/", liveURL).toString();
  const server = await startLocalServer(cloneDir);
  const cloneTarget = new URL(args.page || "/", server.url).toString();

  const browser = await chromium.launch();
  const orig = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const clone = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const origPage = await orig.newPage();
  const clonePage = await clone.newPage();
  const origErrors = attachErrorCounter(origPage);
  const cloneErrors = attachErrorCounter(clonePage);
  const origAssets = attachAssetCounter(origPage);
  const cloneAssets = attachAssetCounter(clonePage);

  try {
    // Resilient nav: networkidle fails on heavy sites with long-lived
    // sockets (analytics keep-alive, hot-reload, etc.). Try strict → load →
    // domcontentloaded so we still get a usable score on slow origins.
    const gotoResilient = async (page, url) => {
      const attempts = [
        { waitUntil: "networkidle", timeout: 25000 },
        { waitUntil: "load", timeout: 20000 },
        { waitUntil: "domcontentloaded", timeout: 15000 },
      ];
      let last;
      for (const opts of attempts) {
        try {
          await page.goto(url, opts);
          return;
        } catch (e) {
          last = e;
        }
      }
      throw last;
    };
    await Promise.all([
      gotoResilient(origPage, liveTarget),
      gotoResilient(clonePage, cloneTarget),
    ]);
    // Networkidle isn't enough for SPAs — frameworks like React hydrate
    // after fetch finishes, and the DOM keeps changing for a beat after.
    // Wait for the DOM to be mutation-free for `stableMs` (max `maxMs`).
    // Without this, the score tool measures a half-hydrated orig and
    // unfairly punishes the clone for being more complete.
    const waitStable = async (page) =>
      page.evaluate(
        ({ stableMs, maxMs }) =>
          new Promise((resolve) => {
            let last = Date.now();
            const obs = new MutationObserver(() => {
              last = Date.now();
            });
            obs.observe(document.body, {
              attributes: true,
              childList: true,
              subtree: true,
            });
            const start = Date.now();
            const tick = () => {
              if (Date.now() - last >= stableMs) {
                obs.disconnect();
                resolve("stable");
                return;
              }
              if (Date.now() - start >= maxMs) {
                obs.disconnect();
                resolve("max");
                return;
              }
              setTimeout(tick, 120);
            };
            tick();
          }),
        { stableMs: 1500, maxMs: 8000 },
      );
    await Promise.all([waitStable(origPage), waitStable(clonePage)]);

    const visual = await probeVisual(origPage, clonePage);
    const structural = await probeStructural(origPage, clonePage);
    const interactive = await probeInteractive(origPage, clonePage);

    const errors = {
      score: scoreErrors(origErrors, cloneErrors),
      orig: origErrors,
      clone: cloneErrors,
    };
    const assetsResult = scoreAssets(origAssets, cloneAssets);
    const assets = {
      score: assetsResult.score,
      perCategory: assetsResult.perCategory,
      orig: origAssets,
      clone: cloneAssets,
    };

    const overall = Math.round(
      visual.score * WEIGHTS.visual +
        structural.score * WEIGHTS.structural +
        errors.score * WEIGHTS.errors +
        assets.score * WEIGHTS.assets +
        interactive.score * WEIGHTS.interactive,
    );

    const result = {
      live: liveTarget,
      clone: cloneTarget,
      cloneDir,
      ranAt: new Date().toISOString(),
      scores: {
        visual: visual.score,
        structural: structural.score,
        errors: errors.score,
        assets: assets.score,
        interactive: interactive.score,
        overall,
      },
      weights: WEIGHTS,
      details: { visual, structural, errors, assets, interactive },
    };

    const bar = (n) => {
      const w = 30;
      const filled = Math.round((n / 100) * w);
      return "█".repeat(filled) + "·".repeat(w - filled);
    };
    const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);

    console.log("");
    console.log(`  Site X-Ray — accuracy score`);
    console.log(`  live  ${liveTarget}`);
    console.log(`  clone ${cloneTarget}  (${cloneDir})`);
    console.log("");
    for (const k of [
      "visual",
      "structural",
      "errors",
      "assets",
      "interactive",
    ]) {
      const s = result.scores[k];
      console.log(`  ${pad(k, 12)} ${bar(s)}  ${String(s).padStart(3)}/100`);
    }
    console.log(
      `  ${pad("OVERALL", 12)} ${bar(overall)}  ${String(overall).padStart(3)}/100`,
    );
    console.log("");
    const sumOK = (s) => Object.values(s.counts).reduce((x, y) => x + y, 0);
    console.log(
      `  details:  visual-diff ${(visual.ratio * 100).toFixed(1)}%  ·  ` +
        `visible ${structural.clone.visible}/${structural.orig.visible}  ·  ` +
        `errors ${cloneErrors.count}/${origErrors.count}  ·  ` +
        `assets ${sumOK(cloneAssets)}/${sumOK(origAssets)}  ·  ` +
        `interactive ${interactive.matched}/${interactive.tested}`,
    );
    if (interactive.samples.length) {
      console.log("");
      console.log("  interactive samples:");
      for (const s of interactive.samples) {
        const mark = s.ok ? "✓" : "✗";
        console.log(
          `    ${mark}  ${pad(s.orig, 12)} vs ${pad(s.clone, 12)}  ${s.sel}`,
        );
      }
    }
    console.log("");

    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
      console.log(`  → ${args.out}`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
