// Phase 6, Task 6.1: the pure diff rules behind LayoutSettingsForm. The form
// renders a MERGED engine settings object (mergeLayout's output) and must emit
// the SMALLEST partial relative to what was originally rendered — a full-config
// save would freeze DEFAULT_SETTINGS values into the page scope and defeat the
// page > global > defaults cascade. All of that bookkeeping lives here, so the
// component carries no logic and the invariant is unit-testable without a DOM
// (same extracted-helpers precedent as mobile/volumeTap.js).
// Phase 6, Task 6.2: the preset snapshot rules. A preset is a named snapshot
// of the layout KNOBS only (plan D4: "Presets save layout settings and
// responsive behavior. They do NOT save tile placements.") — the global
// defaults scope plus optional per-page scopes, never slots or sizes. The
// snapshot reuses the same "smallest partial that means the same" discipline
// as 6.1's save path, so the host's preset sanitizer (sanitizePresetConfig,
// a per-scope pass of sanitizeLayoutFields) accepts every key it emits.
import { DEFAULT_SETTINGS, PRESETS, resolveBounds } from "./deckLayout.js";

// The segmented picker's options: the three engine presets plus the UI-only
// "custom" choice. "custom" is deliberately NOT a preset name — the engine has
// no custom preset; custom bounds are simply explicit minCell/maxCell/gap
// overrides (resolveBounds layers them over whatever preset survives).
export const PRESET_CHOICES = [...Object.keys(PRESETS), "custom"];

// The form's cols picker bounds (plan D4's ceiling mirrors computeDeckLayout's
// maxCols and the host sanitizer) and slider bounds, picked to cover PRESETS
// (compact 40..96/gap 6 up to large 180) with round headroom.
export const COLS_MIN = 1;
export const COLS_MAX = 12;
export const MIN_CELL_MIN = 20;
export const MIN_CELL_MAX = 120;
export const MAX_CELL_MIN = 40;
export const MAX_CELL_MAX = 200;
// Floor is 1, NOT 0: both sanitizers (host/src/layoutConfig.js and the client
// mirror in layoutSettings.js) require gap > 0, and no engine PRESET uses 0.
// A GAP_MIN of 0 would let the optimistic setGlobalLayout({gap:0}) render a
// gapless deck for a moment, only for the sanitizer to reject it and snap back
// on the next pairing — a lie to the user. gap=0 as a real wish is Phase 8.
export const GAP_MIN = 1;
export const GAP_MAX = 20;

// Which preset segment is lit: any non-null slider override reads as "custom"
// (there is no other way to tell, and it matches what the engine does with
// them); otherwise the merged preset name, falling back to the engine default.
export function detectPreset(settings) {
  if (!settings || typeof settings !== "object") return "balanced";
  if (
    settings.minCell != null ||
    settings.maxCell != null ||
    settings.gap != null
  )
    return "custom";
  return settings.preset ?? "balanced";
}

// Control positions when the form mounts. Untouched knobs show what the user
// SEES today — the preset's implicit bounds via resolveBounds, or a neutral
// column count when auto mode never picked one — never a bare null a range
// input cannot display. None of these displayed-but-untouched values are ever
// emitted as changes.
export function initialValues(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const bounds = resolveBounds(s);
  return {
    mode: s.mode === "custom" ? "custom" : "auto",
    preset: detectPreset(s),
    cols: Number.isInteger(s.cols) ? s.cols : 4,
    minCell: s.minCell ?? bounds.minCell,
    maxCell: s.maxCell ?? bounds.maxCell,
    gap: s.gap ?? bounds.gap,
  };
}

// The only mutation a slider/segment can make: record the key as touched.
export function setValue(changes, key, value) {
  return { ...changes, [key]: value };
}

// Preset segmentation has diff semantics beyond a plain value:
// - a NAMED preset also CLEARS the custom sliders in the local diff (explicit
//   nulls are the scope's clear signal — the host sanitizer keeps them as
//   clears and the client mergeLayout drops them, so resolution falls back to
//   the preset's implicit bounds);
// - choosing "custom" is a REVEAL only: it withdraws a same-session named
//   pick (nothing was saved yet), and persists nothing until a slider moves.
//   The preset:"custom" key that stays behind is the UI marker the form reads
//   to show the sliders — buildPartial filters it out, so nothing invalid
//   reaches the wire.
export function pickPreset(changes, preset) {
  const next = { ...changes };
  delete next.preset;
  if (preset === "custom") {
    delete next.minCell;
    delete next.maxCell;
    delete next.gap;
    next.preset = "custom";
    return next;
  }
  return { ...next, preset, minCell: null, maxCell: null, gap: null };
}

// What onSave receives: exactly the touched keys. The UI-only "custom"
// preset view never travels to the wire (the host sanitizer would drop it
// anyway — better not to send junk that a stricter future sanitizer rejects).
export function buildPartial(changes) {
  const out = {};
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (value === undefined) continue;
    if (key === "preset" && value === "custom") continue;
    out[key] = value;
  }
  return out;
}

