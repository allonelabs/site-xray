#!/usr/bin/env node
/**
 * Site X-Ray v5 — Multi-page website cloner
 *
 * Single file. One dependency (playwright). Zero config.
 * Crawls all internal pages, captures each one, produces a complete static clone.
 *
 * Usage: node xray.js <url> [output-dir] [max-pages]
 *
 * Default max-pages: 20. Set to 1 for single-page only.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const TARGET = process.argv[2];
if (!TARGET) { console.log('Site X-Ray v5\nUsage: node xray.js <url> [output-dir] [max-pages]'); process.exit(0); }

const PARSED = new URL(TARGET);
const DOMAIN = PARSED.origin;
const SLUG = PARSED.hostname.replace(/\./g, '-');
const OUT = process.argv[3] || `/tmp/clone-${SLUG}`;
const MAX_PAGES = parseInt(process.argv[4]) || 20;

// ═══════════════════════════════════════
// Shared state across all pages
// ═══════════════════════════════════════
const urlMap = {};        // asset URL → local path
const networkURLs = new Map();
const crawled = new Set();
const queue = [PARSED.pathname || '/'];
let imgCount = 0, fontCount = 0, vidCount = 0, mediaCount = 0;
let sharedCSS = '';       // Computed CSS (captured once from first page)
let bundleData = null;    // Bundle analysis (captured once)
let cdnScripts = [];      // CDN script tags

// ═══════════════════════════════════════
// Download helper
// ═══════════════════════════════════════
function dl(url, dest, timeout = 20000) {
  return new Promise((resolve) => {
    try {
      if (!url || url.startsWith('data:') || url.startsWith('blob:')) return resolve(false);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          file.close(); try { fs.unlinkSync(dest); } catch(e) {}
          return dl(new URL(res.headers.location, url).href, dest, timeout).then(resolve);
        }
        if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(dest); } catch(e) {} return resolve(false); }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
        file.on('error', () => resolve(false));
      });
      req.on('error', () => { try { file.close(); fs.unlinkSync(dest); } catch(e) {} resolve(false); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch(e) { resolve(false); }
  });
}

function assetName(url, prefix, index, fallbackExt) {
  try {
    let ext = path.extname(new URL(url, DOMAIN).pathname).split('?')[0].split('#')[0];
    if (!ext || ext.length > 6) ext = fallbackExt || '.bin';
    return `${prefix}-${index}${ext}`;
  } catch { return `${prefix}-${index}${fallbackExt || '.bin'}`; }
}

function mapAsset(origUrl, localPath) {
  urlMap[origUrl] = localPath;
  try {
    const abs = new URL(origUrl, DOMAIN).href;
    urlMap[abs] = localPath;
    urlMap[new URL(abs).origin + new URL(abs).pathname] = localPath;
  } catch(e) {}
}

// Convert a URL path to a file path: /about → /about/index.html, / → /index.html
function pathToFile(urlPath) {
  let p = urlPath || '/';
  if (p.endsWith('/')) p += 'index.html';
  else if (!path.extname(p)) p += '/index.html';
  return p;
}

// ═══════════════════════════════════════
// Capture a single page
// ═══════════════════════════════════════
async function capturePage(page, urlPath, isFirst) {
  const fullURL = DOMAIN + urlPath;
  console.log(`\n  📄 ${urlPath}`);

  await page.goto(fullURL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(isFirst ? 5000 : 2000);

  // Scroll to trigger lazy content
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= height; y += 300) {
    await page.evaluate(s => window.scrollTo(0, s), y);
    await page.waitForTimeout(40);
  }
  if (isFirst) {
    // Double scroll on first page
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    for (let y = 0; y <= height; y += 500) {
      await page.evaluate(s => window.scrollTo(0, s), y);
      await page.waitForTimeout(30);
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // ── Discover internal links ──
  const links = await page.evaluate((domain) => {
    const found = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      try {
        const url = new URL(a.href, domain);
        if (url.origin === domain && !url.hash && !url.pathname.match(/\.(jpg|png|pdf|zip|svg|mp4|webp)$/i)) {
          found.add(url.pathname);
        }
      } catch(e) {}
    });
    return [...found];
  }, DOMAIN);

  // Add new links to crawl queue
  for (const link of links) {
    if (!crawled.has(link) && !queue.includes(link) && crawled.size + queue.length < MAX_PAGES) {
      queue.push(link);
    }
  }
  console.log(`     Links found: ${links.length} (queue: ${queue.length}, crawled: ${crawled.size})`);

  // ── First page only: capture CSS, assets, bundles ──
  if (isFirst) {
    // Computed CSS
    sharedCSS = await page.evaluate(() => {
      let css = '';
      for (const sheet of document.styleSheets) {
        try { for (const rule of sheet.cssRules) css += rule.cssText + '\n'; } catch(e) {}
      }
      return css;
    });
    console.log(`     CSS: ${sharedCSS.length} chars`);

    // Collect ALL asset URLs from DOM + network
    const assetData = await page.evaluate((domain) => {
      const imgs = new Set(), fonts = new Set(), vids = new Set(), media = new Set();

      // Images: every possible source
      document.querySelectorAll('img, [data-src], [data-lazy], [data-bg], video[poster], [style*="background"]').forEach(el => {
        for (const attr of ['src', 'data-src', 'data-lazy', 'data-bg', 'poster']) {
          const v = el.getAttribute(attr);
          if (v && !v.startsWith('data:') && !v.startsWith('blob:')) imgs.add(v);
        }
        const ss = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (ss) ss.split(',').forEach(s => { const u = s.trim().split(' ')[0]; if (u) imgs.add(u); });
      });
      document.querySelectorAll('picture source').forEach(s => {
        if (s.srcset) s.srcset.split(',').forEach(p => { const u = p.trim().split(' ')[0]; if (u) imgs.add(u); });
      });
      // Background images
      document.querySelectorAll('*').forEach(el => {
        try {
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== 'none') {
            const urls = bg.match(/url\(["']?([^"')]+)["']?\)/g);
            if (urls) urls.forEach(u => {
              const clean = u.replace(/url\(["']?|["']?\)/g, '');
              if (clean && !clean.startsWith('data:')) imgs.add(clean);
            });
          }
        } catch(e) {}
      });

      // Videos
      document.querySelectorAll('video, video source').forEach(v => {
        if (v.src) vids.add(v.src);
        if (v.getAttribute('data-src')) vids.add(v.getAttribute('data-src'));
      });

      // Fonts from CSS
      const computed = [];
      for (const sheet of document.styleSheets) {
        try { for (const rule of sheet.cssRules) computed.push(rule.cssText); } catch(e) {}
      }
      const css = computed.join('\n');
      const fm = css.match(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf|eot)[^"')]*)/gi);
      if (fm) fm.forEach(m => {
        let url = m.replace(/url\(["']?/i, '');
        if (url.startsWith('/')) url = domain + url;
        else if (!url.startsWith('http')) url = domain + '/' + url;
        fonts.add(url);
      });

      return { imgs: [...imgs], fonts: [...fonts], vids: [...vids], media: [...media] };
    }, DOMAIN);

    // Download images
    const allImgs = new Set([...assetData.imgs, ...[...networkURLs.entries()].filter(([,t]) => t === 'image').map(([u]) => u)]);
    for (const url of allImgs) {
      try {
        const abs = new URL(url, DOMAIN).href;
        const name = assetName(abs, 'img', imgCount, '.jpg');
        if (await dl(abs, `${OUT}/images/${name}`)) { mapAsset(url, `/images/${name}`); imgCount++; }
      } catch(e) {}
    }
    console.log(`     Images: ${imgCount}`);

    // Download fonts
    const allFonts = new Set([...assetData.fonts, ...[...networkURLs.entries()].filter(([,t]) => t === 'font').map(([u]) => u)]);
    for (const url of allFonts) {
      try {
        const abs = new URL(url, DOMAIN).href;
        const name = assetName(abs, 'font', fontCount, '.woff2');
        if (await dl(abs, `${OUT}/fonts/${name}`)) { mapAsset(url, `/fonts/${name}`); fontCount++; }
      } catch(e) {}
    }
    console.log(`     Fonts: ${fontCount}`);

    // Download videos
    const allVids = new Set([...assetData.vids, ...[...networkURLs.entries()].filter(([,t]) => t === 'video').map(([u]) => u)]);
    for (const url of allVids) {
      try {
        const abs = new URL(url, DOMAIN).href;
        const name = assetName(abs, 'vid', vidCount, '.mp4');
        if (await dl(abs, `${OUT}/videos/${name}`)) { mapAsset(url, `/videos/${name}`); vidCount++; }
      } catch(e) {}
    }
    console.log(`     Videos: ${vidCount}`);

    // Special media from network
    for (const [url, type] of networkURLs.entries()) {
      if (!['lottie', 'rive', 'model', 'audio'].includes(type)) continue;
      try {
        const abs = new URL(url, DOMAIN).href;
        const ext = type === 'lottie' ? '.json' : type === 'rive' ? '.riv' : type === 'model' ? '.glb' : '.mp3';
        const name = `media-${mediaCount}${ext}`;
        if (await dl(abs, `${OUT}/media/${name}`)) { mapAsset(url, `/media/${name}`); mediaCount++; }
      } catch(e) {}
    }

    // Favicon
    await dl(`${DOMAIN}/favicon.ico`, `${OUT}/favicon.ico`);
    const favicons = await page.evaluate(() => [...document.querySelectorAll('link[rel*="icon"]')].map(l => l.href));
    for (const u of favicons) { try { await dl(u, `${OUT}/favicon${path.extname(new URL(u).pathname) || '.ico'}`); } catch(e) {} }

    // Canvas capture
    const canvases = await page.$$('canvas');
    for (let i = 0; i < canvases.length; i++) {
      try {
        const du = await canvases[i].evaluate(c => { try { return c.toDataURL('image/png'); } catch { return null; } });
        if (du) fs.writeFileSync(`${OUT}/images/canvas-${i}.png`, Buffer.from(du.split(',')[1], 'base64'));
        else await canvases[i].screenshot({ path: `${OUT}/images/canvas-${i}.png` });
      } catch(e) {}
    }

    // Bundle analysis
    console.log('     Analyzing bundles...');
    bundleData = { lib: '', gsap: [], st: [], lenis: [], framer: [], eases: [], durations: [], delays: [] };
    const jsURLs = [...networkURLs.entries()].filter(([,t]) => t === 'script').map(([u]) => u);
    const appJS = jsURLs.filter(u => /page|layout|app|main|index/i.test(u)).slice(0, 10);
    const libJS = jsURLs.filter(u => !appJS.includes(u) && /\d{2,5}-|[a-f0-9]{8,}/.test(u) && !/(polyfill|webpack|framework)/i.test(u)).slice(0, 8);
    const otherJS = [...appJS, ...libJS];

    for (const url of [...appJS, ...otherJS]) {
      try {
        const code = await page.evaluate(async (u) => { try { return await (await fetch(u)).text(); } catch { return ''; } }, url);
        if (!code) continue;
        for (const m of code.matchAll(/(?:gsap|[a-z]\.(?:p8|ZP|Bt|Dn))\.\s*(?:to|from|fromTo|set)\s*\([^)]{0,2000}\)/g)) bundleData.gsap.push(m[0].substring(0, 500));
        for (const m of code.matchAll(/scrollTrigger\s*:\s*\{[^}]{0,1000}\}|ScrollTrigger\.create\s*\([^)]{0,1000}\)/g)) bundleData.st.push(m[0].substring(0, 500));
        for (const m of code.matchAll(/new\s+\w+\s*\(\s*\{[^}]*duration[^}]*easing[^}]*\}/g)) bundleData.lenis.push(m[0].substring(0, 500));
        for (const m of code.matchAll(/(?:motion\.\w+|whileInView|AnimatePresence|variants\s*:\s*\{[^}]+\})/g)) bundleData.framer.push(m[0].substring(0, 300));
        if (/anime\s*\(\s*\{/.test(code)) bundleData.lib += 'anime,';
        if (/locomotive/i.test(code) && /ScrollTrigger/i.test(code)) bundleData.lib += 'locomotive,';
        for (const m of code.matchAll(/ease\s*:\s*["'][^"']+["']/g)) bundleData.eases.push(m[0]);
        for (const m of code.matchAll(/duration\s*:\s*[\d.]+/g)) bundleData.durations.push(m[0]);
        for (const m of code.matchAll(/delay\s*:\s*[\d.]+/g)) bundleData.delays.push(m[0]);
      } catch(e) {}
    }

    const iLib = (await page.evaluate(() => window.__xr?.lib)) || '';
    if (bundleData.gsap.length || iLib.includes('gsap')) bundleData.lib += 'gsap,';
    if (bundleData.st.length || iLib.includes('scrolltrigger')) bundleData.lib += 'scrolltrigger,';
    if (bundleData.lenis.length || iLib.includes('lenis')) bundleData.lib += 'lenis,';
    if (bundleData.framer.length) bundleData.lib += 'framer-motion,';
    bundleData.lib = [...new Set(bundleData.lib.split(','))].filter(Boolean).join(',');
    bundleData.eases = [...new Set(bundleData.eases)];
    bundleData.durations = [...new Set(bundleData.durations)];
    bundleData.delays = [...new Set(bundleData.delays)];

    console.log(`     Libraries: ${bundleData.lib || 'css-only'}`);

    // CDN scripts
    if (bundleData.lib.includes('gsap')) cdnScripts.push('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js');
    if (bundleData.lib.includes('scrolltrigger')) cdnScripts.push('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js');
    if (bundleData.lib.includes('lenis')) cdnScripts.push('https://unpkg.com/lenis@1.1.18/dist/lenis.min.js');
    if (bundleData.lib.includes('locomotive')) cdnScripts.push('https://cdn.jsdelivr.net/npm/locomotive-scroll@4.1.4/dist/locomotive-scroll.min.js');
  }

  // ── Phase 6b: Collect mutations recorded since page load ──
  let animData = null;
  if (isFirst && (bundleData?.lib || '').includes('gsap')) {
    console.log('     Collecting recorded mutations...');

    // Mark where scroll phase starts, then scroll to capture scroll mutations
    await page.evaluate(() => { window.__scrollMutStart = window.__mutations.length; });

    const h2 = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y <= h2; y += 200) {
      await page.evaluate(s => window.scrollTo(0, s), y);
      await page.waitForTimeout(30);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    animData = await page.evaluate(() => {
      const muts = window.__mutations || [];
      const scrollStart = window.__scrollMutStart || 0;
      const entranceMuts = muts.slice(0, scrollStart);
      const scrollMuts = muts.slice(scrollStart);

      // Group entrance by element
      const entranceByEl = {};
      for (const m of entranceMuts) {
        if (!entranceByEl[m.el]) entranceByEl[m.el] = [];
        entranceByEl[m.el].push(m);
      }

      // Group scroll by element
      const scrollByEl = {};
      for (const m of scrollMuts) {
        if (!scrollByEl[m.el]) scrollByEl[m.el] = [];
        scrollByEl[m.el].push(m);
      }

      // Classify: many scroll mutations = scroll-driven, few = entrance-on-scroll
      const scrollDriven = {};
      const scrollEntrance = {};
      for (const [el, ms] of Object.entries(scrollByEl)) {
        if (ms.length > 10) scrollDriven[el] = ms.length;
        else scrollEntrance[el] = ms;
      }

      return {
        total: muts.length,
        entranceCount: entranceMuts.length,
        scrollCount: scrollMuts.length,
        entranceByEl,
        scrollDriven,
        scrollEntrance,
      };
    });

    console.log(`     Mutations: ${animData.total} (entrance: ${animData.entranceCount}, scroll: ${animData.scrollCount})`);
    console.log(`     Entrance elements: ${Object.keys(animData.entranceByEl).length} | Scroll-driven: ${Object.keys(animData.scrollDriven).length}`);
  }

  // ── Phase 6c: Download videos — check rendered DOM + network ──
  if (isFirst) {
    // Videos from rendered DOM (JS injects <video> elements with relative paths)
    const domVideos = await page.evaluate(() => {
      const vids = new Set();
      document.querySelectorAll('video, video source').forEach(v => {
        if (v.src) vids.add(v.src);
        if (v.getAttribute('data-src')) vids.add(v.getAttribute('data-src'));
      });
      // Also check for video paths in script data (RSC payloads often contain video paths)
      const html = document.documentElement.innerHTML;
      const matches = html.match(/\/videos\/[^"'\s]+\.mp4/g);
      if (matches) matches.forEach(m => vids.add(m));
      return [...vids];
    });

    // Videos from network intercept
    const netVideos = [...networkURLs.entries()].filter(([, t]) => t === 'video').map(([u]) => u);

    const allVidURLs = [...new Set([...domVideos, ...netVideos])];
    for (const url of allVidURLs) {
      if (Object.values(urlMap).some(v => v === url)) continue; // already mapped
      try {
        const abs = url.startsWith('/') ? DOMAIN + url : new URL(url, DOMAIN).href;
        const name = assetName(abs, 'vid', vidCount, '.mp4');
        if (await dl(abs, `${OUT}/videos/${name}`)) {
          mapAsset(url, `/videos/${name}`);
          mapAsset(abs, `/videos/${name}`);
          vidCount++;
          console.log(`     Downloaded video: ${name}`);
        }
      } catch(e) {}
    }
  }

  // ── Capture this page's rendered DOM ──
  const renderedHTML = await page.content();

  // ── Also discover new asset URLs on this page (subsequent pages may have new images) ──
  if (!isFirst) {
    const newImgs = await page.evaluate(() => {
      const found = [];
      document.querySelectorAll('img[src], [data-src]').forEach(el => {
        const s = el.src || el.getAttribute('data-src');
        if (s && !s.startsWith('data:')) found.push(s);
      });
      return found;
    });
    for (const url of newImgs) {
      if (urlMap[url]) continue; // Already downloaded
      try {
        const abs = new URL(url, DOMAIN).href;
        if (urlMap[abs]) continue;
        const name = assetName(abs, 'img', imgCount, '.jpg');
        if (await dl(abs, `${OUT}/images/${name}`)) { mapAsset(url, `/images/${name}`); imgCount++; }
      } catch(e) {}
    }
  }

  // ── Assemble this page's HTML ──
  let html = renderedHTML;
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  html = html.replace(/<div hidden=""[^>]*>[\s\S]*?<\/div>/, '');
  html = html.replace(/<!--\/?\$\??-->/g, '');

  // Rewrite asset URLs
  const sorted = Object.entries(urlMap).sort((a, b) => b[0].length - a[0].length);
  for (const [orig, local] of sorted) {
    try { html = html.replace(new RegExp(orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), local); } catch(e) {}
  }

  // Rewrite internal links to local paths
  for (const link of [...crawled, ...queue]) {
    const file = pathToFile(link);
    // Replace href="/about" with href="/about/index.html"
    try {
      html = html.replace(new RegExp(`href="${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'), `href="${file}"`);
    } catch(e) {}
  }

  // Canvas → image/video
  let ci = 0;
  html = html.replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/g, () => {
    const idx = ci++;
    if (idx === 0 && vidCount > 0) {
      const v = Object.values(urlMap).find(v => v.startsWith('/videos/'));
      if (v) return `<video autoplay muted playsinline loop style="width:100%;height:auto" src="${v}"></video>`;
    }
    if (fs.existsSync(`${OUT}/images/canvas-${idx}.png`)) return `<img src="/images/canvas-${idx}.png" style="width:100%;height:auto" />`;
    return '';
  });

  // Fix blocking classes
  html = html.replace(/\block-scroll\b/g, '');
  html = html.replace(/\blenis-stopped\b/g, '');

  // Inject shared CSS + fixes before </head>
  let css = sharedCSS;
  for (const [orig, local] of sorted) {
    try { css = css.replace(new RegExp(orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), local); } catch(e) {}
  }

  const headInject = `
<style>${css}</style>
<style>
html, body { overflow-y: auto !important; overflow-x: hidden !important; scroll-behavior: smooth; }
html { scrollbar-width: none; }
html::-webkit-scrollbar { display: none; }
</style>
<link rel="icon" href="/favicon.ico" />`;
  html = html.replace('</head>', headInject + '\n</head>');

  // ── Generate animation script from mutation data + bundle analysis ──
  let animScript = '';
  const lib = bundleData?.lib || '';

  if (lib.includes('gsap') && isFirst) {
    // Parse Lenis config from bundle
    let lenisInit = '';
    if (lib.includes('lenis')) {
      const lenisRaw = (bundleData.lenis || [])[0] || '';
      const durMatch = lenisRaw.match(/duration\s*:\s*([\d.]+)/);
      const dur = durMatch ? durMatch[1] : '0.8';
      lenisInit = `
const lenis = new Lenis({ duration: ${dur}, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smooth: true });
function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }
requestAnimationFrame(raf);
gsap.registerPlugin(ScrollTrigger);
lenis.on("scroll", ScrollTrigger.update);
gsap.ticker.add((time) => lenis.raf(time * 1000));
gsap.ticker.lagSmoothing(0);`;
    } else {
      lenisInit = 'gsap.registerPlugin(ScrollTrigger);';
    }

    // Parse eases from bundle — pick the primary ones
    const defaultEase = (bundleData.eases || []).find(e => e.includes('expo') || e.includes('power4')) || '"expo.out"';
    const entranceEase = (bundleData.eases || []).find(e => e.includes('power4.inOut')) || defaultEase;

    // Parse durations
    const allDurs = (bundleData.durations || []).map(d => d.replace('duration:', '').trim()).filter(d => parseFloat(d) > 0.1);

    // Build script from mutation observations + bundle params
    animScript = `
${lenisInit}

// ── Entrance animations (from mutation observation + bundle eases/durations) ──
`;
    // Entrance elements from mutation data
    if (animData?.entranceByEl) {
      for (const [selector, muts] of Object.entries(animData.entranceByEl)) {
        // Check what the first mutation set (that's GSAP's initial .set() call)
        const firstMut = muts[0];
        if (!firstMut) continue;
        const initialStyle = firstMut.new || firstMut.old || '';

        // Detect animation type from initial style
        if (initialStyle.includes('opacity') && initialStyle.includes('0')) {
          // Fade in animation
          const hasTranslate = initialStyle.includes('translate');
          const yMatch = initialStyle.match(/translate\([^,)]*,\s*(-?\d+)/);
          const y = yMatch ? yMatch[1] + 'px' : hasTranslate ? '-20px' : '0';

          const dur = allDurs.find(d => parseFloat(d) < 1) || '0.5';
          animScript += `gsap.from('${selector}', { autoAlpha: 0, y: '${y}', duration: ${dur}, ease: ${entranceEase.includes('"') ? entranceEase : '"' + entranceEase + '"'}, delay: 0.25 });\n`;
        } else if (initialStyle.includes('scale(0') || initialStyle.includes('scaleX(0')) {
          // Scale reveal animation
          const originMatch = initialStyle.match(/transform-origin:\s*([^;]+)/);
          const origin = originMatch ? originMatch[1].trim() : 'left center';
          const dur = allDurs.find(d => parseFloat(d) > 1) || '1.2';
          animScript += `gsap.from('${selector}', { scaleX: 0, transformOrigin: '${origin}', duration: ${dur}, delay: 0.2, ease: ${defaultEase.includes('"') ? defaultEase : '"' + defaultEase + '"'} });\n`;
        }
      }
    }

    // Scroll-driven elements from mutation data
    if (animData?.scrollDriven) {
      animScript += `\n// ── Scroll-driven animations (${Object.keys(animData.scrollDriven).length} elements with continuous style changes) ──\n`;
      for (const [selector, mutCount] of Object.entries(animData.scrollDriven)) {
        if (selector.includes('Row') || selector.includes('row')) {
          // Row progress animation
          animScript += `
document.querySelectorAll('${selector}:not(.fake-projects-row)').forEach((row, i) => {
  const rowH = row.getBoundingClientRect().height || 182;
  gsap.set(row, { '--progress': 0.5, '--base-height': rowH + 'px' });
  row.style.setProperty('min-height', rowH + 'px');
  ScrollTrigger.create({
    trigger: row,
    start: 'bottom-=' + (rowH - (i === 0 ? 42 : 0)) + 'px bottom',
    end: 'top top',
    scrub: 1,
    onUpdate: (self) => {
      gsap.set(row, { '--progress': 0.5 + 0.5 * self.progress });
    },
  });
  row.classList.add('automatic-minheight');
});
`;
        } else if (selector.includes('progress') || mutCount > 20) {
          // Generic scroll-driven element
          animScript += `ScrollTrigger.create({ trigger: '${selector}', start: 'top bottom', end: 'top top', scrub: 1, onUpdate: (self) => { document.querySelector('${selector}')?.style.setProperty('--progress', self.progress); } });\n`;
        }
      }
    }

    // Card entrance stagger (common pattern)
    animScript += `
// ── Card entrance stagger ──
document.querySelectorAll('.Row_wrapper__Fk73V, [class*="wrapper"], [class*="grid"]').forEach(wrapper => {
  const elements = wrapper.querySelectorAll('[class*="element"], [class*="card"], [class*="item"]');
  if (elements.length < 2) return;
  gsap.set(elements, { x: -25, opacity: 0 });
  ScrollTrigger.create({
    trigger: wrapper, start: 'top 80%', once: true,
    onEnter: () => {
      elements.forEach((el, i) => {
        gsap.to(el, { x: 0, opacity: 1, duration: 0.8, delay: i * 0.1, ease: ${defaultEase.includes('"') ? defaultEase : '"' + defaultEase + '"'}, clearProps: 'transform' });
      });
    },
  });
});

// ── InflatingText character animation ──
document.querySelectorAll('[class*="InflatingText"], [class*="inflating"], [class*="split-text"]').forEach(container => {
  const chars = container.querySelectorAll('[class*="character"], [class*="char"]');
  if (chars.length === 0) return;
  gsap.set(chars, { scaleX: 0, x: -5, transformOrigin: 'left bottom' });
  ScrollTrigger.create({
    trigger: container, start: 'top 90%', once: true,
    onEnter: () => gsap.to(chars, { scaleX: 1, x: 0, duration: 0.6, stagger: 0.02, ease: ${defaultEase.includes('"') ? defaultEase : '"' + defaultEase + '"'} }),
  });
});

// ── Projects grid visibility ──
document.querySelectorAll('[class*="projects"], [class*="Projects"]').forEach(el => {
  el.classList.add('ready'); el.classList.add('projects-animated');
});

// ── Hover effects on media ──
document.querySelectorAll('[class*="element"], [class*="card"]').forEach(el => {
  el.style.pointerEvents = 'auto';
  el.style.cursor = 'pointer';
  const img = el.querySelector('img');
  if (img) {
    el.addEventListener('mouseenter', () => gsap.to(img, { scale: 1.03, filter: 'brightness(0.9)', duration: 0.75, ease: 'expo.out' }));
    el.addEventListener('mouseleave', () => gsap.to(img, { scale: 1, filter: 'brightness(1)', duration: 0.75, ease: 'expo.out' }));
  }
});
`;
  }

  // Interactive elements (always)
  animScript += `
document.querySelectorAll('button, a, [role="button"]').forEach(el => {
  el.style.pointerEvents = 'auto';
  if (el.tagName === 'A' || el.tagName === 'BUTTON') el.style.cursor = 'pointer';
});`;

  // Inject CDN + animation script before </body>
  const bodyInject = `
${cdnScripts.map(u => `<script src="${u}"></script>`).join('\n')}
<script>
${animScript}
</script>`;
  html = html.replace('</body>', bodyInject + '\n</body>');

  // Write page HTML
  const filePath = pathToFile(urlPath);
  const fullPath = path.join(OUT, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, html);
  console.log(`     → ${filePath} (${(html.length / 1024).toFixed(0)}KB)`);

  // Screenshot
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const screenshotName = urlPath === '/' ? 'reference' : urlPath.replace(/\//g, '_').replace(/^_/, '');
  await page.screenshot({ path: `${OUT}/data/${screenshotName}.png`, fullPage: true }).catch(() => {});
}

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════
async function main() {
  for (const d of ['images', 'fonts', 'videos', 'media', 'data']) fs.mkdirSync(`${OUT}/${d}`, { recursive: true });

  console.log(`\n🔬 Site X-Ray v5`);
  console.log(`   ${TARGET} → ${OUT}`);
  console.log(`   Max pages: ${MAX_PAGES}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  // Animation interceptors + MutationObserver — BEFORE page loads
  await context.addInitScript(() => {
    window.__xr = { lib: '', gsap: [], lenis: null };
    window.__mutations = [];
    window.__mutStart = Date.now();

    // MutationObserver for style+class changes — starts immediately
    const startObserver = () => {
      const obs = new MutationObserver(muts => {
        const now = Date.now() - window.__mutStart;
        for (const m of muts) {
          if (m.type !== 'attributes' || m.attributeName !== 'style') continue;
          const el = m.target;
          const cls = (el.className?.toString() || '').split(/\s+/).find(c => c.includes('__')) || '';
          if (!cls) continue;
          window.__mutations.push({ t: now, el: '.' + cls, old: (m.oldValue || '').substring(0, 300), new: (el.getAttribute('style') || '').substring(0, 300) });
        }
      });
      obs.observe(document.documentElement, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['style'] });
    };

    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver);

    // Library detection
    const iv = setInterval(() => {
      if (window.gsap && !window.gsap.__xr) { window.gsap.__xr = true; window.__xr.lib += 'gsap,'; }
      if (window.ScrollTrigger && !window.ScrollTrigger.__xr) { window.ScrollTrigger.__xr = true; window.__xr.lib += 'scrolltrigger,'; }
      if (window.Lenis && !window.Lenis.__xr) { window.Lenis.__xr = true; window.__xr.lib += 'lenis,'; }
      if (window.LocomotiveScroll) window.__xr.lib += 'locomotive,';
    }, 50);
    setTimeout(() => clearInterval(iv), 15000);
  });

  const page = await context.newPage();

  // Network tracking
  page.on('response', async (res) => {
    try {
      if (res.status() === 200) {
        const url = res.url();
        const ct = res.headers()['content-type'] || '';
        let type = 'other';
        if (ct.includes('image') || url.match(/\.(jpg|jpeg|png|gif|webp|svg|avif|ico)(\?|$)/i)) type = 'image';
        else if (ct.includes('font') || url.match(/\.(woff2?|ttf|otf|eot)(\?|$)/i)) type = 'font';
        else if (ct.includes('video') || url.match(/\.(mp4|webm|mov|m4v)(\?|$)/i)) type = 'video';
        else if (ct.includes('audio') || url.match(/\.(mp3|wav|ogg|m4a)(\?|$)/i)) type = 'audio';
        else if (url.match(/\.json(\?|$)/i) && url.includes('lottie')) type = 'lottie';
        else if (url.match(/\.riv(\?|$)/i)) type = 'rive';
        else if (url.match(/\.(gltf|glb)(\?|$)/i)) type = 'model';
        else if (url.match(/\.js(\?|$)/i)) type = 'script';
        networkURLs.set(url, type);
      }
    } catch(e) {}
  });

  // ── Crawl loop ──
  let pageNum = 0;
  while (queue.length > 0 && pageNum < MAX_PAGES) {
    const urlPath = queue.shift();
    if (crawled.has(urlPath)) continue;
    crawled.add(urlPath);

    try {
      await capturePage(page, urlPath, pageNum === 0);
      pageNum++;
    } catch(e) {
      console.log(`     ❌ Failed: ${e.message}`);
    }
  }

  // Save metadata
  fs.writeFileSync(`${OUT}/data/config.json`, JSON.stringify({
    url: TARGET, domain: DOMAIN, pages: [...crawled],
    assets: { images: imgCount, fonts: fontCount, videos: vidCount, media: mediaCount },
    animation: bundleData?.lib || 'css-only',
  }, null, 2));

  // Summary
  const totalFiles = fs.readdirSync(OUT, { recursive: true }).filter(f => !f.includes('data/')).length;
  const totalSize = parseInt(require('child_process').execSync(`du -sk "${OUT}" 2>/dev/null`).toString().split('\t')[0]) || 0;

  console.log(`\n✅ Clone ready — ${pageNum} pages`);
  console.log(`   ${imgCount} images, ${fontCount} fonts, ${vidCount} videos`);
  console.log(`   ${totalFiles} files, ${(totalSize / 1024).toFixed(1)}MB`);
  console.log(`   Pages: ${[...crawled].join(', ')}`);
  console.log(`\n   cd ${OUT} && python3 -m http.server 3035\n`);

  await browser.close();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
