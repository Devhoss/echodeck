// Layout-settings merge tests (Task 3.1). Pure module, `node --test`, no DOM.
// Contract: page overrides global, global overrides DEFAULT_SETTINGS;
// junk keys and nulls are dropped so resolution falls through to defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLayout, DEFAULT_LAYOUT } from "../src/layout/layoutSettings.js";
import { DEFAULT_SETTINGS } from "../src/layout/deckLayout.js";

const KEYS = ["mode", "preset", "cols", "minCell", "maxCell", "gap"];

test("DEFAULT_LAYOUT is the engine's DEFAULT_SETTINGS, unchanged", () => {
  assert.equal(DEFAULT_LAYOUT, DEFAULT_SETTINGS);
});

test("no configs resolves to exactly the defaults (all six keys)", () => {
  assert.deepEqual(mergeLayout(null, null), DEFAULT_SETTINGS);
  assert.deepEqual(mergeLayout(undefined, undefined), DEFAULT_SETTINGS);
  assert.deepEqual(Object.keys(mergeLayout(null, null)).sort(), [...KEYS].sort());
});

test("global scope overrides defaults", () => {
  assert.deepEqual(mergeLayout({ preset: "compact", cols: 5 }, null), {
    ...DEFAULT_SETTINGS,
    preset: "compact",
    cols: 5,
  });
});

test("page scope overrides the same key from global", () => {
  const merged = mergeLayout(
    { preset: "compact", cols: 5, mode: "custom" },
    { preset: "large", cols: 7 },
  );
  assert.equal(merged.preset, "large");
  assert.equal(merged.cols, 7);
  assert.equal(merged.mode, "custom"); // untouched by page: global survives
});

test("junk keys are dropped and never mask a lower scope", () => {
  const merged = mergeLayout(
    { mode: "diagonal", preset: "huge", cols: 13, minCell: -2, maxCell: "x", gap: 1.5 },
    null,
  );
  assert.deepEqual(merged, DEFAULT_SETTINGS);
  // unknown keys never leak into the result either
  const withExtra = mergeLayout({ unknown: 7, mode: "custom" }, null);
  assert.equal(withExtra.mode, "custom");
  assert.ok(!("unknown" in withExtra));
});

test("nulls fall through: a null value at page level cannot clear global", () => {
  const merged = mergeLayout({ cols: 6 }, { cols: null, minCell: null });
  assert.equal(merged.cols, 6); // null page value ignored, global stands
  assert.equal(merged.minCell, null); // nothing set it anywhere -> default
});

test("non-object scopes (strings, arrays, numbers) are ignored", () => {
  assert.deepEqual(mergeLayout("[still a string]", 42), DEFAULT_SETTINGS);
  assert.deepEqual(mergeLayout(["preset"], ["gap"]), DEFAULT_SETTINGS);
});

test("cols boundary: 1 and 12 accepted, 0 and 13 dropped", () => {
  assert.equal(mergeLayout({ cols: 1 }, null).cols, 1);
  assert.equal(mergeLayout({ cols: 12 }, null).cols, 12);
  assert.equal(mergeLayout({ cols: 0 }, null).cols, DEFAULT_SETTINGS.cols);
  assert.equal(mergeLayout({ cols: 13 }, null).cols, DEFAULT_SETTINGS.cols);
});