// Save-button gate, kept pure so the UI decision is unit-tested without a DOM:
// the Save is offered only when (a) the diff actually carries something to
// send and (b) the min/max cell bounds are not inverted. Empty diff would fire
// a no-op save that flashes a false "saved"; inverted bounds (minCell >
// maxCell, reachable because the two sliders have independent ranges) would
// resolve a sub-minimum grid — bounded but visually broken. The engine and
// sanitizers stay as-is; this stops the inversion at the UI boundary.
// `diffKeys` is the emitted partial's key list (length > 0 means "has diff");
// minCell/maxCell are the current display values.
export function computeSaveEnabled({ diffKeys, minCell, maxCell }) {
  const hasDiff =
    Array.isArray(diffKeys) ? diffKeys.length > 0 : Boolean(diffKeys);
  if (!hasDiff) return false;
  return !(minCell > maxCell);
}

// The host's routes REPLACE the whole stored layout_config for a scope
// (POST /api/settings stores the value as the new global; updatePage writes
// the page column wholesale), so the container layers the diff over the
// SCOPE'S OWN STORED config — never over the merged display values, which is
// what would freeze defaults — and an explicit null in the diff deletes the
// key. The result is the complete replacement value for that scope.
export function mergeScopeConfig(stored, partial) {
  const base =
    stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const next = { ...base, ...(partial ?? {}) };
  for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
  return next;
}

// The six keys a layout scope can hold — the DEFAULT_SETTINGS shape.
const SNAPSHOT_KEYS = Object.keys(DEFAULT_SETTINGS);

// The scope snapshot a preset stores, computed from the form's pending diff.
// `changes` is the form's touched-key diff (the same object buildPartial
// consumes), `initialConfig` the merged engine settings the form rendered,
// `currentPageId` the page the "Apply to this page" target resolves to (null
// when global-only), and `pageStored` that page's OWN stored layout_config
// (null when none). Emits `{defaults?, pages?}` containing only scopes with
// at least one key — a preset that mentions no scope changes no scope when
// applied (host routes replace a scope wholesale; unmentioned scopes stay).
//
// The smallest-scope-diff rules:
// - defaults = (merged effective MINUS keys the page scope owns) OVERLAID with
//   the touched diff, then keys equal to DEFAULT_SETTINGS dropped. Subtracting
//   page-owned keys matters because the page renders the MERGED config: a
//   page-stored value frozen into defaults would leak that page's opinion
//   into every page on apply (the exact cascade-freezing 6.1 guards against).
//   A key whose global value equals an engine default is dropped too — the
//   engine resolves it identically without it, and unmentioned scopes are
//   left alone on apply (per-scope ruling; presets never clear a scope).
// - pages[id] = the page's full NEW stored config (its own stored value with
//   the diff layered over it, exactly what 6.1's page save PATCHes). Only
//   emitted when the diff has keys — "the page has touched keys" — because an
//   untouched page's stored config is profile-local placement of knobs, not
//   something the user asked the preset to remember.
export function buildPresetSnapshot(
  changes,
  initialConfig,
  currentPageId,
  pageStored,
) {
  const merged =
    initialConfig && typeof initialConfig === "object" && !Array.isArray(initialConfig)
      ? initialConfig
      : {};
  const stored =
    pageStored && typeof pageStored === "object" && !Array.isArray(pageStored)
      ? pageStored
      : {};
  const partial = buildPartial(changes);

  const globalVisible = {};
  for (const key of SNAPSHOT_KEYS) {
    // The page scope owns this key: its stored value is what the merge shows.
    if (stored[key] !== null && stored[key] !== undefined) continue;
    const v = merged[key];
    if (v === null || v === undefined || v === DEFAULT_SETTINGS[key]) continue;
    globalVisible[key] = v;
  }
  const nextGlobal = mergeScopeConfig(globalVisible, partial);
  const defaults = {};
  for (const [key, value] of Object.entries(nextGlobal)) {
    if (value !== DEFAULT_SETTINGS[key]) defaults[key] = value;
  }

  const out = {};
  if (Object.keys(defaults).length) out.defaults = defaults;
  if (
    typeof currentPageId === "string" &&
    currentPageId.length &&
    Object.keys(partial).length
  ) {
    const page = mergeScopeConfig(stored, partial);
    if (Object.keys(page).length) out.pages = { [currentPageId]: page };
  }
  return out;
}

// Preset-name rule mirrors the host's POST /api/layout-presets gate (a
// trimmed non-empty string), plus a display-length cap the input enforces so
// a wall-of-text name cannot wreck the picker. Returns null when unusable.
export const PRESET_NAME_MAX = 60;
export function sanitizePresetName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, PRESET_NAME_MAX);
}
