#!/usr/bin/env node
/**
 * Animation Capture — Records all DOM style mutations on a live site
 * then generates a working GSAP animation script.
 *
 * Instead of parsing webpack bundles, this OBSERVES what the animations
 * actually DO to the DOM (MutationObserver on style attributes).
 *
 * Usage: NODE_PATH=$(npm root -g) node anim-capture.js <url> [output-file]
 */

const { chromium } = require('playwright');
const fs = require('fs');

const URL_TARGET = process.argv[2];
const OUT_FILE = process.argv[3] || '/tmp/animations.js';
if (!URL_TARGET) { console.log('Usage: node anim-capture.js <url> [output.js]'); process.exit(0); }

async function main() {
  console.log(`\n🎬 Animation Capture: ${URL_TARGET}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });

  // ═══════════════════════════════════════
  // Inject MutationObserver BEFORE page loads
  // Records every style change on every element
  // ═══════════════════════════════════════
  await context.addInitScript(() => {
    window.__animLog = [];
    window.__animStart = Date.now();

    // Wait for DOM to be ready, then observe everything
    const startObserving = () => {
      // Capture initial state of all elements
      window.__initialStyles = new Map();

      const observer = new MutationObserver((mutations) => {
        const now = Date.now() - window.__animStart;
        for (const mut of mutations) {
          if (mut.type === 'attributes' && mut.attributeName === 'style') {
            const el = mut.target;
            const selector = getSelector(el);
            if (!selector) continue;

            const oldStyle = mut.oldValue || '';
            const newStyle = el.getAttribute('style') || '';

            // Parse style differences
            const oldProps = parseStyle(oldStyle);
            const newProps = parseStyle(newStyle);
            const changes = {};
            let hasChange = false;

            for (const [key, val] of Object.entries(newProps)) {
              if (oldProps[key] !== val) {
                changes[key] = { from: oldProps[key] || null, to: val };
                hasChange = true;
              }
            }

            if (hasChange) {
              window.__animLog.push({ t: now, el: selector, changes });
            }

            // Store initial state
            if (!window.__initialStyles.has(selector)) {
              window.__initialStyles.set(selector, oldStyle);
            }
          }

          // Also watch class changes (GSAP adds/removes classes)
          if (mut.type === 'attributes' && mut.attributeName === 'class') {
            const el = mut.target;
            const selector = getSelector(el);
            if (!selector) continue;
            const oldCls = mut.oldValue || '';
            const newCls = el.className?.toString() || '';
            if (oldCls !== newCls) {
              // Find added/removed classes
              const oldSet = new Set(oldCls.split(/\s+/).filter(Boolean));
              const newSet = new Set(newCls.split(/\s+/).filter(Boolean));
              const added = [...newSet].filter(c => !oldSet.has(c));
              const removed = [...oldSet].filter(c => !newSet.has(c));
              if (added.length || removed.length) {
                window.__animLog.push({ t: Date.now() - window.__animStart, el: selector, classChange: { added, removed } });
              }
            }
          }
        }
      });

      observer.observe(document.body, {
        attributes: true,
        attributeOldValue: true,
        subtree: true,
        attributeFilter: ['style', 'class'],
      });
    };

    function getSelector(el) {
      if (!el || !el.tagName) return null;
      // Prefer CSS module class names (unique identifiers)
      const cls = el.className?.toString() || '';
      const moduleClass = cls.split(/\s+/).find(c => c.includes('__') && c.includes('_'));
      if (moduleClass) return '.' + moduleClass;
      // Fallback: id
      if (el.id) return '#' + el.id;
      // Fallback: tag + first meaningful class
      const firstCls = cls.split(/\s+/).find(c => c.length > 2 && !c.startsWith('css-'));
      if (firstCls) return el.tagName.toLowerCase() + '.' + firstCls;
      return null;
    }

    function parseStyle(styleStr) {
      const props = {};
      if (!styleStr) return props;
      styleStr.split(';').forEach(part => {
        const [key, ...vals] = part.split(':');
        if (key && vals.length) {
          props[key.trim()] = vals.join(':').trim();
        }
      });
      return props;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving);
    } else {
      startObserving();
    }
  });

  const page = await context.newPage();

  // ═══════════════════════════════════════
  // Phase 1: Load page — capture initial animations
  // ═══════════════════════════════════════
  console.log('Phase 1: Loading (capturing entrance animations)...');
  await page.goto(URL_TARGET, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(6000); // Let entrance animations complete

  const entranceCount = await page.evaluate(() => window.__animLog.length);
  console.log(`  Entrance mutations: ${entranceCount}`);

  // ═══════════════════════════════════════
  // Phase 2: Scroll — capture scroll-driven animations
  // ═══════════════════════════════════════
  console.log('Phase 2: Scrolling (capturing scroll animations)...');
  const height = await page.evaluate(() => document.body.scrollHeight);

  // Mark the start of scroll phase
  await page.evaluate(() => window.__scrollStart = window.__animLog.length);

  for (let y = 0; y <= height; y += 100) {
    await page.evaluate(s => window.scrollTo(0, s), y);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(1000);

  const scrollCount = await page.evaluate(() => window.__animLog.length - window.__scrollStart);
  console.log(`  Scroll mutations: ${scrollCount}`);

  // Scroll back up
  await page.evaluate(() => {
    window.__scrollBackStart = window.__animLog.length;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1000);

  // ═══════════════════════════════════════
  // Phase 3: Hover — capture hover animations
  // ═══════════════════════════════════════
  console.log('Phase 3: Hovering interactive elements...');
  await page.evaluate(() => window.__hoverStart = window.__animLog.length);

  const hoverTargets = await page.$$('a, button, [role="button"], [class*="element"], [class*="card"]');
  for (let i = 0; i < Math.min(hoverTargets.length, 15); i++) {
    try {
      if (await hoverTargets[i].isVisible()) {
        await hoverTargets[i].hover();
        await page.waitForTimeout(300);
      }
    } catch(e) {}
  }
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);

  const hoverCount = await page.evaluate(() => window.__animLog.length - window.__hoverStart);
  console.log(`  Hover mutations: ${hoverCount}`);

  // ═══════════════════════════════════════
  // Phase 4: Collect + analyze all mutations
  // ═══════════════════════════════════════
  console.log('\nPhase 4: Analyzing mutations...');

  const { animLog, scrollStart, hoverStart, initialStyles } = await page.evaluate(() => ({
    animLog: window.__animLog,
    scrollStart: window.__scrollStart || 0,
    hoverStart: window.__hoverStart || 0,
    initialStyles: Object.fromEntries(window.__initialStyles || new Map()),
  }));

  console.log(`  Total mutations: ${animLog.length}`);

  // ═══════════════════════════════════════
  // Phase 5: Categorize animations
  // ═══════════════════════════════════════
  const entranceAnims = animLog.slice(0, scrollStart);
  const scrollAnims = animLog.slice(scrollStart, hoverStart);
  const hoverAnims = animLog.slice(hoverStart);

  // Group entrance animations by element
  const entranceByElement = {};
  for (const mut of entranceAnims) {
    if (!mut.el || mut.classChange) continue;
    if (!entranceByElement[mut.el]) entranceByElement[mut.el] = [];
    entranceByElement[mut.el].push(mut);
  }

  // Group scroll animations by element (find elements whose styles change with scroll)
  const scrollByElement = {};
  for (const mut of scrollAnims) {
    if (!mut.el || mut.classChange) continue;
    if (!scrollByElement[mut.el]) scrollByElement[mut.el] = [];
    scrollByElement[mut.el].push(mut);
  }

  // Group hover animations
  const hoverByElement = {};
  for (const mut of hoverAnims) {
    if (!mut.el || mut.classChange) continue;
    if (!hoverByElement[mut.el]) hoverByElement[mut.el] = [];
    hoverByElement[mut.el].push(mut);
  }

  // ═══════════════════════════════════════
  // Phase 6: Detect Lenis config from bundle
  // ═══════════════════════════════════════
  const jsURLs = [...new Set([...await page.evaluate(() =>
    [...document.querySelectorAll('script[src]')].map(s => s.src)
  )])];

  let lenisConfig = null;
  let detectedLib = '';
  const eases = new Set();
  const durations = new Set();

  for (const url of jsURLs.filter(u => /page|layout|app|main/i.test(u)).slice(0, 5)) {
    try {
      const code = await page.evaluate(async u => { try { return await (await fetch(u)).text(); } catch { return ''; } }, url);
      if (!code) continue;

      // Lenis
      const lenisMatch = code.match(/\{[^}]*duration\s*:\s*([\d.]+)[^}]*easing\s*:\s*(\([^)]*\))\s*=>\s*([^,}]+)/);
      if (lenisMatch) {
        lenisConfig = { duration: parseFloat(lenisMatch[1]), easing: `(${lenisMatch[2]}) => ${lenisMatch[3]}` };
        detectedLib += 'lenis,';
      }

      // GSAP detection
      if (/gsap|\.p8\.|\.ZP\.|ScrollTrigger/i.test(code)) detectedLib += 'gsap,';
      if (/ScrollTrigger/i.test(code)) detectedLib += 'scrolltrigger,';

      // Eases and durations from bundle
      for (const m of code.matchAll(/ease\s*:\s*["']([^"']+)["']/g)) eases.add(m[1]);
      for (const m of code.matchAll(/duration\s*:\s*([\d.]+)/g)) durations.add(m[1]);
    } catch(e) {}
  }

  detectedLib = [...new Set(detectedLib.split(','))].filter(Boolean).join(',');
  console.log(`  Libraries: ${detectedLib || 'css-only'}`);
  console.log(`  Eases: ${[...eases].join(', ')}`);
  console.log(`  Entrance elements: ${Object.keys(entranceByElement).length}`);
  console.log(`  Scroll-driven elements: ${Object.keys(scrollByElement).length}`);
  console.log(`  Hover elements: ${Object.keys(hoverByElement).length}`);

  // ═══════════════════════════════════════
  // Phase 7: Generate animation script
  // ═══════════════════════════════════════
  console.log('\nPhase 7: Generating animation script...');

  let script = '// Auto-generated by Animation Capture\n';
  script += `// Source: ${URL_TARGET}\n`;
  script += `// Mutations observed: ${animLog.length} (entrance: ${entranceAnims.length}, scroll: ${scrollAnims.length}, hover: ${hoverAnims.length})\n\n`;

  // ── Lenis ──
  if (detectedLib.includes('lenis')) {
    script += '// ── Lenis Smooth Scroll ──\n';
    if (lenisConfig) {
      script += `const lenis = new Lenis({\n`;
      script += `  duration: ${lenisConfig.duration},\n`;
      script += `  easing: ${lenisConfig.easing},\n`;
      script += `  smooth: true,\n`;
      script += `});\n`;
    } else {
      script += `const lenis = new Lenis({ duration: 0.8, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smooth: true });\n`;
    }
    script += 'function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }\n';
    script += 'requestAnimationFrame(raf);\n\n';
  }

  // ── GSAP setup ──
  if (detectedLib.includes('gsap')) {
    script += '// ── GSAP Setup ──\n';
    script += 'gsap.registerPlugin(ScrollTrigger);\n';
    if (detectedLib.includes('lenis')) {
      script += 'lenis.on("scroll", ScrollTrigger.update);\n';
      script += 'gsap.ticker.add((time) => lenis.raf(time * 1000));\n';
      script += 'gsap.ticker.lagSmoothing(0);\n';
    }
    script += '\n';
  }

  // ── Entrance animations ──
  if (Object.keys(entranceByElement).length > 0) {
    script += '// ── Entrance Animations (observed from page load) ──\n';

    for (const [selector, mutations] of Object.entries(entranceByElement)) {
      if (mutations.length < 2) continue; // Skip single mutations (noise)

      // Find the initial and final state
      const first = mutations[0];
      const last = mutations[mutations.length - 1];
      const duration = ((last.t - first.t) / 1000).toFixed(2);
      const delay = (first.t / 1000).toFixed(2);

      // Determine what properties animated
      const fromProps = {};
      const toProps = {};
      let hasAnimatable = false;

      for (const mut of mutations) {
        for (const [prop, { from, to }] of Object.entries(mut.changes)) {
          if (['opacity', 'transform', 'translate', 'rotate', 'scale'].includes(prop)) {
            if (from !== null && !fromProps[prop]) fromProps[prop] = from;
            toProps[prop] = to;
            hasAnimatable = true;
          }
        }
      }

      if (!hasAnimatable) continue;

      // Determine the best ease from detected eases
      const ease = [...eases][0] || 'power4.out';

      // Build the GSAP call
      const fromVars = {};
      const toVars = { duration: Math.max(0.3, parseFloat(duration)), ease: `"${ease}"` };
      if (parseFloat(delay) > 0.1) toVars.delay = parseFloat(delay);

      if (fromProps.opacity === '0') fromVars.autoAlpha = 0;
      if (toProps.opacity === '1' && fromProps.opacity === '0') toVars.autoAlpha = 1;

      if (fromProps.transform && fromProps.transform.includes('translate')) {
        // Parse translateY or translateX from the transform
        const yMatch = fromProps.transform.match(/translate(?:Y)?\(([^,)]+)/);
        if (yMatch) fromVars.y = yMatch[1];
      }

      if (fromProps.translate && fromProps.translate !== 'none') {
        const parts = fromProps.translate.split(' ');
        if (parts[0] && parts[0] !== '0px' && parts[0] !== 'none') fromVars.x = parts[0];
        if (parts[1] && parts[1] !== '0px') fromVars.y = parts[1];
      }

      if (Object.keys(fromVars).length > 0) {
        script += `gsap.from('${selector}', ${JSON.stringify({ ...fromVars, ...toVars }).replace(/"/g, '')});\n`;
      }
    }
    script += '\n';
  }

  // ── Scroll-driven animations ──
  if (Object.keys(scrollByElement).length > 0) {
    script += '// ── Scroll-Driven Animations (observed from scroll) ──\n';

    // Find elements with --progress custom property changes
    const progressElements = {};
    for (const [selector, mutations] of Object.entries(scrollByElement)) {
      const progressMuts = mutations.filter(m =>
        Object.keys(m.changes).some(k => k.startsWith('--'))
      );
      if (progressMuts.length > 0) {
        progressElements[selector] = progressMuts;
      }
    }

    if (Object.keys(progressElements).length > 0) {
      script += '// Elements with scroll-driven CSS custom properties:\n';
      for (const [selector, muts] of Object.entries(progressElements)) {
        const props = new Set();
        muts.forEach(m => Object.keys(m.changes).filter(k => k.startsWith('--')).forEach(k => props.add(k)));
        script += `// ${selector}: ${[...props].join(', ')}\n`;

        // Generate ScrollTrigger for this element
        script += `ScrollTrigger.create({\n`;
        script += `  trigger: '${selector}',\n`;
        script += `  start: 'top bottom',\n`;
        script += `  end: 'top top',\n`;
        script += `  scrub: 1,\n`;
        script += `  onUpdate: (self) => {\n`;
        for (const prop of props) {
          script += `    document.querySelector('${selector}')?.style.setProperty('${prop}', self.progress);\n`;
        }
        script += `  },\n`;
        script += `});\n\n`;
      }
    }

    // Find elements that change opacity/transform with scroll (entrance on scroll)
    const scrollEntranceElements = {};
    for (const [selector, mutations] of Object.entries(scrollByElement)) {
      const opacityChange = mutations.find(m => m.changes.opacity);
      const transformChange = mutations.find(m => m.changes.transform || m.changes.translate);
      if (opacityChange || transformChange) {
        scrollEntranceElements[selector] = { opacityChange, transformChange };
      }
    }

    if (Object.keys(scrollEntranceElements).length > 0) {
      script += '// Elements that animate on scroll into view:\n';
      for (const [selector, { opacityChange, transformChange }] of Object.entries(scrollEntranceElements)) {
        // Skip if it's a --progress element (already handled)
        if (progressElements[selector]) continue;

        const fromVars = {};
        if (opacityChange?.changes.opacity?.from === '0') fromVars.opacity = 0;
        if (transformChange?.changes.transform?.from) {
          const tx = transformChange.changes.transform.from.match(/translateX\(([^)]+)\)/);
          if (tx) fromVars.x = tx[1];
        }

        if (Object.keys(fromVars).length > 0) {
          const ease = [...eases].find(e => e.includes('expo') || e.includes('power4')) || 'expo.out';
          script += `gsap.from('${selector}', {\n`;
          for (const [k, v] of Object.entries(fromVars)) script += `  ${k}: '${v}',\n`;
          script += `  duration: 0.8,\n`;
          script += `  ease: '${ease}',\n`;
          script += `  scrollTrigger: { trigger: '${selector}', start: 'top 85%', once: true },\n`;
          script += `});\n`;
        }
      }
      script += '\n';
    }
  }

  // ── Hover animations ──
  if (Object.keys(hoverByElement).length > 0) {
    script += '// ── Hover Animations (observed from hovering) ──\n';

    for (const [selector, mutations] of Object.entries(hoverByElement)) {
      if (mutations.length < 1) continue;

      const hoverProps = {};
      for (const mut of mutations) {
        for (const [prop, { to }] of Object.entries(mut.changes)) {
          if (['transform', 'filter', 'opacity', 'scale', 'background-color', 'color'].includes(prop)) {
            hoverProps[prop] = to;
          }
        }
      }

      if (Object.keys(hoverProps).length > 0) {
        script += `document.querySelectorAll('${selector}').forEach(el => {\n`;
        script += `  el.addEventListener('mouseenter', () => gsap.to(el, { ${Object.entries(hoverProps).map(([k,v]) => `'${k}': '${v}'`).join(', ')}, duration: 0.75, ease: 'expo.out' }));\n`;

        // Reverse on mouseleave
        const reverseProps = {};
        for (const [prop] of Object.entries(hoverProps)) {
          if (prop === 'transform') reverseProps[prop] = 'none';
          else if (prop === 'filter') reverseProps[prop] = 'none';
          else if (prop === 'opacity') reverseProps[prop] = '1';
          else if (prop === 'scale') reverseProps[prop] = '1';
        }
        script += `  el.addEventListener('mouseleave', () => gsap.to(el, { ${Object.entries(reverseProps).map(([k,v]) => `'${k}': '${v}'`).join(', ')}, duration: 0.75, ease: 'expo.out' }));\n`;
        script += `});\n`;
      }
    }
    script += '\n';
  }

  // ── Interactive elements ──
  script += '// ── Interactive elements ──\n';
  script += "document.querySelectorAll('button, a, [role=\"button\"]').forEach(el => {\n";
  script += '  el.style.pointerEvents = "auto";\n';
  script += '  el.style.cursor = "pointer";\n';
  script += '});\n';

  // Write the script
  fs.writeFileSync(OUT_FILE, script);

  // Also save raw data for debugging
  fs.writeFileSync(OUT_FILE.replace('.js', '-raw.json'), JSON.stringify({
    totalMutations: animLog.length,
    entranceElements: Object.keys(entranceByElement).length,
    scrollElements: Object.keys(scrollByElement).length,
    hoverElements: Object.keys(hoverByElement).length,
    detectedLib,
    eases: [...eases],
    durations: [...durations],
    lenisConfig,
    entranceByElement: Object.fromEntries(
      Object.entries(entranceByElement).map(([k, v]) => [k, v.slice(0, 5)])
    ),
  }, null, 2));

  console.log(`\n✅ Animation script generated`);
  console.log(`   ${OUT_FILE} (${script.length} chars)`);
  console.log(`   ${Object.keys(entranceByElement).length} entrance animations`);
  console.log(`   ${Object.keys(scrollByElement).length} scroll-driven animations`);
  console.log(`   ${Object.keys(hoverByElement).length} hover animations`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
