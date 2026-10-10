// Unit tests for the pure deck item-order (slot) logic. Mirrors
// widgetShape.test.js: db.js cannot be loaded under system node (better-sqlite3
// is compiled against Electron's ABI), so all slot math lives in itemOrder.js
// and is tested here with plain objects.
//
// Row-shape contract under test (decided in itemOrder.js header):
//   existingRows / currentRows / targetPageRows = { buttons: [{id,...}], widgets: [{id,...}] }
//   backfill rows = { id, position, rowid?, page_id? }
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  backfillSlots,
  applyReorder,
  moveItemSlots,
} = require("../src/itemOrder.js");

// --- backfillSlots -----------------------------------------------------------

test("backfillSlots reproduces today's rendered order (buttons sorted, then widgets)", () => {
  // Fixture from the plan: buttons with positions [2,0,1], widgets [0,1].
  // Today the renderer shows buttons ordered by (position,rowid) then widgets
  // by (position,rowid) — the backfill must hand that same sequence slots
  // 0..4 so applying it is visually a no-op.
  const buttons = [
    { id: "bA", position: 2, rowid: 1 },
    { id: "bB", position: 0, rowid: 2 },
    { id: "bC", position: 1, rowid: 3 },
  ];
  const widgets = [
    { id: "wA", position: 0, rowid: 4 },
    { id: "wB", position: 1, rowid: 5 },
  ];
  const out = backfillSlots(buttons, widgets);
  assert.deepEqual(out, [
    { table: "buttons", id: "bB", slot: 0, position: 0 },
    { table: "buttons", id: "bC", slot: 1, position: 1 },
    { table: "buttons", id: "bA", slot: 2, position: 2 },
    { table: "widgets", id: "wA", slot: 3, position: 0 },
    { table: "widgets", id: "wB", slot: 4, position: 1 },
  ]);
});

test("backfillSlots breaks position ties by rowid", () => {
  const buttons = [
    { id: "bHi", position: 0, rowid: 9 },
    { id: "bLo", position: 0, rowid: 2 },
  ];
  const out = backfillSlots(buttons, []);
  assert.deepEqual(
    out.map((r) => [r.id, r.slot]),
    [
      ["bLo", 0],
      ["bHi", 1],
    ],
  );
});

test("backfillSlots numbers slots per page and resets across pages", () => {
  // Slots are page-scoped: two pages must each start at 0, exactly like the
  // per-page (position,rowid) rendering they replace.
  const buttons = [
    { id: "b1", position: 0, rowid: 1, page_id: "p1" },
    { id: "b2", position: 1, rowid: 2, page_id: "p1" },
    { id: "b3", position: 0, rowid: 3, page_id: "p2" },
  ];
  const widgets = [{ id: "w1", position: 0, rowid: 4, page_id: "p2" }];
  const out = backfillSlots(buttons, widgets);
  const byId = Object.fromEntries(out.map((r) => [r.id, r]));
  assert.equal(byId.b1.slot, 0);
  assert.equal(byId.b2.slot, 1);
  assert.equal(byId.b3.slot, 0); // p2 restarts
  assert.equal(byId.w1.slot, 1); // p2: buttons first, widgets continue
  assert.equal(byId.w1.table, "widgets");
});

test("backfillSlots carries the legacy position through unchanged", () => {
  const out = backfillSlots([{ id: "bX", position: 7 }], []);
  assert.deepEqual(out, [{ table: "buttons", id: "bX", slot: 0, position: 7 }]);
});

// --- applyReorder ------------------------------------------------------------

test("applyReorder derives legacy positions from an interleaved reorder (b0,w0,b1)", () => {
  // Mandated case: buttons b0,b1 and widget w0 submitted interleaved as
  // b0,w0,b1 -> button positions 0,1 (dense rank among buttons) and widget
  // position 0.
  const existing = {
    buttons: [{ id: "b0" }, { id: "b1" }],
    widgets: [{ id: "w0" }],
  };
  const submitted = [
    { kind: "buttons", id: "b0", slot: 0 },
    { kind: "widgets", id: "w0", slot: 1 },
    { kind: "buttons", id: "b1", slot: 2 },
  ];
  const result = applyReorder(existing, submitted);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.slots, new Map([
    ["b0", 0],
    ["w0", 1],
    ["b1", 2],
  ]));
  assert.deepEqual(result.positions, new Map([
    ["b0", 0],
    ["b1", 1],
    ["w0", 0],
  ]));
});

test("applyReorder maps iterate in slot order", () => {
  const existing = { buttons: [{ id: "a" }, { id: "b" }], widgets: [] };
  const result = applyReorder(existing, [
    { kind: "buttons", id: "b", slot: 0 },
    { kind: "buttons", id: "a", slot: 1 },
  ]);
  assert.deepEqual([...result.slots.keys()], ["b", "a"]);
  assert.deepEqual([...result.positions.keys()], ["b", "a"]);
});

