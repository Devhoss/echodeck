// FEATURE: Mobile customization (Task 5.3, fix round 1, Minor #2) — the pure
// arm-gating decision behind the status handle's double-tap window. A pull-
// consumed trailing click arrives while React still shows the stale
// `sheetOpen === false`; arming on it would let the NEXT single tap (<350 ms
// later) jump into edit mode. See src/mobile/handleTap.js.
import assert from "node:assert/strict";
import test from "node:test";

import { armDoubleTapOn } from "../src/mobile/handleTap.js";

test("armDoubleTapOn: a tap that opens the sheet arms the window", () => {
  assert.equal(
    armDoubleTapOn({ clickConsumedByPull: false, sheetOpenAtClick: false }),
    true,
  );
});

test("armDoubleTapOn: a tap while open (closing) never arms", () => {
  assert.equal(
    armDoubleTapOn({ clickConsumedByPull: false, sheetOpenAtClick: true }),
    false,
  );
});

test("armDoubleTapOn: a pull-consumed click never arms, stale-open or not", () => {
  // The bug: the trailing click of a pull races the re-render, so
  // sheetOpenAtClick is the stale false — gating on the pull claim is what
  // keeps the window from arming.
  assert.equal(
    armDoubleTapOn({ clickConsumedByPull: true, sheetOpenAtClick: false }),
    false,
  );
  assert.equal(
    armDoubleTapOn({ clickConsumedByPull: true, sheetOpenAtClick: true }),
    false,
  );
});
