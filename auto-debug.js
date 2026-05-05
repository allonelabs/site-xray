#!/usr/bin/env node
/**
 * Site X-Ray — Auto Debug
 * Iteratively builds a Next.js project, parses errors, and applies fixes
 * until the build succeeds or max rounds are exhausted.
 *
 * Usage: node auto-debug.js <nextjs-dir> [--max-rounds=5] [--screenshot] [--verbose]
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

// ── Dynamic Port Allocation ─────────────────────────────────────────────────
function findPort(start = 3099) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', () => resolve(start + Math.floor(Math.random() * 1000)));
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v || 'true'; }
  else positional.push(a);
}
const DIR = positional[0];
if (!DIR) { console.log('Usage: node auto-debug.js <nextjs-dir> [--max-rounds=5] [--screenshot] [--verbose]'); process.exit(0); }
const PROJECT_DIR = path.resolve(DIR);
const MAX_ROUNDS = parseInt(flags.maxRounds) || 5;
const VERBOSE = flags.verbose === 'true';
const SCREENSHOT = flags.screenshot === 'true';
const CLONE_DIR = flags.cloneDir || '';
if (!fs.existsSync(PROJECT_DIR)) { console.error(`Error: directory not found: ${PROJECT_DIR}`); process.exit(1); }

// ── Logging ──────────────────────────────────────────────────────────────────
const log = {
  section: (m) => console.log(`\n${'='.repeat(60)}\n  ${m}\n${'='.repeat(60)}`),
  round:  (n, mx) => console.log(`\n--- Round ${n}/${mx} ${'─'.repeat(44)}`),
  ok:   (m) => console.log(`  [OK]    ${m}`),
  fix:  (m) => console.log(`  [FIX]   ${m}`),
  skip: (m) => console.log(`  [SKIP]  ${m}`),
  err:  (m) => console.log(`  [ERR]   ${m}`),
  info: (m) => console.log(`  [INFO]  ${m}`),
  debug:(m) => VERBOSE && console.log(`  [DEBUG] ${m}`),
};

// ── Build Runner ─────────────────────────────────────────────────────────────
function runBuild(dir) {
  log.info('Running next build...');
  try {
    execSync('npx next build', { cwd: dir, stdio: 'pipe', timeout: 180_000,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' } });
    return { success: true, errors: [], raw: '' };
  } catch (e) {
    const raw = ((e.stderr?.toString() || '') + '\n' + (e.stdout?.toString() || ''))
      .replace(/\x1b\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*m/g, '');
    log.debug(`Build output: ${raw.length} chars`);
    return { success: false, errors: parseErrors(raw, dir), raw };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function readPkgJson(dir) {
  const p = path.join(dir, 'package.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function resolveErrorFile(dir, rel) {
  if (!rel) return null;
  for (const base of [dir, (() => { try { return fs.realpathSync(dir); } catch { return dir; } })()]) {
    const fp = path.join(base, rel.replace(/^\.\//, ''));
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}
function findFileNear(lines, i, range = 5) {
  for (let j = Math.max(0, i - range); j < i; j++) {
    const m = lines[j].match(/^\.\/(.*?)(?::\d|$)/);
    if (m) return m[1];
  }
  return '';
}
function findSwcFile(lines, i, dir, range = 12) {
  const resolvedDir = (() => { try { return fs.realpathSync(dir); } catch { return dir; } })();
  for (let j = i; j < Math.min(lines.length, i + range); j++) {
    const m = lines[j].match(/,-\[([^\]]+?):(\d+):(\d+)\]/);
    if (m) {
      const raw = m[1].trim();
      return { file: path.isAbsolute(raw) ? path.relative(resolvedDir, raw) : raw, line: parseInt(m[2]) };
    }
  }
  return null;
}

// ── Error Parser (Next.js 15 / SWC format) ───────────────────────────────────
function parseErrors(output, dir) {
  const errors = [], seen = new Set(), lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Missing module (npm or local)
    const modM = line.match(/Module not found:\s*(?:Can't resolve|Cannot find module)\s*'([^']+)'/);
    if (modM) {
      const mod = modM[1]; const key = `mod:${mod}`;
      if (!seen.has(key)) { seen.add(key);
        let file = findFileNear(lines, i);
        if (!file) { for (let j = i+1; j < Math.min(lines.length, i+5); j++) { const m = lines[j].match(/Import trace.*:\s*\.\/(.*?)$/); if (m) { file = m[1]; break; } } }
        errors.push({ category: mod.startsWith('.') || mod.startsWith('/') ? 'missing-local-module' : 'missing-module', module: mod, file, message: line.trim() });
      } continue;
    }

    // Type error
    const typeM = line.match(/Type error:\s*(.*)/);
    if (typeM) {
      let file = '', ln = 0;
      for (let j = Math.max(0, i-3); j < i; j++) { const m = lines[j].match(/^\.\/(.*?):(\d+):(\d+)/); if (m) { file = m[1]; ln = parseInt(m[2]); break; } }
      const key = `type:${file}:${ln}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ category: 'type-error', file, line: ln, message: typeM[1].trim() }); }
      continue;
    }

    // Client/Server component mismatch ('use client')
    if (/You're importing a component that needs/i.test(line) || /ReactServerComponentsError/i.test(line) ||
        /only works in a Client Component/i.test(line) || /mark.*file.*with.*["'`]use client["'`]/i.test(line) ||
        (/\b(useState|useEffect|useRef|useContext|useReducer|useCallback|useMemo|createContext)\b/.test(line) && /(server|client) component/i.test(line))) {
      let file = findFileNear(lines, i);
      const inLine = line.match(/in\s+\.\/(.*?)(?:\s|$|:)/);
      if (inLine) file = inLine[1];
      if (!file) { const swc = findSwcFile(lines, i, dir); if (swc) file = swc.file; }
      const key = `client:${file}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ category: 'use-client', file, message: line.trim() }); }
      continue;
    }

    // JSX / SWC syntax error
    const jsxM = line.match(/(?:Error:\s*)?x\s+(Unexpected token|Expected|Unterminated|Adjacent)(.*)/);
    if (jsxM) {
      let file = '', ln = 0;
      const swc = findSwcFile(lines, i, dir);
      if (swc) { file = swc.file; ln = swc.line; }
      if (!file) file = findFileNear(lines, i);
      const key = `jsx:${file}:${ln}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ category: 'jsx-syntax', file, line: ln, message: (jsxM[1] + jsxM[2]).trim() }); }
      continue;
    }

    // SWC "Syntax Error" continuation — skip (already captured above)
    if (/^\s*Syntax Error\s*$/.test(line)) continue;

    // Missing export
    const expM = line.match(/'([^']+)'\s*(?:is not exported from|does not contain a default export|which was not found in)\s*'([^']+)'/);
    if (expM) {
      const key = `exp:${expM[1]}:${expM[2]}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ category: 'missing-export', name: expM[1], from: expM[2], file: findFileNear(lines, i), message: line.trim() }); }
      continue;
    }

    // CSS / Tailwind
    if (/Unknown at rule @(tailwind|apply|layer|config)/i.test(line) || /PostCSS.*error/i.test(line) || /tailwind.*not found/i.test(line)) {
      const key = `css:${line.trim().slice(0, 60)}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ category: 'css-error', message: line.trim() }); }
      continue;
    }

    // Image optimization
    if (/Invalid src prop.*next\/image/i.test(line) || /hostname.*is not configured under images/i.test(line)) {
      const hm = line.match(/hostname\s*"([^"]+)"/); const hostname = hm ? hm[1] : '';
      const key = `img:${hostname || line.slice(0, 40)}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ category: 'image-error', hostname, message: line.trim() }); }
      continue;
    }

    // Adjacent JSX elements
    if (line.includes('Adjacent JSX elements must be wrapped')) {
      let file = '', ln = 0;
      for (let j = Math.max(0, i-5); j < i; j++) { const m = lines[j].match(/^\.\/(.*?):(\d+):(\d+)/); if (m) { file = m[1]; ln = parseInt(m[2]); break; } }
      const key = `adj:${file}:${ln}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ category: 'adjacent-jsx', file, line: ln, message: line.trim() }); }
      continue;
    }

    // Module parse failed (duplicate declarations)
    const parseM = line.match(/Module parse failed:\s*(.*)/);
    if (parseM) {
      const file = findFileNear(lines, i);
      const dup = parseM[1].match(/Identifier '(\w+)' has already been declared/);
      if (dup) { const key = `dup:${file}:${dup[1]}`; if (!seen.has(key)) { seen.add(key); errors.push({ category: 'duplicate-decl', file, name: dup[1], message: parseM[1].trim() }); } }
      else { const key = `pf:${file}`; if (!seen.has(key)) { seen.add(key); errors.push({ category: 'jsx-syntax', file, line: 0, message: parseM[1].trim() }); } }
      continue;
    }

    // Catch-all
    const genM = line.match(/^(?:Build)?Error:\s*(.*)/);
    if (genM && !line.includes('Module not found') && !line.includes('Type error')) {
      const file = findFileNear(lines, i); const key = `gen:${file}:${genM[1].slice(0, 40)}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ category: 'generic', file, message: genM[1].trim() }); }
    }
  }
  return errors;
}

// ── Error Fixers ─────────────────────────────────────────────────────────────
function fixError(dir, err) {
  const handlers = {
    'missing-module': fixMissingModule, 'missing-local-module': fixMissingLocalModule,
    'type-error': fixTypeError, 'jsx-syntax': fixJsxSyntax, 'adjacent-jsx': fixAdjacentJsx,
    'missing-export': fixMissingExport, 'css-error': fixCssError, 'image-error': fixImageError,
    'use-client': fixUseClient, 'duplicate-decl': fixDuplicateDecl, 'generic': fixGeneric,
  };
  return (handlers[err.category] || (() => ({ fixed: false, action: `Unknown: ${err.category}` })))(dir, err);
}

function fixMissingModule(dir, error) {
  let pkg = error.module;
  pkg = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
  try { execSync(`npm install ${pkg} --legacy-peer-deps`, { cwd: dir, stdio: 'pipe', timeout: 60_000 });
    return { fixed: true, action: `Installed: ${pkg}` };
  } catch { try { execSync(`npm install ${pkg} --force`, { cwd: dir, stdio: 'pipe', timeout: 60_000 });
    return { fixed: true, action: `Installed (forced): ${pkg}` };
  } catch (e) { return { fixed: false, action: `Failed to install ${pkg}` }; } }
}

function fixMissingLocalModule(dir, error) {
  const { module: mod, file: sourceFile } = error;
  if (!sourceFile) return { fixed: false, action: 'No source file for local import' };
  const sourceDir = path.dirname(path.join(dir, sourceFile));
  const exts = ['.tsx', '.ts', '.jsx', '.js', '.css', '.module.css'];
  // Check if file exists with any extension
  for (const ext of exts) { if (fs.existsSync(path.resolve(sourceDir, mod + ext))) return { fixed: false, action: 'File exists — check import specifier' }; }
  // Create stub
  let stubPath = path.resolve(sourceDir, mod);
  if (!path.extname(stubPath)) stubPath += '.tsx';
  const name = path.basename(mod).replace(/\.[^.]+$/, '');
  const isComp = /^[A-Z]/.test(name);
  // Detect named vs default import
  let isNamed = false;
  const srcPath = path.join(dir, sourceFile);
  if (fs.existsSync(srcPath)) {
    const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    isNamed = new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*['"]${esc}['"]`).test(fs.readFileSync(srcPath, 'utf8'));
  }
  fs.mkdirSync(path.dirname(stubPath), { recursive: true });
  if (stubPath.endsWith('.css') || stubPath.endsWith('.module.css'))
    fs.writeFileSync(stubPath, '/* auto-generated stub */\n');
  else if (isComp)
    fs.writeFileSync(stubPath, isNamed
      ? `// Auto-generated stub\nexport function ${name}() { return null; }\n`
      : `// Auto-generated stub\nexport default function ${name}() { return null; }\n`);
  else fs.writeFileSync(stubPath, `// Auto-generated stub\nexport default {};\n`);
  return { fixed: true, action: `Created stub: ${path.relative(dir, stubPath)}` };
}

