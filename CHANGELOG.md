# Changelog

Notable changes to Site X-Ray. See `git log v54-stable.js` for full per-commit history.

## v54

Adds an iterative verify+fix loop, an accuracy-measurement tool, and a one-command ship pipeline (git + Vercel) on top of v52's clone engine.

### New

- **Verify+fix loop** — after cloning, runs 8 detectors (click, hover, form, animation trajectory, animation frames, scroll checkpoint, visual diff, console audit) against the clone vs the live origin, then applies fix strategies for each detected mismatch. Stalls or `--max-passes` end the loop.
- **Mutation-replay click fix** — for click-no-op detections on interactive panels, captures the live site's post-click DOM diff and injects a one-shot handler that swaps in the recorded subtree. One shared router handles all per-page fixes via a `window.__v54Fixes` registry so multiple cards on a list don't undo each other's state.
- **`score-clone.js`** — standalone tool that renders live + clone side-by-side and produces a 0–100 accuracy score across five dimensions (visual, structural, errors, assets, interactive). Outputs per-sample interactive breakdown and actionable suggestions.
- **`--score` flag** — runs score-clone automatically after verify completes; score JSON written to `data/score.json` and surfaced in the debug-report sidebar.
- **`--ship` / `--push-git` / `--deploy` flags** — push clone to `allonelabs/xray-<slug>` (private by default) and deploy to Vercel allonelabs team in one command.
- **`--verify-budget <sec>` flag** — cap total verify wall-clock per pass.
- **Redesigned `data/debug-report.html`** — dark-mode card list with semantic family-color rails, Newsreader serif, JetBrains Mono, pass-by-pass mini bar chart, embedded animation playback for visual-drift-animated issues.
- **`data/url-map.json`** — persisted live→local URL mapping so mutation-replay fixes rewrite asset URLs to the clone's renamed paths.

### Robustness

- **Wall-clock-bounded navigation** — `gotoResilient` tries `networkidle` → `load` → `domcontentloaded` with a Promise.race deadline (timeout + 5s). Between retries the page is closed+reopened to actually cancel the hung underlying `page.goto` (Playwright otherwise serializes the next goto behind it).
- **Wall-clock-bounded per-detector** — each detector capped at min(remaining budget, 120s). After the first wall-clock cap, the page is treated as poisoned and remaining detectors skip cleanly.
- **Wall-clock-bounded per-click** — `observeClick` caps each candidate at (in-page wait + 1500ms). On bottega-class sites this took `probeClick` from 578s to ~70s.
- **Force-close cleanup** — `runVerifyPhase`'s cleanup closes pages first with a 5s timeout, then context; prevents the cleanup hanging on a still-running evaluate.
- **Port-range local server** — `startLocalServer` tries 50 ports from the base, falling back to the first free. Orphan servers from prior crashes no longer crash the next run.

### Clone-time cleanup (feedback-driven)

Based on the bottega53→gogaphotography rebrand feedback session, the clone phase now:

- **Strips inline `opacity:0` animation residue** on non-overlay elements (skips hover-reveal classes like `info`/`caption`/`overlay`/`tooltip`).
- **Unwraps GSAP `.pin-spacer` wrappers** (cause double-scroll on rebind).
- **Strips `lenis lenis-smooth` classes** from `<html>` (Lenis-runtime residue that breaks scroll feel).
- **Strips `router-link-active` / `data-revealed`** runtime classes.
- **Strips sub-pixel-translate transform residue** (mid-frame ScrollTrigger snapshots).
- **Removes the blanket `pointer-events:auto` script** that broke `pointer-events:none` on collapsed filter panels.
- **Removes the blanket `gsap.to(img, {brightness:0.9})` hover script** that darkened images on hover (a heuristic that doesn't match most real sites).
- **Hardens v24 opacity-force** to skip elements matching hover-reveal class patterns.
- **Stubs common JS globals** (gsap, ScrollTrigger, Lenis, anime, AOS, Swiper, barba) with chainable no-ops to prevent console errors from inline scripts that call `gsap.timeline()` etc. in a clone with no real lib loaded.
- **Stubs getComputedStyle** to fail-soft when called with non-Element arguments (post-stub fallout).

### Security

- **Ship-arg allow-list** — `shipToGit` and `shipToVercel` reject repo/slug values that don't match `[A-Za-z0-9._-]+/[A-Za-z0-9._-]+` or `[A-Za-z0-9._-]+` respectively, before shelling out via `execSync`.
- **Default to `gh repo create --private`** — clones contain third-party content; public would expose copyrighted assets without permission.
- **`.gitignore` on ship** — excludes `node_modules/`, `.vercel/`, `*.log`, and `data/*.png` (per-page diagnostic screenshots) from the deploy.

### Score-tool refinements

- Asset score classifies URLs by extension/domain and only scores content categories (doc/css/image/font/video). JS bundles and analytics requests are excluded because visual-mode clones are static by design.
- Structural score drops raw total-node count (frameworks render internal nodes the clone doesn't need) and counts visible elements + interactive affordances.
- Interactive classifier uses both mutation count (≥10) AND body-byte delta (≥2000) so snapshot-style fixes (one childList swap, large byte change) are recognized as action.
- `probeInteractive` reloads both pages between candidates so navigation-style links don't poison subsequent samples.
- `gotoResilient` 3-stage fallback (networkidle → load → domcontentloaded) so heavy origins like bottega53 still produce a score.

### Score baselines

| Site          | Baseline                   | After v54 fixes |
| ------------- | -------------------------- | --------------- |
| kenkais.com   | 67/100                     | **94/100**      |
| bottega53.com | 65/100                     | 76–78/100       |
| piranhabar.ie | n/a (live site unreliable) | —               |

The remaining bottega gap is dominated by a 19–21% visual diff (clone body bg captured at black before live JS sets it white; some hidden static-HTML markup the live runtime strips), and structural button/text divergence from JS-time hydration cleanup. Open in `data/debug-report.html` to see the per-issue evidence cards.

### v54 file map

- `v54-stable.js` — clone + verify + fix + ship engine (single file, only `playwright` runtime dep).
- `score-clone.js` — accuracy measurement tool.
- `test/v54-utils.test.js`, `test/v54-detectors.test.js`, `test/v54-loop.test.js` — unit tests.
- `test/score-clone-units.test.js` — unit tests for score-clone helpers.
- `README.md` — product overview.
- `gogaphotography/SITE_XRAY_FEEDBACK.md` — punch list from a real rebrand session, drives much of the cleanup work above.

## v52

Visual-fidelity mode (`--visual` flag) with pixel-perfect clones, sitemap-based site-wide crawl (`--all`), page-level passcodes for gated content.

## Earlier versions

`v10`, `v11`, `v12`, `v13`, `v18`, `v25`, `v51` — preserved for reference and reproducibility.
