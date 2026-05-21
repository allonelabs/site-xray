const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");

const OUT = "/tmp/test-out";

function safePath(filePath) {
  const resolved = path.resolve(OUT, filePath.replace(/^\//, ""));
  if (!resolved.startsWith(path.resolve(OUT))) return null;
  return resolved;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function rewriteURLs(text, map) {
  const keys = Object.keys(map);
  if (keys.length === 0) return text;
  keys.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map(escapeRegExp).join("|"), "g");
  return text.replace(pattern, (match) => map[match] || match);
}

test("safePath blocks ../ traversal", () => {
  assert.strictEqual(safePath("../etc/passwd"), null);
  assert.strictEqual(
    safePath("/normal/file.txt"),
    path.resolve(OUT, "normal/file.txt"),
  );
});

test("safePath blocks absolute escape", () => {
  assert.strictEqual(safePath("/../etc/passwd"), null);
});

test("rewriteURLs replaces longest match first", () => {
  const map = {
    "https://example.com/a.js": "/a.js",
    "https://example.com/a.js.map": "/a.js.map",
  };
  const out = rewriteURLs('"https://example.com/a.js.map"', map);
  assert.strictEqual(out, '"/a.js.map"');
});

test("rewriteURLs no-op on empty map", () => {
  assert.strictEqual(rewriteURLs("abc", {}), "abc");
});

function issueId(type, selector, viewport) {
  const key = `${type}|${selector || ""}|${viewport ? viewport.w + "x" + viewport.h : ""}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 8);
}

function writePassIssues(outDir, passNum, issues) {
  const n = Number(passNum);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `writePassIssues: passNum must be a non-negative integer, got ${passNum}`,
    );
  }
  const dir = path.join(outDir, "data", "passes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `pass-${n}.json`),
    JSON.stringify(issues, null, 2),
  );
}

test("issueId is stable for same inputs", () => {
  const a = issueId("click-no-op", "button.cta", { w: 1440, h: 900 });
  const b = issueId("click-no-op", "button.cta", { w: 1440, h: 900 });
  assert.strictEqual(a, b);
});

test("issueId differs for different selectors", () => {
  const a = issueId("click-no-op", "button.cta", null);
  const b = issueId("click-no-op", "button.other", null);
  assert.notStrictEqual(a, b);
});

test("writePassIssues serializes deterministically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v54-test-"));
  try {
    const issues = [
      { id: "abc", type: "click-no-op", selector: "button", fixAttempts: 0 },
    ];
    writePassIssues(dir, 1, issues);
    const round = JSON.parse(
      fs.readFileSync(path.join(dir, "data", "passes", "pass-1.json"), "utf-8"),
    );
    assert.deepStrictEqual(round, issues);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStableSelector source string is well-formed", () => {
  // We test the resolver's behavior through browser fixtures in v54-detectors.test.js.
  // Here, we just check that the function source can be passed to new Function() and runs.
  const src = `
    function resolveStableSelector(el) {
      if (el.id) return '#' + el.id;
      if (el.dataset && el.dataset.testid) return '[data-testid="' + el.dataset.testid + '"]';
      const classes = (el.className || '').split(/\\s+/).filter(c => c && !/^(js-|is-|has-)/.test(c));
      if (classes.length) {
        const sel = el.tagName.toLowerCase() + '.' + classes.join('.');
        return sel;
      }
      const parent = el.parentElement;
      if (!parent) return el.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      const idx = siblings.indexOf(el) + 1;
      return resolveStableSelector(parent) + ' > ' + el.tagName.toLowerCase() + ':nth-of-type(' + idx + ')';
    }
    return typeof resolveStableSelector;
  `;
  const result = new Function(src)();
  assert.strictEqual(result, "function");
});
