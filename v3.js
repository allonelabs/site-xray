#!/usr/bin/env node
/**
 * Site X-Ray v3 — Universal website cloning tool
 *
 * Single command: captures EVERYTHING needed to produce a working static clone.
 * Handles: Next.js, Nuxt, React, Angular, Svelte, WordPress, Webflow, Framer, vanilla.
 * Handles: GSAP, Framer Motion, Anime.js, Lenis, Locomotive Scroll, CSS-only.
 * Handles: CSS Modules, CSS-in-JS, Tailwind, vanilla CSS.
 * Handles: srcset, lazy images, background-image, SVG, emoji, web fonts, video, canvas.
 *
 * Usage: NODE_PATH=$(npm root -g) node site-xray.js <url> [output-dir]
 * Output: A self-contained directory that can be served with `python3 -m http.server`
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const URL_TARGET = process.argv[2];
if (!URL_TARGET) { console.log('Usage: node site-xray.js <url> [output-dir]'); process.exit(1); }

const PARSED = new URL(URL_TARGET);
const DOMAIN = PARSED.origin;
const SLUG = PARSED.hostname.replace(/\./g, '-');
const OUT = process.argv[3] || `/tmp/clone-${SLUG}`;

// ══════════════════════════════════════
// Utility: download file
// ══════════════════════════════════════
function dl(url, dest, timeout = 15000) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          file.close();
          fs.unlinkSync(dest);
          return dl(res.headers.location, dest, timeout).then(resolve);
        }
        if (res.statusCode !== 200) { file.close(); fs.unlinkSync(dest); resolve(false); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
      });
      req.on('error', () => { try { file.close(); fs.unlinkSync(dest); } catch(e) {} resolve(false); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch(e) { resolve(false); }
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const d of ['images', 'fonts', 'videos', 'svg', 'css', 'data']) {
    fs.mkdirSync(`${OUT}/${d}`, { recursive: true });
  }

  console.log(`\n🔬 Site X-Ray v3: ${URL_TARGET}`);
  console.log(`   Output: ${OUT}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // Intercept animation libraries before page loads
  await context.addInitScript(() => {
    window.__xray = { gsap: { tweens: [], sets: [], scrollTriggers: [] }, lenis: null, library: '' };
    function safe(o, d) { if (!o || d > 2) return o; d = d || 0; if (typeof o !== 'object') return o; if (o instanceof Element) return o.tagName + '.' + (o.className?.toString().split(' ')[0] || ''); const s = {}; for (const [k,v] of Object.entries(o)) { if (typeof v === 'function') s[k] = '[fn]'; else if (v instanceof Element) s[k] = safe(v); else if (typeof v === 'object' && v !== null) s[k] = safe(v, d+1); else s[k] = v; } return s; }
    const iv = setInterval(() => {
      if (window.gsap && !window.gsap.__xp) { window.gsap.__xp = true; window.__xray.library += 'gsap,';
        ['to','from','fromTo','set'].forEach(m => { const o = window.gsap[m].bind(window.gsap); window.gsap[m] = function() { window.__xray.gsap[m === 'set' ? 'sets' : 'tweens'].push({ method: m, targets: safe(arguments[0]), vars: safe(arguments[m === 'fromTo' ? 2 : 1]) }); return o.apply(window.gsap, arguments); }; });
      }
      if (window.ScrollTrigger && !window.ScrollTrigger.__xp) { window.ScrollTrigger.__xp = true; window.__xray.library += 'scrolltrigger,';
        const oc = window.ScrollTrigger.create.bind(window.ScrollTrigger); window.ScrollTrigger.create = function(v) { window.__xray.gsap.scrollTriggers.push({ trigger: safe(v.trigger), start: v.start, end: v.end, scrub: v.scrub, once: v.once }); return oc(v); };
      }
    }, 50);
    setTimeout(() => clearInterval(iv), 15000);
  });

  const page = await context.newPage();

  // ══════════════════════════════════════
  // Track ALL network resources for download
  // ══════════════════════════════════════
  const allURLs = new Set();
  page.on('response', async (res) => {
    try { if (res.status() === 200) allURLs.add(res.url()); } catch(e) {}
  });

  // ══════════════════════════════════════
  // PHASE 1: Load + wait for full render
  // ══════════════════════════════════════
  console.log('Phase 1: Loading...');
  await page.goto(URL_TARGET, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Scroll full page to trigger lazy loading and scroll animations
  console.log('Phase 2: Scrolling to trigger lazy content...');
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= totalHeight; y += 300) {
    await page.evaluate(sy => window.scrollTo(0, sy), y);
    await page.waitForTimeout(80);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(2000);

  // ══════════════════════════════════════
  // PHASE 3: Capture EVERYTHING from rendered page
  // ══════════════════════════════════════
  console.log('Phase 3: Capturing rendered state...');

  const capture = await page.evaluate((domain) => {
    const result = {
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      charset: document.characterSet,
      lang: document.documentElement.lang || 'en',
      htmlClasses: document.documentElement.className || '',
      htmlStyle: document.documentElement.getAttribute('style') || '',
      bodyClasses: document.body.className || '',
      bodyStyle: document.body.getAttribute('style') || '',

      // All stylesheet URLs
      stylesheetURLs: [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href),

      // All computed CSS from stylesheets
      computedCSS: '',

      // All inline <style> tags
      inlineStyles: [...document.querySelectorAll('style')].map(s => s.textContent),

      // Asset URLs found in DOM
      imageURLs: [],
      fontURLs: [],
      videoURLs: [],
      bgImageURLs: [],

      // Framework detection
      framework: 'unknown',
    };

    // Computed CSS from all sheets
    for (const sheet of document.styleSheets) {
      try { for (const rule of sheet.cssRules) result.computedCSS += rule.cssText + '\n'; } catch(e) {}
    }

    // Framework detection
    if (document.querySelector('#__next')) result.framework = 'nextjs';
    else if (document.querySelector('#__nuxt')) result.framework = 'nuxt';
    else if (document.querySelector('[data-reactroot]') || document.querySelector('[data-react-helmet]')) result.framework = 'react';
    else if (document.querySelector('[ng-version]')) result.framework = 'angular';
    else if (document.querySelector('meta[name="generator"]')?.content.includes('WordPress')) result.framework = 'wordpress';
    else if (document.querySelector('meta[name="generator"]')?.content.includes('Webflow')) result.framework = 'webflow';

    // ── Collect ALL image URLs ──
    // <img src>, <img srcset>, <source srcset>, <picture>, data-src, data-lazy
    document.querySelectorAll('img').forEach(img => {
      if (img.src) result.imageURLs.push(img.src);
      if (img.srcset) img.srcset.split(',').forEach(s => { const url = s.trim().split(' ')[0]; if (url) result.imageURLs.push(url); });
      if (img.dataset.src) result.imageURLs.push(img.dataset.src);
      if (img.dataset.lazy) result.imageURLs.push(img.dataset.lazy);
    });
    document.querySelectorAll('source').forEach(src => {
      if (src.srcset) src.srcset.split(',').forEach(s => { const url = s.trim().split(' ')[0]; if (url) result.imageURLs.push(url); });
    });

    // ── Background images from computed styles ──
    document.querySelectorAll('*').forEach(el => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const urls = bg.match(/url\(["']?([^"')]+)["']?\)/g);
        if (urls) urls.forEach(u => {
          const clean = u.replace(/url\(["']?|["']?\)/g, '');
          if (clean && !clean.startsWith('data:')) result.bgImageURLs.push(clean);
        });
      }
    });

    // ── Video URLs ──
    document.querySelectorAll('video, video source').forEach(v => {
      if (v.src) result.videoURLs.push(v.src);
    });

    // ── Font URLs from @font-face in computed CSS ──
    const fontMatches = result.computedCSS.match(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf|eot)[^"')]*)/g);
    if (fontMatches) fontMatches.forEach(m => {
      let url = m.replace(/url\(["']?/, '').replace(/["']?\).*/, '');
      if (url.startsWith('/')) url = domain + url;
      result.fontURLs.push(url);
    });

    // Deduplicate
    result.imageURLs = [...new Set(result.imageURLs)].filter(u => u && !u.startsWith('data:'));
    result.bgImageURLs = [...new Set(result.bgImageURLs)];
    result.videoURLs = [...new Set(result.videoURLs)];
    result.fontURLs = [...new Set(result.fontURLs)];

    return result;
  }, DOMAIN);

  // Save metadata
  fs.writeFileSync(`${OUT}/data/capture.json`, JSON.stringify(capture, null, 2));
  console.log(`  Framework: ${capture.framework}`);
  console.log(`  CSS: ${capture.computedCSS.length} chars`);
  console.log(`  Images: ${capture.imageURLs.length}`);
  console.log(`  BG images: ${capture.bgImageURLs.length}`);
  console.log(`  Videos: ${capture.videoURLs.length}`);
  console.log(`  Fonts: ${capture.fontURLs.length}`);
  console.log(`  Inline styles: ${capture.inlineStyles.length} blocks`);

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4: Capture rendered DOM with INLINE STYLES on every element
  // This handles CSS-in-JS (Emotion, styled-components, etc.)
  // ══════════════════════════════════════════════════════════════════
  console.log('\nPhase 4: Capturing DOM with inline computed styles...');

  const fullHTML = await page.evaluate(() => {
    // For CSS-in-JS sites: bake computed styles into inline style attributes
    // This ensures the clone looks right even without the original JS
    const important = ['display', 'position', 'top', 'right', 'bottom', 'left',
      'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
      'margin', 'padding', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink',
      'align-items', 'justify-content', 'gap', 'grid-template-columns', 'grid-template-rows',
      'grid-column', 'grid-row', 'background-color', 'background-image', 'background-size',
      'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
      'text-transform', 'text-align', 'text-decoration', 'white-space',
      'border', 'border-radius', 'box-shadow', 'opacity', 'overflow', 'z-index',
      'transform', 'transition', 'aspect-ratio', 'object-fit', 'cursor', 'pointer-events',
      'visibility', 'clip-path', 'filter', 'backdrop-filter',
    ];

    // Check if site uses CSS-in-JS (styles in <style> tags with generated class names)
    const hasCSSinJS = document.querySelector('style[data-emotion], style[data-styled], style[data-jss]') !== null;
    // Also check: lots of inline styles or classes like css-xxx, sc-xxx
    const hasGeneratedClasses = document.querySelector('[class*="css-"], [class*="sc-"], [class*="emotion-"]') !== null;
    const needsInlineStyles = hasCSSinJS || hasGeneratedClasses;

    if (needsInlineStyles) {
      // Bake computed styles inline for CSS-in-JS sites
      document.querySelectorAll('*').forEach(el => {
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'HEAD', 'HTML', 'BODY'].includes(el.tagName)) return;
        const cs = getComputedStyle(el);
        const existingStyle = el.getAttribute('style') || '';
        const newStyles = [];

        important.forEach(prop => {
          const val = cs.getPropertyValue(prop);
          const camel = prop.replace(/-([a-z])/g, (_, l) => l.toUpperCase());
          // Skip defaults
          if (prop === 'display' && val === 'block' && el.tagName === 'DIV') return;
          if (prop === 'position' && val === 'static') return;
          if (prop === 'opacity' && val === '1') return;
          if (prop === 'visibility' && val === 'visible') return;
          if (prop === 'overflow' && val === 'visible') return;
          if (prop === 'transform' && val === 'none') return;
          if (prop === 'background-color' && val === 'rgba(0, 0, 0, 0)') return;
          if (prop === 'background-image' && val === 'none') return;
          if (val && !existingStyle.includes(prop)) {
            newStyles.push(`${prop}:${val}`);
          }
        });

        if (newStyles.length > 0) {
          el.setAttribute('style', (existingStyle ? existingStyle + ';' : '') + newStyles.join(';'));
        }
      });
    }

    return document.documentElement.outerHTML;
  });

  console.log(`  DOM: ${fullHTML.length} chars (inline styles: ${fullHTML.includes('css-') ? 'baked' : 'not needed'})`);

  // ══════════════════════════════════════
  // PHASE 5: Capture canvases as images
  // ══════════════════════════════════════
  console.log('\nPhase 5: Canvas capture...');
  const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
  for (let i = 0; i < canvasCount; i++) {
    try {
      const canvas = (await page.$$('canvas'))[i];
      const dataURL = await canvas.evaluate(c => { try { return c.toDataURL('image/png'); } catch(e) { return null; } });
      if (dataURL) {
        fs.writeFileSync(`${OUT}/images/canvas-${i}.png`, Buffer.from(dataURL.split(',')[1], 'base64'));
        console.log(`  Canvas ${i} → PNG`);
      } else {
        await canvas.screenshot({ path: `${OUT}/images/canvas-${i}.png` });
        console.log(`  Canvas ${i} → screenshot`);
      }
    } catch(e) {}
  }

  // ══════════════════════════════════════
  // PHASE 6: Download ALL assets
  // ══════════════════════════════════════
  console.log('\nPhase 6: Downloading assets...');

  // Download images
  let imgCount = 0;
  const imageMap = {}; // original URL → local path
  for (const url of [...capture.imageURLs, ...capture.bgImageURLs]) {
    try {
      const parsed = new URL(url, DOMAIN);
      const ext = path.extname(parsed.pathname).split('?')[0] || '.jpg';
      const filename = `img-${imgCount}${ext}`;
      const ok = await dl(parsed.href, `${OUT}/images/${filename}`);
      if (ok) {
        imageMap[url] = `/images/${filename}`;
        imageMap[parsed.href] = `/images/${filename}`;
        // Also map without query params
        imageMap[parsed.origin + parsed.pathname] = `/images/${filename}`;
        imgCount++;
      }
    } catch(e) {}
  }
  console.log(`  Images: ${imgCount} downloaded`);

  // Download fonts
  let fontCount = 0;
  const fontMap = {};
  for (const url of capture.fontURLs) {
    try {
      const parsed = new URL(url, DOMAIN);
      const ext = path.extname(parsed.pathname).split('?')[0] || '.woff2';
      const filename = `font-${fontCount}${ext}`;
      const ok = await dl(parsed.href, `${OUT}/fonts/${filename}`);
      if (ok) {
        fontMap[url] = `/fonts/${filename}`;
        fontMap[parsed.href] = `/fonts/${filename}`;
        fontMap[parsed.origin + parsed.pathname] = `/fonts/${filename}`;
        fontCount++;
      }
    } catch(e) {}
  }
  console.log(`  Fonts: ${fontCount} downloaded`);

  // Download videos
  let vidCount = 0;
  const videoMap = {};
  for (const url of capture.videoURLs) {
    try {
      const parsed = new URL(url, DOMAIN);
      const ext = path.extname(parsed.pathname).split('?')[0] || '.mp4';
      const filename = `video-${vidCount}${ext}`;
      const ok = await dl(parsed.href, `${OUT}/videos/${filename}`);
      if (ok) {
        videoMap[url] = `/videos/${filename}`;
        videoMap[parsed.href] = `/videos/${filename}`;
        vidCount++;
      }
    } catch(e) {}
  }
  console.log(`  Videos: ${vidCount} downloaded`);

  // Download favicon
  await dl(`${DOMAIN}/favicon.ico`, `${OUT}/favicon.ico`);

  // ══════════════════════════════════════
  // PHASE 7: Bundle analysis for animations
  // ══════════════════════════════════════
  console.log('\nPhase 7: Bundle analysis...');

  // Download JS bundles
  const jsBundles = [...allURLs].filter(u => u.endsWith('.js') && (u.includes('chunk') || u.includes('app') || u.includes('page') || u.includes('layout') || u.includes('main') || u.includes('vendor')));
  const bundleAnalysis = { library: '', gsapCalls: [], scrollTriggerConfigs: [], lenisConfig: [], framerMotion: [], eases: [], durations: [], delays: [] };

  for (const url of jsBundles.slice(0, 15)) {
    try {
      const filename = path.basename(new URL(url).pathname);
      const dest = `${OUT}/data/${filename}`;
      await dl(url, dest);
      const code = fs.readFileSync(dest, 'utf-8');

      // GSAP (webpack aliases: v.p8, e.p8, t.p8, r.ZP, etc.)
      for (const m of code.matchAll(/(?:gsap|\.p8|\.ZP|\.Bt)\.\s*(?:to|from|fromTo|set)\s*\([^)]{0,2000}\)/g)) {
        bundleAnalysis.gsapCalls.push({ file: filename, code: m[0].substring(0, 500) });
      }
      // Framer Motion
      for (const m of code.matchAll(/(?:motion\.\w+|whileInView|AnimatePresence|useAnimation|initial:\s*\{[^}]+\})/g)) {
        bundleAnalysis.framerMotion.push({ file: filename, code: m[0].substring(0, 300) });
      }
      // ScrollTrigger
      for (const m of code.matchAll(/scrollTrigger\s*:\s*\{[^}]{0,1000}\}|ScrollTrigger\.create\s*\([^)]{0,1000}\)/g)) {
        bundleAnalysis.scrollTriggerConfigs.push({ file: filename, code: m[0].substring(0, 500) });
      }
      // Lenis / smooth scroll
      for (const m of code.matchAll(/new\s+\w+\s*\(\s*\{[^}]*duration[^}]*easing[^}]*\}|new\s+Lenis\s*\(/g)) {
        bundleAnalysis.lenisConfig.push({ file: filename, code: m[0].substring(0, 500) });
      }
      // Locomotive
      if (/locomotive/i.test(code)) bundleAnalysis.library += 'locomotive,';
      // Anime.js
      if (/anime\s*\(\s*\{/.test(code)) bundleAnalysis.library += 'anime,';

      // Values
      for (const m of code.matchAll(/ease\s*:\s*["'][^"']+["']/g)) bundleAnalysis.eases.push(m[0]);
      for (const m of code.matchAll(/duration\s*:\s*[\d.]+/g)) bundleAnalysis.durations.push(m[0]);
      for (const m of code.matchAll(/delay\s*:\s*[\d.]+/g)) bundleAnalysis.delays.push(m[0]);

      // Clean up — don't keep the full bundle in output
      fs.unlinkSync(dest);
    } catch(e) {}
  }

  // Detect libraries
  if (bundleAnalysis.gsapCalls.length > 0) bundleAnalysis.library += 'gsap,';
  if (bundleAnalysis.framerMotion.length > 0) bundleAnalysis.library += 'framer-motion,';
  if (bundleAnalysis.scrollTriggerConfigs.length > 0) bundleAnalysis.library += 'scrolltrigger,';
  if (bundleAnalysis.lenisConfig.length > 0) bundleAnalysis.library += 'lenis,';
  bundleAnalysis.library = [...new Set(bundleAnalysis.library.split(','))].filter(Boolean).join(',');
  bundleAnalysis.eases = [...new Set(bundleAnalysis.eases)];
  bundleAnalysis.durations = [...new Set(bundleAnalysis.durations)];
  bundleAnalysis.delays = [...new Set(bundleAnalysis.delays)];

  // Also check intercepted data
  const intercepted = await page.evaluate(() => window.__xray);

  console.log(`  Libraries: ${bundleAnalysis.library || intercepted?.library || 'css-only'}`);
  console.log(`  GSAP calls: ${bundleAnalysis.gsapCalls.length}`);
  console.log(`  Framer Motion: ${bundleAnalysis.framerMotion.length}`);
  console.log(`  Eases: ${bundleAnalysis.eases.slice(0, 5).join(', ')}`);

  fs.writeFileSync(`${OUT}/data/bundle-analysis.json`, JSON.stringify(bundleAnalysis, null, 2));
  fs.writeFileSync(`${OUT}/data/intercepted.json`, JSON.stringify(intercepted, null, 2));

  // ══════════════════════════════════════
  // PHASE 8: Assemble the clone
  // ══════════════════════════════════════
  console.log('\nPhase 8: Assembling clone...');

  // Process the HTML
  let html = fullHTML;

  // Remove scripts (they won't work statically)
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');

  // Remove hidden RSC/hydration divs
  html = html.replace(/<div hidden="">[\s\S]*?<\/div>/, '');

  // Rewrite ALL asset URLs to local paths
  for (const [orig, local] of Object.entries(imageMap)) {
    // Escape special regex chars in URL
    const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped, 'g'), local);
  }
  for (const [orig, local] of Object.entries(fontMap)) {
    const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped, 'g'), local);
  }
  for (const [orig, local] of Object.entries(videoMap)) {
    const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped, 'g'), local);
  }

  // Replace canvas elements with captured PNGs
  let ci = 0;
  html = html.replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/g, () => {
    const png = `/images/canvas-${ci}.png`;
    ci++;
    if (fs.existsSync(`${OUT}${png}`)) {
      return `<img src="${png}" style="width:100%;height:auto" />`;
    }
    return '<!-- canvas removed -->';
  });

  // If videos exist and canvas was replaced, offer video as alternative
  if (vidCount > 0 && ci > 0) {
    // Replace first canvas-img with video if available
    const firstVideo = Object.values(videoMap)[0];
    if (firstVideo) {
      html = html.replace(
        /<img src="\/images\/canvas-0\.png"[^>]*\/>/,
        `<video autoplay muted playsinline loop style="width:100%;height:auto" src="${firstVideo}"></video>`
      );
    }
  }

  // Fix: remove lock-scroll and other JS-dependent blocking classes
  html = html.replace(/\block-scroll\b/g, '');
  html = html.replace(/\blenis-stopped\b/g, '');

  // Determine CDN scripts
  const lib = bundleAnalysis.library || intercepted?.library || '';
  const cdnScripts = [];
  if (lib.includes('gsap')) cdnScripts.push('<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>');
  if (lib.includes('scrolltrigger')) cdnScripts.push('<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>');
  if (lib.includes('lenis')) cdnScripts.push('<script src="https://unpkg.com/lenis@1.1.18/dist/lenis.min.js"></script>');
  if (lib.includes('locomotive')) cdnScripts.push('<script src="https://cdn.jsdelivr.net/npm/locomotive-scroll@4.1.4/dist/locomotive-scroll.min.js"></script>');

  // Build visibility/scroll fix CSS
  const fixCSS = `
<style>
/* X-Ray v3 — fixes for static serving */
html, body { overflow-y: auto !important; overflow-x: hidden !important; scroll-behavior: smooth; }
html { scrollbar-width: none; }
html::-webkit-scrollbar { display: none; }
/* Emoji rendering */
body { font-feature-settings: normal; text-rendering: optimizeLegibility; }
</style>`;

  // Inject fixes before </head>
  html = html.replace('</head>', fixCSS + '\n</head>');

  // Inject CDN scripts + animation data before </body>
  const animComment = `
<!-- Animation data from bundle analysis:
  Libraries: ${lib || 'css-only'}
  Eases: ${bundleAnalysis.eases.join(', ')}
  Durations: ${bundleAnalysis.durations.join(', ')}
  GSAP calls: ${bundleAnalysis.gsapCalls.length}
  ScrollTrigger configs: ${bundleAnalysis.scrollTriggerConfigs.length}
  Framer Motion patterns: ${bundleAnalysis.framerMotion.length}
-->`;
  const scriptBlock = `${animComment}\n${cdnScripts.join('\n')}\n<script>
// Interactive elements
document.querySelectorAll('button, a, [role="button"], [class*="element"]').forEach(el => {
  el.style.pointerEvents = 'auto';
  el.style.cursor = el.tagName === 'A' || el.tagName === 'BUTTON' ? 'pointer' : el.style.cursor;
});
</script>`;

  html = html.replace('</body>', scriptBlock + '\n</body>');

  // Write final HTML
  fs.writeFileSync(`${OUT}/index.html`, html);
  console.log(`  HTML: ${html.length} chars`);

  // Full page screenshot for reference
  await page.screenshot({ path: `${OUT}/reference.png`, fullPage: true });

  // ══════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════
  const totalFiles = fs.readdirSync(OUT, { recursive: true }).length;
  console.log('\n═══════════════════════════════════════');
  console.log('Site X-Ray v3 Complete');
  console.log('═══════════════════════════════════════');
  console.log(`Framework: ${capture.framework}`);
  console.log(`Animation: ${lib || 'css-only'}`);
  console.log(`HTML: ${html.length} chars`);
  console.log(`CSS: ${capture.computedCSS.length} chars`);
  console.log(`Images: ${imgCount} | Fonts: ${fontCount} | Videos: ${vidCount}`);
  console.log(`Total files: ${totalFiles}`);
  console.log(`\nServe: cd ${OUT} && python3 -m http.server 3035`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
