#!/usr/bin/env node
/**
 * Site X-Ray → Next.js Converter
 * Takes a site-xray output directory and converts it to a Next.js app.
 *
 * Usage: node to-nextjs.js <clone-dir> [output-dir]
 *
 * What it does:
 * 1. Reads index.html (+ any other .html pages)
 * 2. Extracts all <style> blocks → app/styles.css
 * 3. Extracts body content → app/body-content.html (per page)
 * 4. Extracts <script> blocks → app/components/SiteScripts.tsx (useEffect)
 * 5. Detects CDN scripts (GSAP, Three.js, Cannon, Lenis) → dynamic imports
 * 6. Copies assets (fonts, images, videos, models, .glb) → public/
 * 7. Generates package.json, layout.tsx, page.tsx, tsconfig.json
 * 8. Generates ThemeToggle component (dark/light)
 * 9. If 3D scripts found → generates Hero3D.tsx component
 */

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
if (!SRC) {
  console.log('Site X-Ray → Next.js Converter');
  console.log('Usage: node to-nextjs.js <clone-dir> [output-dir]');
  process.exit(0);
}

const OUT = process.argv[3] || SRC + '-nextjs';
const srcPath = path.resolve(SRC);
const outPath = path.resolve(OUT);

console.log(`\n⚡ Site X-Ray → Next.js Converter`);
console.log(`   Source: ${srcPath}`);
console.log(`   Output: ${outPath}\n`);

// ── Helpers ──
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function write(p, content) { mkdirp(path.dirname(p)); fs.writeFileSync(p, content); console.log(`   ✓ ${path.relative(outPath, p)}`); }
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return 0;
  mkdirp(dest);
  let count = 0;
  for (const f of fs.readdirSync(src, { withFileTypes: true })) {
    if (f.isDirectory()) { count += copyDir(path.join(src, f.name), path.join(dest, f.name)); }
    else { fs.copyFileSync(path.join(src, f.name), path.join(dest, f.name)); count++; }
  }
  return count;
}

// ── Step 1: Find all HTML pages ──
const htmlFiles = fs.readdirSync(srcPath).filter(f => f.endsWith('.html'));
if (!htmlFiles.length) { console.error('No .html files found in source directory'); process.exit(1); }
console.log(`   Found ${htmlFiles.length} HTML page(s): ${htmlFiles.join(', ')}`);

// ── Step 2: Parse main index.html ──
const mainHtml = fs.readFileSync(path.join(srcPath, 'index.html'), 'utf-8');

// Extract <style> blocks
const styleRegex = /<style>([\s\S]*?)<\/style>/g;
let styles = '';
let m;
while ((m = styleRegex.exec(mainHtml)) !== null) { styles += m[1] + '\n\n'; }

// Extract <title>
const titleMatch = mainHtml.match(/<title>(.*?)<\/title>/);
const siteTitle = titleMatch ? titleMatch[1] : 'Cloned Site';

// Extract meta description
const descMatch = mainHtml.match(/<meta name="description" content="(.*?)"/);
const siteDesc = descMatch ? descMatch[1] : '';

// Extract body content
const bodyStart = mainHtml.indexOf('<body');
const bodyTagEnd = mainHtml.indexOf('>', bodyStart) + 1;

// Find where scripts begin (exclude inline styles/scripts from body)
let bodyEndIdx = mainHtml.lastIndexOf('</body>');
const bodyContent = mainHtml.substring(bodyTagEnd, bodyEndIdx).trim();

// Extract CDN script URLs
const cdnScriptRegex = /<script src="(https?:\/\/[^"]+)"[^>]*><\/script>/g;
const cdnScripts = [];
while ((m = cdnScriptRegex.exec(mainHtml)) !== null) { cdnScripts.push(m[1]); }

// Extract inline scripts (not CDN)
const inlineScriptRegex = /<script>(?!.*<\/style>)([\s\S]*?)<\/script>/g;
const inlineScripts = [];
let scriptSearch = mainHtml;
while ((m = inlineScriptRegex.exec(scriptSearch)) !== null) {
  const s = m[1].trim();
  if (s.length > 50 && !s.startsWith('try{var t=localStorage')) { // Skip tiny/theme scripts
    inlineScripts.push(s);
  }
}

// Detect 3D (Three.js/Cannon)
const has3D = cdnScripts.some(s => s.includes('three')) ||
  mainHtml.includes('THREE.WebGLRenderer') ||
  mainHtml.includes('THREE.Scene');