test("applyReorder accepts a submitted batch listed out of slot order", () => {
  // Slot values are authoritative, array order is not.
  const existing = { buttons: [{ id: "a" }], widgets: [{ id: "w" }] };
  const result = applyReorder(existing, [
    { kind: "widgets", id: "w", slot: 1 },
    { kind: "buttons", id: "a", slot: 0 },
  ]);
  assert.deepEqual([...result.slots], [["a", 0], ["w", 1]]);
});

test("applyReorder rejects a duplicate slot and carries a reason string", () => {
  const existing = { buttons: [{ id: "a" }, { id: "b" }], widgets: [] };
  const result = applyReorder(existing, [
    { kind: "buttons", id: "a", slot: 0 },
    { kind: "buttons", id: "b", slot: 0 },
  ]);
  assert.equal(result.slots, undefined);
  assert.match(result.error, /duplicate slot/);
});

test("applyReorder rejects an id that does not exist on the page", () => {
  const existing = { buttons: [{ id: "a" }], widgets: [] };
  const result = applyReorder(existing, [
    { kind: "buttons", id: "a", slot: 0 },
    { kind: "buttons", id: "ghost", slot: 1 },
  ]);
  assert.equal(result.slots, undefined);
  assert.match(result.error, /unknown item id/);
});

test("applyReorder rejects a button id submitted under the widget kind", () => {
  const existing = { buttons: [{ id: "a" }], widgets: [] };
  const result = applyReorder(existing, [
    { kind: "widgets", id: "a", slot: 0 },
  ]);
  assert.match(result.error, /unknown item id/);
});

test("applyReorder rejects out-of-range, non-integer and duplicate ids", () => {
  const existing = { buttons: [{ id: "a" }, { id: "b" }], widgets: [] };
  assert.match(applyReorder(existing, [
    { kind: "buttons", id: "a", slot: 0 },
    { kind: "buttons", id: "b", slot: 2 },
  ]).error, /slot/);
  assert.match(applyReorder(existing, [
    { kind: "buttons", id: "a", slot: 0 },
    { kind: "buttons", id: "b", slot: 1.5 },
  ]).error, /integer/);
  assert.match(applyReorder(existing, [
    { kind: "buttons", id: "a", slot: 0 },
    { kind: "buttons", id: "a", slot: 1 },
  ]).error, /duplicate/);
});

test("applyReorder rejects a partial batch instead of leaving holes", () => {
  // All-or-nothing: the batch must cover every item on the page so the
  // legacy position derivation below stays dense.
  const existing = { buttons: [{ id: "a" }, { id: "b" }], widgets: [] };
  const result = applyReorder(existing, [{ kind: "buttons", id: "a", slot: 0 }]);
  assert.match(result.error, /must cover every item/);
});

test("applyReorder rejects an unknown kind", () => {
  const existing = { buttons: [{ id: "a" }], widgets: [] };
  const result = applyReorder(existing, [{ kind: "pets", id: "a", slot: 0 }]);
  assert.match(result.error, /unknown kind/);
});

test("applyReorder rejects malformed submissions without throwing", () => {
  const existing = { buttons: [{ id: "a" }], widgets: [] };
  assert.match(applyReorder(existing, "nope").error, /array/);
  assert.match(applyReorder(existing, [{}]).error, /.+/);
});

// --- moveItemSlots -----------------------------------------------------------

test("moveItemSlots appends at the target slot and renumbers both pages", () => {
  // Mandated cross-page append: move b0 (page A: b0,b1) to the end of page B
  // (widget w1, button b2). The moved item lands at slot 2 on page B with the
  // existing items keeping relative order, and page A compacts to 0..0.
  const currentRows = { buttons: [{ id: "b0" }, { id: "b1" }], widgets: [] };
  const targetPageRows = {
    buttons: [{ id: "b2", slot: 1 }],
    widgets: [{ id: "w1", slot: 0 }],
  };
  const result = moveItemSlots(currentRows, "b0", 2, targetPageRows);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.target, [
    { kind: "widgets", id: "w1", slot: 0 },
    { kind: "buttons", id: "b2", slot: 1 },
    { kind: "buttons", id: "b0", slot: 2 },
  ]);
  assert.deepEqual(result.source, [
    { kind: "buttons", id: "b1", slot: 0 },
  ]);
});

test("moveItemSlots inserts mid-page, shifting items after the slot up", () => {
  const currentRows = { buttons: [{ id: "b0" }], widgets: [] };
  const targetPageRows = {
    buttons: [{ id: "t1", slot: 0 }, { id: "t2", slot: 1 }],
    widgets: [],
  };
  const result = moveItemSlots(currentRows, "b0", 1, targetPageRows);
  assert.deepEqual(result.target, [
    { kind: "buttons", id: "t1", slot: 0 },
    { kind: "buttons", id: "b0", slot: 1 },
    { kind: "buttons", id: "t2", slot: 2 },
  ]);
  assert.deepEqual(result.source, []);
});

