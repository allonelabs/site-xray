const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const SIDECAR_PORT = 19877;

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withSidecar(fn) {
  const server = spawn("python3", ["-m", "http.server", String(SIDECAR_PORT)], {
    cwd: FIXTURES,
    stdio: "ignore",
  });
  try {
    await waitMs(1500);
    return await fn();
  } finally {
    server.kill();
  }
}

function runVerifyOnly(brokenDir, sidecarUrl) {
  return spawnSync(
    "node",
    [
      path.join(ROOT, "v54-stable.js"),
      sidecarUrl,
      "--verify-only",
      brokenDir,
      "--no-fix",
    ],
    { encoding: "utf-8", timeout: 80000 },
  );
}

test(
  "v54 C1: probeClick detects missing click handler on broken clone",
  { timeout: 90000 },
  async () => {
    const brokenDir = path.join(FIXTURES, "click-noop-broken");
    const sidecarUrl = `http://localhost:${SIDECAR_PORT}/click-noop.html`;
    await withSidecar(async () => {
      const res = runVerifyOnly(brokenDir, sidecarUrl);
      const out = (res.stdout || "") + (res.stderr || "");
      assert.match(
        out,
        /click-no-op|click-throws/,
        `expected click-no-op or click-throws in output; got:\n${out}`,
      );
    });
  },
);

test(
  "v54 C2: probeHover detects missing :hover style on broken clone",
  { timeout: 90000 },
  async () => {
    const brokenDir = path.join(FIXTURES, "missing-hover-broken");
    const sidecarUrl = `http://localhost:${SIDECAR_PORT}/missing-hover.html`;
    await withSidecar(async () => {
      const res = runVerifyOnly(brokenDir, sidecarUrl);
      const out = (res.stdout || "") + (res.stderr || "");
      assert.match(
        out,
        /missing-hover/,
        `expected missing-hover in output; got:\n${out}`,
      );
    });
  },
);

test(
  "v54 C2: auditForms detects cross-origin form action on broken clone",
  { timeout: 90000 },
  async () => {
    const brokenDir = path.join(FIXTURES, "broken-form-broken");
    const sidecarUrl = `http://localhost:${SIDECAR_PORT}/broken-form.html`;
    await withSidecar(async () => {
      const res = runVerifyOnly(brokenDir, sidecarUrl);
      const out = (res.stdout || "") + (res.stderr || "");
      assert.match(
        out,
        /broken-form-action/,
        `expected broken-form-action in output; got:\n${out}`,
      );
    });
  },
);
