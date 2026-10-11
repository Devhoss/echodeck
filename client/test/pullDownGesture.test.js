// FEATURE: Mobile customization (Task 5.3) — the pure pull-down gesture rules
// (see src/mobile/pullDownGesture.js): top-strip/handle origin filtering and
// vertical-dominance claiming, plus the complementarity invariant with the
// deck's horizontal page-swipe test.
import assert from "node:assert/strict";
import test from "node:test";

import {
  isPullDownGesture,
  originInPullZone,
} from "../src/mobile/pullDownGesture.js";

// Mirrors App.jsx's deck swipe rejection, inverted: this is what makes a deck
// sequence count as a page swipe.
function isPageSwipe(startX, startY, curX, curY) {
  const dx = curX - startX;
  const dy = curY - startY;
  return Math.abs(dx) >= 60 && Math.abs(dx) >= Math.abs(dy) * 1.5;
}

test("originInPullZone: inside the 28px strip below the safe area", () => {
  assert.equal(originInPullZone(10, 47, false), true); // inset padding zone
  assert.equal(originInPullZone(47, 47, false), true); // strip top edge
  assert.equal(originInPullZone(75, 47, false), true); // 47 + 28 boundary, inclusive
});

test("originInPullZone: below the strip only the handle rescues it", () => {
  assert.equal(originInPullZone(76, 47, false), false); // first tile row
  assert.equal(originInPullZone(300, 47, false), false);
  // The handle's ::after hit box extends 8px below the strip; a pointer there
  // targets the button, so the onHandle arm matches regardless of y.
  assert.equal(originInPullZone(80, 47, true), true);
});

test("originInPullZone: zero safe area (browser/desktop) keeps the plain 28px rule", () => {
  assert.equal(originInPullZone(28, 0, false), true);
  assert.equal(originInPullZone(29, 0, false), false);
});

test("isPullDownGesture: straight-down deliberate pull claims", () => {
  assert.equal(isPullDownGesture(100, 20, 100, 44), true); // exactly 24px
  assert.equal(isPullDownGesture(100, 20, 104, 80), true); // slight drift
});

test("isPullDownGesture: short or upward travel never claims", () => {
  assert.equal(isPullDownGesture(100, 20, 100, 43), false); // 23px, under floor
  assert.equal(isPullDownGesture(100, 20, 100, 20), false); // no travel
  assert.equal(isPullDownGesture(100, 80, 100, 20), false); // up-swipe
});

test("isPullDownGesture: horizontal-dominant travel never claims", () => {
  // 1.5 * |dx| must be beaten: dy=30 with dx=25 needs 30 > 37.5 — fails.
  assert.equal(isPullDownGesture(100, 20, 125, 50), false);
  // A classic page swipe: dy stays small while dx runs away.
  assert.equal(isPullDownGesture(100, 20, 400, 40), false);
});

test("invariant: a pull-down and a page swipe are mutually exclusive by construction", () => {
  // Exhaustive small grid: no displacement passes BOTH the sheet's vertical
  // test and the deck's horizontal test — the complementarity the brief's
  // Rule 3 requires. (dy > 1.5|dx| and |dx| >= 1.5dy together imply
  // dy > 2.25dy, impossible for dy > 0.)
  for (let dx = -120; dx <= 120; dx += 4) {
    for (let dy = -120; dy <= 120; dy += 4) {
      const pull = isPullDownGesture(0, 0, dx, dy);
      const swipe = isPageSwipe(0, 0, dx, dy);
      assert.ok(
        !(pull && swipe),
        `vector (${dx},${dy}) claimed by BOTH the pull-down and the page swipe`,
      );
    }
  }
});
