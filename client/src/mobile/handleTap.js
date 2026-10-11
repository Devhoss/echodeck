// FEATURE: Mobile customization (Task 5.3, fix round 1) — the one pure rule
// behind the status handle's double-tap-into-edit-mode window.
//
// The handle arms `lastTapAtRef` inside its click handler. A pull-down that
// starts on the handle leaves a race: React has already opened the sheet via
// the pull claim, but the trailing click can dispatch BEFORE the re-render
// with `sheetOpen=true` reaches the handler — so the handler sees the stale
// `sheetOpen === false` and would arm the window. A single tap within 350 ms
// then jumps into edit mode.
//
// The gate is the pull-claim signal App already owns: `toggleSheetFromHandle`
// returns `false` exactly when the click was consumed by the pull (the
// pointer sequence that opened the sheet), and that click must never arm.
// All other behavior is unchanged: the tap that opens arms, a tap while open
// (closing) resets.

/**
 * @param {object} state
 * @param {boolean} state.clickConsumedByPull  the App's pull-claim consumed this click
 * @param {boolean} state.sheetOpenAtClick     sheetOpen as the handler saw it (pre-toggle)
 * @returns {boolean} true = arm the double-tap window with "now"; false = reset it to 0
 */
export function armDoubleTapOn({ clickConsumedByPull, sheetOpenAtClick }) {
  return !clickConsumedByPull && !sheetOpenAtClick;
}
