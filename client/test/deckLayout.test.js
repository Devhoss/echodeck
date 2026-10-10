// Responsive deck-layout engine tests (Task 1.1). Pure module, `node --test`, no DOM.
// The eight assertions are the contract from the plan's Task 1.1 Step 1; tests 1-3
// iterate every viewport in test/viewports.js crossed with every item fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TILE_SIZES,
  PRESETS,
  DEFAULT_SETTINGS,
  spanFor,
  resolveBounds,
  packGrid,
  computeDeckLayout,
} from "../src/layout/deckLayout.js";
import { VIEWPORTS } from "./viewports.js";

// ---- fixtures ----------------------------------------------------------------

const buttons = (n) => Array.from({ length: n }, () => ({ size: "1x1" }));
const mixedSpans = [
  { size: "2x1" }, { size: "1x2" }, { size: "2x1" }, { size: "1x2" },
  { size: "2x1" }, { size: "1x2" }, { size: "1x1" }, { size: "2x2" },
];

// Every item set the invariants must hold for, at every viewport.
const FIXTURES = [
  { name: "0 items", items: [] },
  { name: "1 button", items: buttons(1) },
  { name: "3 buttons", items: buttons(3) },
  { name: "6 buttons", items: buttons(6) },
  { name: "12 buttons", items: buttons(12) },
  { name: "16 buttons", items: buttons(16) },
  { name: "24 buttons", items: buttons(24) },
  { name: "12 buttons + 1 widget 2x2", items: [...buttons(12), { size: "2x2" }] },
  { name: "mixed 2x1/1x2 spans", items: mixedSpans },
];

const usedWidth = (r) => r.cols * r.cell + (r.cols - 1) * r.gap;

// ---- 1. no horizontal overflow ------------------------------------------------

for (const vp of VIEWPORTS) {
  for (const fx of FIXTURES) {
    test(`no horizontal overflow — ${vp.name} × ${fx.name}`, () => {
      const r = computeDeckLayout({ width: vp.w, height: vp.h, items: fx.items });
      assert.ok(
        usedWidth(r) <= vp.w + 1,
        `grid ${usedWidth(r)}px exceeds ${vp.w}px viewport (+1px tolerance)`,
      );
    });
  }
}

// ---- 2. cell within bounds when not scrolling ----------------------------------

for (const vp of VIEWPORTS) {
  for (const fx of FIXTURES) {
    test(`cell within bounds — ${vp.name} × ${fx.name}`, () => {
      const r = computeDeckLayout({ width: vp.w, height: vp.h, items: fx.items });
      if (r.scrollY === false) {
        const { minCell, maxCell } = resolveBounds(DEFAULT_SETTINGS);
        assert.ok(r.cell >= minCell, `cell ${r.cell} < minCell ${minCell}`);
        assert.ok(r.cell <= maxCell, `cell ${r.cell} > maxCell ${maxCell}`);
      }
    });
  }
}

// ---- 3. all items placed and in-grid -------------------------------------------

for (const vp of VIEWPORTS) {
  for (const fx of FIXTURES) {
    test(`all items placed in-grid — ${vp.name} × ${fx.name}`, () => {
      const r = computeDeckLayout({ width: vp.w, height: vp.h, items: fx.items });
      assert.equal(r.placements.length, fx.items.length, "every item is placed, none invented");
      for (const p of r.placements) {
        assert.ok(p.col >= 0 && p.col + p.span.cols <= r.cols, `col ${p.col}+${p.span.cols} > ${r.cols}`);
        assert.ok(p.row >= 0 && p.row + p.span.rows <= r.rows, `row ${p.row}+${p.span.rows} > ${r.rows}`);
      }
    });
  }
}

// ---- 4. landscape fills width ---------------------------------------------------

test("landscape fills width: 12 buttons at 800x360 use >= 90% of the viewport", () => {
  const width = 800;
  const r = computeDeckLayout({ width, height: 360, items: buttons(12) });
  assert.ok(
    usedWidth(r) >= width * 0.9,
    `used ${usedWidth(r)}px < 90% of ${width}px (cols=${r.cols}, cell=${r.cell})`,
  );
});

