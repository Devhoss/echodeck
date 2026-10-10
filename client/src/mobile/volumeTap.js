// FEATURE: Mobile customization (Task 5.2) — the one pure rule behind the
// control sheet's volume slider. A slider tap cannot "set" a level: the host
// only moves volume through the existing hold protocol (volume_hold_start /
// volume_hold_stop), and the host runs one synchronous tick before installing
// its repeat interval. So a start/stop pair with step = |target − current|
// lands exactly one bump that reaches the tapped position. This helper turns
// the tap into those two arguments, or says "nothing to do".
//
// The clamp range mirrors the host's own clamp of `step` (server.js
// volume_hold_start) and the client-side VOLUME_STEP_* range in App.jsx: a
// far slider tap therefore moves the largest single legal bump (20), not the
// whole remaining distance — repeat the tap to walk the rest of the way.

export const SHEET_STEP_MIN = 1;
export const SHEET_STEP_MAX = 20;

/**
 * @param {number|null|undefined} current  the level the sheet currently shows (0–100)
 * @param {number|string} next             the value the user tapped on the slider (0–100)
 * @returns {{direction: "up"|"down", step: number} | null} null = send nothing
 */
export function sliderTapArgs(current, next) {
  // `Number(null)` is 0, so a missing level must be rejected before coercion —
  // guessing "0" would bump the real level by the whole tapped distance.
  if (current === null || current === undefined) return null;
  const cur = Number(current);
  const nx = Number(next);
  if (!Number.isFinite(cur) || !Number.isFinite(nx)) return null;
  const delta = Math.round(nx - cur);
  if (delta === 0) return null;
  const step = Math.min(SHEET_STEP_MAX, Math.max(SHEET_STEP_MIN, Math.abs(delta)));
  return { direction: delta > 0 ? "up" : "down", step };
}
