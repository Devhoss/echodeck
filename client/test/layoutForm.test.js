// Layout-settings FORM diff tests (Tasks 6.1 + 6.2). Pure module, `node
// --test`, no DOM. Contract under test is the "smallest diff" invariant: the
// form renders a merged engine settings object but only ever emits keys the
// user actively touched, so an untouched save cannot freeze DEFAULT_SETTINGS
// values into a scope and defeat the page > global > defaults cascade.
// Preset↔slider clearing (named preset pick nulls the custom overrides;
// "custom" pick is a reveal only) and the container's scope-merge (host
// routes REPLACE the whole stored config; nulls delete) are the other two
// rules with real logic. The 6.2 section covers buildPresetSnapshot, which
// reuses all of that discipline for the {defaults, pages} preset scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GAP_MIN,
  PRESET_CHOICES,
  PRESET_NAME_MAX,
  buildPartial,
  buildPresetSnapshot,
  computeSaveEnabled,
  detectPreset,
  initialValues,
  mergeScopeConfig,
  pickPreset,
  sanitizePresetName,
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

// --- Task 6.2: preset snapshots (buildPresetSnapshot) -----------------------
// The four contract cases from the brief, plus the cascade guards. Remember:
// applying a preset REPLACES each scope it mentions and leaves every other
// scope alone, so a scope that would say nothing must be absent entirely.

test("buildPresetSnapshot: nothing touched over an all-defaults deck emits {}", () => {
  // The preset-save analogue of the 6.1 smallest-diff invariant: the form may
  // DISPLAY balanced bounds (48/132/8) and a neutral 4 columns, but an
  // untouched snapshot must not freeze them into the preset.
  assert.deepEqual(buildPresetSnapshot({}, merged(), null, null), {});
});

test("buildPresetSnapshot: only defaults touched emits just {defaults}", () => {
  const snap = buildPresetSnapshot({ gap: 12 }, merged(), null, null);
  assert.deepEqual(snap, { defaults: { gap: 12 } });
  assert.equal(snap.pages, undefined);
});

test("buildPresetSnapshot: toggle OFF (global scope) writes only defaults, never pages", () => {
  // The scope-routing fix for Task 6.2 Important #1. Toggle OFF → the touch
  // lands on the deck's defaults; it must NOT also pin pages[p1] (that used
  // to leak a page's scope against future global edits). currentPageId is
  // passed in but ignored in the global scope.
  const snap = buildPresetSnapshot(
    { gap: 9 },
    merged({ preset: "large" }, null),
    "p1",
    null,
    "global",
  );
  assert.deepEqual(snap, { defaults: { preset: "large", gap: 9 } });
  assert.equal(snap.pages, undefined);
});

test("buildPresetSnapshot: a page with no touched keys never produces a pages entry", () => {
  // Empty pages entries are filtered out — a preset that says nothing about
  // a page must leave that page's scope ALONE on apply, not replace it.
  const snap = buildPresetSnapshot({}, merged({ gap: 11 }, null), "p1", {
    cols: 5,
  });
  assert.deepEqual(snap, { defaults: { gap: 11 } });
});

test("buildPresetSnapshot: toggle ON (page scope) writes only pages[pid], defaults untouched", () => {
  // Host PATCH replaces the page scope wholesale, so a touched-only diff
  // would silently DROP the page's other stored knobs on apply. Keeping them
  // is the same mergeScopeConfig discipline as 6.1's page save. Crucially the
  // page branch emits NO defaults key — a page-scoped touch must never bake
  // itself into the deck's global config (the leak the fix removed).
  const snap = buildPresetSnapshot(
    { gap: 9 },
    merged(null, { cols: 5, gap: 4 }),
    "p1",
    { cols: 5, gap: 4 },
    "page",
  );
  assert.deepEqual(snap, { pages: { p1: { cols: 5, gap: 9 } } });
  assert.equal(snap.defaults, undefined);
});

test("buildPresetSnapshot: stored PAGE overrides never leak into a global-scope defaults", () => {
  // The merge the form renders is page > global; a page-owned key is not the
  // global's opinion. Freezing it into defaults would spread one page's
  // knobs across the whole deck on apply — the cascade-freezing 6.1 refuses.
  // Global scope (toggle OFF) also emits NO pages entry: the touch targets
  // only the deck defaults.
  const snap = buildPresetSnapshot(
    { gap: 10 }, // gap touched while viewing a page whose stored config owns cols
    merged({ preset: "compact" }, { cols: 6 }),
    "p1",
    { cols: 6 },
    "global",
  );
  assert.deepEqual(snap, { defaults: { preset: "compact", gap: 10 } });
  assert.equal(snap.defaults.cols, undefined);
  assert.equal(snap.pages, undefined);
});