// ---- 5. span clamp fallback -----------------------------------------------------

test("span clamp fallback: a 2x2 at width 320 clamps to 1 column and is still placed", () => {
  // At 320 px there is room for a single readable column once cells are large
  // (D6: shrink span cols, never drop items).
  const settings = { ...DEFAULT_SETTINGS, minCell: 160, maxCell: 260 };
  const items = [{ size: "2x2" }];
  const r = computeDeckLayout({ width: 320, height: 653, items, settings });
  assert.equal(r.placements.length, 1, "nothing is dropped");
  const [p] = r.placements;
  assert.equal(p.span.clamped, true);
  assert.equal(p.span.cols, 1);
  assert.ok(p.col + p.span.cols <= r.cols && p.row + p.span.rows <= r.rows);

  // packGrid's own contract: same clamp when the grid is one column wide.
  const packed = packGrid(items, 1);
  assert.equal(packed.placements[0].span.clamped, true);
  assert.equal(packed.placements[0].span.cols, 1);
});

// ---- 6. preferred-cols ceiling --------------------------------------------------

test("preferred-cols ceiling: custom cols 6 is a ceiling, not a floor (D4)", () => {
  const settings = { ...DEFAULT_SETTINGS, mode: "custom", cols: 6 };
  const small = computeDeckLayout({ width: 320, height: 653, items: buttons(12), settings });
  assert.ok(small.cols <= 3, `320px resolved ${small.cols} columns, expected <= 3`);
  const large = computeDeckLayout({ width: 1600, height: 900, items: buttons(12), settings });
  assert.equal(large.cols, 6);
});

// ---- 7. determinism --------------------------------------------------------------

test("determinism: same inputs produce byte-identical placements", () => {
  for (const vp of VIEWPORTS) {
    const a = computeDeckLayout({ width: vp.w, height: vp.h, items: mixedSpans });
    const b = computeDeckLayout({ width: vp.w, height: vp.h, items: mixedSpans });
    assert.equal(JSON.stringify(a.placements), JSON.stringify(b.placements), vp.name);
  }
});

// ---- 8. height overflow degrades to scroll, not clip ------------------------------

test("height overflow degrades to scroll: cols stay width-driven", () => {
  // 24 buttons cannot fit any height budget here: every legal column count needs
  // rows * minCell > 100 px of height.
  const width = 800;
  const height = 100;
  const items = buttons(24);
  const r = computeDeckLayout({ width, height, items });
  const { minCell, gap } = resolveBounds(DEFAULT_SETTINGS);
  assert.equal(r.scrollY, true);
  assert.ok(r.rows * minCell > height, "fixture really does overflow the height");
  // Columns were chosen from width alone: this many readable columns fit...
  assert.ok(r.cols * (2 * minCell) + (r.cols - 1) * gap <= width + 1);
  // ...and one more column of readable cells would not.
  assert.ok((r.cols + 1) * (2 * minCell) + r.cols * gap > width + 1);
  assert.equal(r.placements.length, items.length);
});

// ---- module surface ---------------------------------------------------------------

test("interface surface matches the plan exactly", () => {
  assert.deepEqual(TILE_SIZES, ["1x1", "2x1", "1x2", "2x2"]);
  assert.deepEqual(spanFor("1x2"), { cols: 1, rows: 2 });
  assert.deepEqual(spanFor("nonsense"), { cols: 1, rows: 1 });
  assert.deepEqual(Object.keys(PRESETS).sort(), ["balanced", "compact", "large"]);
  assert.deepEqual(DEFAULT_SETTINGS, {
    mode: "auto", preset: "balanced", cols: null, minCell: null, maxCell: null, gap: null,
  });
  assert.deepEqual(resolveBounds({ preset: "compact" }), { minCell: 40, maxCell: 96, gap: 6 });
});
