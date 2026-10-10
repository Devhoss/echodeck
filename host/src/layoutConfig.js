/**
 * layoutConfig.js  —  host/src/layoutConfig.js
 *
 * Validation for the layout-redesign primitives (plan D4/D7): the per-page
 * layout_config knobs, the global layout_config default, layout-preset
 * payloads, and the button size whitelist. Pure — no better-sqlite3 import —
 * so it is unit-testable under plain `node --test`; db.js and server.js
 * require it from here. (Same ABI precedent as widgetShape.js: db.js loads
 * better-sqlite3, which is compiled against Electron's ABI.)
 *
 * Philosophy mirrors buildWidgetUpdate's drop-don't-default: an unknown key is
 * stripped, an invalid value for a known key drops that key (never a silent
 * replacement default — a knob we guessed wrong would move the user's deck),
 * and a whole value that is not an object at all becomes null so callers can
 * store "no config" rather than a corrupt string.
 */

// Keys a layout_config may carry, per plan D4. Everything else is dropped.
const LAYOUT_MODES = ["auto", "custom"];
const LAYOUT_PRESETS = ["compact", "balanced", "large"];

// Button sizes the host accepts on PATCH. Deliberate mirror of the client's
// TILE_SIZES in client/src/layout/deckLayout.js — must stay in step, same as
// the WIDGET_SIZES cross-package link (layout.js:11-12 precedent).
const BUTTON_SIZES = ["1x1", "2x1", "1x2", "2x2"];

function isValidButtonSize(size) {
  return BUTTON_SIZES.includes(size);
}

/**
 * Core sanitizer: a plain object in, a validated plain object out (or null
 * when nothing survives / the input is not an object). `cols` outside 1..12
 * is rejected rather than clamped: a silently clamped column count would
 * reflow the deck the user did not ask for.
 */
function sanitizeLayoutFields(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};

  if (LAYOUT_MODES.includes(obj.mode)) out.mode = obj.mode;
  if (LAYOUT_PRESETS.includes(obj.preset)) out.preset = obj.preset;

  // cols: explicit null clears the override; anything else must be an integer
  // in 1..12 or it is dropped.
  if (obj.cols === null) out.cols = null;
  else if (Number.isInteger(obj.cols) && obj.cols >= 1 && obj.cols <= 12)
    out.cols = obj.cols;

  for (const key of ["minCell", "maxCell", "gap"]) {
    if (obj[key] === null) out[key] = null;
    else if (Number.isInteger(obj[key]) && obj[key] > 0) out[key] = obj[key];
  }

  return Object.keys(out).length ? out : null;
}

/**
 * Storage form for a layout_config value: accepts a plain object (or a JSON
 * string of one, so the settings route can pass text through) and returns the
 * JSON string to store, or null for "no config".
 */
function sanitizeLayoutConfig(value) {
  const parsed = typeof value === "string" ? parseLayoutConfig(value) : value;
  const clean = sanitizeLayoutFields(parsed);
  return clean ? JSON.stringify(clean) : null;
}

/** Read form: stored text back to a plain object, or null when absent/corrupt. */
function parseLayoutConfig(text) {
  if (typeof text !== "string" || !text.length) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Layout-preset payload (plan D7): `{ defaults?: {...}, pages?: {[pageId]: {...}} }`.
 * Each scope runs through sanitizeLayoutFields; scopes that survive empty are
 * dropped. Returns a storable plain object, or null when nothing is valid —
 * an empty preset would be a clickable nothing.
 */
function sanitizePresetConfig(value) {
  const source = typeof value === "string" ? parseLayoutConfig(value) : value;
  if (!source || typeof source !== "object" || Array.isArray(source))
    return null;

  const out = {};
  const defaults = sanitizeLayoutFields(source.defaults);
  if (defaults) out.defaults = defaults;

  if (
    source.pages &&
    typeof source.pages === "object" &&
    !Array.isArray(source.pages)
  ) {
    const pages = {};
    for (const [pageId, raw] of Object.entries(source.pages)) {
      if (typeof pageId !== "string" || !pageId.length) continue;
      const clean = sanitizeLayoutFields(raw);
      if (clean) pages[pageId] = clean;
    }
    if (Object.keys(pages).length) out.pages = pages;
  }

  return Object.keys(out).length ? out : null;
}

module.exports = {
  LAYOUT_MODES,
  LAYOUT_PRESETS,
  BUTTON_SIZES,
  isValidButtonSize,
  sanitizeLayoutFields,
  sanitizeLayoutConfig,
  parseLayoutConfig,
  sanitizePresetConfig,
};
