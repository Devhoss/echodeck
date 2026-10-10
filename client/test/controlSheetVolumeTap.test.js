// FEATURE: Mobile customization (Task 5.2, fix round 1) — the pure rule behind
// the sheet's volume slider: a change event maps to ONE `volume_set` frame
// carrying the ABSOLUTE level (see src/mobile/volumeTap.js). No start/stop pair,
// no delta, no host hold race.
import assert from "node:assert/strict";
import test from "node:test";

import { sliderSetArgs } from "../src/mobile/volumeTap.js";

test("sliderSetArgs: higher slider value sets the absolute level", () => {
  assert.deepEqual(sliderSetArgs("speaker", "52"), {
    kind: "set",
    level: 52,
    target: "speaker",
  });
});

test("sliderSetArgs: lower slider value sets the absolute level (mic)", () => {
  assert.deepEqual(sliderSetArgs("mic", 30), {
    kind: "set",
    level: 30,
    target: "mic",
  });
});

test("sliderSetArgs: level clamps to 0..100", () => {
  // The host clamps the absolute level the same way; a far drag reports the
  // true target, never a wrapped/overshooting value.
  assert.equal(sliderSetArgs("speaker", 140).level, 100);
  assert.equal(sliderSetArgs("speaker", -8).level, 0);
});

test("sliderSetArgs: a full-range set is exact, not a ≤20 bump", () => {
  // The old hold helper clamped a single move to 20 so a far tap undershot.
  // Absolute set lands the whole distance in one frame.
  assert.deepEqual(sliderSetArgs("speaker", 100), {
    kind: "set",
    level: 100,
    target: "speaker",
  });
  assert.deepEqual(sliderSetArgs("speaker", 0), {
    kind: "set",
    level: 0,
    target: "speaker",
  });
});

test("sliderSetArgs: value is rounded to an integer level", () => {
  assert.equal(sliderSetArgs("speaker", "40.6").level, 41);
});

test("sliderSetArgs: unparseable or empty slider values send nothing", () => {
  assert.equal(sliderSetArgs("speaker", "abc"), null);
  assert.equal(sliderSetArgs("speaker", ""), null);
  assert.equal(sliderSetArgs("speaker", null), null);
  assert.equal(sliderSetArgs("speaker", undefined), null);
});

test("sliderSetArgs: rapid change events emit one absolute set each, not deltas", () => {
  // A fast 40→55 drag fires several events; each must carry the FULL target of
  // that event (45, 50, 55), never a delta off a stale prop that could sum past
  // the finger. This is the reviewer's invariant.
  const drag = ["45", "50", "55"].map((v) => sliderSetArgs("speaker", v));
  assert.deepEqual(
    drag.map((f) => f && f.level),
    [45, 50, 55],
  );
  assert.ok(drag.every((f) => f && f.kind === "set"));
});