test("buildPresetSnapshot: an untouched form over a customized global snapshots that scope", () => {
  // The preset is a snapshot of the CURRENT state, not only of this session's
  // edits — stored non-default knobs must ride along, while keys equal to the
  // engine defaults (auto/balanced) stay dropped.
  const snap = buildPresetSnapshot(
    {},
    merged({ mode: "custom", cols: 7, preset: "balanced" }, null),
    null,
    null,
  );
  assert.deepEqual(snap, { defaults: { mode: "custom", cols: 7 } });
});

test("buildPresetSnapshot: the UI-only custom marker alone produces no scopes at all", () => {
  // pickPreset("custom") is a reveal: buildPartial filters the marker, so the
  // snapshot sees an empty diff — no defaults keys and no page touches, hence
  // no pages entry either. This is what the Save-as-preset gate reads.
  const revealed = pickPreset({}, "custom");
  assert.deepEqual(buildPresetSnapshot(revealed, merged(), "p1", { cols: 5 }), {});
});

test("buildPresetSnapshot: a named-preset pick folds its slider clears into both scopes", () => {
  // Stored global preset large + explicit minCell 100; the user picks
  // balanced (pickPreset emits the named preset plus null clears). The
  // snapshot's global result must have the sliders GONE, not frozen at 100.
  const changes = pickPreset({}, "balanced");
  const snap = buildPresetSnapshot(
    changes,
    merged({ preset: "large", minCell: 100 }, null),
    null,
    null,
  );
  // balanced IS the engine default, and the cleared sliders resolve to the
  // balanced bounds — so the smallest scope that means the same is empty, and
  // an empty defaults scope is dropped per the ruling (presets never clear a
  // scope on apply; documented edge).
  assert.deepEqual(snap, {});
  // The same pick over a NON-default stored sibling still snapshots that
  // sibling — proving the drop is about default equality, not about clears.
  const snap2 = buildPresetSnapshot(
    pickPreset({ mode: "custom", cols: 7 }, "balanced"),
    merged({ preset: "large", minCell: 100, cols: 7 }, null),
    null,
    null,
  );
  assert.deepEqual(snap2, { defaults: { mode: "custom", cols: 7 } });
});

test("buildPresetSnapshot: junk arguments cannot crash it", () => {
  for (const junk of [null, undefined, "string", 42, []]) {
    assert.doesNotThrow(() => buildPresetSnapshot(junk, junk, junk, junk));
  }
  // A numeric page id is a host-shaped id string; anything else is ignored.
  assert.deepEqual(buildPresetSnapshot({ gap: 3 }, merged(), 7, null), {
    defaults: { gap: 3 },
  });
});

test("buildPresetSnapshot: a page-scoped touch produces a page-only snapshot (no defaults key)", () => {
  // Reviewer Minor #5 — the definitive proof of the scope-routing fix. Toggle
  // ON, viewing page "pageA" whose global has a non-default preset, user
  // changes gap. The snapshot must contain ONLY a pages entry (the page's full
  // new stored value), and must NOT carry a `defaults` key at all — before the
  // fix the gap baked into defaults too, so applying shifted gap for the whole
  // deck rather than just pageA.
  const snap = buildPresetSnapshot(
    { gap: 7 },
    merged({ preset: "large" }, { cols: 3 }),
    "pageA",
    { cols: 3 },
    "page",
  );
  assert.deepEqual(snap, { pages: { pageA: { cols: 3, gap: 7 } } });
  assert.equal("defaults" in snap, false);
});

test("buildPresetSnapshot: a page-scoped touch with no page in view is empty", () => {
  // scope "page" but currentPageId null (toggle wired to a page that vanished)
  // → nothing to write; never falls back to a defaults entry.
  assert.deepEqual(
    buildPresetSnapshot({ gap: 7 }, merged({ preset: "large" }, null), null, null, "page"),
    {},
  );
});

// --- sanitizePresetName ------------------------------------------------------

test("sanitizePresetName trims, rejects blank, and caps at PRESET_NAME_MAX", () => {
  assert.equal(sanitizePresetName("  Concert Mode  "), "Concert Mode");
  assert.equal(sanitizePresetName("   "), null);
  assert.equal(sanitizePresetName(""), null);
  assert.equal(sanitizePresetName(null), null);
  assert.equal(sanitizePresetName(42), null);
  assert.equal(sanitizePresetName("x".repeat(PRESET_NAME_MAX + 30)).length, PRESET_NAME_MAX);
});
