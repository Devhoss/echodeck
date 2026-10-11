// FEATURE: Mobile customization (Task 5.3, issue #9) — the pure geometry of the
// outer-column pull-down gesture, extracted so the two arbitration tests can be
// unit-tested without a DOM.
//
// Origin test (Rule 2 of the brief): a pointer sequence may only become a
// pull-down if it STARTED in the top strip — the safe-area inset plus the
// 28-px StatusHandle — or on the handle element itself. The `onHandle` arm
// covers the handle's 44-px ::after hit box, which extends 8 px below the
// strip onto the first tile row: a pointer landing there hits the button, and
// `closest("[data-status-handle]")` recognises it even though `clientY` says
// "below the strip". Tile sequences are excluded by origin — tiles never sit
// in the top strip (Rules 4 and 5: hold-to-confirm, volume hold, and guarded
// tiles' setPointerCapture are untouched).
//
// Move test: a pull is `dy >= 24 && dy > 1.5 * |dx|`. It is complementary BY
// CONSTRUCTION to the deck's page-swipe test in App.jsx (which rejects when
// `|dx| < 60 || |dx| < |dy| * 1.5`): both would require `dy > 1.5|dx|` AND
// `|dx| >= 1.5dy`, i.e. `dy > 2.25 * dy` — impossible. One pointer sequence
// can never both open the sheet and flip a page.

export const STRIP_HEIGHT_PX = 28;
export const PULL_MIN_DY_PX = 24;
export const PULL_DOMINANCE = 1.5;

/**
 * @param {number} clientY   pointerdown y in viewport coordinates
 * @param {number} safeTopPx computed env(safe-area-inset-top) of the root column
 * @param {boolean} onHandle whether the target is inside [data-status-handle]
 */
export function originInPullZone(clientY, safeTopPx, onHandle) {
  return onHandle || clientY <= safeTopPx + STRIP_HEIGHT_PX;
}

/** True once the travel from (startX,startY) to (curX,curY) is a deliberate downward pull. */
export function isPullDownGesture(startX, startY, curX, curY) {
  const dy = curY - startY;
  const dx = curX - startX;
  return dy >= PULL_MIN_DY_PX && dy > PULL_DOMINANCE * Math.abs(dx);
}
