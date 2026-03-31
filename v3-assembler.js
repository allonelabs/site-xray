#!/usr/bin/env node
/**
 * X-Ray to Code v2 — Universal site clone assembler
 *
 * Reads Site X-Ray v2 output and produces a self-contained static clone.
 * Uses: rendered DOM, computed CSS, auto-generated animation script,
 * clone config (CDN scripts, framework detection).
 *
 * Usage: NODE_PATH=$(npm root -g) node xray-to-code.js <xray-dir> <output-dir> [assets-dir]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const XRAY_DIR = process.argv[2];
const OUT_DIR = process.argv[3];
const ASSETS_DIR = process.argv[4]; // Optional: pre-downloaded assets

if (!XRAY_DIR || !OUT_DIR) {
  console.log('Usage: node xray-to-code.js <xray-dir> <output-dir> [assets-dir]');
  process.exit(1);
}

function loadJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(XRAY_DIR, file), 'utf-8'));
}
function loadText(file) {
  return fs.readFileSync(path.join(XRAY_DIR, file), 'utf-8');
}
function exists(file) {
  return fs.existsSync(path.join(XRAY_DIR, file));
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dest);
    fs.mkdirSync(dir, { recursive: true });
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { file.close(); resolve(); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', () => { fs.unlink(dest, () => {}); resolve(); });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('📦 X-Ray to Code v2');
  console.log(`   Source: ${XRAY_DIR}`);
  console.log(`   Output: ${OUT_DIR}\n`);

  // Load X-Ray data
  const renderedDOM = loadText('rendered-dom.html');
  const allCSS = loadText('all-styles.css');
  const cloneConfig = loadJSON('clone-config.json');
  const animScript = exists('generated-animations.js') ? loadText('generated-animations.js') : '';

  console.log(`Framework: ${cloneConfig.framework}`);
  console.log(`Animation: ${cloneConfig.animationLibrary}`);
  console.log(`CDN scripts: ${cloneConfig.cdnScripts.length}`);

  // ── Step 1: Extract and process body ──
  const bodyMatch = renderedDOM.match(/<body[^>]*>([\s\S]*)<\/body>/);
  let body = bodyMatch ? bodyMatch[1] : renderedDOM;

  // Strip framework hydration scripts
  body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  body = body.replace(/<div hidden="">[\s\S]*?<\/div>/, '');

  // ── Step 2: Detect and rewrite CDN image URLs ──
  // Common CDN patterns
  const cdnPatterns = [
    { pattern: /https:\/\/www\.datocms-assets\.com\/\d+\//g, local: '/images/' },
    { pattern: /https:\/\/images\.ctfassets\.net\/[^/]+\//g, local: '/images/' },
    { pattern: /https:\/\/cdn\.sanity\.io\/images\/[^/]+\/[^/]+\//g, local: '/images/' },
    { pattern: /https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/[^/]*\//g, local: '/images/' },
    { pattern: /https:\/\/images\.prismic\.io\/[^/]+\//g, local: '/images/' },
  ];

  for (const { pattern, local } of cdnPatterns) {
    body = body.replace(pattern, local);
  }
  // Strip query params from image URLs
  body = body.replace(/(\/images\/[^"?\s]+)\?[^"]*/g, '$1');

  // ── Step 3: Replace canvas elements ──
  // Replace any canvas with captured PNG (if available)
  let canvasIdx = 0;
  body = body.replace(/<canvas[^>]*>[^<]*<\/canvas>/g, () => {
    const pngFile = `canvas-${canvasIdx}.png`;
    canvasIdx++;
    if (fs.existsSync(path.join(XRAY_DIR, pngFile))) {
      return `<img src="/${pngFile}" style="width:100%;height:auto" alt="Canvas capture" />`;
    }
    return '<!-- canvas removed -->';
  });

  // Also check for video fallbacks (common pattern: canvas on desktop, video on mobile)
  // Look for video src patterns in the rendered DOM
  const videoSrcs = renderedDOM.match(/src="(\/videos\/[^"]+)"/g);
  if (videoSrcs && canvasIdx > 0) {
    // If there are videos AND canvases, the first canvas likely has a video alternative
    const firstVideoSrc = videoSrcs[0]?.replace('src="', '').replace('"', '');
    if (firstVideoSrc) {
      // Replace the first canvas-capture img with a video
      body = body.replace(
        /<img src="\/canvas-0\.png"[^>]*>/,
        `<video autoplay muted playsinline loop style="width:100%;height:auto" src="${firstVideoSrc}"></video>`
      );
    }
  }

  // ── Step 4: Extract metadata ──
  const titleMatch = renderedDOM.match(/<title>([^<]*)<\/title>/);
  const descMatch = renderedDOM.match(/name="description"\s+content="([^"]*)"/);
  const title = titleMatch ? titleMatch[1] : 'Clone';
  const description = descMatch ? descMatch[1] : '';

  // Extract font-face declarations from CSS
  const fontFaces = allCSS.match(/@font-face\s*\{[^}]+\}/g) || [];

  // ── Step 5: Build visibility overrides ──
  // Elements that start hidden (opacity:0) and need JS to show
  let overrideCSS = '/* Visibility overrides for JS-animated elements */\n';
  overrideCSS += 'html, body { overflow-y: auto !important; overflow-x: hidden !important; scroll-behavior: smooth; }\n';
  overrideCSS += 'html { scrollbar-width: none; }\n';
  overrideCSS += 'html::-webkit-scrollbar { display: none; }\n';

  // ── Step 6: Assemble HTML ──
  const cdnTags = cloneConfig.cdnScripts.map(src => `<script src="${src}"><\/script>`).join('\n');

  const finalHTML = `<!DOCTYPE html>
<html lang="en" class="lenis lenis-smooth" style="--size: 1680">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${description}" />
<link rel="icon" href="/favicon.ico" />

<!-- Computed CSS (captured from live site) -->
<style>
${allCSS}
</style>

<!-- Overrides -->
<style>
${overrideCSS}
</style>
</head>
<body>
${body}

<!-- Animation libraries (auto-detected from site) -->
${cdnTags}

<!-- Animation script (auto-generated from intercepted API calls + bundle analysis) -->
<script>
${animScript}
</script>
</body>
</html>`;

  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), finalHTML);
  console.log(`\nHTML: ${finalHTML.length} chars → ${path.join(OUT_DIR, 'index.html')}`);

  // ── Step 7: Copy/download assets ──
  console.log('\nCopying assets...');

  // Copy from assets dir if provided
  if (ASSETS_DIR && fs.existsSync(ASSETS_DIR)) {
    const copyDirs = ['images', 'fonts', 'videos', 'rives'];
    for (const dir of copyDirs) {
      const src = path.join(ASSETS_DIR, dir);
      const dest = path.join(OUT_DIR, dir);
      if (fs.existsSync(src)) {
        fs.cpSync(src, dest, { recursive: true });
        console.log(`  Copied ${dir}/`);
      }
    }
    // Copy root files
    for (const file of ['favicon.ico', 'site.webmanifest']) {
      const src = path.join(ASSETS_DIR, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(OUT_DIR, file));
        console.log(`  Copied ${file}`);
      }
    }
  }

  // Copy canvas captures from X-Ray
  for (let i = 0; i < 5; i++) {
    const src = path.join(XRAY_DIR, `canvas-${i}.png`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT_DIR, `canvas-${i}.png`));
      console.log(`  Copied canvas-${i}.png`);
    }
  }

  // Copy reference screenshot
  const refShot = path.join(XRAY_DIR, 'full-page-final.png');
  if (fs.existsSync(refShot)) {
    fs.copyFileSync(refShot, path.join(OUT_DIR, 'reference.png'));
    console.log('  Copied reference.png');
  }

  // Download assets from catalog if not already local
  if (exists('assets/asset-list.json')) {
    const assetList = loadJSON('assets/asset-list.json');
    const fontAssets = assetList.filter(a => a.url.match(/\.(woff2?|ttf|otf|eot)$/));
    const videoAssets = assetList.filter(a => a.url.match(/\.(mp4|webm)$/));
    const riveAssets = assetList.filter(a => a.url.match(/\.riv$/));

    for (const asset of [...fontAssets, ...videoAssets, ...riveAssets]) {
      const urlPath = new URL(asset.url).pathname;
      const dest = path.join(OUT_DIR, urlPath);
      if (!fs.existsSync(dest)) {
        try {
          await download(asset.url, dest);
          console.log(`  Downloaded ${path.basename(urlPath)}`);
        } catch(e) {}
      }
    }
  }

  console.log('\n✓ Clone assembled!');
  console.log(`  Serve with: cd ${OUT_DIR} && python3 -m http.server 3035`);
}

main().catch(e => { console.error(e); process.exit(1); });
