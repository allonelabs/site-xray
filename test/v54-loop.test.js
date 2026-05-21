const test = require("node:test");
const assert = require("node:assert");

// v54 E1: Logic-only abstraction of runUntilClean's stall detector.
// The production loop in v54-stable.js spawns Playwright contexts per pass,
// runs detectors, applies fixes, etc. This simulateLoop strips all of that
// away and replays a pre-baked sequence of issue counts so we can exercise
// the stop-condition state machine in isolation.
//
// Stop conditions (must match runUntilClean exactly):
//   - issueCount === 0                  → "clean"
//   - stall >= 2 (two non-decreasing passes in a row) → "stalled"
//   - pass >= maxPasses                 → "max-passes"
//
// `counts` is the array of issue counts the simulated detector returns
// at each pass (counts[0] = pass-1 count, counts[1] = pass-2 count, ...).
function simulateLoop(counts, maxPasses = Infinity) {
  let prev = Infinity;
  let stall = 0;
  let pass = 0;
  const history = [];
  let stopReason = null;
  for (let i = 0; i < counts.length; i++) {
    pass++;
    const ic = counts[i];
    history.push({ pass, issueCount: ic });
    if (ic === 0) {
      stopReason = "clean";
      break;
    }
    if (ic >= prev) stall++;
    else stall = 0;
    if (stall >= 2) {
      stopReason = "stalled";
      break;
    }
    if (pass >= maxPasses) {
      stopReason = "max-passes";
      break;
    }
    prev = ic;
  }
  return { stopReason, pass, history };
}

test("stops at first clean pass", () => {
  const r = simulateLoop([10, 5, 0, 0]);
  assert.strictEqual(r.stopReason, "clean");
  assert.strictEqual(r.pass, 3);
});

test("stops after 2 stall passes", () => {
  const r = simulateLoop([10, 8, 8, 8, 5, 0]);
  assert.strictEqual(r.stopReason, "stalled");
  assert.strictEqual(r.pass, 4);
});

test("stops at max-passes", () => {
  const r = simulateLoop([10, 9, 8, 7, 6, 5], 3);
  assert.strictEqual(r.stopReason, "max-passes");
  assert.strictEqual(r.pass, 3);
});

test("decreasing then stable counts as stall", () => {
  const r = simulateLoop([20, 15, 10, 10, 10]);
  assert.strictEqual(r.stopReason, "stalled");
});
