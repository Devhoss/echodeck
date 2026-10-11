// Phase 6, Task 6.1: the pure diff rules behind LayoutSettingsForm. The form
// renders a MERGED engine settings object (mergeLayout's output) and must emit
// the SMALLEST partial relative to what was originally rendered — a full-config
// save would freeze DEFAULT_SETTINGS values into the page scope and defeat the
// page > global > defaults cascade. All of that bookkeeping lives here, so the
// component carries no logic and the invariant is unit-testable without a DOM
// (same extracted-helpers precedent as mobile/volumeTap.js).
import { PRESETS, resolveBounds } from "./deckLayout.js";

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
export const GAP_MIN = 0;
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
