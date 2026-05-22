# Changelog

Notable changes to Site X-Ray. See `git log v54-stable.js` for full per-commit history.

## v55 — backend reverse engineering

Closes the "clone looks right but breaks the moment you interact" gap. Static clones today are visually faithful but dead the moment an SPA tries to fetch its data or a visitor submits a form. v55 captures the **backend surface** during the Playwright clone and emits replay infrastructure.

### P1 — keep-alive Agent pool (`xray-static.js`)

- Memoized `http/https.Agent` per origin (`keepAlive:true`, `maxSockets:16`, `maxFreeSockets:8`).
- TLS handshakes drop from once-per-fetch to ~5-10 per session.
- Marginal wall-clock improvement on already-CDN-fronted sites (TLS session resumption was already cheap); meaningful resource hygiene improvement (fewer sockets, less ephemeral port churn).
- Streaming asset writes via `stream.pipeline` were prototyped and reverted — the `createWriteStream + pipeline` setup cost (~20ms/file) dominated for small assets (the 95% case) and made the clone 5-8s **slower**.

### P2 — API capture + Vercel replay (`v54-stable.js`)

During Playwright clone, hook `page.on("response")` and record every XHR/fetch/eventsource response:

- Save body to `data/api/<10-char-hash>.<ext>`
- Append metadata to `data/api-recordings.json` (url, method, status, content-type, request body, sanitized request headers, byte count)
- Emit Vercel rewrites in `vercel.json` so the deployed clone serves the saved blobs for matching paths

Filters (defaults sensible):

- `--no-capture-api` opts out
- Analytics/tracking domains stripped
- Skip 4xx/5xx (not useful to replay)
- Skip > 5MB bodies (likely streaming endpoints)
- Dedupe by `method+url+postData` hash
- Hard cap 2000 recordings

Rewrite intelligence: when a captured URL's pathname collides with a static HTML file in the clone (e.g. `/showcase?_rsc=...` and `/showcase/index.html`), the rewrite gets a `has:[{type:query, key:_rsc}]` discriminator so the static page is still served on the bare path.

Benchmark (tailwindcss.com): 313 API responses captured (mostly React Server Component fetches), 73 rewrites generated.

### P3 — form handler generation (`v54-stable.js`)

Post-clone scan of every `*.html` for `<form method="POST" action="...">`. For each unique action path, generate a Vercel function at `api/<safe>.js` that:

- Accepts POST only (405 on other methods)
- Parses JSON or urlencoded body
- Logs the submission (Vercel function logs visible)
- Optionally forwards to Resend mail if `--form-email <to>` was passed (`RESEND_API_KEY` env on the deploy)
- Returns 200 JSON `{ok:true, received:<body>}`

Closes the "clone loses contact/signup/newsletter forms" gap.

### Multi-page scoring (`score-pages.js` new)

`score-clone.js` scored only the homepage. Real clones diverge across pages. `score-pages.js`:

- Reads manifest.json's `pages` (or filesystem-walks for `index.html`)
- Stratified-samples N pages (always includes the homepage)
- Runs `score-clone` once per page
- Emits per-page table + aggregate (mean, min, max)

On Kenkais: homepage 94/100, /agency 87/100, /resources 96/100 → aggregate 92/100 (more honest than the single-page 94).

## xray-static (new engine)

Adds `xray-static.js` — a Playwright-free HTTP-only clone engine for sites that ship full content in their HTML response (SSR Next.js, Astro, Hugo, WordPress, plain HTML).

- Detects "static-enough" by checking visible text length and SPA-shell signatures. `--force` overrides.
- Parallel asset download (12 concurrent) with per-asset 50MB cap, 15s request timeout, and recursive CSS `url()` expansion.
- URL rewriting maps each absolute URL into its path-only, origin+path, and HTML-entity-encoded variants — fixes the otherwise-common "downloaded but not linked" bug where HTML uses relative paths.
- Writes a `manifest.json` compatible with `score-clone.js`, so scoring works the same as Playwright clones.

**Benchmarks** (tailwindcss.com, 10 pages):

| Engine             | Time    | Score      |
| ------------------ | ------- | ---------- |
| v54-stable.js      | 11:46   | 75/100     |
| **xray-static.js** | **40s** | **77/100** |

16× faster, +2 points higher. The structural dimension jumps 71 → 99 because raw SSR HTML is cleaner than a Playwright-captured post-hydration DOM that includes runtime markup the live site cleans up.

Not a replacement for `v54-stable.js` — anti-bot CDNs (Stripe-style) block raw HTTP. Use `v54-stable.js` for those.

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
