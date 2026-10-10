// FEATURE: Mobile customization (Task 5.2) — controlSheet tests for the one
// pure rule inside the sheet's volume slider: a tap maps to exactly one
// host-side bump via the existing hold protocol (see src/mobile/volumeTap.js).
import assert from "node:assert/strict";
import test from "node:test";

import { sliderTapArgs } from "../src/mobile/volumeTap.js";

test("sliderTapArgs: higher tap target bumps up by the delta", () => {
  assert.deepEqual(sliderTapArgs(40, "52"), { direction: "up", step: 12 });
});

test("sliderTapArgs: lower tap target bumps down", () => {
  assert.deepEqual(sliderTapArgs(70, 55), { direction: "down", step: 15 });
});

test("sliderTapArgs: step clamps to the host's hold range [1, 20]", () => {
  // The host clamps every hold step to 20, so a far slider tap moves the
  // largest single legal bump rather than teleporting the full distance.
  assert.deepEqual(sliderTapArgs(10, 100), { direction: "up", step: 20 });
  assert.deepEqual(sliderTapArgs(100, 0), { direction: "down", step: 20 });
  assert.deepEqual(sliderTapArgs(70, 45), { direction: "down", step: 20 });
});

test("sliderTapArgs: no-op taps send nothing", () => {
  assert.equal(sliderTapArgs(35, 35), null);
  // A delta that rounds to zero cannot move the level — send nothing.
  assert.equal(sliderTapArgs(10.2, 10.4), null);
});

test("sliderTapArgs: a missing current level is never guessed as 0", () => {
  assert.equal(sliderTapArgs(null, 40), null);
  assert.equal(sliderTapArgs(undefined, 40), null);
});

test("sliderTapArgs: unparseable slider values send nothing", () => {
  assert.equal(sliderTapArgs(40, "abc"), null);
});