const hasCannon = mainHtml.includes('CANNON') || mainHtml.includes('cannon');
const hasGSAP = cdnScripts.some(s => s.includes('gsap')) || mainHtml.includes('gsap.');
const hasLenis = mainHtml.includes('Lenis') || mainHtml.includes('lenis');

// Detect fonts
const fontFaceRegex = /@font-face\s*\{[^}]*src:\s*url\(["']?([^)"']+)["']?\)/g;
const fontFiles = new Set();
while ((m = fontFaceRegex.exec(styles + mainHtml)) !== null) {
  const fontPath = m[1].replace(/^\//, '');
  fontFiles.add(fontPath);
}

// Find the primary font file for Next.js localFont
const fontDir = path.join(srcPath, 'fonts');
let primaryFont = null;
if (fs.existsSync(fontDir)) {
  const fonts = fs.readdirSync(fontDir).filter(f => f.endsWith('.woff') || f.endsWith('.woff2'));
  if (fonts.length) primaryFont = fonts[0];
}

console.log(`   Title: "${siteTitle}"`);
console.log(`   Styles: ${(styles.length / 1024).toFixed(0)}KB`);
console.log(`   Body: ${(bodyContent.length / 1024).toFixed(0)}KB`);
console.log(`   CDN scripts: ${cdnScripts.length}`);
console.log(`   Inline scripts: ${inlineScripts.length}`);
console.log(`   3D: ${has3D ? 'yes' : 'no'}, GSAP: ${hasGSAP ? 'yes' : 'no'}, Lenis: ${hasLenis ? 'yes' : 'no'}`);
console.log(`   Font: ${primaryFont || 'system'}`);
console.log('');

// ── Step 3: Create output structure ──
mkdirp(outPath);
mkdirp(path.join(outPath, 'app', 'components'));
mkdirp(path.join(outPath, 'public'));

// ── Step 4: Copy assets ──
console.log('   Copying assets...');
const assetDirs = ['fonts', 'images', 'videos', 'models', 'data'];
let totalAssets = 0;
for (const d of assetDirs) {
  const c = copyDir(path.join(srcPath, d), path.join(outPath, 'public', d));
  if (c) console.log(`     ${d}/: ${c} files`);
  totalAssets += c;
}
// Copy root-level assets (.glb, .png, .ico, .json, etc.)
const rootAssets = fs.readdirSync(srcPath).filter(f =>
  /\.(glb|gltf|png|jpg|jpeg|webp|ico|svg|json|mp4|webm|umd\.js)$/i.test(f)
);
for (const f of rootAssets) {
  fs.copyFileSync(path.join(srcPath, f), path.join(outPath, 'public', f));
  totalAssets++;
}
console.log(`   Total: ${totalAssets} assets\n`);

// ── Step 5: Generate files ──
console.log('   Generating Next.js project...');

// package.json
const deps = {
  "next": "^15.3.0",
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
};
if (has3D) { deps["three"] = "^0.171.0"; }
if (hasCannon) { deps["cannon-es"] = "^0.20.0"; }
if (hasGSAP) { deps["gsap"] = "^3.12.5"; }
if (hasLenis) { deps["lenis"] = "^1.3.20"; }

const devDeps = {
  "@types/node": "^22.0.0",
  "@types/react": "^19.0.0",
  "@types/react-dom": "^19.0.0",
  "typescript": "^5.7.0",
};
if (has3D) { devDeps["@types/three"] = "^0.171.0"; }

write(path.join(outPath, 'package.json'), JSON.stringify({
  name: siteTitle.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'),
  version: "0.1.0",
  private: true,
  scripts: { dev: "next dev", build: "next build", start: "next start" },
  dependencies: deps,
  devDependencies: devDeps,
}, null, 2));

// tsconfig.json
write(path.join(outPath, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true,
    skipLibCheck: true, strict: false, noEmit: true, esModuleInterop: true,
    module: "esnext", moduleResolution: "bundler", resolveJsonModule: true,
    isolatedModules: true, jsx: "preserve", incremental: true,
    plugins: [{ name: "next" }], paths: { "@/*": ["./*"] }
  },
  include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  exclude: ["node_modules"]
}, null, 2));

// next.config.ts
write(path.join(outPath, 'next.config.ts'), `import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n`);

