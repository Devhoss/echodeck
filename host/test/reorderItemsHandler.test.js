// Host regression coverage for the `reorder_items` WS handler's DATA CONTRACT.
//
// The handler lives in src/server.js (`msg.t === "reorder_items"`, ~1173-1192):
// it maps the incoming frame's items through WIRE_KINDS, drops any item whose
// kind is not recognised, and hands the resulting [{kind,id,slot}] batch to
// db.applyItemReorder -> itemOrder.applyReorder. On any rejection it returns
// early WITHOUT broadcast, so the deck is never half-ordered.
//
// Importing server.js (ws) or db.js (better-sqlite3, compiled against
// Electron's ABI) is impossible under system `node --test` — see the header of
// src/itemOrder.js for the precedent. So this test drives the PURE itemOrder
// function the handler ultimately depends on, replicating the handler's
// normalisation verbatim. Zero socket, zero database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyReorder } = require("../src/itemOrder.js");

// Verbatim copy of server.js WIRE_KINDS (host/src/server.js:527-532). The wire
// sends singular kinds ("button"/"widget"); itemOrder validates against its own
// plural table names, so both spellings normalise to the latter.
const WIRE_KINDS = {
  button: "buttons",
  widget: "widgets",
  buttons: "buttons",
  widgets: "widgets",
};

// Verbatim replica of the reorder_items handler body (server.js:1179-1185): map
// each wire item's kind through WIRE_KINDS, keep id/slot as-is, and drop any
// item whose kind is not recognised (so a stray/poisoned frame under-covers the
// page and is rejected before it reaches the writer).
function normalizeReorderItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({ kind: WIRE_KINDS[it?.kind], id: it?.id, slot: it?.slot }))
    .filter((it) => it.kind);
}

test("reorder_items: a well-formed wire frame yields a dense slot map and per-kind legacy positions", () => {
  const msg = {
    page_id: "p1",
    items: [
      { kind: "button", id: 1, slot: 0 },
      { kind: "widget", id: 10, slot: 1 },
      { kind: "button", id: 2, slot: 2 },
    ],
  };
  const existingRows = { buttons: [{ id: 1 }, { id: 2 }], widgets: [{ id: 10 }] };

  const result = applyReorder(existingRows, normalizeReorderItems(msg.items));
  assert.equal(result.error, undefined);
  // slot is the authoritative submitted permutation — exactly the value the
  // handler's db write persists (`UPDATE ... SET slot=?`).
  assert.deepEqual(result.slots, new Map([[1, 0], [10, 1], [2, 2]]));
  // positions are the dense per-kind ranks persisted alongside slot so legacy
  // (position-only) clients keep rendering in the merged order.
  assert.deepEqual(result.positions, new Map([[1, 0], [2, 1], [10, 0]]));
  // Both maps iterate top-to-bottom in slot order, which is what the writer
  // relies on when it walks each kind's rows.
  assert.deepEqual([...result.slots.keys()], [1, 10, 2]);
});

test("reorder_items: singular and plural wire kinds both normalise into itemOrder's table names", () => {
  const items = [
    { kind: "button", id: 1, slot: 0 }, // singular wire spelling
    { kind: "widgets", id: 10, slot: 1 }, // already-plural is also accepted
  ];
  const existing = { buttons: [{ id: 1 }], widgets: [{ id: 10 }] };
  const result = applyReorder(existing, normalizeReorderItems(items));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.slots, new Map([[1, 0], [10, 1]]));
});

test("reorder_items: a pre-backfill page (rows carry only legacy `position`) round-trips to dense slot + position", () => {
  // getItemRows orders rows by COALESCE(slot, position); before backfill a row
  // has no slot, only a legacy position. The reorder batch's slots are still the
  // authoritative order, and the derived positions OVERWRITE the stale legacy
  // ranks rather than trusting them — so an old client picks up the new order.
  const existing = {
    buttons: [
      { id: 1, position: 9 },
      { id: 2, position: 3 },
    ],
    widgets: [{ id: 10, position: 7 }],
  };
  const items = [
    { kind: "button", id: 2, slot: 0 }, // user dragged button 2 to the top
    { kind: "widget", id: 10, slot: 1 },
    { kind: "button", id: 1, slot: 2 },
  ];
  const result = applyReorder(existing, normalizeReorderItems(items));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.slots, new Map([[2, 0], [10, 1], [1, 2]]));
  // dense by kind: buttons 2->0, 1->1; widget 10->0. The stored position values
  // (9, 3, 7) are gone from the derivation.
  assert.deepEqual(result.positions, new Map([[2, 0], [1, 1], [10, 0]]));
});

test("reorder_items: an unrecognised wire kind is dropped, so the short batch is rejected all-or-nothing", () => {
  // kind "pet" maps to undefined and is filtered out by the handler, which
  // under-covers the two-item page. applyReorder rejects the WHOLE batch, so the
  // handler returns early and broadcasts nothing — a poisoned frame can never
  // half-slot a deck.
  const existing = { buttons: [{ id: 1 }], widgets: [{ id: 10 }] };
  const items = [
    { kind: "button", id: 1, slot: 0 },
    { kind: "pet", id: 10, slot: 1 }, // filtered out by WIRE_KINDS
  ];
  const result = applyReorder(existing, normalizeReorderItems(items));
  assert.equal(result.slots, undefined);
  assert.match(result.error, /must cover every item/);
});

test("reorder_items: a duplicate slot in the wire frame is rejected", () => {
  const existing = { buttons: [{ id: 1 }, { id: 2 }], widgets: [] };
  const items = [
    { kind: "button", id: 1, slot: 0 },
    { kind: "button", id: 2, slot: 0 },
  ];
  const result = applyReorder(existing, normalizeReorderItems(items));
  assert.equal(result.slots, undefined);
  assert.match(result.error, /duplicate slot/);
});

test("reorder_items: out-of-range and non-integer slots are rejected", () => {
  const existing = { buttons: [{ id: 1 }], widgets: [{ id: 10 }] };
  assert.match(
    applyReorder(
      existing,
      normalizeReorderItems([
        { kind: "button", id: 1, slot: 5 }, // out of range on a 2-item page
        { kind: "widget", id: 10, slot: 1 },
      ]),
    ).error,
    /out of range/,
  );
  assert.match(
    applyReorder(
      existing,
      normalizeReorderItems([
        { kind: "button", id: 1, slot: 0 },
        { kind: "widget", id: 10, slot: 1.5 }, // non-integer
      ]),
    ).error,
    /integer/,
  );
});

test("reorder_items: an empty or malformed `items` payload normalises to a rejection, never a throw", () => {
  const existing = { buttons: [{ id: 1 }], widgets: [] };
  // The handler defaults a non-array `msg.items` to []. An empty batch then
  // under-covers the page and is rejected all-or-nothing.
  assert.match(
    applyReorder(existing, normalizeReorderItems(undefined)).error,
    /must cover every item/,
  );
  // A frame whose only item has an unrecognised kind normalises to [] as well.
  assert.match(
    applyReorder(existing, normalizeReorderItems([{ kind: "nope", id: 1, slot: 0 }])).error,
    /must cover every item/,
  );
});