function fixTypeError(dir, error) {
  if (!error.file || !error.line) return { fixed: false, action: 'Type error without file/line' };
  const fp = resolveErrorFile(dir, error.file);
  if (!fp) return { fixed: false, action: `File not found: ${error.file}` };
  const lines = fs.readFileSync(fp, 'utf8').split('\n');
  const idx = error.line - 1;
  if (idx < 0 || idx >= lines.length) return { fixed: false, action: `Line ${error.line} out of range` };
  if (idx > 0 && lines[idx - 1].includes('@ts-ignore')) return { fixed: false, action: '@ts-ignore already present' };
  const indent = lines[idx].match(/^(\s*)/)[1];
  lines.splice(idx, 0, `${indent}// @ts-ignore — auto-debug`);
  fs.writeFileSync(fp, lines.join('\n'));
  return { fixed: true, action: `Added @ts-ignore at ${error.file}:${error.line}` };
}

function fixJsxSyntax(dir, error) {
  if (!error.file) return { fixed: false, action: 'JSX syntax error without file' };
  const fp = resolveErrorFile(dir, error.file);
  if (!fp) return { fixed: false, action: `File not found: ${error.file}` };
  let content = fs.readFileSync(fp, 'utf8');
  const message = error.message || '';

  // Fix invalid function names (dots, hyphens, etc.)
  if (message.includes("Expected '('") || message.includes("Expected ','")) {
    const funcMatch = content.match(/export default function ([A-Za-z0-9_./-]+)\(/);
    if (funcMatch) {
      const badName = funcMatch[1];
      const fixedName = badName.replace(/[^A-Za-z0-9]/g, '');
      content = content.replace(
        `export default function ${badName}(`,
        `export default function ${fixedName}(`
      );
      fs.writeFileSync(fp, content);
      return { fixed: true, action: `Fixed invalid function name: ${badName} → ${fixedName}` };
    }
  }

  let c = content, changed = false;

  // class= -> className=, for= -> htmlFor=
  if (c.includes(' class='))  { c = c.replace(/\sclass=/g, ' className='); changed = true; }
  if (/\sfor=/.test(c))       { c = c.replace(/\sfor=/g, ' htmlFor='); changed = true; }

  // style="..." -> style={{ ... }}
  if (/style="[^"]+"/.test(c)) {
    c = c.replace(/style="([^"]+)"/g, (_, css) => {
      const obj = css.split(';').filter(Boolean).map(p => {
        const [k, v] = p.split(':').map(s => s.trim());
        return k && v ? `${k.replace(/-([a-z])/g, (__, ch) => ch.toUpperCase())}: '${v}'` : null;
      }).filter(Boolean).join(', ');
      return `style={{ ${obj} }}`;
    }); changed = true;
  }

  // Self-closing tags
  for (const tag of ['img','br','hr','input','meta','link','area','base','col','embed','source','track','wbr']) {
    const re = new RegExp(`(<${tag}(?:\\s[^>]*?)?)(?<!/)>`, 'gi');
    const r = c.replace(re, '$1 />');
    if (r !== c) { c = r; changed = true; }
  }

  // HTML event handlers -> React (onclick->onClick, etc.)
  const events = { onclick:'onClick', onchange:'onChange', onsubmit:'onSubmit', onfocus:'onFocus',
    onblur:'onBlur', onkeydown:'onKeyDown', onkeyup:'onKeyUp', onmousedown:'onMouseDown',
    onmouseup:'onMouseUp', onmouseover:'onMouseOver', onmouseout:'onMouseOut', oninput:'onInput', onscroll:'onScroll' };
  for (const [h, r] of Object.entries(events)) {
    if (new RegExp(`\\s${h}=`, 'i').test(c)) { c = c.replace(new RegExp(`\\s${h}=`, 'gi'), ` ${r}=`); changed = true; }
  }

  // HTML attributes -> React (tabindex->tabIndex, etc.)
  const attrs = { tabindex:'tabIndex', colspan:'colSpan', rowspan:'rowSpan', cellpadding:'cellPadding',
    cellspacing:'cellSpacing', maxlength:'maxLength', minlength:'minLength', readonly:'readOnly',
    autocomplete:'autoComplete', autofocus:'autoFocus', enctype:'encType', crossorigin:'crossOrigin',
    srcset:'srcSet', novalidate:'noValidate', datetime:'dateTime', accesskey:'accessKey', charset:'charSet',
    frameborder:'frameBorder', allowfullscreen:'allowFullScreen', viewbox:'viewBox',
    'fill-rule':'fillRule', 'clip-rule':'clipRule', 'stroke-width':'strokeWidth',
    'stroke-linecap':'strokeLinecap', 'stroke-linejoin':'strokeLinejoin',
    'clip-path':'clipPath', 'xlink:href':'xlinkHref' };
  for (const [h, r] of Object.entries(attrs)) {
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\s${esc}=`, 'i').test(c)) { c = c.replace(new RegExp(`\\s${esc}=`, 'gi'), ` ${r}=`); changed = true; }
  }

  if (changed) { fs.writeFileSync(fp, c); return { fixed: true, action: `Fixed JSX syntax in ${error.file}` }; }
  return { fixed: false, action: `Could not auto-fix: ${error.message.slice(0, 80)}` };
}

function fixAdjacentJsx(dir, error) {
  if (!error.file) return { fixed: false, action: 'Adjacent JSX error without file' };
  const fp = resolveErrorFile(dir, error.file);
  if (!fp) return { fixed: false, action: `File not found: ${error.file}` };
  let c = fs.readFileSync(fp, 'utf8');
  if (/return\s*\(\s*\n/.test(c)) {
    c = c.replace(/return\s*\(\s*\n/, 'return (\n<>\n');
    c = c.replace(/\n(\s*)\);(\s*\n\s*\})/, '\n$1</>\n$1);$2');
    fs.writeFileSync(fp, c);
    return { fixed: true, action: `Wrapped return in fragment: ${error.file}` };
  }
  return { fixed: false, action: `Could not auto-wrap adjacent JSX` };
}

function fixMissingExport(dir, error) {
  const { name, from, file } = error;
  if (from && (from.startsWith('.') || from.startsWith('/'))) {
    const fromPath = file ? path.resolve(path.join(dir, path.dirname(file)), from) : path.resolve(dir, from);
    const target = [fromPath, fromPath+'.tsx', fromPath+'.ts', fromPath+'.jsx', fromPath+'.js'].find(c => fs.existsSync(c));
    if (target) {
      let c = fs.readFileSync(target, 'utf8');
      if (name === 'default' && !c.includes('export default')) {
        const comp = c.match(/export\s+function\s+(\w+)/);
        c += comp ? `\nexport default ${comp[1]};\n` : `\nexport default function Stub() { return null; }\n`;
        fs.writeFileSync(target, c);
        return { fixed: true, action: `Added default export to ${path.relative(dir, target)}` };
      } else if (name !== 'default' && !c.includes(`export function ${name}`) && !c.includes(`export const ${name}`)) {
        c += /^[A-Z]/.test(name) ? `\nexport function ${name}() { return null; }\n` : `\nexport const ${name} = {} as any;\n`;
        fs.writeFileSync(target, c);
        return { fixed: true, action: `Added stub export '${name}' to ${path.relative(dir, target)}` };
      }
    }
  }
  // Stub in source file
  if (file) {
    const fp = path.join(dir, file);
    if (fs.existsSync(fp)) {
      let c = fs.readFileSync(fp, 'utf8');
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const im = c.match(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]${esc}['"]`));
      if (im) {
        const stub = /^[A-Z]/.test(name) ? `const ${name} = () => null;` : `const ${name} = {} as any;`;
        c = c.replace(im[0], `// ${im[0]}\n${stub} // auto-debug stub`);
        fs.writeFileSync(fp, c);
        return { fixed: true, action: `Stubbed '${name}' from '${from}' in ${file}` };
      }
    }
  }
  return { fixed: false, action: `Could not fix missing export '${name}' from '${from}'` };
}

