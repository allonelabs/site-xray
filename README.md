# Site X-Ray

Take any URL. Get a faithful static clone you can host anywhere.

```bash
# Full clone with verify+fix (Playwright)
node v54-stable.js https://example.com

# Fast HTTP-only clone (no Playwright — for SSR sites)
node xray-static.js https://example.com
```

Two clone engines:

| Engine           | Speed       | Best for                                                                               |
| ---------------- | ----------- | -------------------------------------------------------------------------------------- |
| `v54-stable.js`  | seconds–min | SPAs, sites needing JS to render content, sites needing verify+fix loop                |
| `xray-static.js` | 16× faster  | SSR Next.js, Astro, Hugo, plain HTML, WordPress-rendered — content arrives in raw HTML |

`xray-static` skips Playwright entirely. It HTTP-fetches the page, detects whether the response is "static-enough" (visible text > 1KB, no obvious SPA shell), then downloads assets in parallel and rewrites URLs. Tailwindcss.com benchmarks at **40s** with `xray-static` vs **11:46** with `v54-stable.js` and scores 2 points higher (`77/100` vs `75/100`) because raw SSR HTML is cleaner than a Playwright-captured post-hydration DOM. The trade-off: anti-bot CDN protections (Stripe-style) block raw HTTP — fall back to `v54-stable.js` for those.

## What it does

1. **Clone** — renders the live page in a headless browser, captures the post-hydration DOM, downloads every referenced asset, and rewrites URLs to local paths. JS bundles are deliberately not bundled in `--visual` mode (the clone is a static snapshot; no runtime needed).
2. **Verify** — runs detectors against the clone and the live site side-by-side: click behavior, hover state, form audit, animation drift, scroll checkpoints, visual diff, console errors.
3. **Fix** — for each detected mismatch, applies a strategy: inject a delegated navigation handler, replay captured DOM mutations on click (panel/dropdown patterns), stub missing globals, etc. Loops until the verify pass is clean, stalls, or exceeds `--max-passes`.
4. **Ship** — optionally pushes the clone to a GitHub repo (`allonelabs/xray-<slug>`) and deploys to Vercel (`allonelabs` team) in one step.

## Quick start

```bash
# Visual-fidelity clone with default homepage + 50 pages
node v54-stable.js https://example.com --visual

# Clone the whole site (sitemap + crawl)
node v54-stable.js https://example.com --all

# Page-gated content: pass passcodes per route
node v54-stable.js https://example.com --passcode /vip:1234

# Skip verify+fix (legacy v52 behavior)
node v54-stable.js https://example.com --no-verify

# Re-run verify on an existing clone (no re-download)
node v54-stable.js --verify-only /tmp/example --debug-report

# Ship: push to git AND deploy to Vercel
node v54-stable.js https://example.com --ship

# Just push to git, or just deploy, separately
node v54-stable.js https://example.com --push-git
node v54-stable.js https://example.com --deploy

# Override the auto-derived slug
node v54-stable.js https://example.com --ship --ship-name my-clone
```

## Measuring accuracy

`score-clone.js` runs a live URL and a clone side-by-side and scores them across five dimensions:

```bash
node score-clone.js https://example.com /tmp/example
```

| Dimension       | Weight | What it measures                                                                                                         |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| **visual**      | 35%    | Pixel-diff between full-page screenshots                                                                                 |
| **structural**  | 15%    | Visible elements, links/buttons/forms, text parity                                                                       |
| **errors**      | 15%    | Console error count vs the live origin                                                                                   |
| **assets**      | 15%    | Per-category request parity (doc/css/image/font/video). JS and analytics are ignored — clones are static by design.      |
| **interactive** | 20%    | Click-behavior parity on up to 20 candidates (reloaded between candidates to keep samples comparable on nav-style links) |

Score is 0–100. Reports per-sample interactive breakdowns and per-category asset gaps.

## Key flags

| Flag                      | What it does                                         |
| ------------------------- | ---------------------------------------------------- |
| `--visual`                | Pixel-perfect clones, no DOM mutations from JS       |
| `--all`                   | Crawl every page (sitemap.xml + recursive)           |
| `--auth <file>`           | Load saved Playwright auth state                     |
| `--save-auth`             | Open a visible browser for manual login + save state |
| `--passcode <route:code>` | Page-level passcode (repeatable)                     |
| `--no-verify`             | Skip the verify+fix phase                            |
| `--verify-only <dir>`     | Verify+fix an existing clone without re-cloning      |
| `--no-fix`                | Run verify only, no fix injection                    |
| `--max-passes <N>`        | Cap verify+fix iterations (default unlimited)        |
| `--verify-budget <sec>`   | Cap verify wall-clock per pass (default 300)         |
| `--debug-report`          | Always emit `data/debug-report.html` even when clean |
| `--responsive`            | Capture desktop/tablet/mobile screenshots            |
| `--push-git [repo]`       | Push the clone to `allonelabs/<slug>` on GitHub      |
| `--deploy`                | Deploy the clone to Vercel (`allonelabs` team)       |
| `--ship`                  | `--push-git` + `--deploy`                            |
| `--ship-name <slug>`      | Override the auto-derived repo/project name          |

## What the verify phase catches

