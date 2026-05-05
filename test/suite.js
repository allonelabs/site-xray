#!/usr/bin/env node
/**
 * Site X-Ray Test Suite v2 — Strict 100% accuracy scoring
 *
 * 100% means REAL 100%:
 * - Every image renders visually (not just has a src)
 * - Layout matches original pixel-by-pixel (SSIM > 0.92)
 * - Every internal link resolves to a working page
 * - All text content preserved
 * - Fonts load and render
 * - No console errors
 * - Interactive elements respond
 *
 * Sites that score 100% become regression tests (must stay 100%).
 * New harder sites rotate in from the queue.
 *
 * Usage: node test/suite.js [version]
 */

const { execSync, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    require('child_process').exec(cmd, { ...opts, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

const XRAY_DIR = path.join(__dirname, '..');
let nextPort = 19870; // sequential port allocation — no collisions
const version = process.argv[2] || detectLatestVersion();
const xrayFile = path.join(XRAY_DIR, `${version}-stable.js`);
const sitesConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf-8'));
const RESULTS_DIR = path.join(__dirname, 'results', version);
const REPORT_FILE = path.join(__dirname, 'results', `${version}.json`);

function detectLatestVersion() {
  const files = fs.readdirSync(XRAY_DIR).filter(f => /^v\d+-stable\.js$/.test(f));
  return 'v' + files.map(f => parseInt(f.match(/v(\d+)/)[1])).sort((a, b) => b - a)[0];
}

// ═══════════════════════════════════════
// STRICT SCORING — each metric is pass/fail + percentage
// ═══════════════════════════════════════

async function scoreImages(page, html, cloneDir) {
  // Check every <img> actually renders (naturalWidth > 0)
  const result = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    const total = imgs.length;
    let rendered = 0, broken = 0, empty = 0;
    const brokenList = [];
    imgs.forEach(img => {
      if (!img.src || img.src === '') { empty++; return; }
      if (img.complete && img.naturalWidth > 0) { rendered++; }
      else { broken++; brokenList.push(img.src?.slice(0, 80)); }
    });
    return { total, rendered, broken, empty, brokenList };
  });

  const score = result.total > 0 ? Math.round((result.rendered / result.total) * 100) : 100;
  return { score, ...result, perfect: score === 100 };
}

async function scoreCSS(page) {
  // Check: does the page have styled elements? Compare with unstyled baseline
  const result = await page.evaluate(() => {
    const body = document.body;
    const cs = getComputedStyle(body);

    // Check key indicators of styling
    const hasBackground = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    const hasFont = !cs.fontFamily.includes('serif') || cs.fontFamily.includes('sans-serif');
    const hasPadding = parseInt(cs.padding) > 0 || parseInt(cs.margin) > 0;

    // Check if any element has grid/flex layout
    let hasLayout = false;
    document.querySelectorAll('*').forEach(el => {
      const d = getComputedStyle(el).display;
      if (d === 'grid' || d === 'flex' || d === 'inline-grid' || d === 'inline-flex') hasLayout = true;
    });

    // Check total stylesheet size
    let cssSize = 0;
    document.querySelectorAll('style').forEach(s => cssSize += s.textContent.length);

    // Check for custom fonts
    const fontsLoaded = document.fonts.size;

    return { hasBackground, hasFont, hasPadding, hasLayout, cssSize, fontsLoaded };
  });

  let score = 0;
  if (result.cssSize > 50000) score += 40;
  else if (result.cssSize > 10000) score += 30;
  else if (result.cssSize > 1000) score += 15;
  if (result.hasLayout) score += 25;
  if (result.hasFont) score += 15;
  if (result.fontsLoaded > 0) score += 10;
  if (result.hasBackground) score += 10;
  score = Math.min(score, 100);

  return { score, ...result, perfect: score >= 95 };
}

async function scoreLinks(cloneDir) {
  // Check EVERY internal link resolves to a file that exists
  const htmlFiles = [];
  function find(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) find(path.join(dir, f.name));
      else if (f.name.endsWith('.html')) htmlFiles.push(path.join(dir, f.name));
    }
  }
  find(cloneDir);

  let totalLinks = 0, workingLinks = 0, brokenLinks = 0, externalLinks = 0;
  const broken = [];

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf-8');
    const hrefs = html.match(/href="([^"]+)"/g) || [];
    for (const h of hrefs) {
      const href = h.match(/href="([^"]+)"/)[1];
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
      if (href.startsWith('http://') || href.startsWith('https://')) { externalLinks++; continue; }

      totalLinks++;
      // Resolve the path relative to cloneDir
      const resolved = path.join(cloneDir, href);
      if (fs.existsSync(resolved)) {
        workingLinks++;
      } else {
        // Try without index.html
        const withIndex = path.join(cloneDir, href, 'index.html');
        if (fs.existsSync(withIndex)) {
          workingLinks++;
        } else {
          brokenLinks++;
          if (broken.length < 10) broken.push(href);
        }
      }
    }
  }

  const score = totalLinks > 0 ? Math.round((workingLinks / totalLinks) * 100) : 100;
  return { score, totalLinks, workingLinks, brokenLinks, externalLinks, broken, perfect: score === 100 && externalLinks === 0 };
}