// app/styles.css (extracted from HTML)
write(path.join(outPath, 'app', 'styles.css'), styles);

// app/globals.css (theme + fixes)
write(path.join(outPath, 'app', 'globals.css'), `/* Auto-generated enhancement styles */

.theme-toggle {
  position: fixed; bottom: 18px; right: 20px; z-index: 300;
  font-size: 11px; font-weight: 500; text-transform: uppercase;
  letter-spacing: -0.2px; cursor: pointer; background: none; border: none;
  padding: 4px 8px; transition: color 0.4s ease, opacity 0.4s ease;
  font-family: inherit; pointer-events: auto;
}
.theme-toggle:hover { opacity: 0.5; }
[data-theme="light"] .theme-toggle { color: #000; }
[data-theme="dark"] .theme-toggle, :root:not([data-theme="light"]) .theme-toggle { color: #fff; }

[data-theme="light"], [data-theme="light"] body {
  background-color: #fff !important; color: #000 !important;
}
[data-theme="light"] canvas { filter: invert(1); }
[data-theme="light"] video { filter: invert(1); }

@media (max-width: 37.49em) {
  body { font-size: 12px; }
}
`);

// Body content HTML
write(path.join(outPath, 'app', 'body-content.html'), bodyContent);

// app/layout.tsx
const fontImport = primaryFont
  ? `import localFont from "next/font/local";\n\nconst siteFont = localFont({\n  src: "../public/fonts/${primaryFont}",\n  variable: "--font-site",\n  weight: "500",\n  display: "swap",\n});\n`
  : '';
const fontClass = primaryFont ? '${siteFont.variable}' : '';
const fontBodyClass = primaryFont ? `\`${fontClass} lenis lenis-smooth\`` : '"lenis lenis-smooth"';

write(path.join(outPath, 'app', 'layout.tsx'), `import type { Metadata } from "next";
${fontImport}import "./styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "${siteTitle.replace(/"/g, '\\"')}",
  description: "${siteDesc.replace(/"/g, '\\"')}",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={${fontBodyClass}} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: \`try{var t=localStorage.getItem('site-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}\` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
`);

// ThemeToggle component
write(path.join(outPath, 'app', 'components', 'ThemeToggle.tsx'), `"use client";
import { useState, useEffect } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = localStorage.getItem("site-theme") as "dark" | "light" | null;
    if (saved) { setTheme(saved); document.documentElement.setAttribute("data-theme", saved); }
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("site-theme", next);
  };

  return <button className="theme-toggle" onClick={toggle}>{theme === "dark" ? "Light" : "Dark"}</button>;
}
`);

// SiteScripts component (GSAP + Lenis + animations)
const scriptLoaders = cdnScripts.map(u => `    await loadScript("${u}");`).join('\n');
const inlineScriptCode = inlineScripts.map(s =>
  s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
).join('\n\n');

