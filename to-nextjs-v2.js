#!/usr/bin/env node
/**
 * Site X-Ray → Next.js App Router Converter v2
 *
 * Reads v53 clone output (manifest.json, custom-properties.json, multi-page HTML)
 * and produces a complete Next.js 15 App Router project with:
 *   - Multi-page routing from crawled pages
 *   - Shared layout (header/footer extraction)
 *   - Custom properties → globals.css + tailwind config
 *   - Asset copying with reference rewriting
 *   - Font loading via next/font/local
 *   - Metadata from manifest.json
 *
 * Usage: node to-nextjs-v2.js <clone-dir> [output-dir] [--debug]
 *
 * No dependencies — Node.js built-ins only (fs, path, crypto).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = { debug: false };
const positional = [];
for (const a of args) {
  if (a === '--debug') flags.debug = true;
  else positional.push(a);
}

const SRC = positional[0];
if (!SRC) {
  console.log('Site X-Ray → Next.js Converter v2');
  console.log('Usage: node to-nextjs-v2.js <clone-dir> [output-dir] [--debug]');
  console.log('');
  console.log('Reads v53 manifest + custom-properties for multi-page App Router output.');
  process.exit(0);
}

const OUT = positional[1] || SRC + '-nextjs';
const srcPath = path.resolve(SRC);
const outPath = path.resolve(OUT);
const debug = (...a) => flags.debug && console.log('  [debug]', ...a);

console.log(`\n Site X-Ray → Next.js v2`);
console.log(`   Source: ${srcPath}`);
console.log(`   Output: ${outPath}\n`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function write(p, content) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
  console.log(`   + ${path.relative(outPath, p)}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return 0;
  mkdirp(dest);
  let count = 0;
  for (const f of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, f.name);
    const dp = path.join(dest, f.name);
    if (f.isDirectory()) { count += copyDir(sp, dp); }
    else { fs.copyFileSync(sp, dp); count++; }
  }
  return count;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function componentName(route) {
  if (route === '/') return 'HomePage';
  return route.split('/').filter(Boolean)
    .map(s => {
      // Strip URL-encoded chars, dots, and other non-alphanumeric chars
      const clean = decodeURIComponent(s)
        .replace(/[^a-zA-Z0-9-_]/g, '')
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        .replace(/-/g, '');
      return clean.charAt(0).toUpperCase() + clean.slice(1);
    })
    .join('') + 'Page';
}

// ── PHASE 1: Parse ──────────────────────────────────────────────────────────

console.log('Phase 1: Parse');

// 1a. Read manifest
const manifestPath = path.join(srcPath, 'data', 'manifest.json');
const manifest = readJSON(manifestPath);
if (manifest) {
  console.log(`   Manifest: ${manifest.version}, ${manifest.pageCount} pages, ${manifest.totalFiles} files`);
  debug('Pages:', manifest.pages);
} else {
  console.log('   No manifest.json found — will discover pages from HTML files');
}

// 1b. Read custom properties
const customPropsPath = path.join(srcPath, 'data', 'custom-properties.json');
const customProps = readJSON(customPropsPath);
if (customProps) {
  const propCount = Object.keys(customProps).length;
  console.log(`   Custom properties: ${propCount} selectors`);
} else {
  console.log('   No custom-properties.json found');
}

// 1c. Discover all HTML files recursively
function findHTML(dir, base) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    const rel = path.join(base, f.name);
    if (f.isDirectory()) {
      // Skip data/css/fonts/images/videos/models directories
      if (['data', 'css', 'fonts', 'images', 'videos', 'models', 'components', 'i'].includes(f.name)) continue;
      // Skip URL-encoded junk directories and hash fragments
      if (f.name.includes('?') || f.name.includes('&') || f.name.includes('%')) continue;
      if (f.name.includes('#')) continue;
      results = results.concat(findHTML(full, rel));
    } else if (f.name === 'index.html') {
      results.push({ file: full, route: '/' + base.replace(/\\/g, '/') });
    } else if (f.name.endsWith('.html')) {
      const name = f.name.replace('.html', '');
      results.push({ file: full, route: '/' + path.join(base, name).replace(/\\/g, '/') });
    }
  }
  return results;
}

// Root index.html
const allPages = [];
const rootIndex = path.join(srcPath, 'index.html');
if (fs.existsSync(rootIndex)) {
  allPages.push({ file: rootIndex, route: '/' });
}

// Subdirectory pages
const subPages = findHTML(srcPath, '');
for (const p of subPages) {
  // Normalize route
  let route = p.route.replace(/\/+/g, '/');
  if (route !== '/' && route.endsWith('/')) route = route.slice(0, -1);
  // Skip root index (already added) and junk routes
  if (route === '/' || route === '/.') continue;
  if (route.includes('?') || route.includes('&') || route.includes('%') || route.includes('#')) continue;
  // Dedupe
  if (!allPages.find(x => x.route === route)) {
    allPages.push({ file: p.file, route });
  }
}

// If manifest specifies pages, prioritize those
let targetPages = allPages;
if (manifest && manifest.pages && manifest.pages.length > 0) {
  const manifestRoutes = new Set(manifest.pages.map(p => p === '/' ? '/' : p.replace(/\/+$/, '')));
  // Filter to manifest pages, but keep others as bonus
  const primary = allPages.filter(p => manifestRoutes.has(p.route));
  const extra = allPages.filter(p => !manifestRoutes.has(p.route));
  targetPages = [...primary, ...extra];
  console.log(`   Manifest pages: ${primary.length}, extra discovered: ${extra.length}`);
}

console.log(`   Total pages to convert: ${targetPages.length}`);

// 1d. Parse each HTML file
function parseHTML(filePath) {
  const html = fs.readFileSync(filePath, 'utf-8');

  // Extract <title>
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Extract meta description
  const descMatch = html.match(/meta[^>]*name="description"[^>]*content="([^"]*)"/i);
  const description = descMatch ? descMatch[1] : '';

  // Extract OG image
  const ogMatch = html.match(/meta[^>]*property="og:image"[^>]*content="([^"]*)"/i);
  const ogImage = ogMatch ? ogMatch[1] : '';

  // Extract viewport
  const viewportMatch = html.match(/meta[^>]*name="viewport"[^>]*content="([^"]*)"/i);
  const viewport = viewportMatch ? viewportMatch[1] : '';

  // Extract theme-color
  const themeColorMatch = html.match(/meta[^>]*name="theme-color"[^>]*content="([^"]*)"/i);
  const themeColor = themeColorMatch ? themeColorMatch[1] : '';

  // Extract charset
  const charsetMatch = html.match(/meta[^>]*charset="([^"]*)"/i);
  const charset = charsetMatch ? charsetMatch[1] : '';

  // Extract og:url, og:type, og:site_name
  const ogUrlMatch = html.match(/meta[^>]*property="og:url"[^>]*content="([^"]*)"/i);
  const ogUrl = ogUrlMatch ? ogUrlMatch[1] : '';
  const ogTypeMatch = html.match(/meta[^>]*property="og:type"[^>]*content="([^"]*)"/i);
  const ogType = ogTypeMatch ? ogTypeMatch[1] : '';
  const ogSiteNameMatch = html.match(/meta[^>]*property="og:site_name"[^>]*content="([^"]*)"/i);
  const ogSiteName = ogSiteNameMatch ? ogSiteNameMatch[1] : '';

  // Extract twitter meta
  const twitterCardMatch = html.match(/meta[^>]*name="twitter:card"[^>]*content="([^"]*)"/i);
  const twitterCard = twitterCardMatch ? twitterCardMatch[1] : '';
  const twitterSiteMatch = html.match(/meta[^>]*name="twitter:site"[^>]*content="([^"]*)"/i);
  const twitterSite = twitterSiteMatch ? twitterSiteMatch[1] : '';

  // Extract favicon and icon links
  const iconLinks = [];
  const iconRe = /<link[^>]*rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*>/gi;
  let iconM;
  while ((iconM = iconRe.exec(html)) !== null) {
    const hrefM = iconM[0].match(/href="([^"]*)"/i);
    const relM = iconM[0].match(/rel="([^"]*)"/i);
    const sizesM = iconM[0].match(/sizes="([^"]*)"/i);
    const typeM = iconM[0].match(/type="([^"]*)"/i);
    if (hrefM) {
      iconLinks.push({
        href: hrefM[1],
        rel: relM ? relM[1] : 'icon',
        sizes: sizesM ? sizesM[1] : '',
        type: typeM ? typeM[1] : '',
      });
    }
  }

  // Extract CSS link references
  const cssLinks = [];
  const cssLinkRe = /<link[^>]*href="([^"]*\.css)"[^>]*>/gi;
  let m;
  while ((m = cssLinkRe.exec(html)) !== null) {
    cssLinks.push(m[1]);
  }

  // Extract inline <style> blocks
  const styles = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleRe.exec(html)) !== null) {
    styles.push(m[1]);
  }

  // Extract body content
  const bodyStart = html.indexOf('<body');
  const bodyTagEnd = bodyStart >= 0 ? html.indexOf('>', bodyStart) + 1 : -1;
  const bodyEnd = html.lastIndexOf('</body>');
  const bodyContent = bodyTagEnd > 0 && bodyEnd > bodyTagEnd
    ? html.substring(bodyTagEnd, bodyEnd)
    : '';

  // Extract body class/attributes
  const bodyTagMatch = html.match(/<body([^>]*)>/i);
  const bodyAttrs = bodyTagMatch ? bodyTagMatch[1].trim() : '';
  const bodyClassMatch = bodyAttrs.match(/class="([^"]*)"/);
  const bodyClass = bodyClassMatch ? bodyClassMatch[1] : '';

  // Extract <html> attributes
  const htmlTagMatch = html.match(/<html([^>]*)>/i);
  const htmlAttrs = htmlTagMatch ? htmlTagMatch[1].trim() : '';
  const htmlClassMatch = htmlAttrs.match(/class="([^"]*)"/);
  const htmlClass = htmlClassMatch ? htmlClassMatch[1] : '';
  const htmlStyleMatch = htmlAttrs.match(/style="([^"]*)"/);
  const htmlStyle = htmlStyleMatch ? htmlStyleMatch[1] : '';

  // Extract CDN scripts
  const cdnScripts = [];
  const cdnRe = /<script[^>]*src="(https?:\/\/[^"]+)"[^>]*><\/script>/gi;
  while ((m = cdnRe.exec(html)) !== null) cdnScripts.push(m[1]);

  // Extract font preloads
  const fontPreloads = [];
  const fontPreloadRe = /<link[^>]*href="([^"]*\/fonts\/[^"]*)"[^>]*>/gi;
  while ((m = fontPreloadRe.exec(html)) !== null) fontPreloads.push(m[1]);

  return { title, description, ogImage, viewport, themeColor, charset, ogUrl, ogType, ogSiteName, twitterCard, twitterSite, iconLinks, cssLinks, styles, bodyContent, bodyClass, bodyAttrs, htmlClass, htmlStyle, cdnScripts, fontPreloads };
}

const parsedPages = {};
for (const page of targetPages) {
  try {
    parsedPages[page.route] = parseHTML(page.file);
    debug(`Parsed ${page.route}: ${(parsedPages[page.route].bodyContent.length / 1024).toFixed(0)}KB body`);
  } catch (e) {
    console.log(`   WARNING: Failed to parse ${page.file}: ${e.message}`);
  }
}

// 1e. Identify shared header/footer across pages
let sharedHeader = '';
let sharedFooter = '';

if (Object.keys(parsedPages).length >= 2) {
  const pageRoutes = Object.keys(parsedPages);
  const first = parsedPages[pageRoutes[0]].bodyContent;
  const second = parsedPages[pageRoutes[1]].bodyContent;

  // Strategy: find the <header> or element with id/data containing "header"
  const headerRe = /(<(?:header|nav)[^>]*(?:data-navigation-header|id="header|class="[^"]*header)[^>]*>[\s\S]*?<\/(?:header|nav)>)/i;
  const h1 = first.match(headerRe);
  const h2 = second.match(headerRe);

  if (h1 && h2) {
    // Use the shorter one (more likely to be just the nav, not the whole page)
    sharedHeader = h1[0].length <= h2[0].length ? h1[0] : h2[0];
    debug(`Shared header found: ${(sharedHeader.length / 1024).toFixed(1)}KB`);
  }

  // Footer: find <footer> tag
  const footerRe = /(<footer[^>]*>[\s\S]*?<\/footer>)/i;
  const f1 = first.match(footerRe);
  const f2 = second.match(footerRe);

  if (f1 && f2) {
    sharedFooter = f1[0].length <= f2[0].length ? f1[0] : f2[0];
    debug(`Shared footer found: ${(sharedFooter.length / 1024).toFixed(1)}KB`);
  }
}

console.log(`   Shared header: ${sharedHeader ? (sharedHeader.length / 1024).toFixed(1) + 'KB' : 'none detected'}`);
console.log(`   Shared footer: ${sharedFooter ? (sharedFooter.length / 1024).toFixed(1) + 'KB' : 'none detected'}`);

// 1f. Detect libraries
const rootParsed = parsedPages['/'] || parsedPages[Object.keys(parsedPages)[0]] || {};
const allCDNScripts = new Set();
for (const p of Object.values(parsedPages)) {
  for (const s of (p.cdnScripts || [])) allCDNScripts.add(s);
}

const hasGSAP = [...allCDNScripts].some(s => s.includes('gsap'));
const hasThree = [...allCDNScripts].some(s => s.includes('three'));
const hasLenis = [...allCDNScripts].some(s => s.includes('lenis'));
debug(`Libraries: GSAP=${hasGSAP}, Three=${hasThree}, Lenis=${hasLenis}`);

// ── PHASE 2: Extract ────────────────────────────────────────────────────────

console.log('\nPhase 2: Extract');
mkdirp(outPath);

// 2a. Copy assets
console.log('   Copying assets...');
const assetDirs = ['fonts', 'images', 'videos', 'models', 'css'];
let totalAssets = 0;
for (const d of assetDirs) {
  const c = copyDir(path.join(srcPath, d), path.join(outPath, 'public', d));
  if (c) console.log(`     ${d}/: ${c} files`);
  totalAssets += c;
}

// Copy root-level assets
const rootAssetExts = /\.(glb|gltf|png|jpg|jpeg|webp|ico|svg|json|mp4|webm|woff|woff2|ttf|otf|eot)$/i;
if (fs.existsSync(srcPath)) {
  for (const f of fs.readdirSync(srcPath)) {
    if (rootAssetExts.test(f) && f !== 'package.json') {
      mkdirp(path.join(outPath, 'public'));
      fs.copyFileSync(path.join(srcPath, f), path.join(outPath, 'public', f));
      totalAssets++;
    }
  }
}

// Copy image/ directory (Vercel-style CDN path rewrites)
const imageDir = path.join(srcPath, 'image');
if (fs.existsSync(imageDir)) {
  const c = copyDir(imageDir, path.join(outPath, 'public', 'image'));
  if (c) console.log(`     image/: ${c} files`);
  totalAssets += c;
}

// Copy data/ screenshots to public for reference
const dataDir = path.join(srcPath, 'data');
if (fs.existsSync(dataDir)) {
  mkdirp(path.join(outPath, 'public', 'data'));
  for (const f of fs.readdirSync(dataDir)) {
    if (/\.(png|jpg|jpeg|webp|svg)$/i.test(f)) {
      fs.copyFileSync(path.join(dataDir, f), path.join(outPath, 'public', 'data', f));
      totalAssets++;
    }
  }
}

console.log(`   Total assets: ${totalAssets}`);

// 2b. Detect fonts — discover up to 5 key fonts by weight/style heuristics
const fontDir = path.join(srcPath, 'fonts');
const fontFiles = [];
const keyFonts = []; // Up to 5 primary fonts loaded via next/font/local
const remainingFonts = []; // Rest preloaded via <link rel="preload">
if (fs.existsSync(fontDir)) {
  const all = fs.readdirSync(fontDir);
  // Prefer woff2, then woff, then ttf/otf
  const allFontFiles = all.filter(f => /\.woff2?$/.test(f));
  const ttfOtf = all.filter(f => /\.(ttf|otf)$/.test(f));
  const candidates = allFontFiles.length ? allFontFiles : ttfOtf;
  fontFiles.push(...candidates);

  // Prioritize: Regular > Bold > Medium > Italic > Mono > Display
  const priorities = ['regular', 'normal', '400', 'bold', '700', 'medium', '500', 'mono', 'italic', 'display', 'light', '300'];
  const sorted = [...candidates].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aIdx = priorities.findIndex(p => aLower.includes(p));
    const bIdx = priorities.findIndex(p => bLower.includes(p));
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });
  keyFonts.push(...sorted.slice(0, 5));
  remainingFonts.push(...sorted.slice(5));
}
const primaryFont = keyFonts[0] || null;
console.log(`   Key fonts (next/font): ${keyFonts.length ? keyFonts.join(', ') : 'none'}`);
console.log(`   Preload fonts: ${remainingFonts.length}`);
console.log(`   Total font files: ${fontFiles.length}`);

// 2c. Extract per-page body content (strip shared header/footer)
function stripShared(body) {
  let result = body;
  if (sharedHeader) {
    // Remove header from body — use first 200 chars as anchor
    const headerAnchor = sharedHeader.slice(0, 200);
    const idx = result.indexOf(headerAnchor);
    if (idx >= 0) {
      // Find the end of the header block
      const endIdx = result.indexOf(sharedHeader.slice(-50));
      if (endIdx >= 0) {
        result = result.slice(0, idx) + result.slice(endIdx + 50);
      }
    }
  }
  if (sharedFooter) {
    const footerAnchor = sharedFooter.slice(0, 200);
    const idx = result.indexOf(footerAnchor);
    if (idx >= 0) {
      result = result.slice(0, idx);
    }
  }
  return result;
}

// 2d. Collect all CSS link references for each page
const allCSSFiles = new Set();
for (const p of Object.values(parsedPages)) {
  for (const css of (p.cssLinks || [])) {
    allCSSFiles.add(css);
  }
}
console.log(`   CSS files referenced: ${allCSSFiles.size}`);

// 2e. Collect all inline styles (deduplicated, capped at 500KB to avoid bloat)
const MAX_INLINE_STYLES_KB = 500;
let allInlineStyles = '';
const seenStyles = new Set();
let inlineStylesTruncated = false;
for (const p of Object.values(parsedPages)) {
  for (const s of (p.styles || [])) {
    if (allInlineStyles.length > MAX_INLINE_STYLES_KB * 1024) {
      inlineStylesTruncated = true;
      break;
    }
    const hash = crypto.createHash('md5').update(s).digest('hex');
    if (!seenStyles.has(hash)) {
      seenStyles.add(hash);
      allInlineStyles += s + '\n\n';
    }
  }
  if (inlineStylesTruncated) break;
}
console.log(`   Inline styles extracted: ${(allInlineStyles.length / 1024).toFixed(0)}KB${inlineStylesTruncated ? ' (capped)' : ''}`);

// ── PHASE 3: Generate ───────────────────────────────────────────────────────

console.log('\nPhase 3: Generate');

// Get metadata from manifest or parsed index
const meta = manifest?.metadata || {};
const siteTitle = meta.title || rootParsed.title || 'Cloned Site';
const siteDesc = meta.description || rootParsed.description || '';
const ogImage = meta.ogImage || rootParsed.ogImage || '';
const siteName = slugify(siteTitle).slice(0, 40) || 'site-clone';

// 3a. package.json
const deps = {
  "next": "15.3.2",
  "react": "^19.1.0",
  "react-dom": "^19.1.0",
};
if (hasThree) deps["three"] = "^0.171.0";
if (hasGSAP) deps["gsap"] = "^3.12.7";
if (hasLenis) deps["lenis"] = "^1.3.20";

const devDeps = {
  "@types/node": "^22.0.0",
  "@types/react": "^19.0.0",
  "@types/react-dom": "^19.0.0",
  "typescript": "^5.8.0",
  "tailwindcss": "^3.4.17",
  "postcss": "^8.5.0",
  "autoprefixer": "^10.4.20",
};
if (hasThree) devDeps["@types/three"] = "^0.171.0";

write(path.join(outPath, 'package.json'), JSON.stringify({
  name: siteName,
  version: "0.1.0",
  private: true,
  scripts: {
    dev: "next dev",
    build: "next build",
    start: "next start",
    lint: "next lint"
  },
  dependencies: deps,
  devDependencies: devDeps,
}, null, 2));

// 3b. tsconfig.json
write(path.join(outPath, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: "ES2017",
    lib: ["dom", "dom.iterable", "esnext"],
    allowJs: true,
    skipLibCheck: true,
    strict: false,
    noEmit: true,
    esModuleInterop: true,
    module: "esnext",
    moduleResolution: "bundler",
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: "preserve",
    incremental: true,
    plugins: [{ name: "next" }],
    paths: { "@/*": ["./*"] }
  },
  include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  exclude: ["node_modules"]
}, null, 2));

// 3c. next.config.ts
write(path.join(outPath, 'next.config.ts'), `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow external images (OG images, CDN assets)
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  // Suppress hydration warnings from cloned HTML
  reactStrictMode: false,
};

export default nextConfig;
`);

// 3d. tailwind.config.ts
// Extract meaningful custom properties for tailwind extend
const tailwindColors = {};
const tailwindFonts = {};

if (customProps) {
  for (const [selector, props] of Object.entries(customProps)) {
    for (const [prop, value] of Object.entries(props)) {
      // Extract font families
      if (prop === '--font-sans' || prop === '--font-mono') {
        const key = prop.replace('--font-', '');
        tailwindFonts[key] = `var(${prop})`;
      }
      // Extract simple color values (not recursive var refs)
      if (prop.match(/--ds-(gray|red|blue|green|yellow|orange|purple|pink)-\d+/) && !value.includes('var(')) {
        const name = prop.replace('--ds-', '').replace(/-/g, '.');
        tailwindColors[name] = value;
      }
    }
  }
}

const fontExtend = Object.keys(tailwindFonts).length
  ? `\n    fontFamily: {\n${Object.entries(tailwindFonts).map(([k, v]) => `      '${k}': ['${v}'],`).join('\n')}\n    },`
  : '';

write(path.join(outPath, 'tailwind.config.ts'), `import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx,js,jsx}",
    "./components/**/*.{ts,tsx,js,jsx}",
  ],
  theme: {
    extend: {${fontExtend}
    },
  },
  plugins: [],
};