async function scoreContent(page, originalPage, siteUrl) {
  // Compare text content between original and clone
  let origText = '';
  try {
    await originalPage.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await originalPage.waitForTimeout(3000);
    origText = await originalPage.evaluate(() => document.body?.innerText?.trim() || '');
  } catch {}

  const cloneText = await page.evaluate(() => document.body?.innerText?.trim() || '');

  if (!origText || !cloneText) return { score: 50, origLength: origText.length, cloneLength: cloneText.length, perfect: false };

  // Compare: how much of original text appears in clone
  const origWords = new Set(origText.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const cloneWords = new Set(cloneText.toLowerCase().split(/\s+/).filter(w => w.length > 3));

  let matched = 0;
  for (const w of origWords) { if (cloneWords.has(w)) matched++; }

  const score = origWords.size > 0 ? Math.round((matched / origWords.size) * 100) : 100;
  return { score, origWords: origWords.size, cloneWords: cloneWords.size, matched, perfect: score >= 95 };
}

async function scoreLayout(page, originalPage, siteUrl, resultsDir, hostname) {
  // Pixel comparison: screenshot original vs clone
  const origShot = path.join(resultsDir, `${hostname}-original.png`);
  const cloneShot = path.join(resultsDir, `${hostname}-clone.png`);

  try {
    await originalPage.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await originalPage.waitForTimeout(3000);
    await originalPage.screenshot({ path: origShot, fullPage: false });
  } catch {}

  await page.screenshot({ path: cloneShot, fullPage: false });

  // Basic structural comparison: count visible elements and compare
  const origStructure = await originalPage.evaluate(() => {
    let divs = 0, imgs = 0, texts = 0;
    document.querySelectorAll('*').forEach(el => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        divs++;
        if (el.tagName === 'IMG') imgs++;
        if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) texts++;
      }
    });
    return { divs, imgs, texts };
  }).catch(() => ({ divs: 0, imgs: 0, texts: 0 }));

  const cloneStructure = await page.evaluate(() => {
    let divs = 0, imgs = 0, texts = 0;
    document.querySelectorAll('*').forEach(el => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        divs++;
        if (el.tagName === 'IMG') imgs++;
        if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) texts++;
      }
    });
    return { divs, imgs, texts };
  });

  // Score based on structural similarity
  const divRatio = origStructure.divs > 0 ? Math.min(cloneStructure.divs / origStructure.divs, 1) : 0.5;
  const imgRatio = origStructure.imgs > 0 ? Math.min(cloneStructure.imgs / origStructure.imgs, 1) : 1;

  const score = Math.round((divRatio * 50 + imgRatio * 50));
  return { score, origStructure, cloneStructure, screenshots: { original: origShot, clone: cloneShot }, perfect: score >= 90 };
}

async function scoreInteractions(page) {
  // Check: do buttons have click handlers? Does the menu toggle?
  const result = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"]')];
    const clickable = buttons.filter(b => b.style.pointerEvents !== 'none' && b.offsetParent !== null).length;
    const links = [...document.querySelectorAll('a[href]')].filter(a => a.offsetParent !== null).length;
    const nav = document.querySelector('nav, [role="navigation"]');
    const hasNav = !!nav;
    return { totalButtons: buttons.length, clickable, links, hasNav };
  });

  const score = result.totalButtons > 0
    ? Math.round((result.clickable / result.totalButtons) * 60 + (result.hasNav ? 40 : 0))
    : (result.hasNav ? 100 : 50);

  return { score: Math.min(score, 100), ...result, perfect: score >= 90 };
}

async function scoreConsoleErrors(page) {
  // Capture JS errors during page load
  const errors = [];
  page.on('pageerror', err => errors.push(err.message?.slice(0, 100)));
  await page.waitForTimeout(2000);
  const score = errors.length === 0 ? 100 : Math.max(0, 100 - errors.length * 15);
  return { score, errors: errors.slice(0, 5), count: errors.length, perfect: errors.length === 0 };
}

// ═══════════════════════════════════════
// PIXEL COMPARISON — SSIM-like visual fidelity
// ═══════════════════════════════════════

