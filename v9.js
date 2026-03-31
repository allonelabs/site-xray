#!/usr/bin/env node
/**
 * Site X-Ray v9 — Universal website cloner
 * Fixes: CSS var() shorthand corruption, font URL rewriting, WebGL fallback, dead links
 * Single file. One dependency (playwright). Zero config.
 *
 * Usage: node v9.js <url> [output-dir] [max-pages]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const TARGET = process.argv[2];
if (!TARGET) { console.log('Site X-Ray v9\nUsage: node v9.js <url> [output-dir] [max-pages]'); process.exit(0); }

const PARSED = new URL(TARGET);
const DOMAIN = PARSED.origin;
const OUT = process.argv[3] || `/tmp/clone-${PARSED.hostname.replace(/\./g, '-')}`;
const MAX_PAGES = parseInt(process.argv[4]) || 20;

// Shared state
const urlMap = {};
const networkURLs = new Set();
const crawled = new Set();
const queue = [PARSED.pathname || '/'];
let rawCSS = '', bundleLib = '', cdnScripts = [], sharedAnimScript = '';
let imgC = 0, fontC = 0, vidC = 0;

function dl(url, dest, timeout = 15000) {
  return new Promise(resolve => {
    try {
      if (!url || url.startsWith('data:') || url.startsWith('blob:')) return resolve(false);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout }, res => {
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
          file.close(); try{fs.unlinkSync(dest)}catch(e){} return dl(new URL(res.headers.location,url).href,dest,timeout).then(resolve);
        }
        if (res.statusCode!==200) { file.close(); try{fs.unlinkSync(dest)}catch(e){} return resolve(false); }
        res.pipe(file); file.on('finish',()=>{file.close();resolve(true)});
      });
      req.on('error',()=>{try{file.close();fs.unlinkSync(dest)}catch(e){}resolve(false)});
      req.on('timeout',()=>{req.destroy();resolve(false)});
    } catch(e){resolve(false)}
  });
}

function mapAsset(orig, local) {
  urlMap[orig] = local;
  try {
    const a = new URL(orig, DOMAIN).href;
    urlMap[a] = local;
    urlMap[new URL(a).origin + new URL(a).pathname] = local;
    // Also map the pathname alone (for CSS url() references like "/_next/static/media/...")
    const pn = new URL(a).pathname;
    if (pn && pn !== '/') urlMap[pn] = local;
  } catch(e){}
}

function pathToFile(p) { p=p||'/'; if(p.endsWith('/'))p+='index.html'; else if(!path.extname(p))p+='/index.html'; return p; }

// ═══════════════════════════════════════
// Capture one page
// ═══════════════════════════════════════
async function capturePage(page, urlPath, isFirst) {
  const fullURL = DOMAIN + urlPath;
  let webglCanvases = [];
  console.log(`\n  📄 ${urlPath}`);

  await page.goto(fullURL, { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
  await page.waitForTimeout(isFirst ? 5000 : 2000);

  // Scroll to trigger lazy content
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y=0;y<=h;y+=300) { await page.evaluate(s=>window.scrollTo(0,s),y); await page.waitForTimeout(isFirst?80:40); }
  if (isFirst) { await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(300);
    for(let y=0;y<=h;y+=500){await page.evaluate(s=>window.scrollTo(0,s),y);await page.waitForTimeout(30);} }
  await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(500);

  // Discover internal links
  const links = await page.evaluate(domain => {
    const found = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      try { const u=new URL(a.href,domain); if(u.origin===domain&&!u.hash&&!u.pathname.match(/\.(jpg|png|pdf|zip|svg|mp4)$/i)) found.add(u.pathname); } catch(e){}
    });
    return [...found];
  }, DOMAIN);
  for (const link of links) { if(!crawled.has(link)&&!queue.includes(link)&&crawled.size+queue.length<MAX_PAGES) queue.push(link); }
  console.log(`     Links: ${links.length} (queue: ${queue.length})`);

  // ── First page: capture CSS, download assets, analyze bundles ──
  if (isFirst) {

    // ═══════════════════════════════════════
    // FIX #1: Fetch RAW CSS files instead of using cssRules.cssText
    // cssRules.cssText corrupts shorthands with var() (e.g., padding: var(--gap) → padding-top: ;)
    // ═══════════════════════════════════════
    const cssData = await page.evaluate(async (domain) => {
      const result = { external: [], inline: '' };

      // Fetch each external stylesheet as raw text
      const linkEls = document.querySelectorAll('link[rel="stylesheet"]');
      for (const link of linkEls) {
        const href = link.href;
        if (!href) continue;
        try {
          const res = await fetch(href);
          if (res.ok) {
            const text = await res.text();
            result.external.push({ href, text });
          }
        } catch(e) {}
      }

      // Also capture inline <style> blocks
      const styleEls = document.querySelectorAll('style');
      for (const s of styleEls) {
        if (s.textContent && s.textContent.trim().length > 0) {
          result.inline += s.textContent + '\n';
        }
      }

      // Capture computed CSS custom properties from :root/html
      // (these may be set by JS at runtime and not in any stylesheet)
      const htmlEl = document.documentElement;
      const cs = getComputedStyle(htmlEl);
      const runtimeVars = {};
      // Check all stylesheets for variable declarations
      const allVarNames = new Set();
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            const text = rule.cssText || '';
            const matches = text.matchAll(/--([\w-]+)\s*:/g);
            for (const m of matches) allVarNames.add('--' + m[1]);
          }
        } catch(e) {}
      }
      // Get computed values for all discovered variables
      for (const name of allVarNames) {
        const val = cs.getPropertyValue(name).trim();
        if (val) runtimeVars[name] = val;
      }

      return result;
    }, DOMAIN);

    // Build raw CSS from fetched stylesheets (preserves var() shorthands!)
    rawCSS = cssData.external.map(s => `/* ${s.href} */\n${s.text}`).join('\n\n');
    if (cssData.inline) rawCSS += '\n/* inline styles */\n' + cssData.inline;

    console.log(`     CSS: ${rawCSS.length} chars (${cssData.external.length} external sheets)`);

    // Collect asset URLs
    const assets = await page.evaluate(domain => {
      const imgs=new Set(), fonts=new Set(), vids=new Set();
      document.querySelectorAll('img,[data-src],[data-lazy],[data-bg],video[poster]').forEach(el=>{
        for(const a of['src','data-src','data-lazy','data-bg','poster']){const v=el.getAttribute(a);if(v&&!v.startsWith('data:'))imgs.add(v);}
        const ss=el.getAttribute('srcset')||el.getAttribute('data-srcset');
        if(ss)ss.split(',').forEach(s=>{const u=s.trim().split(' ')[0];if(u)imgs.add(u);});
      });
      document.querySelectorAll('picture source').forEach(s=>{if(s.srcset)s.srcset.split(',').forEach(p=>{const u=p.trim().split(' ')[0];if(u)imgs.add(u);});});
      document.querySelectorAll('*').forEach(el=>{try{const bg=getComputedStyle(el).backgroundImage;if(bg&&bg!=='none'){const urls=bg.match(/url\(["']?([^"')]+)["']?\)/g);if(urls)urls.forEach(u=>{const c=u.replace(/url\(["']?|["']?\)/g,'');if(c&&!c.startsWith('data:'))imgs.add(c);});}}catch(e){}});
      document.querySelectorAll('video,video source').forEach(v=>{if(v.src)vids.add(v.src);if(v.getAttribute('data-src'))vids.add(v.getAttribute('data-src'));});
      // Font URLs from CSS
      let css='';for(const s of document.styleSheets){try{for(const r of s.cssRules)css+=r.cssText+'\n'}catch(e){}}
      const fm=css.match(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf|eot)[^"')]*)/gi);
      if(fm)fm.forEach(m=>{let u=m.replace(/url\(["']?/i,'');if(u.startsWith('/'))u=domain+u;else if(!u.startsWith('http'))u=domain+'/'+u;fonts.add(u);});
      // Also extract font URLs from raw stylesheet text (in case cssRules missed some)
      const linkEls = document.querySelectorAll('link[rel="stylesheet"]');
      return{imgs:[...imgs],fonts:[...fonts],vids:[...vids]};
    }, DOMAIN);

    // Also extract font URLs directly from fetched CSS text
    const fontUrlsFromRaw = rawCSS.match(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf|eot)[^"')]*)/gi) || [];
    for (const m of fontUrlsFromRaw) {
      let u = m.replace(/url\(["']?/i, '');
      if (u.startsWith('/')) u = DOMAIN + u;
      else if (!u.startsWith('http')) u = DOMAIN + '/' + u;
      assets.fonts.push(u);
    }

    // Download images
    const allImgs = new Set([...assets.imgs, ...[...networkURLs].filter(u=>u.match(/\.(jpg|jpeg|png|gif|webp|svg|avif|tif|tiff)(\?|$)/i))]);
    for(const url of allImgs){try{const a=new URL(url,DOMAIN).href;const ext=path.extname(new URL(a).pathname).split('?')[0]||'.jpg';const nm=`img-${imgC}${ext}`;if(await dl(a,`${OUT}/images/${nm}`)){mapAsset(url,`/images/${nm}`);imgC++;}}catch(e){}}
    console.log(`     Images: ${imgC}`);

    // Download fonts
    const allFonts = new Set([...assets.fonts,...[...networkURLs].filter(u=>u.match(/\.(woff2?|ttf|otf|eot)(\?|$)/i))]);
    for(const url of allFonts){try{const a=new URL(url,DOMAIN).href;const ext=path.extname(new URL(a).pathname).split('?')[0]||'.woff2';const nm=`font-${fontC}${ext}`;if(await dl(a,`${OUT}/fonts/${nm}`)){mapAsset(url,`/fonts/${nm}`);fontC++;}}catch(e){}}
    console.log(`     Fonts: ${fontC}`);

    // Download videos
    const allVids = new Set([...assets.vids,...[...networkURLs].filter(u=>u.match(/\.(mp4|webm|mov)(\?|$)/i))]);
    for(const url of allVids){try{const a=new URL(url,DOMAIN).href;const ext=path.extname(new URL(a).pathname).split('?')[0]||'.mp4';const nm=`vid-${vidC}${ext}`;if(await dl(a,`${OUT}/videos/${nm}`)){mapAsset(url,`/videos/${nm}`);vidC++;}}catch(e){}}
    console.log(`     Videos: ${vidC}`);

    // ═══════════════════════════════════════
    // FIX #2: Rewrite font URLs in raw CSS AFTER downloading
    // ═══════════════════════════════════════
    const sorted = Object.entries(urlMap).sort((a,b) => b[0].length - a[0].length);
    for (const [orig, local] of sorted) {
      try { rawCSS = rawCSS.replace(new RegExp(orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), local); } catch(e) {}
    }
    console.log(`     CSS rewritten: ${rawCSS.length} chars`);

    await dl(`${DOMAIN}/favicon.ico`, `${OUT}/favicon.ico`);

    // ═══════════════════════════════════════
    // Canvas capture — identify WebGL canvases
    // ═══════════════════════════════════════
    const canvasInfo = await page.evaluate(() => [...document.querySelectorAll('canvas')].map((c,i) => {
      const r = c.getBoundingClientRect();
      let ctxType = '2d';
      try { if(c.getContext('webgl2')) ctxType='webgl2'; else if(c.getContext('webgl')) ctxType='webgl'; } catch{}
      return { i, w: r.width, h: r.height, ctxType, visible: r.width > 50 && r.height > 50 };
    }));
    webglCanvases = canvasInfo.filter(c => c.ctxType !== '2d' && c.visible);

    // Static capture for all canvases
    const canvases = await page.$$('canvas');
    for (let i=0; i<canvases.length; i++) {
      try {
        const du = await canvases[i].evaluate(c => { try { return c.toDataURL('image/png') } catch { return null } });
        if (du && du.length > 500) fs.writeFileSync(`${OUT}/images/canvas-${i}.png`, Buffer.from(du.split(',')[1], 'base64'));
        else await canvases[i].screenshot({ path: `${OUT}/images/canvas-${i}.png` });
      } catch(e) {}
    }

    // WebGL frame capture
    if (webglCanvases.length > 0) {
      console.log(`     WebGL canvases: ${webglCanvases.length} (capturing frames)...`);
      for (const wc of webglCanvases) {
        const seqDir = `${OUT}/sequences/webgl-${wc.i}`;
        fs.mkdirSync(seqDir, { recursive: true });
        const frameCount = 120;
        let captured = 0;
        for (let f = 0; f < frameCount; f++) {
          const frame = await page.evaluate((ci) => {
            const c = document.querySelectorAll('canvas')[ci];
            if (!c) return null;
            try { return c.toDataURL('image/webp', 0.85) } catch { return null }
          }, wc.i);
          if (frame && frame.length > 2000) {
            fs.writeFileSync(`${seqDir}/frame-${f+1}.webp`, Buffer.from(frame.split(',')[1], 'base64'));
            captured++;
          }
          await page.waitForTimeout(50);
        }
        console.log(`       canvas[${wc.i}]: ${captured}/${frameCount} frames (${wc.w}x${wc.h} ${wc.ctxType})`);
      }
    }

    // Bundle analysis
    console.log('     Analyzing bundles...');
    const bundle = { lib:'', gsap:[], st:[], lenis:[], framer:[], eases:[], durs:[], delays:[], frameSequences:[] };
    const jsURLs = [...networkURLs].filter(u => u.match(/\.js(\?|$)/i) && !/(polyfill|webpack|framework|chunk-\w{2,3}\.)/i.test(u));
    const jsSizes = [];
    for (const url of jsURLs.slice(0,15)) {
      try {
        const code = await page.evaluate(async u => { try { return await (await fetch(u)).text() } catch { return '' } }, url);
        if (code) jsSizes.push({ url, code, size: code.length });
      } catch(e) {}
    }
    jsSizes.sort((a,b) => b.size - a.size);
    let fullBundleCode = '';
    for (const { url, code } of jsSizes.slice(0,8)) {
      fullBundleCode += code + '\n';
      if (code.includes('ScrollTrigger') || code.includes('scrollTrigger')) bundle.lib += 'scrolltrigger,';
      if (code.includes('gsap.to') || code.includes('gsap.from') || code.includes('gsap.set') || code.includes('gsap.timeline')) bundle.lib += 'gsap,';
      if (code.includes('power4.inOut') || code.includes('expo.out') || code.includes('ScrollToPlugin')) bundle.lib += 'gsap,';
      for (const m of code.matchAll(/(?:gsap|[a-z]\.(?:p8|ZP|Bt|Dn))\.\s*(?:to|from|fromTo|set)\s*\([^)]{0,2000}\)/g)) bundle.gsap.push(m[0].substring(0,500));
      for (const m of code.matchAll(/scrollTrigger\s*:\s*\{[^}]{0,1000}\}|ScrollTrigger\.create\s*\([^)]{0,1000}\)/g)) bundle.st.push(m[0].substring(0,500));
      for (const m of code.matchAll(/new\s+\w+\s*\(\s*\{[^}]*duration[^}]*easing[^}]*\}/g)) bundle.lenis.push(m[0].substring(0,500));
      for (const m of code.matchAll(/(?:motion\.\w+|whileInView|AnimatePresence|variants\s*:\s*\{[^}]+\})/g)) bundle.framer.push(m[0].substring(0,300));
      if (/anime\s*\(\s*\{/.test(code)) bundle.lib += 'anime,';
      if (/locomotive/i.test(code) && /ScrollTrigger/i.test(code)) bundle.lib += 'locomotive,';
      for (const m of code.matchAll(/ease\s*:\s*["'][^"']+["']/g)) bundle.eases.push(m[0]);
      for (const m of code.matchAll(/duration\s*:\s*[\d.]+/g)) bundle.durs.push(m[0]);
      for (const m of code.matchAll(/delay\s*:\s*[\d.]+/g)) bundle.delays.push(m[0]);
      // Three.js detection
      if (code.includes('THREE.') || code.includes('three') || /new\s+\w*Scene\s*\(/.test(code)) bundle.lib += 'three,';
      // Frame sequence detection
      for (const m of code.matchAll(/framePath\s*:\s*["']([^"']+)["']/g)) {
        const fp = m[1];
        const nameMatch = code.substring(Math.max(0,m.index-200), m.index+300).match(/frameName\s*:\s*["']([^"']+)["']/);
        const countMatch = code.substring(Math.max(0,m.index-200), m.index+300).match(/frameCount\s*:\s*(\d+)/);
        const extMatch = code.substring(Math.max(0,m.index-200), m.index+300).match(/extension\s*:\s*["']([^"']+)["']/);
        if (nameMatch && countMatch) {
          const key = fp + '/' + nameMatch[1];
          if (!bundle.frameSequences.some(s => (s.path+'/'+s.name) === key))
            bundle.frameSequences.push({ path: fp, name: nameMatch[1], count: parseInt(countMatch[1]), ext: extMatch ? extMatch[1] : 'webp' });
        }
      }
    }
    const iLib = (await page.evaluate(() => window.__xray?.library)) || '';
    if (bundle.gsap.length || iLib.includes('gsap')) bundle.lib += 'gsap,';
    if (bundle.st.length || iLib.includes('scrolltrigger')) bundle.lib += 'scrolltrigger,';
    if (bundle.lenis.length || iLib.includes('lenis')) bundle.lib += 'lenis,';
    if (bundle.framer.length) bundle.lib += 'framer-motion,';
    bundleLib = [...new Set(bundle.lib.split(','))].filter(Boolean).join(',');
    bundle.eases = [...new Set(bundle.eases)];
    bundle.durs = [...new Set(bundle.durs)];
    bundle.delays = [...new Set(bundle.delays)];
    console.log(`     Libraries: ${bundleLib || 'css-only'}`);
    fs.writeFileSync(`${OUT}/data/bundle.json`, JSON.stringify(bundle, null, 2));

    // CDN scripts
    cdnScripts = [];
    if (bundleLib.includes('gsap')) cdnScripts.push('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js');
    if (bundleLib.includes('scrolltrigger')) cdnScripts.push('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js');
    if (bundleLib.includes('lenis')) cdnScripts.push('https://unpkg.com/lenis@1.1.18/dist/lenis.min.js');
    if (bundleLib.includes('locomotive')) cdnScripts.push('https://cdn.jsdelivr.net/npm/locomotive-scroll@4.1.4/dist/locomotive-scroll.min.js');
    if (!bundleLib.includes('lenis') && await page.evaluate(() => document.documentElement.className.includes('lenis'))) {
      bundleLib += bundleLib ? ',lenis' : 'lenis';
      cdnScripts.push('https://unpkg.com/lenis@1.1.18/dist/lenis.min.js');
    }

    // Download frame sequences from bundles
    if (bundle.frameSequences.length > 0) {
      fs.mkdirSync(`${OUT}/sequences`, { recursive: true });
      for (const seq of bundle.frameSequences) {
        const seqDir = `${OUT}/sequences${seq.path}`;
        fs.mkdirSync(seqDir, { recursive: true });
        console.log(`     Downloading sequence: ${seq.path} (${seq.count} frames)...`);
        let dlCount = 0;
        for (let i = 1; i <= seq.count; i += 10) {
          const batch = [];
          for (let j = i; j < Math.min(i + 10, seq.count + 1); j++) {
            const frameUrl = `${DOMAIN}${seq.path}${seq.name}${j}.${seq.ext}`;
            const dest = `${seqDir}${seq.name}${j}.${seq.ext}`;
            batch.push(dl(frameUrl, dest).then(ok => { if (ok) dlCount++; }));
          }
          await Promise.all(batch);
        }
        console.log(`       Downloaded: ${dlCount}/${seq.count} frames`);
      }
    }

    // ── Generate animation script ──
    // CHANGED: Generate animations regardless of library — WebGL frames need playback too
    const hasAnimations = bundleLib.includes('gsap') || bundleLib.includes('scrolltrigger') || bundleLib.includes('lenis') || bundleLib.includes('framer-motion') || bundle.frameSequences.length > 0;
    const hasWebGLFrames = webglCanvases.length > 0 && fs.existsSync(`${OUT}/sequences`);

    if (hasAnimations || hasWebGLFrames) {
      console.log('     Generating animation script...');

      // Record style timeline if gsap/lenis
      if (bundleLib.includes('gsap') || bundleLib.includes('lenis')) {
        await page.evaluate(() => { window.__scrollTimelineStart = window.__timeline.length; });
        const h2 = await page.evaluate(() => document.body.scrollHeight);
        for (let y=0; y<=h2; y+=200) { await page.evaluate(s => window.scrollTo(0,s), y); await page.waitForTimeout(30); }
        await page.evaluate(() => window.scrollTo(0,0));
        await page.waitForTimeout(1000);
      }

      let animScript = '';

      // Lenis
      if (bundleLib.includes('lenis')) {
        const lenisRaw = bundle.lenis[0] || '';
        const lenisDur = lenisRaw.match(/duration\s*:\s*([\d.]+)/)?.[1] || '0.8';
        animScript += `const lenis=new Lenis({duration:${lenisDur},easing:t=>Math.min(1,1.001-Math.pow(2,-10*t)),smooth:true});\n`;
        animScript += `function raf(t){lenis.raf(t);requestAnimationFrame(raf)}requestAnimationFrame(raf);\n`;
      }

      // GSAP setup
      if (bundleLib.includes('gsap')) {
        animScript += `gsap.registerPlugin(ScrollTrigger);\n`;
        if (bundleLib.includes('lenis')) {
          animScript += `lenis.on("scroll",ScrollTrigger.update);gsap.ticker.add(t=>lenis.raf(t*1000));gsap.ticker.lagSmoothing(0);\n`;
        }
      }

      // ═══════════════════════════════════════
      // FIX #4: WebGL frame playback — ALWAYS generate when frames exist
      // ═══════════════════════════════════════
      if (hasWebGLFrames) {
        // createSequencePlayer helper
        animScript += `function createSequencePlayer(canvas, basePath, frameName, frameCount, ext) {\n`;
        animScript += `  const ctx = canvas.getContext("2d");\n`;
        animScript += `  const frames = []; let loaded = 0;\n`;
        animScript += `  const rect = canvas.getBoundingClientRect();\n`;
        animScript += `  canvas.width = rect.width * (window.devicePixelRatio || 1);\n`;
        animScript += `  canvas.height = rect.height * (window.devicePixelRatio || 1);\n`;
        animScript += `  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);\n`;
        animScript += `  for (let i = 1; i <= frameCount; i++) {\n`;
        animScript += `    const img = new Image();\n`;
        animScript += `    img.onload = () => { loaded++; if (loaded === 1) drawFrame(0); };\n`;
        animScript += `    img.src = basePath + frameName + i + "." + ext;\n`;
        animScript += `    frames.push(img);\n`;
        animScript += `  }\n`;
        animScript += `  function drawFrame(idx) {\n`;
        animScript += `    if (idx < 0 || idx >= frames.length || !frames[idx].complete) return;\n`;
        animScript += `    const img = frames[idx];\n`;
        animScript += `    const cw = canvas.width / (window.devicePixelRatio || 1);\n`;
        animScript += `    const ch = canvas.height / (window.devicePixelRatio || 1);\n`;
        animScript += `    const scale = Math.max(cw / img.width, ch / img.height);\n`;
        animScript += `    const x = (cw - img.width * scale) / 2;\n`;
        animScript += `    const y = (ch - img.height * scale) / 2;\n`;
        animScript += `    ctx.clearRect(0, 0, cw, ch);\n`;
        animScript += `    ctx.drawImage(img, x, y, img.width * scale, img.height * scale);\n`;
        animScript += `  }\n`;
        animScript += `  return { drawFrame, getFrameCount: () => frameCount };\n`;
        animScript += `}\n`;

        // Auto-play WebGL captured sequences
        for (const wc of webglCanvases) {
          const seqDir = `${OUT}/sequences/webgl-${wc.i}`;
          if (!fs.existsSync(seqDir)) continue;
          const frameFiles = fs.readdirSync(seqDir).filter(f => f.endsWith('.webp') || f.endsWith('.png'));
          if (frameFiles.length < 5) continue;
          const fExt = frameFiles[0].split('.').pop() || 'webp';
          animScript += `(()=>{\n`;
          animScript += `  const c=document.querySelectorAll("canvas")[${wc.i}];if(!c)return;\n`;
          animScript += `  // Remove WebGL context attributes so we can use 2d for frame playback\n`;
          animScript += `  const newC=document.createElement("canvas");\n`;
          animScript += `  newC.className=c.className;newC.style.cssText=c.style.cssText;\n`;
          animScript += `  newC.width=c.width;newC.height=c.height;\n`;
          animScript += `  c.parentNode.replaceChild(newC,c);\n`;
          animScript += `  const player=createSequencePlayer(newC,"/sequences/webgl-${wc.i}","/frame-",${frameFiles.length},"${fExt}");\n`;
          animScript += `  let f=0,last=0;\n`;
          animScript += `  function loop(t){if(t-last>83){player.drawFrame(f);f=(f+1)%${frameFiles.length};last=t}requestAnimationFrame(loop)}\n`;
          animScript += `  requestAnimationFrame(loop);\n`;
          animScript += `})();\n`;
        }
      }

      // ═══════════════════════════════════════
      // Framer Motion replacement — SAFE approach
      // Only add hover effects + make hidden things visible
      // Do NOT hide anything or set opacity:0
      // ═══════════════════════════════════════
      if (bundleLib.includes('framer-motion')) {
        const fastDur = '0.3';
        animScript += `// Framer Motion — hover effects only (no entrance animations to avoid hiding content)\n`;
        animScript += `(()=>{\n`;

        // Hover effects on links/buttons with images
        animScript += `  document.querySelectorAll('a,button,[role="button"]').forEach(el=>{\n`;
        animScript += `    el.style.pointerEvents='auto';el.style.cursor='pointer';\n`;
        animScript += `    const img=el.querySelector('img');\n`;
        animScript += `    if(img){\n`;
        animScript += `      img.style.transition='transform ${fastDur}s ease-out, filter ${fastDur}s ease-out';\n`;
        animScript += `      el.addEventListener('mouseenter',()=>{img.style.transform='scale(1.03)';img.style.filter='brightness(0.92)'});\n`;
        animScript += `      el.addEventListener('mouseleave',()=>{img.style.transform='scale(1)';img.style.filter='brightness(1)'});\n`;
        animScript += `    }\n`;
        animScript += `  });\n`;

        // CSS transitions on interactive elements
        animScript += `  document.querySelectorAll('[class*="button"],[class*="Button"]').forEach(btn=>{\n`;
        animScript += `    btn.style.transition='color ${fastDur}s ease-out, background-color ${fastDur}s ease-out';\n`;
        animScript += `    btn.style.cursor='pointer';\n`;
        animScript += `  });\n`;

        animScript += `})();\n`;
      }

      // Visibility fix for JS-dependent elements
      animScript += `// Visibility fix\n`;
      animScript += `document.querySelectorAll('[style*="visibility: hidden"],[style*="visibility:hidden"]').forEach(el=>{\n`;
      animScript += `  if(!el.closest('[class*="modal"],[class*="Modal"],[class*="overlay"],[class*="Overlay"]'))el.style.visibility="visible";\n`;
      animScript += `});\n`;
      animScript += `document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"]').forEach(el=>{\n`;
      animScript += `  if(!el.closest('[class*="modal"],[class*="Modal"]'))el.style.opacity="1";\n`;
      animScript += `});\n`;

      // Pointer events for interactive elements
      animScript += `document.querySelectorAll('button,a,[role="button"]').forEach(el=>{\n`;
      animScript += `  el.style.pointerEvents="auto";el.style.cursor="pointer";\n`;
      animScript += `});\n`;

      fs.writeFileSync(`${OUT}/data/animations.js`, animScript);
      console.log(`     Animation script: ${animScript.length} chars`);
      sharedAnimScript = animScript;
    }

    // Download extra videos from bundles
    const allVidPathsFromBundles = new Set();
    const vidInBundle = (fullBundleCode || '').match(/\/videos\/[^"'\s\\,)]+\.(?:mp4|webm|m4v)/g);
    if (vidInBundle) vidInBundle.forEach(v => allVidPathsFromBundles.add(v));
    const pageVidPaths = await page.evaluate(() => {
      const paths = new Set();
      const html = document.documentElement.outerHTML;
      const matches = html.match(/\/videos\/[^"'\s\\]+\.(?:mp4|webm|m4v)/g);
      if (matches) matches.forEach(m => paths.add(m.replace(/\\/g, '')));
      document.querySelectorAll('video,video source').forEach(v => { if(v.src) try{paths.add(new URL(v.src).pathname)}catch(e){} });
      return [...paths];
    });
    const allVidPaths = [...new Set([...allVidPathsFromBundles, ...pageVidPaths])];
    for (const vPath of allVidPaths) {
      try {
        const a = DOMAIN + vPath;
        if (urlMap[vPath] || urlMap[a]) continue;
        const nm = `vid-${vidC}.mp4`;
        if (await dl(a, `${OUT}/videos/${nm}`)) { mapAsset(vPath, `/videos/${nm}`); mapAsset(a, `/videos/${nm}`); vidC++; }
      } catch(e) {}
    }
  }

  // ── Download new images on subsequent pages ──
  if (!isFirst) {
    const newImgs = await page.evaluate(() => {
      const f = [];
      document.querySelectorAll('img[src],[data-src]').forEach(el => {
        const s = el.src || el.getAttribute('data-src');
        if (s && !s.startsWith('data:')) f.push(s);
      });
      return f;
    });
    for (const url of newImgs) {
      if (urlMap[url]) continue;
      try { const a=new URL(url,DOMAIN).href; if(urlMap[a])continue; const ext=path.extname(new URL(a).pathname).split('?')[0]||'.jpg'; const nm=`img-${imgC}${ext}`; if(await dl(a,`${OUT}/images/${nm}`)){mapAsset(url,`/images/${nm}`);imgC++;} } catch(e) {}
    }
  }

  // ── Capture rendered DOM ──
  const renderedHTML = await page.content();

  // ── Assemble this page ──
  let html = renderedHTML;

  // Strip all scripts
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  // Strip Next.js hidden payloads
  html = html.replace(/<div hidden=""[^>]*>[\s\S]*?<\/div>/, '');
  // Strip React comments
  html = html.replace(/<!--\/?\$\??-->/g, '');

  // ═══════════════════════════════════════
  // FIX #3: Remove dead <link> and <script> references
  // ═══════════════════════════════════════
  // Remove <link rel="stylesheet"> pointing to framework paths (CSS is now inlined)
  html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="[^"]*\/_next\/[^"]*"[^>]*>/g, '');
  html = html.replace(/<link[^>]*href="[^"]*\/_next\/[^"]*"[^>]*rel="stylesheet"[^>]*>/g, '');
  // Remove <link rel="preload"> for CSS/JS from framework
  html = html.replace(/<link[^>]*rel="preload"[^>]*href="[^"]*\/_next\/[^"]*"[^>]*>/g, '');
  html = html.replace(/<link[^>]*href="[^"]*\/_next\/[^"]*"[^>]*rel="preload"[^>]*>/g, '');
  // Remove <link rel="prefetch"> for JS chunks
  html = html.replace(/<link[^>]*rel="prefetch"[^>]*href="[^"]*\/_next\/[^"]*"[^>]*>/g, '');
  html = html.replace(/<link[^>]*href="[^"]*\/_next\/[^"]*"[^>]*rel="prefetch"[^>]*>/g, '');
  // Also handle _nuxt, _astro, etc
  html = html.replace(/<link[^>]*href="[^"]*\/_(next|nuxt|astro)\/[^"]*"[^>]*>/g, '');
  // Remove <link rel="preconnect"> pointing to framework assets
  html = html.replace(/<link[^>]*rel="preconnect"[^>]*href="\/index\.html"[^>]*>/g, '');
  // Remove empty <noscript> tags
  html = html.replace(/<noscript[^>]*><\/noscript>/g, '');

  // Rewrite asset URLs (sort by length to avoid partial matches)
  const sorted = Object.entries(urlMap).sort((a,b) => b[0].length - a[0].length);
  for (const [orig, local] of sorted) {
    try { html = html.replace(new RegExp(orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), local); } catch(e) {}
  }

  // Rewrite internal links to local paths
  for (const link of [...crawled, ...queue]) {
    try { html = html.replace(new RegExp(`href="${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'), `href="${pathToFile(link)}"`); } catch(e) {}
  }

  // ═══════════════════════════════════════
  // FIX #5: Canvas → static fallback when no frame sequence JS
  // ═══════════════════════════════════════
  const hasWebGLSeqs = webglCanvases && webglCanvases.length > 0 && fs.existsSync(`${OUT}/sequences`);
  let ci = 0;
  const logoVid = Object.entries(urlMap).find(([k,v]) => v.startsWith('/videos/') && (k.includes('logo') || k.includes('animation')))?.[1];
  const anyVid = Object.values(urlMap).find(v => v.startsWith('/videos/'));

  html = html.replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/g, (match) => {
    const idx = ci++;
    // If we have WebGL frame sequences AND animation script to play them, keep canvas
    if (hasWebGLSeqs && sharedAnimScript && sharedAnimScript.includes(`webgl-${idx}`)) return match;
    // Otherwise replace with video or static image fallback
    if (logoVid && idx === 0) return `<video autoplay muted playsinline loop style="width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0" src="${logoVid}"></video>`;
    if (anyVid && idx === 0) return `<video autoplay muted playsinline loop style="width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0" src="${anyVid}"></video>`;
    if (fs.existsSync(`${OUT}/images/canvas-${idx}.png`)) return `<img src="/images/canvas-${idx}.png" style="width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0"/>`;
    return '';
  });

  // Fix blocking classes
  html = html.replace(/\block-scroll\b/g, '');
  html = html.replace(/\blenis-stopped\b/g, '');

  // ═══════════════════════════════════════
  // Inject CSS (raw fetched, not corrupted by cssRules expansion)
  // ═══════════════════════════════════════
  html = html.replace('</head>', `
<style>${rawCSS}</style>
<style>
/* X-Ray v9 fixes */
html,body{overflow-y:auto!important;overflow-x:hidden!important;scroll-behavior:smooth}
html{scrollbar-width:none}
html::-webkit-scrollbar{display:none}
body{font-feature-settings:normal;text-rendering:optimizeLegibility}
/* Responsive viewport vars */
</style>
<link rel="icon" href="/favicon.ico"/>
</head>`);

  // Remove the original page's inline <style> blocks (from framework SSR)
  // Our rawCSS (fetched from server) replaces them. Only strip blocks that came
  // from the rendered HTML — our injected blocks are added AFTER </head> replacement.
  // Strategy: strip style blocks that appear BEFORE our injection point (inside <head>
  // from the original page) and are large framework CSS (contain __ class patterns)
  html = html.replace(/<style>([^<]{2000,})<\/style>/g, (match, content) => {
    // Keep our injected blocks (they contain our marker comments)
    if (content.includes('X-Ray v9')) return match;
    if (content.includes('/* http')) return match; // Our rawCSS starts with /* http... */
    // Strip large original framework style blocks
    if (content.includes('__')) return '';
    return match;
  });

  // Inject animation script
  const scriptContent = sharedAnimScript || `
document.querySelectorAll('button,a,[role="button"]').forEach(el=>{el.style.pointerEvents='auto';el.style.cursor='pointer'});
document.querySelectorAll('[style*="visibility: hidden"],[style*="visibility:hidden"]').forEach(el=>{el.style.visibility="visible"});
document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"]').forEach(el=>{if(!el.closest('[class*="modal"],[class*="Modal"]'))el.style.opacity="1"});
`;

  html = html.replace('</body>', `
${cdnScripts.map(u => `<script src="${u}"></script>`).join('\n')}
<script>
// Responsive viewport variables
(function(){
  function setVW(){document.documentElement.style.setProperty('--vw',window.innerWidth+'px');document.documentElement.style.setProperty('--vh',window.innerHeight+'px');document.documentElement.style.setProperty('--ivh',window.innerHeight+'px')}
  setVW();window.addEventListener('resize',setVW);
})();
${scriptContent}
</script>
</body>`);

  // Write
  const filePath = pathToFile(urlPath);
  const fullPath = path.join(OUT, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, html);
  console.log(`     → ${filePath} (${(html.length/1024).toFixed(0)}KB)`);

  // Screenshot
  await page.evaluate(() => window.scrollTo(0,0)); await page.waitForTimeout(300);
  const ssName = urlPath === '/' ? 'reference' : urlPath.replace(/\//g, '_').replace(/^_/, '');
  await page.screenshot({ path: `${OUT}/data/${ssName}.png`, fullPage: true }).catch(() => {});
}

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════
async function main() {
  for (const d of ['images','fonts','videos','data']) fs.mkdirSync(`${OUT}/${d}`, { recursive: true });

  console.log(`\n🔬 Site X-Ray v9\n   ${TARGET} → ${OUT}\n   Max pages: ${MAX_PAGES}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  await context.addInitScript(() => {
    // Force preserveDrawingBuffer on WebGL contexts
    const _origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, attrs) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')
        attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
      return _origGetContext.call(this, type, attrs);
    };
    window.__xray = { library: '' };
    const iv = setInterval(() => {
      if (window.gsap && !window.gsap.__xp) { window.gsap.__xp = true; window.__xray.library += 'gsap,'; }
      if (window.ScrollTrigger && !window.ScrollTrigger.__xp) { window.ScrollTrigger.__xp = true; window.__xray.library += 'scrolltrigger,'; }
      if (window.Lenis && !window.Lenis.__xp) { window.Lenis.__xp = true; window.__xray.library += 'lenis,'; }
      if (window.LocomotiveScroll) window.__xray.library += 'locomotive,';
    }, 50);
    setTimeout(() => clearInterval(iv), 15000);

    // Style timeline poller
    window.__timeline = [];
    window.__timelineStart = Date.now();
    window.__trackedEls = new Map();

    function sel(el) {
      if (!el || !el.tagName) return null;
      const cls = (el.className?.toString() || '').split(/\s+/).find(c => c.includes('__') && c.includes('_'));
      if (cls) return '.' + cls;
      if (el.id) return '#' + el.id;
      return null;
    }

    function startPoller() {
      const check = () => {
        document.querySelectorAll('[style]').forEach(el => {
          if (window.__trackedEls.has(el)) return;
          const s = sel(el); if (!s) return;
          const style = el.getAttribute('style') || '';
          if (style.match(/opacity|transform|translate|scale|rotate/)) {
            window.__trackedEls.set(el, s);
          }
        });
      };
      document.querySelectorAll('*').forEach(el => {
        if (window.__trackedEls.has(el)) return;
        const cs = getComputedStyle(el);
        if ((cs.transition && cs.transition !== 'all 0s ease 0s' && cs.transition !== '') || (cs.animation && !cs.animation.includes('none'))) {
          const s = sel(el); if (s) window.__trackedEls.set(el, s);
        }
      });
      setInterval(() => {
        check();
        const t = Date.now() - window.__timelineStart;
        window.__trackedEls.forEach((selector, el) => {
          try {
            const cs = getComputedStyle(el);
            const snap = { opacity: cs.opacity, transform: cs.transform, visibility: cs.visibility };
            const inl = el.getAttribute('style') || '';
            const progMatch = inl.match(/--progress\s*:\s*([^;]+)/);
            if (progMatch) snap['--progress'] = progMatch[1].trim();
            const bhMatch = inl.match(/--base-height\s*:\s*([^;]+)/);
            if (bhMatch) snap['--base-height'] = bhMatch[1].trim();
            const last = window.__timeline.filter(f => f.el === selector).pop();
            if (!last || last.opacity !== snap.opacity || last.transform !== snap.transform || last['--progress'] !== snap['--progress']) {
              window.__timeline.push({ t, el: selector, ...snap });
            }
          } catch(e) {}
        });
      }, 50);
    }

    if (document.body) startPoller();
    else document.addEventListener('DOMContentLoaded', startPoller);
  });

  const page = await context.newPage();
  page.on('response', async res => { try { if (res.status() === 200) networkURLs.add(res.url()) } catch(e) {} });

  // Crawl loop
  let n = 0;
  while (queue.length > 0 && n < MAX_PAGES) {
    const p = queue.shift(); if (crawled.has(p)) continue; crawled.add(p);
    try { await capturePage(page, p, n === 0); n++; } catch(e) { console.log(`     ❌ ${e.message}`) }
  }

  const totalFiles = fs.readdirSync(OUT, { recursive: true }).filter(f => !f.includes('data/')).length;
  const totalSize = parseInt(require('child_process').execSync(`du -sk "${OUT}" 2>/dev/null`).toString().split('\t')[0]) || 0;

  console.log(`\n✅ Clone ready — ${n} pages`);
  console.log(`   ${imgC} images, ${fontC} fonts, ${vidC} videos`);
  console.log(`   ${totalFiles} files, ${(totalSize / 1024).toFixed(1)}MB`);
  console.log(`   Pages: ${[...crawled].join(', ')}`);
  console.log(`\n   cd ${OUT} && python3 -m http.server 3037\n`);

  await browser.close();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