function fixCssError(dir) {
  let fixed = false; const actions = [];
  const pkg = readPkgJson(dir), deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const isTw4 = /^[~^]?4/.test(deps['tailwindcss'] || '') || !!deps['@tailwindcss/postcss'];
  if (!['postcss.config.mjs','postcss.config.js','postcss.config.cjs'].some(c => fs.existsSync(path.join(dir, c)))) {
    const plugin = isTw4 ? "'@tailwindcss/postcss': {}" : "tailwindcss: {}, autoprefixer: {}";
    fs.writeFileSync(path.join(dir, 'postcss.config.mjs'),
      `const config = { plugins: { ${plugin} } };\nexport default config;\n`);
    actions.push('Created postcss.config.mjs'); fixed = true;
  }
  if (!isTw4 && !['tailwind.config.ts','tailwind.config.js','tailwind.config.mjs'].some(c => fs.existsSync(path.join(dir, c)))) {
    fs.writeFileSync(path.join(dir, 'tailwind.config.ts'),
      `import type { Config } from "tailwindcss";\nconst config: Config = { content: ["./src/**/*.{js,ts,jsx,tsx,mdx}","./app/**/*.{js,ts,jsx,tsx,mdx}"], theme: { extend: {} }, plugins: [] };\nexport default config;\n`);
    actions.push('Created tailwind.config.ts'); fixed = true;
  }
  return fixed ? { fixed: true, action: actions.join('; ') } : { fixed: false, action: 'CSS error — no auto-fix applied' };
}

