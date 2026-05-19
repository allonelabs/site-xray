const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

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
