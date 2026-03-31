#!/usr/bin/env node
/**
 * Site X-Ray v5 — Multi-page website cloner
 * Single file. One dependency (playwright). Zero config.
 *
 * Usage: node xray.js <url> [output-dir] [max-pages]
 * Default max-pages: 20
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
const OUT = process.argv[3] || `/tmp/clone-${PARSED.hostname.replace(/\./g, '-')}`;
const MAX_PAGES = parseInt(process.argv[4]) || 20;

// Shared state
const urlMap = {};
const networkURLs = new Set();
const crawled = new Set();
const queue = [PARSED.pathname || '/'];
let sharedCSS = '', bundleLib = '', cdnScripts = [];
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
  try { const a = new URL(orig,DOMAIN).href; urlMap[a]=local; urlMap[new URL(a).origin+new URL(a).pathname]=local; } catch(e){}
}

function pathToFile(p) { p=p||'/'; if(p.endsWith('/'))p+='index.html'; else if(!path.extname(p))p+='/index.html'; return p; }

// ═══════════════════════════════════════
// Capture one page
// ═══════════════════════════════════════
async function capturePage(page, urlPath, isFirst) {
  const fullURL = DOMAIN + urlPath;
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
    // Computed CSS
    sharedCSS = await page.evaluate(() => {
      let css=''; for(const s of document.styleSheets){try{for(const r of s.cssRules)css+=r.cssText+'\n'}catch(e){}} return css;
    });
    console.log(`     CSS: ${sharedCSS.length} chars`);

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
      let css='';for(const s of document.styleSheets){try{for(const r of s.cssRules)css+=r.cssText+'\n'}catch(e){}}
      const fm=css.match(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf|eot)[^"')]*)/gi);
      if(fm)fm.forEach(m=>{let u=m.replace(/url\(["']?/i,'');if(u.startsWith('/'))u=domain+u;else if(!u.startsWith('http'))u=domain+'/'+u;fonts.add(u);});
      return{imgs:[...imgs],fonts:[...fonts],vids:[...vids]};
    }, DOMAIN);

    // Download images
    const allImgs = new Set([...assets.imgs, ...[...networkURLs].filter(u=>u.match(/\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i))]);
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

    await dl(`${DOMAIN}/favicon.ico`,`${OUT}/favicon.ico`);

    // Canvas capture
    const canvases=await page.$$('canvas');
    for(let i=0;i<canvases.length;i++){try{const du=await canvases[i].evaluate(c=>{try{return c.toDataURL('image/png')}catch{return null}});if(du)fs.writeFileSync(`${OUT}/images/canvas-${i}.png`,Buffer.from(du.split(',')[1],'base64'));else await canvases[i].screenshot({path:`${OUT}/images/canvas-${i}.png`});}catch(e){}}

    // Bundle analysis
    console.log('     Analyzing bundles...');
    const bundle={lib:'',gsap:[],st:[],lenis:[],framer:[],eases:[],durs:[],delays:[]};
    const jsURLs=[...networkURLs].filter(u=>u.match(/\.js(\?|$)/i));
    const appJS=jsURLs.filter(u=>/page|layout|app|main|index/i.test(u)).slice(0,10);
    const libJS=jsURLs.filter(u=>!appJS.includes(u)&&/\d{3,}-|[a-f0-9]{8,}/.test(u)&&!/(polyfill|webpack|framework)/i.test(u)).slice(0,5);
    for(const url of[...appJS,...libJS]){try{
      const code=await page.evaluate(async u=>{try{return await(await fetch(u)).text()}catch{return''}},url);if(!code)continue;
      for(const m of code.matchAll(/(?:gsap|[a-z]\.(?:p8|ZP|Bt|Dn))\.\s*(?:to|from|fromTo|set)\s*\([^)]{0,2000}\)/g))bundle.gsap.push(m[0].substring(0,500));
      for(const m of code.matchAll(/scrollTrigger\s*:\s*\{[^}]{0,1000}\}|ScrollTrigger\.create\s*\([^)]{0,1000}\)/g))bundle.st.push(m[0].substring(0,500));
      for(const m of code.matchAll(/new\s+\w+\s*\(\s*\{[^}]*duration[^}]*easing[^}]*\}/g))bundle.lenis.push(m[0].substring(0,500));
      for(const m of code.matchAll(/(?:motion\.\w+|whileInView|AnimatePresence|variants\s*:\s*\{[^}]+\})/g))bundle.framer.push(m[0].substring(0,300));
      if(/anime\s*\(\s*\{/.test(code))bundle.lib+='anime,';
      if(/locomotive/i.test(code)&&/ScrollTrigger/i.test(code))bundle.lib+='locomotive,';
      for(const m of code.matchAll(/ease\s*:\s*["'][^"']+["']/g))bundle.eases.push(m[0]);
      for(const m of code.matchAll(/duration\s*:\s*[\d.]+/g))bundle.durs.push(m[0]);
      for(const m of code.matchAll(/delay\s*:\s*[\d.]+/g))bundle.delays.push(m[0]);
    }catch(e){}}
    const iLib=(await page.evaluate(()=>window.__xray?.library))||'';
    if(bundle.gsap.length||iLib.includes('gsap'))bundle.lib+='gsap,';
    if(bundle.st.length||iLib.includes('scrolltrigger'))bundle.lib+='scrolltrigger,';
    if(bundle.lenis.length||iLib.includes('lenis'))bundle.lib+='lenis,';
    if(bundle.framer.length)bundle.lib+='framer-motion,';
    bundleLib=[...new Set(bundle.lib.split(','))].filter(Boolean).join(',');
    bundle.eases=[...new Set(bundle.eases)]; bundle.durs=[...new Set(bundle.durs)]; bundle.delays=[...new Set(bundle.delays)];
    console.log(`     Libraries: ${bundleLib||'css-only'}`);
    fs.writeFileSync(`${OUT}/data/bundle.json`,JSON.stringify(bundle,null,2));

    // CDN scripts
    cdnScripts=[];
    if(bundleLib.includes('gsap'))cdnScripts.push('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js');
    if(bundleLib.includes('scrolltrigger'))cdnScripts.push('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js');
    if(bundleLib.includes('lenis'))cdnScripts.push('https://unpkg.com/lenis@1.1.18/dist/lenis.min.js');
    if(bundleLib.includes('locomotive'))cdnScripts.push('https://cdn.jsdelivr.net/npm/locomotive-scroll@4.1.4/dist/locomotive-scroll.min.js');
  }

  // ── Download new images on subsequent pages ──
  if (!isFirst) {
    const newImgs=await page.evaluate(()=>{const f=[];document.querySelectorAll('img[src],[data-src]').forEach(el=>{const s=el.src||el.getAttribute('data-src');if(s&&!s.startsWith('data:'))f.push(s);});return f;});
    for(const url of newImgs){if(urlMap[url])continue;try{const a=new URL(url,DOMAIN).href;if(urlMap[a])continue;const ext=path.extname(new URL(a).pathname).split('?')[0]||'.jpg';const nm=`img-${imgC}${ext}`;if(await dl(a,`${OUT}/images/${nm}`)){mapAsset(url,`/images/${nm}`);imgC++;}}catch(e){}}
  }

  // ── Capture rendered DOM ──
  const renderedHTML = await page.content();

  // ── Assemble this page ──
  let html = renderedHTML;
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  html = html.replace(/<div hidden=""[^>]*>[\s\S]*?<\/div>/, '');
  html = html.replace(/<!--\/?\$\??-->/g, '');

  // Rewrite asset URLs (sort by length to avoid partial matches)
  const sorted = Object.entries(urlMap).sort((a,b)=>b[0].length-a[0].length);
  for(const[orig,local]of sorted){try{html=html.replace(new RegExp(orig.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'),local)}catch(e){}}

  // Rewrite CSS asset URLs too
  let css = sharedCSS;
  for(const[orig,local]of sorted){try{css=css.replace(new RegExp(orig.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'),local)}catch(e){}}

  // Rewrite internal links to local paths
  for(const link of[...crawled,...queue]){try{html=html.replace(new RegExp(`href="${link.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"`,'g'),`href="${pathToFile(link)}"`)}catch(e){}}

  // Canvas → image (first canvas → video if available)
  let ci=0;
  html=html.replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/g,()=>{const idx=ci++;if(idx===0&&vidC>0){const v=Object.values(urlMap).find(v=>v.startsWith('/videos/'));if(v)return`<video autoplay muted playsinline loop style="width:100%;height:auto" src="${v}"></video>`;}if(fs.existsSync(`${OUT}/images/canvas-${idx}.png`))return`<img src="/images/canvas-${idx}.png" style="width:100%;height:auto"/>`;return'';});

  // Fix blocking classes
  html=html.replace(/\block-scroll\b/g,''); html=html.replace(/\blenis-stopped\b/g,'');

  // Inject CSS + fixes
  html=html.replace('</head>',`
<style>${css}</style>
<style>html,body{overflow-y:auto!important;overflow-x:hidden!important;scroll-behavior:smooth}html{scrollbar-width:none}html::-webkit-scrollbar{display:none}body{font-feature-settings:normal;text-rendering:optimizeLegibility}</style>
<link rel="icon" href="/favicon.ico"/>
</head>`);

  // Inject CDN + interactivity
  html=html.replace('</body>',`
${cdnScripts.map(u=>`<script src="${u}"></script>`).join('\n')}
<script>document.querySelectorAll('button,a,[role="button"],[class*="element"],[class*="card"]').forEach(el=>{el.style.pointerEvents='auto';if(el.tagName==='A'||el.tagName==='BUTTON')el.style.cursor='pointer'});</script>
<!-- ${bundleLib||'css-only'} -->
</body>`);

  // Write
  const filePath=pathToFile(urlPath);
  const fullPath=path.join(OUT,filePath);
  fs.mkdirSync(path.dirname(fullPath),{recursive:true});
  fs.writeFileSync(fullPath,html);
  console.log(`     → ${filePath} (${(html.length/1024).toFixed(0)}KB)`);

  // Screenshot
  await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(300);
  const ssName=urlPath==='/'?'reference':urlPath.replace(/\//g,'_').replace(/^_/,'');
  await page.screenshot({path:`${OUT}/data/${ssName}.png`,fullPage:true}).catch(()=>{});
}

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════
async function main() {
  for(const d of['images','fonts','videos','data'])fs.mkdirSync(`${OUT}/${d}`,{recursive:true});

  console.log(`\n🔬 Site X-Ray v5\n   ${TARGET} → ${OUT}\n   Max pages: ${MAX_PAGES}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport:{width:1440,height:900}, userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', locale:'en-US' });

  await context.addInitScript(() => {
    window.__xray={library:''};
    const iv=setInterval(()=>{
      if(window.gsap&&!window.gsap.__xp){window.gsap.__xp=true;window.__xray.library+='gsap,'}
      if(window.ScrollTrigger&&!window.ScrollTrigger.__xp){window.ScrollTrigger.__xp=true;window.__xray.library+='scrolltrigger,'}
      if(window.Lenis&&!window.Lenis.__xp){window.Lenis.__xp=true;window.__xray.library+='lenis,'}
      if(window.LocomotiveScroll)window.__xray.library+='locomotive,';
    },50);
    setTimeout(()=>clearInterval(iv),15000);
  });

  const page = await context.newPage();
  page.on('response',async res=>{try{if(res.status()===200)networkURLs.add(res.url())}catch(e){}});

  // Crawl loop
  let n=0;
  while(queue.length>0&&n<MAX_PAGES){
    const p=queue.shift(); if(crawled.has(p))continue; crawled.add(p);
    try{await capturePage(page,p,n===0);n++;}catch(e){console.log(`     ❌ ${e.message}`)}
  }

  const totalFiles=fs.readdirSync(OUT,{recursive:true}).filter(f=>!f.includes('data/')).length;
  const totalSize=parseInt(require('child_process').execSync(`du -sk "${OUT}" 2>/dev/null`).toString().split('\t')[0])||0;

  console.log(`\n✅ Clone ready — ${n} pages`);
  console.log(`   ${imgC} images, ${fontC} fonts, ${vidC} videos`);
  console.log(`   ${totalFiles} files, ${(totalSize/1024).toFixed(1)}MB`);
  console.log(`   Pages: ${[...crawled].join(', ')}`);
  console.log(`\n   cd ${OUT} && python3 -m http.server 3035\n`);

  await browser.close();
}

main().catch(e=>{console.error('Error:',e.message);process.exit(1)});
