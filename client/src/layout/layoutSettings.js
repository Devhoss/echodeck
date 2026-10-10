// Phase 3, Task 3.1: resolution of the deck layout knobs the engine reads.
// Pure — mirrors the host's validation (host/src/layoutConfig.js) on the
// client so a corrupt or hostile payload can never reach computeDeckLayout
// with, say, cols=0. Deliberate divergence from the host: the host keeps
// explicit nulls to mean "clear this override in storage"; here a null (or an
// invalid value) simply drops the key, so resolution falls through to the next
// scope and finally to DEFAULT_SETTINGS. Precedence: page > global > defaults.
import { DEFAULT_SETTINGS, PRESETS } from "./deckLayout.js";

// Passthrough so callers (App.jsx, and Phase 6's settings UI) import the
// default from here without reaching into the engine module for it.
export const DEFAULT_LAYOUT = DEFAULT_SETTINGS;

// Same enums as the engine: mode is the engine's two modes, preset must name a
// PRESETS entry so resolveBounds can find its bounds.
const MODES = ["auto", "custom"];
const PRESET_NAMES = Object.keys(PRESETS);

// cols ceiling mirrors computeDeckLayout's maxCols default — a wider custom
// request is dropped, not clamped, exactly like the host's sanitizer.
const MAX_COLS = 12;

// Keep only the keys that are present AND valid; everything else is absent,
// which mergeLayout reads as "no opinion at this scope".
function sanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (MODES.includes(raw.mode)) out.mode = raw.mode;
  if (PRESET_NAMES.includes(raw.preset)) out.preset = raw.preset;
  if (Number.isInteger(raw.cols) && raw.cols >= 1 && raw.cols <= MAX_COLS)
    out.cols = raw.cols;
  for (const key of ["minCell", "maxCell", "gap"]) {
    if (Number.isInteger(raw[key]) && raw[key] > 0) out[key] = raw[key];
  }
  return out;
}

/**
 * Merge the two customization scopes into a full engine settings object shaped
 * like DEFAULT_SETTINGS (all six keys always present). null/undefined scopes —
 * and junk inside them — contribute nothing.
 */
export function mergeLayout(globalConfig, pageConfig) {
  return {
    ...DEFAULT_SETTINGS,
    ...sanitize(globalConfig),
    ...sanitize(pageConfig),
  };
}
