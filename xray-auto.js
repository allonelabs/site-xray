#!/usr/bin/env node
/**
 * xray-auto.js — smart dispatcher for Site X-Ray.
 *
 * One command. Picks the right engine:
 *   - `xray-static.js` for SSR sites (16× faster, no Playwright)
 *   - `v54-stable.js` for SPAs / sites needing JS to render
 *
 * Detection probes the homepage via raw HTTP and looks at the response:
 *   - visible text >= 1024 bytes + no obvious SPA shell → static
 *   - otherwise → Playwright
 *
 * Usage:
 *   node xray-auto.js <url> [out-dir] [max-pages] [--engine=auto|static|playwright] [other flags pass through to v54]
 */

const { spawnSync } = require("child_process");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const SCRIPT_DIR = __dirname;
const HTTP_TIMEOUT_MS = 8000;

function quickFetch(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const mod = parsed.protocol === "http:" ? http : https;
    const req = mod.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return quickFetch(next).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function looksStatic(html) {
  if (!html) return { ok: false, reason: "empty response" };
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const noStyles = noScripts.replace(/<style[\s\S]*?<\/style>/gi, "");
  const text = noStyles
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 1024)
    return {
      ok: false,
      reason: `only ${text.length} bytes of visible text`,
      textLen: text.length,
    };
  const shells = [
    /<div id="__next">\s*<\/div>/,
    /<div id="root">\s*<\/div>/,
    /<body[^>]*>\s*<div id="app">\s*<\/div>/,
  ];
  for (const r of shells) {
    if (r.test(html))
      return {
        ok: false,
        reason: `SPA shell pattern (${r})`,
        textLen: text.length,
      };
  }
  return { ok: true, textLen: text.length };
}

async function main() {
  const args = process.argv.slice(2);
  let engine = "auto";
  const cleanArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--engine=")) {
      engine = args[i].split("=")[1];
    } else if (args[i] === "--engine") {
      engine = args[++i];
    } else {
      cleanArgs.push(args[i]);
    }
  }

  const positional = cleanArgs.filter((a) => !a.startsWith("--"));
  if (positional.length < 1) {
    console.log(
      `xray-auto — smart dispatcher

Usage: node xray-auto.js <url> [out-dir] [max-pages] [--engine=auto|static|playwright] [other flags]

Default engine is "auto": detects whether the site ships content in raw HTML
(uses xray-static, 16x faster, no Playwright) or needs JS to render
(uses v54-stable.js with Playwright). Other flags pass through to v54-stable.js.`,
    );
    process.exit(1);
  }
  const url = positional[0];

  let chosen = engine;
  if (engine === "auto") {
    process.stdout.write(`🩻 xray-auto: probing ${url}... `);
    let res;
    try {
      res = await quickFetch(url);
    } catch (e) {
      console.log(`probe failed (${e.message}) — falling back to playwright`);
      chosen = "playwright";
    }
    if (chosen === "auto") {
      if (res.status >= 400) {
        console.log(`status ${res.status} — falling back to playwright`);
        chosen = "playwright";
      } else {
        const decision = looksStatic(res.body);
        if (decision.ok) {
          console.log(
            `static (${decision.textLen} bytes of visible text) → xray-static`,
          );
          chosen = "static";
        } else {
          console.log(`needs JS (${decision.reason}) → playwright`);
          chosen = "playwright";
        }
      }
    }
  }

  const wantsScore = cleanArgs.includes("--score");
  // --score is a v54 flag; xray-static doesn't know it. Strip it from the
  // static-engine args and run score-clone.js explicitly afterwards.
  const engineArgs =
    chosen === "static"
      ? cleanArgs.filter((a, i, arr) => {
          if (a === "--score") return false;
          // --score takes no value, but the next arg might be the value of
          // some preceding flag — leave others alone.
          return true;
        })
      : cleanArgs;

  const script =
    chosen === "static"
      ? path.join(SCRIPT_DIR, "xray-static.js")
      : path.join(SCRIPT_DIR, "v54-stable.js");
  const result = spawnSync("node", [script, ...engineArgs], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);

  // If the user asked for --score on the static engine, run score-clone now.
  // v54 handles its own --score via runScorePhase, so we don't double-run.
  if (chosen === "static" && wantsScore) {
    const outDir = positional[1] || guessOutDirFromHostname(url);
    const scoreScript = path.join(SCRIPT_DIR, "score-clone.js");
    const sc = spawnSync(
      "node",
      [
        scoreScript,
        url,
        outDir,
        "--out",
        path.join(outDir, "data", "score.json"),
      ],
      { stdio: "inherit" },
    );
    process.exit(sc.status ?? 0);
  }
  process.exit(0);
}

function guessOutDirFromHostname(url) {
  try {
    const u = new URL(url);
    return `/tmp/xray-static-${u.hostname.replace(/\./g, "-")}`;
  } catch {
    return "/tmp/xray-static-out";
  }
}

main().catch((e) => {
  console.error("xray-auto:", e.message);
  process.exit(1);
});