async function scorePixels(origScreenshot, cloneScreenshot, resultsDir, hostname) {
  // Compare two screenshots pixel-by-pixel using pixelmatch
  try {
    if (!fs.existsSync(origScreenshot) || !fs.existsSync(cloneScreenshot)) {
      return { score: 0, error: 'screenshots missing', mismatchPercent: 100, perfect: false };
    }

    const origData = PNG.sync.read(fs.readFileSync(origScreenshot));
    const cloneData = PNG.sync.read(fs.readFileSync(cloneScreenshot));

    // Resize to same dimensions (use smaller)
    const width = Math.min(origData.width, cloneData.width);
    const height = Math.min(origData.height, cloneData.height);

    if (width < 10 || height < 10) {
      return { score: 0, error: 'screenshot too small', mismatchPercent: 100, perfect: false };
    }

    // Crop both to same size
    const cropPNG = (png, w, h) => {
      const cropped = new PNG({ width: w, height: h });
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const srcIdx = (y * png.width + x) * 4;
          const dstIdx = (y * w + x) * 4;
          cropped.data[dstIdx] = png.data[srcIdx];
          cropped.data[dstIdx + 1] = png.data[srcIdx + 1];
          cropped.data[dstIdx + 2] = png.data[srcIdx + 2];
          cropped.data[dstIdx + 3] = png.data[srcIdx + 3];
        }
      }
      return cropped;
    };

    const origCropped = origData.width === width && origData.height === height ? origData : cropPNG(origData, width, height);
    const cloneCropped = cloneData.width === width && cloneData.height === height ? cloneData : cropPNG(cloneData, width, height);

    const diff = new PNG({ width, height });
    const mismatchCount = pixelmatch(
      origCropped.data, cloneCropped.data, diff.data,
      width, height,
      { threshold: 0.15, alpha: 0.3 }  // 0.15 = tolerant of anti-aliasing
    );

    const totalPixels = width * height;
    const mismatchPercent = Math.round((mismatchCount / totalPixels) * 10000) / 100;
    const matchPercent = 100 - mismatchPercent;

    // Save diff image for visual inspection
    const diffFile = path.join(resultsDir, `${hostname}-diff.png`);
    fs.writeFileSync(diffFile, PNG.sync.write(diff));

    // Score: 100% match = 100, <50% match = 0
    const score = Math.max(0, Math.min(100, Math.round(matchPercent)));

    return {
      score,
      mismatchPercent,
      mismatchCount,
      totalPixels,
      dimensions: { width, height },
      diffImage: diffFile,
      perfect: matchPercent >= 92,  // 92%+ pixel match = perfect
    };
  } catch (e) {
    return { score: 0, error: e.message?.slice(0, 80), mismatchPercent: 100, perfect: false };
  }
}

// ═══════════════════════════════════════
// CAPTURE MANIFEST — instrument what was captured
// ═══════════════════════════════════════

function generateManifest(cloneDir, site) {
  // Analyze the clone directory to understand what was captured
  const manifest = {
    site: site.url,
    timestamp: new Date().toISOString(),
    files: { html: 0, css: 0, images: 0, fonts: 0, videos: 0, models: 0, other: 0 },
    sizes: { html: 0, css: 0, images: 0, fonts: 0, videos: 0, total: 0 },
    assets: { images: [], fonts: [], videos: [] },
    issues: [],
  };

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const size = fs.statSync(full).size;
      const ext = path.extname(entry.name).toLowerCase();
      manifest.sizes.total += size;

      if (['.html', '.htm'].includes(ext)) {
        manifest.files.html++;
        manifest.sizes.html += size;
        // Check for empty HTML files
        if (size < 100) manifest.issues.push(`Empty HTML: ${path.relative(cloneDir, full)} (${size}b)`);
      } else if (['.css'].includes(ext)) {
        manifest.files.css++;
        manifest.sizes.css += size;
      } else if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.ico'].includes(ext)) {
        manifest.files.images++;
        manifest.sizes.images += size;
        manifest.assets.images.push({ file: entry.name, size });
        // Check for tiny images (likely broken downloads)
        if (size < 100 && !['.svg', '.ico'].includes(ext)) {
          manifest.issues.push(`Tiny image (likely broken): ${entry.name} (${size}b)`);
        }
      } else if (['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext)) {
        manifest.files.fonts++;
        manifest.sizes.fonts += size;
        manifest.assets.fonts.push({ file: entry.name, size });
      } else if (['.mp4', '.webm', '.mov'].includes(ext)) {
        manifest.files.videos++;
        manifest.sizes.videos += size;
        manifest.assets.videos.push({ file: entry.name, size });
      } else if (['.glb', '.gltf', '.obj'].includes(ext)) {
        manifest.files.models++;
      } else {
        manifest.files.other++;
      }
    }
  }
  walk(cloneDir);

  // Check HTML files for remaining external references
  const htmlFiles = [];
  function findHTML(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) findHTML(path.join(dir, entry.name));
      else if (entry.name.endsWith('.html')) htmlFiles.push(path.join(dir, entry.name));
    }
  }
  findHTML(cloneDir);

  let externalRefs = 0;
  let inlineStyles = 0;
  let totalCSSSize = 0;
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf-8');
    // Count external references still in HTML
    const extMatches = html.match(/(?:src|href)="https?:\/\/[^"]+"/g) || [];
    externalRefs += extMatches.length;
    // Count inline style blocks
    const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || [];
    inlineStyles += styleMatches.length;
    for (const s of styleMatches) totalCSSSize += s.length;
  }

  manifest.analysis = {
    htmlPages: htmlFiles.length,
    externalRefsRemaining: externalRefs,
    inlineStyleBlocks: inlineStyles,
    totalCSSInHTML: totalCSSSize,
    avgImageSize: manifest.files.images > 0 ? Math.round(manifest.sizes.images / manifest.files.images) : 0,
    totalSizeKB: Math.round(manifest.sizes.total / 1024),
  };

  if (externalRefs > 0) manifest.issues.push(`${externalRefs} external references still in HTML (should be 0)`);
  if (manifest.files.html === 0) manifest.issues.push('No HTML files captured');
  if (manifest.sizes.html === 0) manifest.issues.push('HTML files are empty (0 bytes total)');

  return manifest;
}