function fixImageError(dir, error) {
  if (!error.hostname) return { fixed: false, action: 'Image error without hostname' };
  const cfgs = ['next.config.ts','next.config.mjs','next.config.js'];
  let cp = cfgs.map(c => path.join(dir, c)).find(c => fs.existsSync(c));
  const pat = `{ protocol: "https", hostname: "${error.hostname}" }`;
  if (!cp) {
    cp = path.join(dir, 'next.config.ts');
    fs.writeFileSync(cp, `import type { NextConfig } from "next";\nconst nextConfig: NextConfig = { images: { remotePatterns: [${pat}] } };\nexport default nextConfig;\n`);
    return { fixed: true, action: `Created next.config.ts with image domain: ${error.hostname}` };
  }
  let c = fs.readFileSync(cp, 'utf8');
  if (c.includes('remotePatterns')) c = c.replace(/remotePatterns:\s*\[/, `remotePatterns: [${pat},`);
  else if (c.includes('images:')) c = c.replace(/images:\s*\{/, `images: { remotePatterns: [${pat}],`);
  else c = c.replace(/const\s+\w+\s*(?::\s*\w+)?\s*=\s*\{/, m => `${m} images: { remotePatterns: [${pat}] },`);
  fs.writeFileSync(cp, c);
  return { fixed: true, action: `Added image domain '${error.hostname}' to ${path.basename(cp)}` };
}

function fixUseClient(dir, error) {
  if (!error.file) return { fixed: false, action: "'use client' error without file" };
  const fp = resolveErrorFile(dir, error.file);
  if (!fp) return { fixed: false, action: `File not found: ${error.file}` };
  let c = fs.readFileSync(fp, 'utf8');
  if (c.startsWith("'use client'") || c.startsWith('"use client"')) return { fixed: false, action: "'use client' already present" };
  fs.writeFileSync(fp, "'use client';\n" + c);
  return { fixed: true, action: `Added 'use client' to ${error.file}` };
}

function fixDuplicateDecl(dir, error) {
  if (!error.file || !error.name) return { fixed: false, action: 'Duplicate decl without file/name' };
  const fp = resolveErrorFile(dir, error.file);
  if (!fp) return { fixed: false, action: `File not found: ${error.file}` };
  let c = fs.readFileSync(fp, 'utf8'); const n = error.name;
  const hasDef = new RegExp(`export\\s+default\\s+function\\s+${n}\\b`).test(c);
  const hasNamed = new RegExp(`export\\s+function\\s+${n}\\b`).test(c);
  if (hasDef && hasNamed) {
    c = c.replace(new RegExp(`\\nexport\\s+function\\s+${n}\\s*\\([^)]*\\)\\s*\\{[^}]*\\}\\n?`), '\n');
    fs.writeFileSync(fp, c);
    return { fixed: true, action: `Removed duplicate '${n}' from ${error.file}` };
  }
  const all = [...c.matchAll(new RegExp(`(export\\s+(?:default\\s+)?function\\s+${n}\\s*\\([^)]*\\)\\s*\\{[^}]*\\})`, 'g'))];
  if (all.length > 1) {
    const last = all[all.length - 1];
    c = (c.slice(0, last.index) + c.slice(last.index + last[0].length)).replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(fp, c);
    return { fixed: true, action: `Removed duplicate '${n}' from ${error.file}` };
  }
  return { fixed: false, action: `Could not resolve duplicate '${n}'` };
}

function fixGeneric(dir, error) {
  const msg = error.message || '';
  if (msg.includes('next/font')) return { fixed: false, action: `Font error: ${msg.slice(0, 80)}` };
  const nd = msg.match(/'(\w+)'\s+is not defined/);
  if (nd && nd[1] === 'React' && error.file) {
    const fp = path.join(dir, error.file);
    if (fs.existsSync(fp)) {
      let c = fs.readFileSync(fp, 'utf8');
      if (!c.includes("import React")) { fs.writeFileSync(fp, "import React from 'react';\n" + c); return { fixed: true, action: `Added React import to ${error.file}` }; }
    }
  }
  return { fixed: false, action: `Unhandled: ${msg.slice(0, 100)}` };
}

// ── Pre-flight Checks ────────────────────────────────────────────────────────
function ensureNodeModules(dir) {
  if (fs.existsSync(path.join(dir, 'node_modules'))) return;
  log.info('Installing dependencies...');
  try { execSync('npm install --legacy-peer-deps', { cwd: dir, stdio: 'pipe', timeout: 120_000 }); log.ok('Dependencies installed');
  } catch { try { execSync('npm install --force', { cwd: dir, stdio: 'pipe', timeout: 120_000 }); log.ok('Dependencies installed (forced)');
  } catch { log.err('npm install failed'); } }
}
function ensureNextConfig(dir) {
  if (['next.config.ts','next.config.mjs','next.config.js'].some(c => fs.existsSync(path.join(dir, c)))) return;
  fs.writeFileSync(path.join(dir, 'next.config.ts'), `import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n`);
  log.ok('Created next.config.ts');
}
function ensureTsConfig(dir) {
  if (fs.existsSync(path.join(dir, 'tsconfig.json'))) return;
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target:'es5', lib:['dom','dom.iterable','esnext'], allowJs:true, skipLibCheck:true, strict:false,
      noEmit:true, esModuleInterop:true, module:'esnext', moduleResolution:'bundler', resolveJsonModule:true,
      isolatedModules:true, jsx:'preserve', incremental:true, plugins:[{name:'next'}], paths:{'@/*':['./src/*']} },
    include: ['next-env.d.ts','**/*.ts','**/*.tsx','.next/types/**/*.ts'], exclude: ['node_modules']
  }, null, 2) + '\n');
  log.ok('Created tsconfig.json');
}

