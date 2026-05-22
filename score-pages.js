#!/usr/bin/env node
/**
 * score-pages.js — score-clone over multiple pages of the same clone.
 *
 * Scoring just the homepage misses divergence on deep pages: a clone can be
 * 94/100 on / and 60/100 on /docs/foo. This tool samples N pages from the
 * clone's manifest (always including the homepage), runs score-clone.js
 * once per page, and emits a per-page table + aggregate.
 *
 * Usage:
 *   node score-pages.js <live-url> <clone-dir> [--pages N] [--out file.json]
 *
 * Default --pages 5 (homepage + 4 stratified samples).
 *
 * Sampling strategy:
 *   - Always include the manifest's first page (typically "/").
 *   - For N>1, take evenly-spaced samples through the rest of the pages
 *     list. This catches deep pages without re-clicking randomness.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = { positional: [], out: null, pages: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--pages") args.pages = parseInt(argv[++i]) || 5;
    else args.positional.push(argv[i]);
  }
  return args;
}

function sample(arr, n) {
  if (n <= 0) return [];
  if (arr.length <= n) return arr.slice();
  // Always include index 0 (homepage), then evenly-spaced through the rest.
  const out = [arr[0]];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 1; i < n; i++) {
    const idx = Math.round(step * i);
    if (out.indexOf(arr[idx]) === -1) out.push(arr[idx]);
  }
  return out;
}

function rgbBar(pct) {
  const w = 24;
  const filled = Math.round((pct / 100) * w);
  return "█".repeat(filled) + "·".repeat(w - filled);
}

function pad(s, n) {
  s = String(s);
  return (s + " ".repeat(n)).slice(0, n);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.length < 2) {
    console.log(`score-pages — multi-page accuracy scoring

Usage: node score-pages.js <live-url> <clone-dir> [--pages N] [--out file.json]

Default --pages 5. Always includes the homepage; the rest are stratified
samples from manifest.json's pages list (or sorted-by-depth fallback).`);
    process.exit(1);
  }
  const [liveURL, cloneDir] = args.positional;
  if (!fs.existsSync(cloneDir)) {
    console.error(`clone dir does not exist: ${cloneDir}`);
    process.exit(1);
  }
  // Discover pages from manifest.json, then fall back to filesystem scan.
  let allPages = [];
  try {
    const m = JSON.parse(
      fs.readFileSync(path.join(cloneDir, "data", "manifest.json"), "utf-8"),
    );
    if (Array.isArray(m.pages)) allPages = m.pages;
  } catch {}
  if (allPages.length === 0) {
    // Fallback: walk for index.html files
    const walk = (dir, base = "") => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (entry.name.startsWith(".") || entry.name === "data") continue;
            walk(path.join(dir, entry.name), base + "/" + entry.name);
          } else if (entry.name === "index.html") {
            allPages.push(base || "/");
          }
        }
      } catch {}
    };
    walk(cloneDir);
    allPages.sort((a, b) => a.length - b.length);
  }
  if (allPages.length === 0) {
    console.error("no pages found in clone");
    process.exit(1);
  }
  const sampled = sample(allPages, args.pages);
  console.log(
    `\n📄 score-pages — ${sampled.length} of ${allPages.length} pages`,
  );
  console.log(`   live  ${liveURL}`);
  console.log(`   clone ${cloneDir}\n`);

  const scoreScript = path.join(__dirname, "score-clone.js");
  const results = [];
  for (const p of sampled) {
    process.stdout.write(`  scoring ${pad(p, 40)}... `);
    const out = spawnSync(
      "node",
      [scoreScript, liveURL, cloneDir, "--page", p],
      { encoding: "utf-8" },
    );
    // Extract the overall score line: "OVERALL ... NN/100"
    const m = out.stdout.match(
      /visual\s+\S+\s+(\d+)\/100[\s\S]+structural\s+\S+\s+(\d+)\/100[\s\S]+errors\s+\S+\s+(\d+)\/100[\s\S]+assets\s+\S+\s+(\d+)\/100[\s\S]+interactive\s+\S+\s+(\d+)\/100[\s\S]+OVERALL\s+\S+\s+(\d+)\/100/,
    );
    if (m) {
      const r = {
        page: p,
        visual: +m[1],
        structural: +m[2],
        errors: +m[3],
        assets: +m[4],
        interactive: +m[5],
        overall: +m[6],
      };
      results.push(r);
      console.log(`${r.overall}/100`);
    } else {
      console.log("?");
      results.push({ page: p, error: out.stderr.slice(0, 100) });
    }
  }

  // Aggregate
  const valid = results.filter((r) => typeof r.overall === "number");
  if (valid.length === 0) {
    console.error("\nno pages scored successfully");
    process.exit(1);
  }
  const avg = (key) =>
    Math.round(valid.reduce((s, r) => s + r[key], 0) / valid.length);
  const min = (key) => Math.min(...valid.map((r) => r[key]));
  const max = (key) => Math.max(...valid.map((r) => r[key]));
  const aggregate = {
    visual: avg("visual"),
    structural: avg("structural"),
    errors: avg("errors"),
    assets: avg("assets"),
    interactive: avg("interactive"),
    overall: avg("overall"),
    overallMin: min("overall"),
    overallMax: max("overall"),
  };

  console.log("");
  console.log("  per-page breakdown:");
  console.log(
    `  ${pad("page", 32)} ${pad("vis", 4)} ${pad("str", 4)} ${pad("err", 4)} ${pad("ast", 4)} ${pad("int", 4)} OVERALL`,
  );
  for (const r of valid) {
    console.log(
      `  ${pad(r.page, 32)} ${pad(r.visual, 4)} ${pad(r.structural, 4)} ${pad(r.errors, 4)} ${pad(r.assets, 4)} ${pad(r.interactive, 4)} ${r.overall}/100`,
    );
  }
  console.log("");
  console.log(
    `  aggregate (mean): visual ${aggregate.visual} · structural ${aggregate.structural} · errors ${aggregate.errors} · assets ${aggregate.assets} · interactive ${aggregate.interactive}`,
  );
  console.log(
    `  ${pad("OVERALL", 32)} ${rgbBar(aggregate.overall)} ${aggregate.overall}/100   (min ${aggregate.overallMin}, max ${aggregate.overallMax})`,
  );
  console.log("");

  if (args.out) {
    fs.writeFileSync(
      args.out,
      JSON.stringify(
        { live: liveURL, clone: cloneDir, pages: results, aggregate },
        null,
        2,
      ),
    );
    console.log(`  → ${args.out}`);
  }
}

main().catch((e) => {
  console.error("Error:", e.stack || e.message);
  process.exit(1);
});