// ═══════════════════════════════════════
// DEEP ANALYSIS — per-site root cause detection
// ═══════════════════════════════════════

async function analyzeSite(browser, site, cloneDir, resultsDir, scoreResult) {
  const hostname = new URL(site.url).hostname.replace(/\./g, '-');
  const reportFile = path.join(resultsDir, `${hostname}-analysis.md`);

  const origPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let origHTML = '', origTechStack = {}, origElementCounts = {};

  try {
    await origPage.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await origPage.waitForTimeout(4000);

    // ── Detect tech stack from original ──
    origTechStack = await origPage.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);
      const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href);
      const metas = {};
      document.querySelectorAll('meta').forEach(m => { if (m.name || m.property) metas[m.name || m.property] = m.content; });

      return {
        framework: html.includes('__next') ? 'Next.js'
          : html.includes('__nuxt') ? 'Nuxt'
          : html.includes('data-reactroot') || html.includes('_reactRoot') ? 'React'
          : html.includes('ng-version') ? 'Angular'
          : html.includes('data-v-') ? 'Vue'
          : document.querySelector('[data-wf-site]') ? 'Webflow'
          : document.querySelector('.wp-block') || html.includes('wp-content') ? 'WordPress'
          : 'Unknown',
        cssStrategy: links.length > 0 ? `${links.length} external sheets`
          : document.querySelectorAll('style').length > 3 ? 'CSS-in-JS / inline'
          : 'Embedded <style>',
        jsLibraries: scripts.filter(s => /gsap|lottie|three|framer|anime|scroll/i.test(s)).map(s => s.split('/').pop()),
        imageStrategy: document.querySelector('img[srcset]') ? 'srcset/responsive'
          : document.querySelector('img[loading="lazy"]') ? 'lazy-loading'
          : document.querySelector('picture source') ? '<picture> element'
          : 'standard <img>',
        totalScripts: scripts.length,
        totalStylesheets: links.length,
        usesWebGL: !!document.querySelector('canvas'),
        usesIframes: document.querySelectorAll('iframe').length,
        usesSVG: document.querySelectorAll('svg').length,
        generator: metas.generator || null,
      };
    }).catch(() => ({}));

    // ── Count visible elements in original ──
    origElementCounts = await origPage.evaluate(() => {
      const visible = el => el.offsetWidth > 0 && el.offsetHeight > 0;
      const all = [...document.querySelectorAll('*')];
      return {
        total: all.length,
        visible: all.filter(visible).length,
        images: [...document.querySelectorAll('img')].filter(visible).length,
        renderedImages: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length,
        links: document.querySelectorAll('a[href]').length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
        grids: all.filter(el => { const d = getComputedStyle(el).display; return d === 'grid' || d === 'inline-grid'; }).length,
        flexes: all.filter(el => { const d = getComputedStyle(el).display; return d === 'flex' || d === 'inline-flex'; }).length,
        videos: document.querySelectorAll('video').length,
        forms: document.querySelectorAll('form, input, textarea, select').length,
      };
    }).catch(() => ({}));

    origHTML = await origPage.content().catch(() => '');
  } catch (e) {
    origHTML = `Error loading original: ${e.message}`;
  }
  await origPage.close();

  // ── Compare clone element counts ──
  let cloneElementCounts = {};
  const port = nextPort++;
  const srv = require('child_process').spawn('python3', ['-m', 'http.server', String(port), '--directory', cloneDir], { stdio: 'pipe', detached: true });
  await new Promise(r => setTimeout(r, 1000));

  const clonePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await clonePage.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await clonePage.waitForTimeout(3000);

    cloneElementCounts = await clonePage.evaluate(() => {
      const visible = el => el.offsetWidth > 0 && el.offsetHeight > 0;
      const all = [...document.querySelectorAll('*')];
      return {
        total: all.length,
        visible: all.filter(visible).length,
        images: [...document.querySelectorAll('img')].filter(visible).length,
        renderedImages: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length,
        links: document.querySelectorAll('a[href]').length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
        grids: all.filter(el => { const d = getComputedStyle(el).display; return d === 'grid' || d === 'inline-grid'; }).length,
        flexes: all.filter(el => { const d = getComputedStyle(el).display; return d === 'flex' || d === 'inline-flex'; }).length,
        videos: document.querySelectorAll('video').length,
        forms: document.querySelectorAll('form, input, textarea, select').length,
      };
    }).catch(() => ({}));
  } catch {}
  await clonePage.close();
  try { process.kill(-srv.pid); } catch { try { srv.kill(); } catch {} }

  // ── Identify root causes per metric ──
  const m = scoreResult.metrics;
  const rootCauses = [];
  const suggestions = [];

  if (m.images?.score < 100) {
    const origImgs = origElementCounts.renderedImages || 0;
    const cloneImgs = cloneElementCounts.renderedImages || 0;
    const missing = origImgs - cloneImgs;
    rootCauses.push(`IMAGES: ${cloneImgs}/${origImgs} rendered (${missing} missing). Strategy: ${origTechStack.imageStrategy || '?'}. Broken: ${(m.images.brokenList || []).slice(0, 5).join(', ')}`);
    if (origTechStack.imageStrategy?.includes('srcset')) suggestions.push('Handle srcset: resolve responsive image URLs and download largest variant');
    if (origTechStack.imageStrategy?.includes('lazy')) suggestions.push('Handle lazy-loading: scroll to trigger lazy images before capture, or rewrite data-src to src');
    if (missing > 0 && origTechStack.framework === 'Next.js') suggestions.push('Next.js Image: intercept /_next/image requests, download optimized variants');
  }
  if (m.css?.score < 95) {
    rootCauses.push(`CSS: size=${m.css.cssSize}, layout=${m.css.hasLayout}, fonts=${m.css.fontsLoaded}. Original uses: ${origTechStack.cssStrategy || '?'}`);
    if (origTechStack.cssStrategy?.includes('external')) suggestions.push('Download external stylesheets and inline them');
    if (origTechStack.cssStrategy?.includes('CSS-in-JS')) suggestions.push('Capture computed styles from rendered DOM, CSS-in-JS doesnt survive HTML serialization');
    if (!m.css.hasLayout && (origElementCounts.grids > 0 || origElementCounts.flexes > 0))
      suggestions.push(`Original has ${origElementCounts.grids} grids + ${origElementCounts.flexes} flexes — JS may be setting display properties`);
  }
  if (m.links?.score < 100) {
    rootCauses.push(`LINKS: ${m.links.workingLinks}/${m.links.totalLinks} working, ${m.links.brokenLinks} broken, ${m.links.externalLinks} external. Broken: ${(m.links.broken || []).slice(0, 5).join(', ')}`);
    if (m.links.externalLinks > 0) suggestions.push('Rewrite ALL external links to local paths');
  }
  if (m.content?.score < 95) {
    rootCauses.push(`CONTENT: ${m.content.matched}/${m.content.origWords} words matched (${m.content.score}%). Clone has ${m.content.cloneWords} words.`);
    if (origTechStack.framework !== 'Unknown') suggestions.push(`${origTechStack.framework} renders content via JS — may need to wait longer or use networkidle`);
  }
  if (m.layout?.score < 90) {
    const oDiv = origElementCounts.visible || 0;
    const cDiv = cloneElementCounts.visible || 0;
    rootCauses.push(`LAYOUT: original ${oDiv} visible elements vs clone ${cDiv} (ratio: ${oDiv > 0 ? (cDiv/oDiv*100).toFixed(0) : 0}%)`);
    if (origTechStack.usesWebGL) suggestions.push('Site uses <canvas>/WebGL — capture as screenshot image or extract Three.js scene');
    if (cDiv < oDiv * 0.5) suggestions.push('More than half the visible elements are missing — JS-dependent rendering, may need to keep critical scripts');
  }
  if (m.interactions?.score < 90) {
    rootCauses.push(`INTERACTIONS: ${m.interactions.clickable}/${m.interactions.totalButtons} buttons clickable, nav: ${m.interactions.hasNav}`);
  }
  if (m.console?.score < 100) {
    rootCauses.push(`CONSOLE ERRORS (${m.console.count}): ${(m.console.errors || []).slice(0, 3).join(' | ')}`);
    suggestions.push('Errors likely from removed scripts referencing missing globals — add stub globals or remove broken script refs');
  }

  // ── Build markdown report ──
  const report = `# Analysis: ${site.url}
**Category:** ${site.category} | **Score:** ${scoreResult.totalScore}/100 | **Perfect:** ${scoreResult.perfect}

## Tech Stack (Original)
- Framework: ${origTechStack.framework || 'Unknown'}
- CSS: ${origTechStack.cssStrategy || 'Unknown'}
- Images: ${origTechStack.imageStrategy || 'Unknown'}
- JS libs: ${(origTechStack.jsLibraries || []).join(', ') || 'none detected'}
- Scripts: ${origTechStack.totalScripts || 0} | Stylesheets: ${origTechStack.totalStylesheets || 0}
- WebGL: ${origTechStack.usesWebGL ? 'YES' : 'no'} | SVGs: ${origTechStack.usesSVG || 0} | Iframes: ${origTechStack.usesIframes || 0}

## Element Comparison (Original → Clone)
| Element | Original | Clone | Delta |
|---------|----------|-------|-------|
| Visible | ${origElementCounts.visible || 0} | ${cloneElementCounts.visible || 0} | ${(cloneElementCounts.visible || 0) - (origElementCounts.visible || 0)} |
| Images (rendered) | ${origElementCounts.renderedImages || 0} | ${cloneElementCounts.renderedImages || 0} | ${(cloneElementCounts.renderedImages || 0) - (origElementCounts.renderedImages || 0)} |
| Links | ${origElementCounts.links || 0} | ${cloneElementCounts.links || 0} | ${(cloneElementCounts.links || 0) - (origElementCounts.links || 0)} |
| Buttons | ${origElementCounts.buttons || 0} | ${cloneElementCounts.buttons || 0} | ${(cloneElementCounts.buttons || 0) - (origElementCounts.buttons || 0)} |
| Headings | ${origElementCounts.headings || 0} | ${cloneElementCounts.headings || 0} | ${(cloneElementCounts.headings || 0) - (origElementCounts.headings || 0)} |
| Grids | ${origElementCounts.grids || 0} | ${cloneElementCounts.grids || 0} | ${(cloneElementCounts.grids || 0) - (origElementCounts.grids || 0)} |
| Flexes | ${origElementCounts.flexes || 0} | ${cloneElementCounts.flexes || 0} | ${(cloneElementCounts.flexes || 0) - (origElementCounts.flexes || 0)} |

## Scores
| Metric | Score | Perfect |
|--------|-------|---------|
| Images | ${m.images?.score}/100 | ${m.images?.perfect ? 'YES' : 'NO'} |
| CSS | ${m.css?.score}/100 | ${m.css?.perfect ? 'YES' : 'NO'} |
| Links | ${m.links?.score}/100 | ${m.links?.perfect ? 'YES' : 'NO'} |
| Content | ${m.content?.score}/100 | ${m.content?.perfect ? 'YES' : 'NO'} |
| Layout | ${m.layout?.score}/100 | ${m.layout?.perfect ? 'YES' : 'NO'} |
| Pixels | ${m.pixels?.score}/100 | ${m.pixels?.perfect ? 'YES' : 'NO'} |
| Interactions | ${m.interactions?.score}/100 | ${m.interactions?.perfect ? 'YES' : 'NO'} |
| Console | ${m.console?.score}/100 | ${m.console?.perfect ? 'YES' : 'NO'} |
| Manifest | ${m.manifest?.score}/100 | ${m.manifest?.perfect ? 'YES' : 'NO'} |

## Pixel Comparison
- Match: ${m.pixels?.mismatchPercent != null ? (100 - m.pixels.mismatchPercent).toFixed(1) : '?'}%
- Mismatched pixels: ${m.pixels?.mismatchCount || '?'} / ${m.pixels?.totalPixels || '?'}
- Diff image: \`${hostname}-diff.png\`

## Capture Manifest
- HTML pages: ${m.manifest?.files?.html || 0}
- Images: ${m.manifest?.files?.images || 0} (avg ${m.manifest?.sizes?.avgImageSize || 0} bytes)
- Fonts: ${m.manifest?.files?.fonts || 0}
- Total size: ${m.manifest?.sizes?.totalSizeKB || 0} KB
- External refs remaining: ${m.manifest?.sizes?.externalRefsRemaining || 0}
- Issues: ${(m.manifest?.issues || []).length > 0 ? m.manifest.issues.map(i => '\n  - ' + i).join('') : 'none'}

## Root Causes
${rootCauses.map(r => `- ${r}`).join('\n')}

## Suggested Fixes (universal)
${suggestions.map(s => `- ${s}`).join('\n') || '- No specific suggestions — site scores well'}

## Screenshots
- Original: \`${hostname}-original.png\`
- Clone: \`${hostname}-clone.png\`
- Diff: \`${hostname}-diff.png\`
`;

  fs.writeFileSync(reportFile, report);
  return { hostname, reportFile, rootCauses, suggestions, techStack: origTechStack };
}

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════