export default config;
`);

// 3e. postcss.config.mjs
write(path.join(outPath, 'postcss.config.mjs'), `/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
`);

// 3f. globals.css — combine custom properties + inline styles + tailwind directives
let globalsCSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

/* ── Custom Properties from site clone ── */
:root {
`;

// Extract :root-level custom properties
if (customProps) {
  const rootSelectors = [':root', 'html', 'body'];
  const seen = new Set();
  for (const [selector, props] of Object.entries(customProps)) {
    // Only include root-level or common vars (skip deeply scoped ones)
    const isRoot = rootSelectors.some(s => selector.includes(s));
    const isVar = selector.includes('variable') || selector.includes('__variable');
    if (isRoot || isVar) {
      for (const [prop, value] of Object.entries(props)) {
        if (!seen.has(prop)) {
          seen.add(prop);
          // Skip data URI values (too long)
          if (value.length < 200) {
            globalsCSS += `  ${prop}: ${value};\n`;
          }
        }
      }
    }
  }
}

globalsCSS += `}

/* ── Base reset ── */
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }

/* ── Ensure cloned content renders correctly ── */
img { max-width: 100%; height: auto; }
a { color: inherit; text-decoration: none; }
`;

// v53 fix: DON'T include inline styles in globals.css — they contain
// modern CSS that cssnano can't parse. Instead, concatenate all cloned
// CSS (external sheets + inline styles) into public/all-styles.css and
// load via <link> tag to bypass Next.js CSS processing entirely.
write(path.join(outPath, 'app', 'globals.css'), globalsCSS);

