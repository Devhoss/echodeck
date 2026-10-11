// Layout-settings FORM diff tests (Task 6.1). Pure module, `node --test`, no
// DOM. Contract under test is the "smallest diff" invariant: the form renders
// a merged engine settings object but only ever emits keys the user actively
// touched, so an untouched save cannot freeze DEFAULT_SETTINGS values into a
// scope and defeat the page > global > defaults cascade. Preset↔slider
// clearing (named preset pick nulls the custom overrides; "custom" pick is a
// reveal only) and the container's scope-merge (host routes REPLACE the whole
// stored config; nulls delete) are the other two rules with real logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GAP_MIN,
  PRESET_CHOICES,
  buildPartial,
  computeSaveEnabled,
  detectPreset,
  initialValues,
  mergeScopeConfig,
  pickPreset,
  setValue,
} from "../src/layout/layoutForm.js";
import { DEFAULT_SETTINGS, PRESETS } from "../src/layout/deckLayout.js";
import { mergeLayout } from "../src/layout/layoutSettings.js";

const merged = (global = null, page = null) => mergeLayout(global, page);

// --- initialValues: what the controls show, never what gets saved ----------

test("a defaults-everywhere form shows auto/balanced with the balanced bounds", () => {
  assert.deepEqual(initialValues(merged()), {
    mode: "auto",
    preset: "balanced",
    cols: 4,
    ...PRESETS.balanced,
  });
});

test("explicit slider overrides read as the Custom preset segment", () => {
  assert.equal(detectPreset(merged({ gap: 12 }, null)), "custom");
  assert.equal(detectPreset(merged({ minCell: 64 }, null)), "custom");
  assert.equal(detectPreset(merged({ preset: "large" }, null)), "large");
  const v = initialValues(merged({ preset: "large", minCell: 100 }, null));
  assert.equal(v.preset, "custom");
  assert.equal(v.minCell, 100); // explicit override shown
  assert.equal(v.maxCell, PRESETS.large.maxCell); // unset sibling: preset's own
});

test("malformed input cannot crash the mount (null/undefined/garbage)", () => {
  for (const junk of [null, undefined, "string", 42, []]) {
    assert.doesNotThrow(() => initialValues(junk));
    assert.doesNotThrow(() => mergeScopeConfig(junk, { gap: 4 }));
  }
});

// --- smallest-diff invariant ------------------------------------------------

test("touching nothing saves nothing — the cascade-freezing case", () => {
  // The whole point: even though the form DISPLAYS mode/preset/cols/cell/gap
  // values (defaults included), an untouched Save must emit {} — not the
  // rendered defaults as if the user had typed them.
  assert.deepEqual(buildPartial({}), {});
});

test("a touched key emits exactly its value and nothing else", () => {
  assert.deepEqual(buildPartial(setValue({}, "gap", 12)), { gap: 12 });
  assert.deepEqual(
    buildPartial(setValue(setValue({}, "mode", "custom"), "cols", 6)),
    { mode: "custom", cols: 6 },
  );
});

test("the UI-only 'custom' preset never travels to the wire", () => {
  // sanitizeLayoutConfig (host) and sanitize (client) both drop preset values
  // outside PRESETS, and pickPreset already withdraws it — belt and braces:
  // buildPartial filters it too.
  assert.deepEqual(buildPartial({ preset: "custom", gap: 9 }), { gap: 9 });
});

test("undefined pending values are filtered, nulls are kept as clear signals", () => {
  assert.deepEqual(buildPartial({ mode: undefined, gap: null }), { gap: null });
});

// --- preset <-> slider clearing ---------------------------------------------

test("picking a named preset clears the custom sliders in the local diff", () => {
  const changes = pickPreset(setValue({}, "gap", 12), "compact");
  assert.deepEqual(changes, {
    preset: "compact",
    minCell: null,
    maxCell: null,
    gap: null,
  });
  assert.deepEqual(buildPartial(changes), {
    preset: "compact",
    minCell: null,
    maxCell: null,
    gap: null,
  });
});

test("picking Custom is a reveal only: it persists nothing by itself", () => {
  // A fresh form over a named preset: withdrawing everything leaves the diff
  // empty — the sliders merely appeared, no storage decision was made yet.
  assert.deepEqual(buildPartial(pickPreset({}, "custom")), {});
});

test("the Custom reveal survives a re-read: the marker key stays, the diff does not", () => {
  // The form derives its preset segment position from the pending changes, so
  // picking Custom must leave a "custom" marker behind — and buildPartial
  // must still filter it out of the emitted partial.
  const revealed = pickPreset({}, "custom");
  assert.equal(revealed.preset, "custom");
  assert.deepEqual(buildPartial(revealed), {});
});