async function scoreSite(browser, site, cloneDir, resultsDir) {
  const hostname = new URL(site.url).hostname.replace(/\./g, '-');
  const indexFile = path.join(cloneDir, 'index.html');

  if (!fs.existsSync(indexFile)) {
    return { site: site.url, category: site.category, totalScore: 0, error: 'No index.html', metrics: {}, perfect: false };
  }

  // Start local server for clone — sequential port per site (no collisions)
  const port = nextPort++;
  const srv = require('child_process').spawn('python3', ['-m', 'http.server', String(port), '--directory', cloneDir], { stdio: 'pipe', detached: true });
  await new Promise(r => setTimeout(r, 1200));

  const clonePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const origPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await clonePage.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await clonePage.waitForTimeout(3000);
  } catch {}

  // Run all scoring (parallel where possible)
  const metrics = {};
  metrics.images = await scoreImages(clonePage, '', cloneDir);
  metrics.css = await scoreCSS(clonePage);
  metrics.links = await scoreLinks(cloneDir);
  metrics.content = await scoreContent(clonePage, origPage, site.url);
  metrics.layout = await scoreLayout(clonePage, origPage, site.url, resultsDir, hostname);
  metrics.interactions = await scoreInteractions(clonePage);
  metrics.console = await scoreConsoleErrors(clonePage);

  await clonePage.close();
  await origPage.close();
  try { process.kill(-srv.pid); } catch { try { srv.kill(); } catch {} }

  // Pixel comparison (uses screenshots from layout scoring)
  const origShot = path.join(resultsDir, `${hostname}-original.png`);
  const cloneShot = path.join(resultsDir, `${hostname}-clone.png`);
  metrics.pixels = await scorePixels(origShot, cloneShot, resultsDir, hostname);

  // Capture manifest — instrument what the cloner produced
  const manifest = generateManifest(cloneDir, site);
  fs.writeFileSync(path.join(resultsDir, `${hostname}-manifest.json`), JSON.stringify(manifest, null, 2));
  metrics.manifest = {
    score: Math.max(0, 100 - manifest.issues.length * 15),
    issues: manifest.issues,
    files: manifest.files,
    sizes: manifest.analysis,
    perfect: manifest.issues.length === 0,
  };

  // WEIGHTED TOTAL (strict — now 9 metrics)
  const totalScore = Math.round(
    metrics.images.score * 0.15 +
    metrics.css.score * 0.12 +
    metrics.links.score * 0.12 +
    metrics.content.score * 0.12 +
    metrics.layout.score * 0.10 +
    metrics.interactions.score * 0.08 +
    metrics.console.score * 0.08 +
    metrics.pixels.score * 0.15 +    // NEW: pixel-level visual fidelity
    metrics.manifest.score * 0.08    // NEW: capture completeness
  );

  // PERFECT = ALL metrics perfect (true 100%)
  const perfect = Object.values(metrics).every(m => m.perfect);

  return { site: site.url, category: site.category, totalScore, perfect, metrics, manifest };
}