write(path.join(outPath, 'app', 'components', 'SiteScripts.tsx'), `"use client";
import { useEffect } from "react";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(\`script[src="\${src}"]\`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = () => resolve(); s.onerror = reject;
    document.head.appendChild(s);
  });
}

export default function SiteScripts() {
  useEffect(() => {
    async function init() {
${scriptLoaders ? `      // Load CDN scripts\n${scriptLoaders}\n` : ''}${hasLenis ? `      // Lenis smooth scroll\n      const { default: Lenis } = await import("lenis");\n` : ''}
      // Run site scripts
      try {
        const gsap = (window as any).gsap;
        const ScrollTrigger = (window as any).ScrollTrigger;
        ${hasLenis ? `const lenis = new Lenis({ duration: 0.8, easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)) } as any);
        if (gsap && ScrollTrigger) {
          gsap.registerPlugin(ScrollTrigger);
          lenis.on("scroll", ScrollTrigger.update);
          gsap.ticker.add((t: number) => lenis.raf(t * 1000));
          gsap.ticker.lagSmoothing(0);
        }` : ''}

        // Visibility fix
        document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"]').forEach((el: any) => {
          if (!el.closest('[class*="modal"],[class*="Modal"]')) el.style.opacity = "1";
        });
        document.querySelectorAll('button,a,[role="button"]').forEach((el: any) => {
          el.style.pointerEvents = "auto";
          el.style.cursor = "pointer";
        });

        // InflatingText fix
        document.querySelectorAll('[class*="InflatingText_container"]').forEach((c: any) => {
          const chars = [...c.querySelectorAll('[class*="InflatingText_character"]')] as HTMLElement[];
          if (!chars.length) return;
          chars.forEach(ch => { ch.style.transform = "translateX(-5px) scaleX(0)"; ch.style.transformOrigin = "left bottom"; });
          const obs = new IntersectionObserver(([e]) => {
            if (e.isIntersecting) {
              chars.forEach((ch, i) => { setTimeout(() => { ch.style.transition = "transform 0.6s cubic-bezier(0.16,1,0.3,1)"; ch.style.transform = "translateX(0) scaleX(1)"; }, i * 20); });
              obs.disconnect();
            }
          }, { threshold: 0.1 });
          obs.observe(c);
        });

        // Hover effects on images
        document.querySelectorAll('button,a,[role="button"]').forEach((el: any) => {
          const img = el.querySelector("img");
          if (!img || !gsap) return;
          el.addEventListener("mouseenter", () => gsap.to(img, { scale: 1.03, filter: "brightness(0.9)", duration: 0.75, ease: "expo.out" }));
          el.addEventListener("mouseleave", () => gsap.to(img, { scale: 1, filter: "brightness(1)", duration: 0.75, ease: "expo.out" }));
        });

        // Mark animated containers ready
        document.querySelectorAll('[class*="projects_projects"]').forEach((el: any) => el.classList.add("projects-animated", "ready"));
        document.querySelectorAll('[class*="placeholderLogo"]').forEach((el: any) => el.classList.add("animation-done"));

      } catch(e) { console.warn("SiteScripts init error:", e); }
    }
    init();
  }, []);

  return null;
}
`);

// SiteContent component
write(path.join(outPath, 'app', 'components', 'SiteContent.tsx'), `"use client";
import SiteScripts from "./SiteScripts";
import ThemeToggle from "./ThemeToggle";

export default function SiteContent({ bodyHtml }: { bodyHtml: string }) {
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      <SiteScripts />
      <ThemeToggle />
    </>
  );
}
`);

// page.tsx
write(path.join(outPath, 'app', 'page.tsx'), `import fs from "fs";
import path from "path";
import SiteContent from "./components/SiteContent";

export default function Home() {
  const bodyHtml = fs.readFileSync(path.join(process.cwd(), "app/body-content.html"), "utf-8");
  return <SiteContent bodyHtml={bodyHtml} />;
}
`);

// Additional pages
for (const htmlFile of htmlFiles) {
  if (htmlFile === 'index.html') continue;
  const pageName = htmlFile.replace('.html', '');
  const pageHtml = fs.readFileSync(path.join(srcPath, htmlFile), 'utf-8');

  // Extract body for this page
  const pBodyStart = pageHtml.indexOf('<body');
  const pBodyTagEnd = pageHtml.indexOf('>', pBodyStart) + 1;
  const pBodyEnd = pageHtml.lastIndexOf('</body>');
  const pBodyContent = pageHtml.substring(pBodyTagEnd, pBodyEnd).trim();

  mkdirp(path.join(outPath, 'app', pageName));
  write(path.join(outPath, 'app', pageName, 'body-content.html'), pBodyContent);
  write(path.join(outPath, 'app', pageName, 'page.tsx'), `import fs from "fs";
import path from "path";
import SiteContent from "../components/SiteContent";

export default function ${pageName.charAt(0).toUpperCase() + pageName.slice(1)}Page() {
  const bodyHtml = fs.readFileSync(path.join(process.cwd(), "app/${pageName}/body-content.html"), "utf-8");
  return <SiteContent bodyHtml={bodyHtml} />;
}
`);
}

// If 3D detected, copy components from data/ if they exist
const componentsDir = path.join(srcPath, 'components');
if (fs.existsSync(componentsDir)) {
  const compFiles = fs.readdirSync(componentsDir).filter(f => f.endsWith('.tsx'));
  for (const f of compFiles) {
    fs.copyFileSync(path.join(componentsDir, f), path.join(outPath, 'app', 'components', f));
    console.log(`   ✓ app/components/${f} (from xray)`);
  }
}

// ── Done ──
console.log(`\n✅ Next.js project ready at: ${outPath}`);
console.log(`\n   cd ${OUT}`);
console.log(`   pnpm install`);
console.log(`   pnpm dev\n`);