test("a Custom reveal withdraws a same-session named pick", () => {
  const named = pickPreset({}, "large");
  const backToCustom = pickPreset(named, "custom");
  assert.deepEqual(buildPartial(backToCustom), {});
});

test("a slider moved after a named pick overrides its clear", () => {
  const changes = setValue(pickPreset({}, "balanced"), "gap", 10);
  assert.deepEqual(buildPartial(changes), {
    preset: "balanced",
    minCell: null,
    maxCell: null,
    gap: 10,
  });
});

test("PRESET_CHOICES is the engine presets plus the UI-only custom", () => {
  assert.deepEqual(PRESET_CHOICES, ["compact", "balanced", "large", "custom"]);
});

// --- container scope merge (host routes replace the stored config) ----------

test("the partial layers over the scope's OWN stored config", () => {
  // Page stored cols:5; the user changed only gap. Replacing wholesale would
  // silently drop the page's cols — merging keeps it.
  assert.deepEqual(
    mergeScopeConfig({ cols: 5, preset: "compact" }, { gap: 12 }),
    { cols: 5, preset: "compact", gap: 12 },
  );
});

test("null in the diff deletes the key from the scope", () => {
  assert.deepEqual(
    mergeScopeConfig({ preset: "large", minCell: 100, gap: 14 }, {
      preset: "balanced",
      minCell: null,
      maxCell: null,
      gap: null,
    }),
    { preset: "balanced" },
  );
});

test("the merge never inherits merged-display values the scope never had", () => {
  // Global preset large, page scope holds nothing, user sets page gap only:
  // the emitted page value must stay {gap} — preset must NOT be materialised
  // into the page scope just because the form displayed it.
  assert.deepEqual(mergeScopeConfig(null, { gap: 7 }), { gap: 7 });
});

test("mergeScopeConfig result survives mergeLayout unchanged at its scope", () => {
  const next = mergeScopeConfig({ cols: 5 }, { gap: 12 });
  const after = mergeLayout(null, next);
  assert.equal(after.cols, 5);
  assert.equal(after.gap, 12);
  assert.equal(after.preset, DEFAULT_SETTINGS.preset); // untouched keys still fall through
});

// --- gap floor -------------------------------------------------------------

test("GAP_MIN is 1: gap=0 is not offered (both sanitizers reject it)", () => {
  // host/src/layoutConfig.js and the client mirror layoutSettings.js both
  // require gap > 0, and no engine PRESET uses 0. A 0 floor would let the
  // optimistic save render a gapless deck then snap back on next pairing.
  assert.equal(GAP_MIN, 1);
});

test("the gap floor builds a partial that survives the client sanitizer", () => {
  // Take the minimum the slider can emit and prove it is accepted (not dropped)
  // by the real mergeLayout sanitizer — the round-trip the optimistic path uses.
  const partial = buildPartial(setValue({}, "gap", GAP_MIN));
  assert.deepEqual(partial, { gap: 1 });
  assert.equal(mergeLayout(null, partial).gap, 1);
});

// --- save gate (empty diff / inverted bounds) ------------------------------

test("computeSaveEnabled: empty diff disables Save (no false-success flash)", () => {
  assert.equal(computeSaveEnabled({ diffKeys: [], minCell: 48, maxCell: 132 }), false);
});

test("computeSaveEnabled: a real diff with valid bounds enables Save", () => {
  assert.equal(
    computeSaveEnabled({ diffKeys: ["gap"], minCell: 48, maxCell: 132 }),
    true,
  );
});

test("computeSaveEnabled: inverted bounds (minCell > maxCell) disable Save", () => {
  assert.equal(
    computeSaveEnabled({ diffKeys: ["minCell"], minCell: 100, maxCell: 50 }),
    false,
  );
});

test("computeSaveEnabled: a diff that is only the UI-only custom marker is empty", () => {
  // buildPartial filters preset:"custom", so the diffKeys the form passes in is
  // [] — a bare Custom reveal must not enable Save.
  const revealed = pickPreset({}, "custom");
  assert.deepEqual(buildPartial(revealed), {});
  assert.equal(
    computeSaveEnabled({
      diffKeys: Object.keys(buildPartial(revealed)),
      minCell: 48,
      maxCell: 132,
    }),
    false,
  );
});

test("computeSaveEnabled: a named-pick clear diff has valid bounds", () => {
  // Named preset emits minCell:null/maxCell:null clears; the display values
  // fall back to the preset bounds (never inverted), so Save is enabled.
  const changes = pickPreset({}, "large");
  assert.equal(
    computeSaveEnabled({
      diffKeys: Object.keys(buildPartial(changes)),
      minCell: PRESETS.balanced.minCell,
      maxCell: PRESETS.balanced.maxCell,
    }),
    true,
  );
});