| Issue type                          | Detection                                       | Fix strategy                                            |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `click-no-op`                       | Click acts on origin, no-op on clone            | Delegated nav (same-origin path) OR diff-replay router  |
| `click-throws`                      | Click throws console error on clone             | Inline missing-global stub OR escalation                |
| `missing-hover`                     | Visual change on hover on origin, none on clone | Inject CSS `:hover` rule via CDP                        |
| `missing-focus`                     | Visual change on focus on origin, none on clone | Inject CSS `:focus` rule via CDP                        |
| `missing-animation`                 | Element moves on origin, static on clone        | Inject keyframes from computed style snapshot           |
| `visual-drift-animated`             | Animated-frame pixel diff > 5%                  | Same as missing-animation                               |
| `scroll-anim-drift`                 | Scroll position mismatch in checkpoint frames   | Same as missing-animation                               |
| `console-error-404`                 | 404 on a referenced URL                         | Lazy-image src restore / asset path rewrite             |
| `lazy-image-stuck`                  | Image never resolves in clone                   | Strip lazy attributes                                   |
| `missing-font-glyphs`               | Glyph rendering mismatch                        | Re-attach @font-face                                    |
| `missing-svg-symbol`                | SVG `<use>` reference broken                    | Inline sprite                                           |
| `webgl-shader-fail`                 | WebGL context error                             | (stub) — context-specific                               |
| `broken-form`                       | Form has no action                              | Inject mailto: stub or local handler                    |
| `visual-drift`                      | Full-page pixel diff > threshold                | (stub) — needs human review                             |
| `iframe-blocked`                    | Embedded iframe X-Frame blocked                 | Replace with placeholder                                |
| `console-error-unhandled-rejection` | Unhandled promise rejection                     | Inject window.onerror swallower for stub-cause messages |

After verify completes, `data/debug-report.html` renders a designed, dark-mode card list of the remaining unfixable issues with side-by-side screenshots and per-pass issue counts.

## Output layout

```
clone-dir/
├── index.html                ← root page
├── <route>/index.html        ← each crawled page (folder hierarchy)
├── css/                      ← bundled stylesheets
├── fonts/                    ← downloaded font files
├── images/                   ← downloaded images (renamed to img-N.png)
├── videos/                   ← downloaded videos
├── data/
│   ├── manifest.json         ← clone metadata + verify pass history + ship URLs
│   ├── url-map.json          ← live URL → local path table (consumed by fix injections)
│   ├── debug-report.html     ← human-readable issue report
│   ├── passes/pass-N.json    ← per-pass detected issues
│   ├── issues/<id>-*.png     ← per-issue evidence screenshots
│   ├── bundle.json           ← detected JS framework / libraries
│   ├── original.png          ← full-page screenshot of the live origin
│   ├── clone.png             ← full-page screenshot of the clone served locally
│   └── ScrollTrigger.min.js  ← any detected third-party scripts
└── vercel.json               ← cache headers for fonts/css/images
```

## Stability + robustness

- Verify-phase navigation uses a 3-stage fallback (`networkidle` → `load` → `domcontentloaded`) wrapped in a wall-clock Promise.race so a heavy live origin can't hang the verify pass.
- Local server start tries a port range so an orphan from a prior crash doesn't break the next run.
- `urlMap` is persisted to `data/url-map.json` and consumed by fix injections so post-click HTML captured from live always uses the clone's local asset paths.

## Multi-site benchmarks

Scores measured by `score-clone.js` against the live origin (visual 35%, structural 15%, errors 15%, assets 15%, interactive 20%):

| Site            | Engine          | Time    | Score      | Notes                                                          |
| --------------- | --------------- | ------- | ---------- | -------------------------------------------------------------- |
| example.com     | v54-stable      | 50s     | 98/100     | Sanity baseline                                                |
| kenkais.com     | v54-stable      | 5min    | 94/100     | Mutation-replay fixes all 5 interactive panels                 |
| tailwindcss.com | **xray-static** | **40s** | **77/100** | 16× faster, +2 points vs v54-stable (75/100 in 11:46)          |
| bottega53.com   | v54-stable      | 5min    | 75/100     | GSAP+Lenis SPA; verify completes cleanly                       |
| vercel.com      | v54-stable      | 21min   | 74/100     | --concurrency 3, 20 pages                                      |
| stripe.com      | v54-stable      | 5min    | 70/100     | Anti-bot CDN blocks xray-static (3× faster but 222 assets 403) |

## Known limitations

- **Interactive panels with stateful frameworks** (React/Vue stateful modals) replay a captured DOM snapshot; close-on-outside-click works, but state mutations after open aren't reactive.
- **Animation-residue capture**: if the live site is mid-animation at capture time, transient inline styles may leak into the clone. The cleanup pass strips known patterns (lenis, `.pin-spacer`, sub-pixel translate residue, inline `opacity:0` on non-overlay elements).
- **Heavy SPAs with multi-megabyte JS bundles** may have logic the static clone can't replay. Fix strategies cover common patterns (click-no-op, missing animation, broken form) — the rest are flagged in the debug report.
- **Mobile-specific behaviors** (touch gestures, intersection observers, scroll-snap) aren't currently detected.
- **Anti-bot CDN protection**: sites like Stripe block raw-HTTP user-agents (403). `xray-static` can't clone these; use `v54-stable.js` which carries a full Playwright browser fingerprint.

## Files

- `v54-stable.js` — the cloner (clone + verify + fix + ship). Single file, only `playwright` as a runtime dependency.
- `score-clone.js` — the accuracy measurement tool.
- `test/` — unit tests for the loop state machine, detectors, and utilities.

Older stable versions (`v25-stable.js`, `v52-stable.js`, etc.) are preserved for reference and reproducibility.
