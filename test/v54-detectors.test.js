const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const SIDECAR_PORT = 19877;
const SIDECAR_URL = `http://localhost:${SIDECAR_PORT}/click-noop.html`;
const BROKEN_DIR = path.join(FIXTURES, "click-noop-broken");

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test(
  "v54 C1: probeClick detects missing click handler on broken clone",
  { timeout: 90000 },
  async () => {
    // Sidecar python3 static server on a non-default port for the "original"
    const server = spawn(
      "python3",
      ["-m", "http.server", String(SIDECAR_PORT)],
      {
        cwd: FIXTURES,
        stdio: "ignore",
      },
    );
    try {
      await waitMs(1500);
      const res = spawnSync(
        "node",
        [
          path.join(ROOT, "v54-stable.js"),
          SIDECAR_URL,
          "--verify-only",
          BROKEN_DIR,
          "--no-fix",
        ],
        { encoding: "utf-8", timeout: 80000 },
      );
      const out = (res.stdout || "") + (res.stderr || "");
      assert.match(
        out,
        /click-no-op|click-throws/,
        `expected click-no-op or click-throws in output; got:\n${out}`,
      );
    } finally {
      server.kill();
    }
  },
);