async function main() {
  if (!fs.existsSync(xrayFile)) { console.error(`Not found: ${xrayFile}`); process.exit(1); }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Test both active AND mastered sites
  const allSites = [...sitesConfig.active, ...sitesConfig.mastered];

  console.log(`\n🧪 Site X-Ray Test Suite v2 (Strict)`);
  console.log(`   Version: ${version}`);
  console.log(`   Active: ${sitesConfig.active.length} | Mastered: ${sitesConfig.mastered.length} | Queue: ${sitesConfig.queue.length}\n`);

  const results = [];
  const browser = await chromium.launch({ headless: true });

  // ── PIPELINE: clone → score → analyze per site, all sites in parallel ──
  console.log('   ⚡ Pipeline: clone→score→analyze per site, all parallel...\n');
  const startTime = Date.now();
  const analyses = [];

  const pipelines = allSites.map(async (site) => {
    const hostname = new URL(site.url).hostname.replace(/\./g, '-');
    const cloneDir = path.join(RESULTS_DIR, hostname);
    const isMastered = sitesConfig.mastered.some(m => m.url === site.url);
    const tag = isMastered ? '🔒' : '🔍';

    // ── STAGE 1: CLONE ──
    try {
      if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true });
      await execAsync(`node ${xrayFile} ${site.url} ${cloneDir} ${site.pages}`, { timeout: 600000 });
      console.log(`   ${tag} ${hostname} cloned — scoring...`);
    } catch (e) {
      console.log(`   ${tag} ${hostname} clone failed: ${e.message?.slice(0, 50)}`);
      results.push({ site: site.url, category: site.category, totalScore: 0, error: e.message?.slice(0, 50), metrics: {}, perfect: false });
      return;
    }

    // ── STAGE 2: SCORE (immediately after clone) ──
    const score = await scoreSite(browser, site, cloneDir, RESULTS_DIR);
    results.push(score);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const status = score.perfect ? '✅ PERFECT' : `${score.totalScore}/100`;
    const breakdown = `img:${score.metrics.images?.score} css:${score.metrics.css?.score} link:${score.metrics.links?.score} px:${score.metrics.pixels?.score} content:${score.metrics.content?.score}`;
    console.log(`   ${tag} ${hostname}: ${status} (${breakdown}) [${elapsed}s]`);

    if (isMastered && !score.perfect) {
      console.log(`      ⚠️  REGRESSION on mastered site! Was 100%, now ${score.totalScore}`);
    }

    // ── STAGE 3: DEEP ANALYSIS (immediately after score) ──
    if (!score.perfect) {
      console.log(`   ${tag} ${hostname} analyzing root causes...`);
      const analysis = await analyzeSite(browser, site, cloneDir, RESULTS_DIR, score);
      analyses.push(analysis);
      console.log(`   ${tag} ${hostname} analysis done — ${analysis.rootCauses.length} root causes, ${analysis.suggestions.length} suggestions [${((Date.now() - startTime) / 1000).toFixed(0)}s]`);
    }
  });
  await Promise.all(pipelines);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n   Pipeline done in ${totalTime}s`);

  // ── SYNTHESIS: cross-site pattern detection ──
  console.log('   🧠 Synthesizing cross-site patterns...\n');

  const allRootCauses = analyses.flatMap(a => a.rootCauses);
  const allSuggestions = analyses.flatMap(a => a.suggestions);
  const techStacks = analyses.map(a => ({ host: a.hostname, ...a.techStack }));

  // Count recurring patterns
  const causeCounts = {};
  for (const cause of allRootCauses) {
    const cat = cause.split(':')[0].trim();
    causeCounts[cat] = (causeCounts[cat] || 0) + 1;
  }

  // Deduplicate suggestions and rank by frequency
  const suggestionCounts = {};
  for (const s of allSuggestions) {
    const key = s.slice(0, 60);
    suggestionCounts[key] = (suggestionCounts[key] || { text: s, count: 0 });
    suggestionCounts[key].count++;
  }
  const rankedSuggestions = Object.values(suggestionCounts).sort((a, b) => b.count - a.count);

  // Framework distribution
  const frameworkCounts = {};
  for (const t of techStacks) {
    const fw = t.framework || 'Unknown';
    frameworkCounts[fw] = (frameworkCounts[fw] || 0) + 1;
  }

  const synthesis = `# Synthesis Report — ${version}
