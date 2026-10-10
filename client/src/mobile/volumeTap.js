// FEATURE: Mobile customization (Task 5.2, fix round 1) — the one pure rule
// behind the control sheet's volume slider. A slider change now maps to a
// dedicated `volume_set` frame carrying the ABSOLUTE tapped level, not a
// start/stop hold pair.
//
// Why the change: the hold protocol raced. On the Voicemeeter-first path the
// host's `volume_hold_start` does a real `await getVolume()` before installing
// its repeat interval, and its generation guard ABANDONS the hold when a
// `volume_hold_stop` arrives mid-await. The client sent start+stop back-to-back
// in the same JS task, so on real hosts the pair landed ZERO volume change. A
// single absolute `volume_set` has no such window.
//
// Because the level is absolute, a rapid sequence of drag/change events each
// emit one `set` with the full target value — deltas never accumulate, so there
// is no clamped-step overshoot past the finger position.
//
// Clamp mirrors the host's own `volume_set` clamp (server.js / actions.js): a
// level outside 0–100 is clamped, and an unparseable value sends nothing.

/**
 * @param {"speaker"|"mic"} kind  which output the slider controls
 * @param {number|string} next     the value the user dragged/tapped to (0–100)
 * @returns {{kind: "set", level: number, target: "speaker"|"mic"} | null} null = send nothing
 */
export function sliderSetArgs(kind, next) {
  // `Number(null)`/`Number("")` are 0, so an empty slider value must be
  // rejected before coercion — guessing "0" would slam the real level to mute.
  if (next === null || next === undefined || next === "") return null;
  const nx = Number(next);
  if (!Number.isFinite(nx)) return null;
  const level = Math.max(0, Math.min(100, Math.round(nx)));
  return { kind: "set", level, target: kind === "mic" ? "mic" : "speaker" };
}