// 3g. Concatenate all cloned CSS into a single public/all-styles.css
const sortedCSS = [...allCSSFiles].sort((a, b) => {
  const numA = parseInt((a.match(/style-(\d+)/) || [])[1] || '999');
  const numB = parseInt((b.match(/style-(\d+)/) || [])[1] || '999');
  return numA - numB;
});

let allStylesCSS = '/* Concatenated clone styles — loaded via <link> to bypass Next.js CSS pipeline */\n\n';
for (const cssRef of sortedCSS) {
  const cssPath = path.join(outPath, 'public', cssRef.replace(/^\//, ''));
  try {
    allStylesCSS += fs.readFileSync(cssPath, 'utf-8') + '\n\n';
  } catch {}
}
// Append inline styles that were extracted from the clone
if (allInlineStyles.length > 0) {
  allStylesCSS += '/* Inline styles from clone pages */\n' + allInlineStyles + '\n';
}
write(path.join(outPath, 'public', 'all-styles.css'), allStylesCSS);

// 3h. app/layout.tsx

// Generate multiple localFont() declarations for key fonts
function fontVarName(filename, index) {
  // Derive a variable name from the font filename
  const base = filename.replace(/\.(woff2?|ttf|otf)$/i, '').replace(/[^a-zA-Z0-9]/g, '_');
  return index === 0 ? 'siteFont' : `font_${base}`;
}

function fontCSSVar(filename, index) {
  const base = filename.replace(/\.(woff2?|ttf|otf)$/i, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return index === 0 ? '--font-site' : `--font-${base}`;
}

let fontImport = '';
const fontVarNames = [];
if (keyFonts.length > 0) {
  fontImport += `import localFont from "next/font/local";\n\n`;
  for (let i = 0; i < keyFonts.length; i++) {
    const varName = fontVarName(keyFonts[i], i);
    const cssVar = fontCSSVar(keyFonts[i], i);
    fontVarNames.push(varName);
    fontImport += `const ${varName} = localFont({\n`;
    fontImport += `  src: "../public/fonts/${keyFonts[i]}",\n`;
    fontImport += `  variable: "${cssVar}",\n`;
    fontImport += `  display: "swap",\n`;
    fontImport += `});\n`;
    if (i < keyFonts.length - 1) fontImport += `\n`;
  }
  fontImport += `\n`;
}

// Build preload links for remaining fonts
const fontPreloadLinks = remainingFonts.map(f => {
  const ext = f.split('.').pop();
  const fontType = ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : ext === 'ttf' ? 'font/ttf' : 'font/otf';
  return `        <link rel="preload" href="/fonts/${f}" as="font" type="${fontType}" crossOrigin="anonymous" />`;
}).join('\n');

// Build className expression joining all font variables
const fontClassName = fontVarNames.length > 0
  ? '`' + fontVarNames.map(v => '${' + v + '.variable}').join(' ') + '`'
  : '""';

// Get html class and style from root page
const rootHTML = parsedPages['/'] || {};
// v53 fix: strip framework-generated class names (module hashes with dots/underscores)
// that can cause issues — keep only semantic ones
const rawHtmlClass = rootHTML.htmlClass || '';
const htmlClass = rawHtmlClass.split(/\s+/)
  .filter(c => !c.includes('__') && !c.includes('module'))
  .join(' ');
const htmlStyle = rootHTML.htmlStyle || '';
const bodyClass = rootHTML.bodyClass || '';

const escapedTitle = siteTitle.replace(/"/g, '\\"').replace(/\n/g, ' ');
const escapedDesc = siteDesc.replace(/"/g, '\\"').replace(/\n/g, ' ');

// Build the style prop — needs special handling for custom properties (TS won't type them)
const reactStyle = htmlStyleToReact(htmlStyle);
const styleAttr = reactStyle ? `style={{ ${reactStyle} } as React.CSSProperties}` : '';

// Extract extended metadata from root page
const rootMeta = parsedPages['/'] || parsedPages[Object.keys(parsedPages)[0]] || {};
const siteViewport = rootMeta.viewport || '';
const siteThemeColor = rootMeta.themeColor || '';
const siteCharset = rootMeta.charset || 'utf-8';
const siteOgUrl = rootMeta.ogUrl || '';
const siteOgType = rootMeta.ogType || '';
const siteOgSiteName = rootMeta.ogSiteName || '';
const siteTwitterCard = rootMeta.twitterCard || '';
const siteTwitterSite = rootMeta.twitterSite || '';
const siteIconLinks = rootMeta.iconLinks || [];

// Determine favicon/icon references — check what actually exists in public/
const publicDir = path.join(outPath, 'public');
const hasFaviconIco = fs.existsSync(path.join(publicDir, 'favicon.ico'));
const hasAppleTouchIcon = fs.existsSync(path.join(publicDir, 'apple-touch-icon.png'));
const hasFavicon16 = fs.existsSync(path.join(publicDir, 'favicon-16x16.png'));
const hasFavicon32 = fs.existsSync(path.join(publicDir, 'favicon-32x32.png'));

// Build icons metadata
let iconsMetadata = '';
const iconEntries = [];
if (hasFaviconIco) {
  iconEntries.push(`      { url: "/favicon.ico", sizes: "any" }`);
}
if (hasFavicon16) {
  iconEntries.push(`      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" }`);
}
if (hasFavicon32) {
  iconEntries.push(`      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" }`);
}
// Also include icon links extracted from HTML that point to local files
for (const ic of siteIconLinks) {
  if (ic.rel !== 'apple-touch-icon') {
    const localHref = ic.href.replace(/^https?:\/\/[^/]+/, '');
    const localPath = path.join(publicDir, localHref.replace(/^\//, ''));
    if (fs.existsSync(localPath) && !iconEntries.some(e => e.includes(localHref))) {
      const entry = `      { url: "${localHref}"${ic.sizes ? `, sizes: "${ic.sizes}"` : ''}${ic.type ? `, type: "${ic.type}"` : ''} }`;
      iconEntries.push(entry);
    }
  }
}
const appleEntries = [];
if (hasAppleTouchIcon) {
  appleEntries.push(`      { url: "/apple-touch-icon.png", sizes: "180x180" }`);
}
for (const ic of siteIconLinks) {
  if (ic.rel === 'apple-touch-icon') {
    const localHref = ic.href.replace(/^https?:\/\/[^/]+/, '');
    const localPath = path.join(publicDir, localHref.replace(/^\//, ''));
    if (fs.existsSync(localPath) && !appleEntries.some(e => e.includes(localHref))) {
      const entry = `      { url: "${localHref}"${ic.sizes ? `, sizes: "${ic.sizes}"` : ''} }`;
      appleEntries.push(entry);
    }
  }
}
if (iconEntries.length || appleEntries.length) {
  iconsMetadata = `  icons: {\n`;
  if (iconEntries.length) {
    iconsMetadata += `    icon: [\n${iconEntries.join(',\n')},\n    ],\n`;
  }
  if (appleEntries.length) {
    iconsMetadata += `    apple: [\n${appleEntries.join(',\n')},\n    ],\n`;
  }
  iconsMetadata += `  },`;
}

// Build openGraph metadata
let openGraphMeta = '';
if (ogImage || siteOgUrl || siteOgType || siteOgSiteName) {
  const ogParts = [];
  if (ogImage) ogParts.push(`    images: ["${ogImage}"],`);
  if (siteOgUrl) ogParts.push(`    url: "${siteOgUrl}",`);
  if (siteOgType) ogParts.push(`    type: "${siteOgType}",`);
  if (siteOgSiteName) ogParts.push(`    siteName: "${siteOgSiteName.replace(/"/g, '\\"')}",`);
  openGraphMeta = `  openGraph: {\n${ogParts.join('\n')}\n  },`;
}

// Build twitter metadata
let twitterMeta = '';
if (siteTwitterCard || siteTwitterSite) {
  const twParts = [];
  if (siteTwitterCard) twParts.push(`    card: "${siteTwitterCard}",`);
  if (siteTwitterSite) twParts.push(`    site: "${siteTwitterSite}",`);
  twitterMeta = `  twitter: {\n${twParts.join('\n')}\n  },`;
}

// Build other metadata
let otherMeta = '';
if (siteThemeColor) {
  otherMeta += `  other: {\n    "theme-color": "${siteThemeColor}",\n  },`;
}

// Build className expression for <html>
const allFontVarsExpr = fontVarNames.length > 0
  ? fontVarNames.map(v => '${' + v + '.variable}').join(' ')
  : '';

const layoutContent = [
  `import type { Metadata, Viewport } from "next";`,
  fontImport ? fontImport : null,
  `import "./globals.css";`,
  `// Clone CSS loaded via <link> in <head> to bypass Next.js cssnano processing`,
  `import { SiteHeader } from "./components/SiteHeader";`,
  `import { SiteFooter } from "./components/SiteFooter";`,
  ``,
  siteViewport ? `export const viewport: Viewport = {\n  themeColor: "${siteThemeColor || '#000000'}",\n  width: "device-width",\n  initialScale: 1,\n};\n` : null,
  `export const metadata: Metadata = {`,
  `  title: "${escapedTitle}",`,
  `  description: "${escapedDesc}",`,
  openGraphMeta || null,
  twitterMeta || null,
  iconsMetadata || null,
  otherMeta || null,
  `};`,
  ``,
  `export default function RootLayout({ children }: { children: React.ReactNode }) {`,
  `  return (`,
  `    <html`,
  `      lang="en"`,
  fontVarNames.length > 0
    ? `      className={\`${htmlClass ? htmlClass + ' ' : ''}${allFontVarsExpr}\`}`
    : (htmlClass ? `      className="${htmlClass}"` : null),
  styleAttr ? `      ${styleAttr}` : null,
  `      suppressHydrationWarning`,
  `    >`,
  `      <head>`,
  `        <link rel="stylesheet" href="/all-styles.css" />`,
  fontPreloadLinks || null,
  `      </head>`,
  bodyClass ? `      <body className="${bodyClass}">` : `      <body>`,
  `        <SiteHeader />`,
  `        {children}`,
  `        <SiteFooter />`,
  `      </body>`,
  `    </html>`,
  `  );`,
  `}`,
].filter(l => l !== null).join('\n') + '\n';

write(path.join(outPath, 'app', 'layout.tsx'), layoutContent);

// 3i. SiteHeader component
mkdirp(path.join(outPath, 'app', 'components'));

if (sharedHeader) {
  write(path.join(outPath, 'app', 'components', 'SiteHeader.tsx'), `"use client";

export function SiteHeader() {
  return (
    <div dangerouslySetInnerHTML={{ __html: HEADER_HTML }} />
  );
}

const HEADER_HTML = ${JSON.stringify(sharedHeader)};
`);
} else {
  write(path.join(outPath, 'app', 'components', 'SiteHeader.tsx'), `export function SiteHeader() {
  return null;
}
`);
}

// 3j. SiteFooter component
if (sharedFooter) {
  write(path.join(outPath, 'app', 'components', 'SiteFooter.tsx'), `"use client";

export function SiteFooter() {
  return (
    <div dangerouslySetInnerHTML={{ __html: FOOTER_HTML }} />
  );
}

const FOOTER_HTML = ${JSON.stringify(sharedFooter)};
`);
} else {
  write(path.join(outPath, 'app', 'components', 'SiteFooter.tsx'), `export function SiteFooter() {
  return null;
}
`);
}

// 3k. SiteScripts component — loads CDN scripts and runs animations
const cdnList = [...allCDNScripts];
const scriptLoaderLines = cdnList.map(u => `    await loadScript(${JSON.stringify(u)});`).join('\n');

write(path.join(outPath, 'app', 'components', 'SiteScripts.tsx'), `"use client";
import { useEffect } from "react";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(\`script[src="\${src}"]\`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(\`Failed to load \${src}\`));
    document.head.appendChild(s);
  });
}

export function SiteScripts() {
  useEffect(() => {
    async function init() {
      try {
${scriptLoaderLines ? `        // Load CDN scripts\n${scriptLoaderLines}\n` : '        // No CDN scripts detected\n'}
        // Fix visibility — some cloned elements start hidden
        document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"]').forEach((el: any) => {
          if (!el.closest('[class*="modal"],[class*="Modal"],[class*="overlay"]')) {
            el.style.opacity = "1";
          }
        });

        // Ensure interactive elements are clickable
        document.querySelectorAll('button,a,[role="button"]').forEach((el: any) => {
          el.style.pointerEvents = "auto";
          el.style.cursor = "pointer";
        });
      } catch (e) {
        console.warn("SiteScripts init error:", e);
      }
    }
    init();
  }, []);

  return null;
}
`);

// 3l. PageContent component — wraps dangerouslySetInnerHTML
write(path.join(outPath, 'app', 'components', 'PageContent.tsx'), `"use client";
import { SiteScripts } from "./SiteScripts";

interface Props {
  html: string;
  className?: string;
}

export function PageContent({ html, className }: Props) {
  return (
    <>
      <main className={className} dangerouslySetInnerHTML={{ __html: html }} />
      <SiteScripts />
    </>
  );
}
`);

// 3m. Generate page routes
for (const page of targetPages) {
  const parsed = parsedPages[page.route];
  if (!parsed) continue;

  // Strip shared elements from body
  let pageBody = parsed.bodyContent;
  if (sharedHeader || sharedFooter) {
    pageBody = stripShared(pageBody);
  }

  // Determine the app directory path
  let appDir;
  if (page.route === '/') {
    appDir = path.join(outPath, 'app');
  } else {
    // /ai → app/(pages)/ai/, /products/previews → app/(pages)/products/previews/
    // Sanitize segments: replace dots with dashes, remove hash fragments
    const segments = page.route.split('/').filter(Boolean)
      .map(s => s.replace(/#.*$/, ''))  // strip hash fragments
      .map(s => s.replace(/\./g, '-'))  // dots → dashes
      .map(s => s.replace(/['"\s]/g, ''))  // strip quotes/spaces
      .filter(Boolean);
    if (!segments.length) continue;
    appDir = path.join(outPath, 'app', '(pages)', ...segments);
  }
  mkdirp(appDir);

  // Write the body HTML file
  write(path.join(appDir, 'content.html'), pageBody);

  // Generate page metadata
  const pageTitle = parsed.title || siteTitle;
  const pageDesc = parsed.description || siteDesc;
  const escapedPageTitle = pageTitle.replace(/"/g, '\\"').replace(/\n/g, ' ');
  const escapedPageDesc = pageDesc.replace(/"/g, '\\"').replace(/\n/g, ' ');
  const name = componentName(page.route);

  // Compute relative path from page to components
  const depth = page.route === '/' ? 0 : page.route.split('/').filter(Boolean).length;
  const relPrefix = page.route === '/' ? './' : '../'.repeat(depth + 1); // +1 for (pages) group

  // Generate page.tsx — server component that reads HTML and passes to client
  write(path.join(appDir, 'page.tsx'), `import fs from "fs";
import path from "path";
import type { Metadata } from "next";
import { PageContent } from "${relPrefix}components/PageContent";

export const metadata: Metadata = {
  title: "${escapedPageTitle}",
  description: "${escapedPageDesc}",
};

export default function ${name}() {
  const html = fs.readFileSync(
    path.join(process.cwd(), "${path.relative(outPath, path.join(appDir, 'content.html')).replace(/\\/g, '/')}"),
    "utf-8"
  );
  return <PageContent html={html} />;
}
`);

  debug(`Generated ${page.route} → ${path.relative(outPath, appDir)}/page.tsx`);
}

// 3n. (pages) layout — just passes children through (route group)
const pagesDir = path.join(outPath, 'app', '(pages)');
if (fs.existsSync(pagesDir)) {
  write(path.join(pagesDir, 'layout.tsx'), `export default function PagesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
`);
}

// 3o. .gitignore
write(path.join(outPath, '.gitignore'), `# deps
node_modules/
.pnp
.pnp.js

# next
.next/
out/

# misc
.DS_Store
*.pem
.env*.local
`);

// 3p. Copy manifest to output for reference
if (manifest) {
  mkdirp(path.join(outPath, 'public', 'data'));
  fs.copyFileSync(manifestPath, path.join(outPath, 'public', 'data', 'manifest.json'));
}

// ── PHASE 4: Validate ───────────────────────────────────────────────────────

console.log('\nPhase 4: Validate');

let issues = 0;

// 4a. Check all generated TSX files exist and have content
const tsxFiles = [];
function findTSX(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) findTSX(full);
    else if (f.name.endsWith('.tsx')) tsxFiles.push(full);
  }
}
findTSX(path.join(outPath, 'app'));

for (const f of tsxFiles) {
  const content = fs.readFileSync(f, 'utf-8');
  if (content.length < 10) {
    console.log(`   WARN: ${path.relative(outPath, f)} is suspiciously small`);
    issues++;
  }
  // Basic JSX syntax check — unmatched template literals
  const backticks = (content.match(/`/g) || []).length;
  if (backticks % 2 !== 0) {
    console.log(`   WARN: ${path.relative(outPath, f)} has unmatched backtick`);
    issues++;
  }
}
console.log(`   TSX files: ${tsxFiles.length}`);