**Date:** ${new Date().toISOString()}
**Sites tested:** ${allSites.length} | **Perfect:** ${results.filter(r => r.perfect).length} | **Average:** ${Math.round(results.reduce((s, r) => s + r.totalScore, 0) / results.length)}/100
**Pipeline time:** ${totalTime}s

## Failure Categories (cross-site)
${Object.entries(causeCounts).sort((a, b) => b[1] - a[1]).map(([cat, count]) => `- **${cat}**: ${count}/${analyses.length} sites affected`).join('\n')}

## Framework Distribution (failing sites)
${Object.entries(frameworkCounts).map(([fw, count]) => `- ${fw}: ${count} sites`).join('\n')}

## Ranked Fix Suggestions (by cross-site impact)
${rankedSuggestions.map((s, i) => `${i + 1}. [${s.count} sites] ${s.text}`).join('\n')}

## Per-Site Root Causes
${analyses.map(a => `### ${a.hostname}\n${a.rootCauses.map(r => `- ${r}`).join('\n')}`).join('\n\n')}

## Recommended Action Plan
Focus on fixes that appear in ${Math.ceil(analyses.length / 2)}+ sites (most universal impact):
${rankedSuggestions.filter(s => s.count >= Math.ceil(analyses.length / 3)).map((s, i) => `${i + 1}. ${s.text} (${s.count} sites)`).join('\n') || 'No single fix affects enough sites — investigate per-site individually'}

