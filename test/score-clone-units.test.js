// Unit tests for the pure helpers used by score-clone.js. We duplicate the
// functions here (rather than importing) to match the project's existing
// pattern in v54-utils.test.js — the CLI script doesn't export anything,
// and refactoring just for tests adds more risk than the duplication.
//
// Keep these in sync with score-clone.js if the helpers change there.

const test = require("node:test");
const assert = require("node:assert");

function parityScore(a, b) {
  if (a === 0 && b === 0) return 100;
  if (a === 0 || b === 0) return 0;
  return Math.round(Math.min(a / b, b / a) * 100);
}

function classifyURL(u) {
  if (
    /googletagmanager|google-analytics|googleads|doubleclick|facebook\.net|fbq|hotjar|segment|mixpanel|amplitude|posthog|datadog|sentry|fullstory|cookiebot|onetrust|clarity\.ms/i.test(
      u,
    )
  )
    return "analytics";
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(u)) return "font";
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(u)) return "image";
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u)) return "video";
  if (/\.(css)(\?|$)|fonts\.googleapis\.com\/css/i.test(u)) return "css";
  if (/\.(js|mjs)(\?|$)/i.test(u)) return "js";
  return "doc";
}

test("parityScore: identical counts → 100", () => {
  assert.strictEqual(parityScore(10, 10), 100);
  assert.strictEqual(parityScore(1, 1), 100);
});

test("parityScore: both zero → 100 (vacuously equal)", () => {
  assert.strictEqual(parityScore(0, 0), 100);
});

test("parityScore: one zero, other non-zero → 0 (full divergence)", () => {
  assert.strictEqual(parityScore(5, 0), 0);
  assert.strictEqual(parityScore(0, 5), 0);
});

test("parityScore: symmetric (min ratio works either direction)", () => {
  assert.strictEqual(parityScore(8, 10), parityScore(10, 8));
});

test("parityScore: 80% / 125% → 80", () => {
  assert.strictEqual(parityScore(80, 100), 80);
  assert.strictEqual(parityScore(100, 80), 80);
});

test("classifyURL: fonts", () => {
  assert.strictEqual(classifyURL("https://x.com/foo.woff2"), "font");
  assert.strictEqual(classifyURL("https://x.com/foo.woff"), "font");
  assert.strictEqual(classifyURL("https://x.com/a.ttf?v=2"), "font");
});

test("classifyURL: images", () => {
  assert.strictEqual(classifyURL("https://x.com/foo.png"), "image");
  assert.strictEqual(classifyURL("https://x.com/foo.jpg?q=1"), "image");
  assert.strictEqual(classifyURL("https://x.com/foo.svg"), "image");
});

test("classifyURL: css", () => {
  assert.strictEqual(classifyURL("https://x.com/foo.css"), "css");
  assert.strictEqual(
    classifyURL("https://fonts.googleapis.com/css2?family=Inter"),
    "css",
  );
});

test("classifyURL: js (extension only — bare doc otherwise)", () => {
  assert.strictEqual(classifyURL("https://x.com/bundle.js"), "js");
  assert.strictEqual(classifyURL("https://x.com/m.mjs?v=1"), "js");
});

test("classifyURL: analytics block — does not classify as js/doc", () => {
  assert.strictEqual(
    classifyURL("https://www.googletagmanager.com/gtm.js?id=GTM-X"),
    "analytics",
  );
  assert.strictEqual(
    classifyURL("https://connect.facebook.net/en_US/fbevents.js"),
    "analytics",
  );
  assert.strictEqual(
    classifyURL("https://www.googletagmanager.com/gtag/js?id=G-X"),
    "analytics",
  );
});

test("classifyURL: HTML/doc fallback", () => {
  assert.strictEqual(classifyURL("https://example.com/"), "doc");
  assert.strictEqual(classifyURL("https://example.com/about"), "doc");
});

test("classifyURL: video", () => {
  assert.strictEqual(classifyURL("https://x.com/hero.mp4"), "video");
  assert.strictEqual(classifyURL("https://x.com/clip.webm?t=2"), "video");
});