// 4b. Check content.html files exist for each page
let contentFiles = 0;
function findContentHTML(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) findContentHTML(full);
    else if (f.name === 'content.html') contentFiles++;
  }
}
findContentHTML(path.join(outPath, 'app'));
console.log(`   Content HTML files: ${contentFiles}`);

// 4c. Verify critical files
const critical = ['package.json', 'tsconfig.json', 'next.config.ts', 'app/layout.tsx', 'app/page.tsx', 'app/globals.css'];
for (const f of critical) {
  if (!fs.existsSync(path.join(outPath, f))) {
    console.log(`   ERROR: Missing critical file: ${f}`);
    issues++;
  }
}

// 4d. Check asset references in content files (sample check)
const sampleContent = fs.existsSync(path.join(outPath, 'app', 'content.html'))
  ? fs.readFileSync(path.join(outPath, 'app', 'content.html'), 'utf-8')
  : '';
const imgRefs = sampleContent.match(/src="\/images\/[^"]+"/g) || [];
let missingAssets = 0;
for (const ref of imgRefs.slice(0, 20)) {
  const assetPath = ref.match(/src="([^"]+)"/)[1];
  if (!fs.existsSync(path.join(outPath, 'public', assetPath))) {
    debug(`Missing asset: ${assetPath}`);
    missingAssets++;
  }
}
if (missingAssets) console.log(`   WARN: ${missingAssets} missing asset references (sample of ${Math.min(20, imgRefs.length)})`);

