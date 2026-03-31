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
let sharedCSS = '', bundleLib = '', cdnScripts = [], sharedAnimScript = '';
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
    // Also detect lenis from HTML class
    if(!bundleLib.includes('lenis') && await page.evaluate(()=>document.documentElement.className.includes('lenis'))){
      bundleLib+= bundleLib?',lenis':'lenis';
      cdnScripts.push('https://unpkg.com/lenis@1.1.18/dist/lenis.min.js');
    }

    // ── Collect style timeline + generate animation script ──
    if (bundleLib.includes('gsap') || bundleLib.includes('lenis')) {
      console.log('     Recording style timeline...');

      // Mark scroll start, then scroll to capture scroll-driven changes
      await page.evaluate(()=>{ window.__scrollTimelineStart = window.__timeline.length; });
      const h2 = await page.evaluate(()=>document.body.scrollHeight);
      for(let y=0;y<=h2;y+=200){await page.evaluate(s=>window.scrollTo(0,s),y);await page.waitForTimeout(30);}
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.waitForTimeout(1000);

      // Collect timeline data
      const timeline = await page.evaluate(()=>{
        const scrollStart = window.__scrollTimelineStart || 0;
        const all = window.__timeline || [];
        // Group by element
        const byEl = {};
        all.forEach((snap,i) => {
          if(!byEl[snap.el]) byEl[snap.el] = { entrance:[], scroll:[] };
          if(i < scrollStart) byEl[snap.el].entrance.push(snap);
          else byEl[snap.el].scroll.push(snap);
        });
        return { total: all.length, scrollStart, elements: byEl };
      });

      console.log(`     Timeline: ${timeline.total} snapshots, ${Object.keys(timeline.elements).length} animated elements`);

      // ── Generate animation script: BUNDLE VALUES (exact) + TIMELINE (element detection) ──
      // Strategy: use bundle-grepped params for exact values, timeline only to confirm which elements animate
      const allEases = bundle.eases.map(e=>e.replace(/ease\s*:\s*/,'').replace(/"/g,''));
      const entranceEase = allEases.find(e=>e.includes('power4.inOut')) || allEases.find(e=>e.includes('power4')) || 'power4.inOut';
      const defaultEase = allEases.find(e=>e.includes('expo.out')) || allEases.find(e=>e.includes('expo')) || 'expo.out';
      const allDurs = bundle.durs.map(d=>parseFloat(d.replace('duration:',''))).filter(d=>d>0.1);
      const lenisRaw = (bundle.lenis[0]||'');
      const lenisDur = lenisRaw.match(/duration\s*:\s*([\d.]+)/)?.[1] || '0.8';

      // Check bundle for specific animation patterns
      const bundleCode = bundle.gsap.join('\n') + '\n' + bundle.st.join('\n');
      const hasScaleX = bundleCode.includes('scaleX');
      const hasAutoAlpha = bundleCode.includes('autoAlpha');
      const hasBaseProgress = bundleCode.includes('baseProgress') || bundleCode.includes('--progress');
      const baseProgress = bundleCode.match(/baseProgress\s*:\s*([\d.]+)/)?.[1] || '0.5';

      let animScript = '';

      // ── Lenis ──
      if (bundleLib.includes('lenis')) {
        animScript += `const lenis=new Lenis({duration:${lenisDur},easing:t=>Math.min(1,1.001-Math.pow(2,-10*t)),smooth:true});\n`;
        animScript += `function raf(t){lenis.raf(t);requestAnimationFrame(raf)}requestAnimationFrame(raf);\n`;
      }

      // ── GSAP setup ──
      if (bundleLib.includes('gsap')) {
        animScript += `gsap.registerPlugin(ScrollTrigger);\n`;
        if (bundleLib.includes('lenis')) {
          animScript += `lenis.on("scroll",ScrollTrigger.update);gsap.ticker.add(t=>lenis.raf(t*1000));gsap.ticker.lagSmoothing(0);\n`;
        }
      }

      // ═══════════════════════════════════════════════════════════
      // PATTERN RECOGNITION — detect from timeline behavior, not class names
      // 4 categories: entrance, scale-reveal, scroll-driven, character-stagger
      // ═══════════════════════════════════════════════════════════

      // Classify every animated element by its timeline behavior
      const patterns = { entrance: [], scaleReveal: [], scrollDriven: [], charStagger: [] };

      for (const [selector, data] of Object.entries(timeline.elements)) {
        const ent = data.entrance;
        const scr = data.scroll;

        // ── PATTERN 1: Entrance fade/slide ──
        // Signature: opacity changes from <0.5 to 1 during page load, few snapshots
        if (ent.length >= 2 && ent.length < 50) {
          const first = ent[0], last = ent[ent.length-1];
          const opFrom = parseFloat(first.opacity), opTo = parseFloat(last.opacity);
          if (opFrom < 0.5 && opTo > 0.8) {
            // Check if transform also changed (slide)
            let fromY = 0;
            if (first.transform !== last.transform) {
              const m = first.transform?.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)/);
              if (m) fromY = parseFloat(m[1]) || 0;
            }
            patterns.entrance.push({ selector, fromY, delay: first.t / 1000 });
          }
        }

        // ── PATTERN 2: Scale reveal ──
        // Signature: transform includes scale(0 or scaleX(0 → 1 during entrance
        if (ent.length >= 2) {
          const hasScale0 = ent.some(s => s.transform?.includes('scale(0') || s.transform?.includes('matrix(0,') || s.transform?.includes('matrix(0 '));
          const hasScale1 = ent.some(s => s.transform?.includes('matrix(1') || s.transform === 'none');
          if (hasScale0 && hasScale1) {
            // Extract transform-origin from the first non-none transform
            patterns.scaleReveal.push({ selector, delay: ent[0].t / 1000 });
          }
        }

        // ── PATTERN 3: Scroll-driven ──
        // Signature: CSS custom property (--progress, --x, etc) changes continuously during scroll
        if (scr.length > 5) {
          const hasCustomProp = scr.some(s => s['--progress'] || s['--base-height']);
          if (hasCustomProp) {
            // Find the initial value of --progress
            const firstProg = scr.find(s => s['--progress']);
            const initProg = firstProg ? parseFloat(firstProg['--progress']) : 0.5;
            patterns.scrollDriven.push({ selector, initProgress: initProg });
          }
        }
      }

      // ── PATTERN 4: Character stagger ──
      // Detect from DOM structure: container with many (>5) small child elements
      // that all have the same class pattern (character, char, letter, word)
      const charContainers = await page.evaluate(() => {
        const found = [];
        document.querySelectorAll('*').forEach(container => {
          const children = container.children;
          if (children.length < 5 || children.length > 200) return;
          // Must be inline elements (SPAN only), small text content, same class
          const childClasses = new Set();
          let allSmall = true;
          for (const child of children) {
            const cls = child.className?.toString() || '';
            if (!cls) { allSmall = false; break; }
            const prefix = cls.split('_')[0] + '_' + (cls.split('_')[1] || '');
            childClasses.add(prefix);
            // Must be SPAN (not DIV, not BUTTON) and have very short text (1-3 chars = character animation)
            if (child.tagName !== 'SPAN') { allSmall = false; break; }
            if ((child.textContent || '').length > 3) { allSmall = false; break; }
          }
          // All children are single-char spans with same class = character stagger
          if (allSmall && childClasses.size === 1 && children.length >= 5) {
            const containerCls = (container.className?.toString() || '').split(/\s+/).find(c => c.includes('__'));
            const childCls = (children[0].className?.toString() || '').split(/\s+/).find(c => c.includes('__'));
            if (containerCls && childCls) {
              found.push({ container: '.' + containerCls, child: '.' + childCls, count: children.length });
            }
          }
        });
        // Deduplicate by container class
        const seen = new Set();
        return found.filter(f => { if (seen.has(f.container)) return false; seen.add(f.container); return true; });
      });

      if (charContainers.length > 0) {
        patterns.charStagger = charContainers;
      }

      console.log(`     Patterns: entrance=${patterns.entrance.length} scale=${patterns.scaleReveal.length} scroll=${patterns.scrollDriven.length} chars=${patterns.charStagger.length}`);

      // ═══════════════════════════════
      // Generate code from patterns
      // ═══════════════════════════════

      // Entrance fade/slide
      if (patterns.entrance.length > 0) {
        animScript += `// Entrance animations (${patterns.entrance.length} elements)\n`;
        // Find entrance ease from bundle (usually power4.inOut or similar)
        const eEase = allEases.find(e => e.includes('inOut')) || entranceEase;
        const eDur = allDurs.find(d => d >= 0.3 && d <= 0.8) || 0.5;
        patterns.entrance.forEach((p, i) => {
          const yPart = p.fromY ? `,y:${Math.round(p.fromY)}` : '';
          animScript += `gsap.fromTo("${p.selector}",{autoAlpha:0${yPart}},{autoAlpha:1,y:0,duration:${eDur},delay:${(p.delay || 0.25 + i * 0.1).toFixed(2)},ease:"${eEase}"});\n`;
        });
      }

      // Scale reveal
      if (patterns.scaleReveal.length > 0) {
        animScript += `// Scale reveal (${patterns.scaleReveal.length} elements)\n`;
        const sDur = allDurs.find(d => d > 1) || 1.2;
        patterns.scaleReveal.forEach(p => {
          animScript += `(()=>{const el=document.querySelector("${p.selector}");if(!el)return;\n`;
          animScript += `gsap.set(el,{opacity:1,scaleX:0,transformOrigin:"left center"});\n`;
          animScript += `gsap.to(el,{scaleX:1,duration:${sDur},delay:0.2,ease:"${defaultEase}"});})();\n`;
        });
        // Hide any sibling overlay/cover elements (gradient covers are common with scale reveals)
        animScript += `document.querySelectorAll('[class*="cover"],[class*="Cover"],[class*="overlay"],[class*="Overlay"]').forEach(el=>{if(el.style)el.style.display="none"});\n`;
      }

      // Scroll-driven CSS custom properties
      if (patterns.scrollDriven.length > 0) {
        animScript += `// Scroll-driven (${patterns.scrollDriven.length} elements)\n`;
        // ALWAYS use bundle value for initial progress (timeline captures FINAL state which is wrong)
        // If bundle has baseProgress, use it. Otherwise default 0.5 (common GSAP pattern)
        const bp = bundleCode.match(/baseProgress\s*:\s*([\d.]+)/)?.[1] || '0.5';
        patterns.scrollDriven.forEach(p => {
          animScript += `document.querySelectorAll("${p.selector}").forEach((el,i)=>{\n`;
          animScript += `  const h=el.getBoundingClientRect().height||180;const vh=window.innerHeight;\n`;
          animScript += `  const mult=(vh/(Math.floor(h)+20))*(1-${bp});\n`;
          animScript += `  gsap.set(el,{"--progress":${bp},"--base-height":h+"px"});el.style.setProperty("min-height",h+"px");\n`;
          animScript += `  ScrollTrigger.create({trigger:el,start:"bottom-="+(h-(i===0?42:0))+"px bottom",end:"top top",scrub:1,\n`;
          animScript += `    onUpdate:s=>{gsap.set(el,{"--progress":${bp}+mult*s.progress})}});\n`;
          animScript += `});\n`;
        });
      }

      // Character stagger — animate each container independently on scroll into view
      if (patterns.charStagger.length > 0) {
        animScript += `// Character stagger (${patterns.charStagger.length} patterns)\n`;
        patterns.charStagger.forEach(p => {
          // Use IntersectionObserver instead of ScrollTrigger for reliability
          // ScrollTrigger with once:true can miss elements if scroll position was cached
          animScript += `document.querySelectorAll("${p.container}").forEach(c=>{\n`;
          animScript += `  const chars=[...c.querySelectorAll("${p.child}")];if(!chars.length)return;\n`;
          animScript += `  chars.forEach(ch=>{ch.style.transform="translateX(-5px) scaleX(0)";ch.style.transformOrigin="left bottom"});\n`;
          animScript += `  const obs=new IntersectionObserver(([e])=>{if(e.isIntersecting){\n`;
          animScript += `    chars.forEach((ch,i)=>{setTimeout(()=>{ch.style.transition="transform 0.6s cubic-bezier(0.16,1,0.3,1)";ch.style.transform="translateX(0) scaleX(1)"},i*20)});\n`;
          animScript += `    obs.disconnect();\n`;
          animScript += `  }},{threshold:0.1});\n`;
          animScript += `  obs.observe(c);\n`;
          animScript += `});\n`;
        });
      }

      // ── Card/grid stagger (detected from DOM: wrapper with 3+ similar children) ──
      const staggerContainers = await page.evaluate(() => {
        const found = [];
        document.querySelectorAll('*').forEach(wrapper => {
          const children = [...wrapper.children].filter(c => c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE');
          if (children.length < 3 || children.length > 20) return;
          // All children must be same tag
          const tags = new Set(children.map(c => c.tagName));
          if (tags.size !== 1) return;
          // All children must have same class prefix (card grid pattern)
          const childPrefixes = new Set(children.map(c => {
            const cls = (c.className?.toString() || '').split(/\s+/).find(x => x.includes('__'));
            return cls ? cls.split('__')[0] : '';
          }).filter(Boolean));
          if (childPrefixes.size !== 1) return;
          // Children must be substantial (have content — img or text > 10 chars)
          const hasContent = children.every(c => c.querySelector('img') || (c.textContent||'').trim().length > 10);
          if (!hasContent) return;
          // Wrapper and child must both be DIRECT parent-child with meaningful classes
          const wrapperCls = (wrapper.className?.toString() || '').split(/\s+/).find(c => c.includes('__'));
          const childCls = (children[0].className?.toString() || '').split(/\s+/).find(c => c.includes('__'));
          if (wrapperCls && childCls && wrapperCls !== childCls) {
            found.push({ wrapper: '.' + wrapperCls, child: '.' + childCls, count: children.length });
          }
        });
        const seen = new Set();
        return found.filter(f => { if (seen.has(f.wrapper)) return false; seen.add(f.wrapper); return true; }).slice(0, 5);
      });

      if (staggerContainers.length > 0) {
        animScript += `// Card stagger (${staggerContainers.length} grids)\n`;
        staggerContainers.forEach(g => {
          animScript += `document.querySelectorAll("${g.wrapper}").forEach(w=>{\n`;
          animScript += `  const els=w.querySelectorAll("${g.child}");if(els.length<2)return;\n`;
          animScript += `  gsap.set(els,{x:-25,opacity:0});\n`;
          animScript += `  ScrollTrigger.create({trigger:w,start:"top 80%",once:true,onEnter:()=>{\n`;
          animScript += `    els.forEach((el,i)=>{gsap.to(el,{x:0,opacity:1,duration:0.8,delay:i*0.1,ease:"${defaultEase}",clearProps:"transform"})});\n`;
          animScript += `  }});\n`;
          animScript += `});\n`;
        });
      }

      // ── Elements with opacity:0 in CSS (need JS to show) ──
      animScript += `// Visibility fix for JS-dependent elements\n`;
      animScript += `document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"]').forEach(el=>{\n`;
      animScript += `  if(!el.closest('[class*="modal"],[class*="Modal"]'))el.style.opacity="1";\n`;
      animScript += `});\n`;

      // ── Hover effects on image containers ──
      animScript += `document.querySelectorAll('button,a,[role="button"]').forEach(el=>{\n`;
      animScript += `  el.style.pointerEvents="auto";el.style.cursor="pointer";\n`;
      animScript += `  const img=el.querySelector("img");if(!img)return;\n`;
      animScript += `  el.addEventListener("mouseenter",()=>gsap.to(img,{scale:1.03,filter:"brightness(0.9)",duration:0.75,ease:"expo.out"}));\n`;
      animScript += `  el.addEventListener("mouseleave",()=>gsap.to(img,{scale:1,filter:"brightness(1)",duration:0.75,ease:"expo.out"}));\n`;
      animScript += `});\n`;

      // Save generated script for debugging
      fs.writeFileSync(`${OUT}/data/animations.js`, animScript);
      console.log(`     Animation script: ${animScript.length} chars`);

      // Store for injection during assembly
      sharedAnimScript = animScript;
    }

    // Download videos — search JS BUNDLES for video paths (they're hardcoded in React components)
    const jsURLs2 = [...networkURLs].filter(u=>u.match(/\.js(\?|$)/i)&&/page|layout|app/i.test(u));
    const allVidPathsFromBundles = new Set();
    for (const url of jsURLs2.slice(0,5)) {
      try {
        const code = await page.evaluate(async u=>{try{return await(await fetch(u)).text()}catch{return''}},url);
        const vids = code.match(/\/videos\/[^"'\s\\,)]+\.(?:mp4|webm|m4v)/g);
        if (vids) vids.forEach(v => allVidPathsFromBundles.add(v));
      } catch(e) {}
    }
    // Also check DOM and RSC payload
    const pageVidPaths = await page.evaluate(() => {
      const paths = new Set();
      const html = document.documentElement.outerHTML;
      const matches = html.match(/\/videos\/[^"'\s\\]+\.(?:mp4|webm|m4v)/g);
      if (matches) matches.forEach(m => paths.add(m.replace(/\\/g, '')));
      document.querySelectorAll('video,video source').forEach(v => { if(v.src) try{paths.add(new URL(v.src).pathname)}catch(e){} });
      return [...paths];
    });
    const allVidPaths = [...new Set([...allVidPathsFromBundles, ...pageVidPaths])];
    // Sort: desktop logo video first, then other logo videos, then project videos
    allVidPaths.sort((a,b) => {
      const score = v => {
        if (v.includes('desktop') && (v.includes('logo')||v.includes('animation'))) return 0;
        if (v.includes('logo') || v.includes('animation')) return 1;
        return 2;
      };
      return score(a) - score(b);
    });
    for (const vPath of allVidPaths) {
      try {
        const a = DOMAIN + vPath;
        const nm = `vid-${vidC}.mp4`;
        if (await dl(a, `${OUT}/videos/${nm}`)) {
          mapAsset(vPath, `/videos/${nm}`);
          mapAsset(a, `/videos/${nm}`);
          vidC++;
          console.log(`     Video: ${nm} (${vPath.substring(0,50)})`);
        }
      } catch(e) {}
    }
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

  // Canvas → video (prefer logo video) or image fallback
  let ci=0;
  const logoVid = Object.entries(urlMap).find(([k,v])=>v.startsWith('/videos/')&&(k.includes('logo')||k.includes('animation')))?.[1];
  const anyVid = Object.values(urlMap).find(v=>v.startsWith('/videos/'));
  html=html.replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/g,()=>{const idx=ci++;if(logoVid){return`<video autoplay muted playsinline loop style="width:100%;height:auto" src="${logoVid}"></video>`;}if(anyVid&&idx===0){return`<video autoplay muted playsinline loop style="width:100%;height:auto" src="${anyVid}"></video>`;}if(fs.existsSync(`${OUT}/images/canvas-${idx}.png`))return`<img src="/images/canvas-${idx}.png" style="width:100%;height:auto"/>`;return'';});

  // Also: empty Logo_container divs (JS-injected content that wasn't rendered) → inject video
  if (logoVid) {
    html=html.replace(/<div class="[^"]*Logo_container[^"]*"><\/div>/g,
      `<div class="Logo_container" style="width:100%;aspect-ratio:750/110"><video autoplay muted playsinline loop style="width:100%;height:auto" src="${logoVid}"></video></div>`);
    // Also handle Logo_container with only a canvas-PNG inside (footer case)
    html=html.replace(/<div class="Logo_container[^"]*"><img src="\/images\/canvas-\d+\.png"[^>]*\/><\/div>/g,
      `<div class="Logo_container" style="width:100%;aspect-ratio:750/110"><video autoplay muted playsinline loop style="width:100%;height:auto" src="${logoVid}"></video></div>`);
  }

  // Fix blocking classes
  html=html.replace(/\block-scroll\b/g,''); html=html.replace(/\blenis-stopped\b/g,'');

  // Inject CSS + fixes
  html=html.replace('</head>',`
<style>${css}</style>
<style>html,body{overflow-y:auto!important;overflow-x:hidden!important;scroll-behavior:smooth}html{scrollbar-width:none}html::-webkit-scrollbar{display:none}body{font-feature-settings:normal;text-rendering:optimizeLegibility}</style>
<link rel="icon" href="/favicon.ico"/>
</head>`);

  // Inject CDN + animation script (or basic interactivity if no animations)
  const scriptContent = sharedAnimScript || `document.querySelectorAll('button,a,[role="button"],[class*="element"],[class*="card"]').forEach(el=>{el.style.pointerEvents='auto';if(el.tagName==='A'||el.tagName==='BUTTON')el.style.cursor='pointer'});`;
  html=html.replace('</body>',`
${cdnScripts.map(u=>`<script src="${u}"></script>`).join('\n')}
<script>
${scriptContent}
</script>
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
    // Library detection
    const iv=setInterval(()=>{
      if(window.gsap&&!window.gsap.__xp){window.gsap.__xp=true;window.__xray.library+='gsap,'}
      if(window.ScrollTrigger&&!window.ScrollTrigger.__xp){window.ScrollTrigger.__xp=true;window.__xray.library+='scrolltrigger,'}
      if(window.Lenis&&!window.Lenis.__xp){window.Lenis.__xp=true;window.__xray.library+='lenis,'}
      if(window.LocomotiveScroll)window.__xray.library+='locomotive,';
    },50);
    setTimeout(()=>clearInterval(iv),15000);

    // Style timeline poller — records style changes on animated elements
    window.__timeline=[];
    window.__timelineStart=Date.now();
    window.__trackedEls=new Map(); // element → selector

    function sel(el){
      if(!el||!el.tagName)return null;
      const cls=(el.className?.toString()||'').split(/\s+/).find(c=>c.includes('__')&&c.includes('_'));
      if(cls)return'.'+cls;
      if(el.id)return'#'+el.id;
      return null;
    }

    // Start polling after DOM ready
    function startPoller(){
      // Find elements likely to be animated (have inline styles set by JS)
      const check=()=>{
        document.querySelectorAll('[style]').forEach(el=>{
          if(window.__trackedEls.has(el))return;
          const s=sel(el); if(!s)return;
          const style=el.getAttribute('style')||'';
          if(style.match(/opacity|transform|translate|scale|rotate/)){
            window.__trackedEls.set(el,s);
          }
        });
      };
      // Also track elements with CSS transition/animation properties
      document.querySelectorAll('*').forEach(el=>{
        if(window.__trackedEls.has(el))return;
        const cs=getComputedStyle(el);
        if((cs.transition&&cs.transition!=='all 0s ease 0s'&&cs.transition!=='')||(cs.animation&&!cs.animation.includes('none'))){
          const s=sel(el); if(s)window.__trackedEls.set(el,s);
        }
      });

      // Poll tracked elements every 50ms
      setInterval(()=>{
        check(); // discover new animated elements
        const t=Date.now()-window.__timelineStart;
        window.__trackedEls.forEach((selector,el)=>{
          try{
            const cs=getComputedStyle(el);
            const snap={
              opacity:cs.opacity,
              transform:cs.transform,
              visibility:cs.visibility,
            };
            // Also check inline style for CSS custom properties
            const inl=el.getAttribute('style')||'';
            const progMatch=inl.match(/--progress\s*:\s*([^;]+)/);
            if(progMatch)snap['--progress']=progMatch[1].trim();
            const bhMatch=inl.match(/--base-height\s*:\s*([^;]+)/);
            if(bhMatch)snap['--base-height']=bhMatch[1].trim();

            // Only record if something changed from last snapshot
            const last=window.__timeline.filter(f=>f.el===selector).pop();
            if(!last||last.opacity!==snap.opacity||last.transform!==snap.transform||last['--progress']!==snap['--progress']){
              window.__timeline.push({t,el:selector,...snap});
            }
          }catch(e){}
        });
      },50);
    }

    if(document.body)startPoller();
    else document.addEventListener('DOMContentLoaded',startPoller);
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