// ── Screenshot ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function takeScreenshot(dir) {
  console.log('\n═══ Visual Verification ═══');
  const port = await findPort();
  // Start production server
  const srv = spawn('npx', ['next', 'start', '-p', String(port)], { cwd: dir, stdio: 'pipe', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  await sleep(3000);

  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const screenshotPath = path.join(dir, 'data', 'build-result.png');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`  Screenshot: ${screenshotPath}`);

    // Compare with original if available
    if (CLONE_DIR) {
      const originalPath = path.join(CLONE_DIR, 'data', 'original.png');
      if (fs.existsSync(originalPath)) {
        console.log(`  Original: ${originalPath}`);
        console.log('  (Pixel comparison requires manual inspection or an image-diff tool)');
      }
    }

    await browser.close();
  } catch (e) {
    console.log(`  Screenshot skipped: ${e.message?.slice(0, 80)}`);
  }

  srv.kill();
}

// ── Main Loop ────────────────────────────────────────────────────────────────
async function main() {
  log.section(`Auto Debug: ${PROJECT_DIR}`);
  log.info(`Max rounds: ${MAX_ROUNDS}`);
  ensureNextConfig(PROJECT_DIR);
  ensureTsConfig(PROJECT_DIR);
  ensureNodeModules(PROJECT_DIR);

  let round = 0, buildResult;
  const allActions = [];
  while (round < MAX_ROUNDS) {
    round++;
    log.round(round, MAX_ROUNDS);
    buildResult = runBuild(PROJECT_DIR);
    if (buildResult.success) { log.ok('Build succeeded!'); break; }

    const { errors } = buildResult;
    log.info(`Found ${errors.length} error(s)`);
    if (errors.length === 0) {
      log.err('Build failed but no parseable errors found.');
      buildResult.raw.split('\n').slice(-30).forEach(l => console.log(`    ${l}`));
      break;
    }

    let fixedCount = 0;
    for (const error of errors) {
      log.debug(`Error: [${error.category}] ${error.message?.slice(0, 100)}`);
      const result = fixError(PROJECT_DIR, error);
      if (result.fixed) { fixedCount++; log.fix(result.action); }
      else log.skip(result.action);
      allActions.push({ round, ...error, ...result });
    }

    if (fixedCount === 0) {
      log.err('No fixable errors. Manual intervention needed.');
      errors.forEach(e => log.err(`  [${e.category}] ${e.message?.slice(0, 120)}`));
      break;
    }
    log.info(`Fixed ${fixedCount}/${errors.length} errors`);
  }

  // Summary
  log.section('Summary');
  log.info(`Rounds: ${round}/${MAX_ROUNDS} | Result: ${buildResult?.success ? 'SUCCESS' : 'FAILED'}`);
  const fixed = allActions.filter(a => a.fixed), failed = allActions.filter(a => !a.fixed);
  if (fixed.length)  { log.info(`Fixes applied (${fixed.length}):`);  fixed.forEach(a => log.fix(`  R${a.round}: ${a.action}`)); }
  if (failed.length) { log.info(`Could not fix (${failed.length}):`); failed.forEach(a => log.skip(`  R${a.round}: ${a.action}`)); }
  if (SCREENSHOT && buildResult?.success) await takeScreenshot(PROJECT_DIR);
  process.exit(buildResult?.success ? 0 : 1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