// 4e. Summary
const pageCount = Object.keys(parsedPages).length;
console.log(`\n   Issues: ${issues}`);
console.log(`   Pages generated: ${pageCount}`);
console.log(`   Components: ${tsxFiles.length}`);
console.log(`   Assets copied: ${totalAssets}`);

// ── Done ─────────────────────────────────────────────────────────────────────

console.log(`\n Done! Next.js project ready at: ${outPath}`);
console.log(`\n   cd ${path.relative(process.cwd(), outPath)}`);
console.log(`   pnpm install`);
console.log(`   pnpm dev\n`);

// ── Utility Functions ────────────────────────────────────────────────────────

function htmlStyleToReact(style) {
  if (!style) return '';
  // Convert "color-scheme: light; --ai-chat-panel-width: 0px" → React style object entries
  const pairs = [];
  const parts = style.split(';').filter(Boolean);
  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim();
    const val = part.slice(colon + 1).trim();
    // Convert CSS prop to camelCase
    const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    // Custom properties stay as-is but need quotes
    if (prop.startsWith('--')) {
      pairs.push(`"${prop}": "${val.replace(/"/g, '\\"')}"`);
    } else {
      pairs.push(`${camel}: "${val.replace(/"/g, '\\"')}"`);
    }
  }
  return pairs.join(', ');
}