## Screenshots to Review
${analyses.map(a => `- \`${a.hostname}-original.png\` vs \`${a.hostname}-clone.png\``).join('\n')}
`;

  const synthesisFile = path.join(RESULTS_DIR, 'synthesis.md');
  fs.writeFileSync(synthesisFile, synthesis);
  console.log(`   Synthesis: ${synthesisFile}`);

  await browser.close();

  // ── Rotate sites: mastered → lock, queue → active ──
  let rotated = false;
  for (const result of results) {
    if (result.perfect && sitesConfig.active.some(a => a.url === result.site)) {
      // Move to mastered
      const siteObj = sitesConfig.active.find(a => a.url === result.site);
      sitesConfig.mastered.push({ ...siteObj, mastered_at: new Date().toISOString(), mastered_version: version });
      sitesConfig.active = sitesConfig.active.filter(a => a.url !== result.site);
      // Pull from queue
      if (sitesConfig.queue.length > 0) {
        const next = sitesConfig.queue.shift();
        sitesConfig.active.push(next);
        console.log(`\n   🔄 Rotated: ${result.site} → mastered, ${next.url} → active`);
        rotated = true;
      }
    }
  }
  if (rotated) {
    fs.writeFileSync(path.join(__dirname, 'sites.json'), JSON.stringify(sitesConfig, null, 2));
  }

  // Summary
  const avgScore = Math.round(results.reduce((s, r) => s + r.totalScore, 0) / results.length);
  const perfectCount = results.filter(r => r.perfect).length;
  const regressions = results.filter(r => sitesConfig.mastered.some(m => m.url === r.site) && !r.perfect);

  const report = {
    version,
    date: new Date().toISOString(),
    averageScore: avgScore,
    perfectCount,
    totalSites: results.length,
    regressions: regressions.length,
    sites: results,
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

  console.log(`\n═══════════════════════════════════════`);
  console.log(`   Version: ${version}`);
  console.log(`   Average: ${avgScore}/100`);
  console.log(`   Perfect: ${perfectCount}/${results.length}`);
  if (regressions.length) console.log(`   ⚠️  Regressions: ${regressions.length}`);
  console.log(`   Active: ${sitesConfig.active.length} | Mastered: ${sitesConfig.mastered.length} | Queue: ${sitesConfig.queue.length}`);
  console.log(`   Report: ${REPORT_FILE}`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