test("moveItemSlots orders source rows by slot, falling back to position", () => {
  // Rows may carry slot (already migrated) or only legacy position.
  const currentRows = {
    buttons: [
      { id: "bNew", position: 0 },
      { id: "bOld", position: 5 },
    ],
    widgets: [{ id: "w", position: 2 }],
  };
  const result = moveItemSlots(currentRows, "bOld", 0, { buttons: [], widgets: [] });
  assert.deepEqual(result.source, [
    { kind: "buttons", id: "bNew", slot: 0 },
    { kind: "widgets", id: "w", slot: 1 },
  ]);
});

test("moveItemSlots rejects a moved id that is not on the source page", () => {
  const currentRows = { buttons: [{ id: "b0" }], widgets: [] };
  const result = moveItemSlots(currentRows, "nope", 0, { buttons: [], widgets: [] });
  assert.match(result.error, /not found on the current page/);
});

test("moveItemSlots rejects a target slot outside 0..target count", () => {
  const currentRows = { buttons: [{ id: "b0" }], widgets: [] };
  const target = { buttons: [{ id: "t1" }], widgets: [] };
  assert.match(moveItemSlots(currentRows, "b0", 3, target).error, /target slot/);
  assert.match(moveItemSlots(currentRows, "b0", -1, target).error, /target slot/);
});

// --- moveItemSlots: same-page moves (task 2.2 review) -------------------------
// Semantics pinned here: a same-page move (movedId present in the target rows)
// is a legitimate single-list reorder. `target` excludes the moved id from the
// slices before inserting it at targetSlot — every page item once, slots
// 0..n-1 — and `source` is returned EQUAL to `target`, because both describe
// the same page's post-move state (a source compacted to n-1 items could never
// validate against the page's n rows).

test("moveItemSlots same-page: target excludes the moved id and is a full reorder", () => {
  // Page order b0@0, w1@1, b2@2; move b0 to slot 2.
  const rows = {
    buttons: [
      { id: "b0", slot: 0 },
      { id: "b2", slot: 2 },
    ],
    widgets: [{ id: "w1", slot: 1 }],
  };
  const result = moveItemSlots(rows, "b0", 2, rows);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.target, [
    { kind: "widgets", id: "w1", slot: 0 },
    { kind: "buttons", id: "b2", slot: 1 },
    { kind: "buttons", id: "b0", slot: 2 },
  ]);
  assert.equal(result.source, result.target);
});

test("moveItemSlots same-page: produced target passes applyReorder", () => {
  // The whole point of the fix: what moveItemSlots hands the slot writer must
  // validate — previously it carried the moved id twice (n+1 length) and every
  // same-page move 400ed.
  const rows = {
    buttons: [{ id: "b0", slot: 0 }],
    widgets: [{ id: "w1", slot: 1 }],
  };
  const plan = moveItemSlots(rows, "w1", 0, rows);
  const applied = applyReorder(rows, plan.target);
  assert.equal(applied.error, undefined);
  assert.deepEqual([...applied.slots], [
    ["w1", 0],
    ["b0", 1],
  ]);
  // Dense per-kind positions are re-derived (legacy clients unaffected).
  assert.deepEqual([...applied.positions], [
    ["w1", 0],
    ["b0", 0],
  ]);
});

test("moveItemSlots same-page: slot range is 0..n-1 (moved id excluded from count)", () => {
  const rows = {
    buttons: [
      { id: "b0", slot: 0 },
      { id: "b1", slot: 1 },
    ],
    widgets: [],
  };
  // n = 2 items -> valid slots 0..1; 2 is out of range now that the moved id
  // no longer inflates the target count.
  assert.equal(moveItemSlots(rows, "b0", 1, rows).error, undefined);
  assert.match(moveItemSlots(rows, "b0", 2, rows).error, /target slot/);
});

test("moveItemSlots same-page: no-op move to the current slot changes nothing", () => {
  const rows = {
    buttons: [
      { id: "b0", slot: 0 },
      { id: "b1", slot: 1 },
    ],
    widgets: [{ id: "w1", slot: 2 }],
  };
  const result = moveItemSlots(rows, "w1", 2, rows);
  assert.deepEqual(result.target, [
    { kind: "buttons", id: "b0", slot: 0 },
    { kind: "buttons", id: "b1", slot: 1 },
    { kind: "widgets", id: "w1", slot: 2 },
  ]);
});

test("moveItemSlots cross-page unchanged: moved id absent from target keeps compacted source", () => {
  // Regression pin for finding 2's "must not regress cross-page": source is
  // the compacted n-1 list, NOT equal to target.
  const current = {
    buttons: [
      { id: "b0", slot: 0 },
      { id: "b1", slot: 1 },
    ],
    widgets: [],
  };
  const other = { buttons: [{ id: "t1", slot: 0 }], widgets: [] };
  const result = moveItemSlots(current, "b0", 1, other);
  assert.deepEqual(result.source, [{ kind: "buttons", id: "b1", slot: 0 }]);
  assert.deepEqual(result.target, [
    { kind: "buttons", id: "t1", slot: 0 },
    { kind: "buttons", id: "b0", slot: 1 },
  ]);
});
