// Deck-layout draft model tests (Task 4.2). Pure module, `node --test`, no DOM.
// The draft is the mobile Edit Layout's in-memory working copy: createDraft
// densifies per-page slots, every operation returns a NEW draft (never mutating
// the base), and diffDraft collapses base -> draft into the four authoritative
// batches Task 4.3 / Save replays to the host. The four return-shape keys are
// the plan's Task 4.2 contract:
//   diffDraft(base, draft) -> { reordersByPage, sizePatches, moves, detachments }
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDraft,
  reorder,
  resize,
  moveToPage,
  detach,
  diffDraft,
} from "../src/layout/layoutDraft.js";

// ---- helpers -----------------------------------------------------------------

// A draft tile is addressed by `${kind}:${id}`: buttons and widgets keep
// separate id sequences, so a bare number can collide across kinds. Operations
// take this key as their `id` argument; diffDraft emits bare {kind, id} numbers
// for the host.
const key = (kind, id) => `${kind}:${id}`;

// Tile keys of a page in slot order (dense 0..n-1 after any draft op).
const pageKeys = (draft, pageId) =>
  draft.items
    .filter((it) => it.page_id === pageId)
    .sort((a, b) => a.slot - b.slot)
    .map((it) => it.key);

// The {kind,id,slot} view of a page in slot order — used to assert density.
const pageSlots = (draft, pageId) =>
  draft.items
    .filter((it) => it.page_id === pageId)
    .sort((a, b) => a.slot - b.slot)
    .map((it) => ({ kind: it.kind, id: it.id, slot: it.slot }));

const EMPTY = { reordersByPage: {}, sizePatches: [], moves: [], detachments: [] };

// One page (id 1) of interleaved buttons/widgets with dense slots.
const mixedDeck = () => [
  { kind: "widget", id: 100, page_id: 1, slot: 0, size: "2x2" },
  { kind: "button", id: 1, page_id: 1, slot: 1, size: "1x1" },
  { kind: "button", id: 2, page_id: 1, slot: 2, size: "1x1" },
  { kind: "widget", id: 101, page_id: 1, slot: 3, size: "2x1" },
  { kind: "button", id: 3, page_id: 1, slot: 4, size: "1x1" },
];

// ---- createDraft -------------------------------------------------------------

test("createDraft densifies slots per page in (slot ?? position) order", () => {
  const base = createDraft(mixedDeck());
  assert.deepEqual(pageKeys(base, 1), [
    key("widget", 100),
    key("button", 1),
    key("button", 2),
    key("widget", 101),
    key("button", 3),
  ]);
  assert.deepEqual(
    pageSlots(base, 1).map((e) => e.slot),
    [0, 1, 2, 3, 4],
  );
});

test("createDraft preserves interleaved order across both kinds (slot vs legacy position)", () => {
  // Some rows carry `slot`, some only the legacy `position`. Ordering must read
  // (slot ?? position) ascending regardless of kind — matching the merged
  // deckItems sort at App.jsx:494-500 (D2: slot authoritative, position fallback).
  const items = [
    { kind: "button", id: 7, page_id: 1, position: 3, size: "1x1" },
    { kind: "widget", id: 20, page_id: 1, slot: 1, size: "2x2" },
    { kind: "button", id: 8, page_id: 1, slot: 0, size: "1x1" },
    { kind: "widget", id: 21, page_id: 1, position: 2, size: "1x1" },
    { kind: "button", id: 9, page_id: 1, slot: 4, size: "1x1" },
  ];
  const base = createDraft(items);
  // Expected by (slot ?? position): b8(0), w20(1), w21(2), b7(3), b9(4)
  assert.deepEqual(pageKeys(base, 1), [
    key("button", 8),
    key("widget", 20),
    key("widget", 21),
    key("button", 7),
    key("button", 9),
  ]);
  assert.deepEqual(
    pageSlots(base, 1).map((e) => e.slot),
    [0, 1, 2, 3, 4],
  );
});

test("createDraft groups pages independently and densifies each 0..n-1", () => {
  const base = createDraft([
    { kind: "button", id: 1, page_id: 2, slot: 5, size: "1x1" },
    { kind: "button", id: 2, page_id: 1, slot: 9, size: "1x1" },
    { kind: "button", id: 3, page_id: 2, slot: 2, size: "1x1" },
    { kind: "button", id: 4, page_id: 1, slot: 1, size: "1x1" },
  ]);
  assert.deepEqual(pageSlots(base, 1), [
    { kind: "button", id: 4, slot: 0 },
    { kind: "button", id: 2, slot: 1 },
  ]);
  assert.deepEqual(pageSlots(base, 2), [
    { kind: "button", id: 3, slot: 0 },
    { kind: "button", id: 1, slot: 1 },
  ]);
});

// ---- resize ------------------------------------------------------------------

test("resize changes only the target tile's size and yields exactly one patch", () => {
  const base = createDraft(mixedDeck());
  const draft = resize(base, key("button", 2), "2x2");
  assert.equal(draft.byId[key("button", 2)].size, "2x2");
  assert.equal(base.byId[key("button", 2)].size, "1x1"); // base untouched
  const diff = diffDraft(base, draft);
  assert.deepEqual(diff.sizePatches, [{ kind: "button", id: 2, size: "2x2" }]);
  assert.equal(diff.sizePatches.length, 1);
});

test("resize to the current size is an idempotent no-op (same draft, empty diff)", () => {
  const base = createDraft(mixedDeck());
  const same = base.byId[key("button", 2)].size;
  const draft = resize(base, key("button", 2), same);
  assert.equal(draft, base); // no-op returns the identical reference
  assert.deepEqual(diffDraft(base, draft), EMPTY);
});

test("resize with an unknown size string is a no-op (draft equals input, no diff)", () => {
  const base = createDraft(mixedDeck());
  const draft = resize(base, key("button", 2), "3x3");
  assert.equal(draft, base);
  assert.equal(draft.byId[key("button", 2)].size, "1x1");
  assert.deepEqual(diffDraft(base, draft).sizePatches, []);
});

// ---- reorder (same page) -----------------------------------------------------

test("reorder moves the active tile to the over tile's slot and densifies the page", () => {
  const base = createDraft(mixedDeck());
  const draft = reorder(base, key("button", 1), key("widget", 101));
  // original [w100,b1,b2,w101,b3]; arrayMove b1 (idx1) -> w101 slot (idx3)
  assert.deepEqual(pageKeys(draft, 1), [
    key("widget", 100),
    key("button", 2),
    key("widget", 101),
    key("button", 1),
    key("button", 3),
  ]);
  assert.deepEqual(
    pageSlots(draft, 1).map((e) => e.slot),
    [0, 1, 2, 3, 4],
  );
  const diff = diffDraft(base, draft);
  // reordersByPage carries the whole affected page as a dense permutation batch.
  assert.deepEqual(Object.keys(diff.reordersByPage), ["1"]);
  assert.deepEqual(diff.reordersByPage["1"], pageSlots(draft, 1));
  assert.deepEqual(diff.sizePatches, []);
  assert.deepEqual(diff.moves, []);
  assert.deepEqual(diff.detachments, []);
});

test("reorder across two different pages is a documented no-op (same draft, empty diff)", () => {
  const base = createDraft([
    { kind: "button", id: 1, page_id: 1, slot: 0, size: "1x1" },
    { kind: "button", id: 2, page_id: 1, slot: 1, size: "1x1" },
    { kind: "button", id: 3, page_id: 2, slot: 0, size: "1x1" },
  ]);
  const draft = reorder(base, key("button", 1), key("button", 3)); // pages 1 vs 2
  assert.equal(draft, base);
  assert.deepEqual(diffDraft(base, draft), EMPTY);
});

test("reorder with an unknown id is a no-op", () => {
  const base = createDraft(mixedDeck());
  assert.equal(reorder(base, key("button", 999), key("button", 1)), base);
});

// ---- moveToPage --------------------------------------------------------------

test("moveToPage re-parents the tile, records a move, and re-densifies BOTH pages", () => {
  const base = createDraft([
    { kind: "button", id: 1, page_id: 1, slot: 0, size: "1x1" },
    { kind: "button", id: 2, page_id: 1, slot: 1, size: "1x1" },
    { kind: "button", id: 3, page_id: 1, slot: 2, size: "1x1" },
    { kind: "widget", id: 50, page_id: 2, slot: 0, size: "2x2" },
    { kind: "widget", id: 51, page_id: 2, slot: 1, size: "2x2" },
  ]);
  const draft = moveToPage(base, key("button", 2), 2);
  assert.deepEqual(pageSlots(draft, 1), [
    { kind: "button", id: 1, slot: 0 },
    { kind: "button", id: 3, slot: 1 },
  ]);
  assert.deepEqual(pageSlots(draft, 2), [
    { kind: "widget", id: 50, slot: 0 },
    { kind: "widget", id: 51, slot: 1 },
    { kind: "button", id: 2, slot: 2 },
  ]);
  const diff = diffDraft(base, draft);
  assert.deepEqual(diff.moves, [
    { kind: "button", id: 2, fromPage: 1, toPage: 2, toSlot: 2 },
  ]);
  assert.deepEqual(diff.detachments, []);
  // Membership changed on both pages, so no pure-permutation reorder is emitted
  // (the host move route re-densifies; applyReorder rejects partial coverage).
  assert.deepEqual(diff.reordersByPage, {});
});

test("moveToPage to the current page is a no-op", () => {
  const base = createDraft(mixedDeck());
  assert.equal(moveToPage(base, key("button", 1), 1), base);
});

// ---- detach ------------------------------------------------------------------

test("detach targets the Unfiled page via a lazily-called callback", () => {
  const base = createDraft([
    { kind: "button", id: 1, page_id: 1, slot: 0, size: "1x1" },
    { kind: "button", id: 2, page_id: 1, slot: 1, size: "1x1" },
    { kind: "widget", id: 9, page_id: 1, slot: 2, size: "2x2" },
  ]);
  let calls = 0;
  const requestUnfiledPage = () => {
    calls += 1;
    return 999; // host-assigned hidden "Unfiled" page id
  };

  // Non-detach operations must never invoke the callback.
  let probe = resize(base, key("button", 2), "2x1");
  probe = reorder(probe, key("button", 2), key("button", 1));
  probe = moveToPage(probe, key("widget", 9), 7);
  assert.equal(calls, 0, "non-detach ops must not request the Unfiled page");

  const draft = detach(probe, key("button", 1), requestUnfiledPage);
  assert.equal(calls, 1, "one detach triggers exactly one lazy request");
  assert.equal(draft.byId[key("button", 1)].page_id, 999);
  assert.deepEqual(pageSlots(draft, 999), [{ kind: "button", id: 1, slot: 0 }]);

  const diff = diffDraft(base, draft);
  assert.deepEqual(diff.detachments, [
    { kind: "button", id: 1, fromPage: 1, toPage: 999, toSlot: 0 },
  ]);
  // widget 9 -> page 7 is a plain move, not a detach.
  assert.deepEqual(diff.moves, [
    { kind: "widget", id: 9, fromPage: 1, toPage: 7, toSlot: 0 },
  ]);
});

test("detach of an unknown id does not call the callback", () => {
  const base = createDraft(mixedDeck());
  let calls = 0;
  const draft = detach(base, key("button", 999), () => {
    calls += 1;
    return 999;
  });
  assert.equal(calls, 0);
  assert.equal(draft, base);
});

// ---- diffDraft: the brief's three explicit cases -----------------------------

test("diff: touching one tile of 20 produces exactly one sizePatch and no other-page reorder", () => {
  const items = [];
  for (let i = 1; i <= 10; i++)
    items.push({ kind: "button", id: i, page_id: 1, slot: i - 1, size: "1x1" });
  for (let i = 11; i <= 20; i++)
    items.push({ kind: "button", id: i, page_id: 2, slot: i - 11, size: "1x1" });
  const base = createDraft(items);

  const draft = resize(base, key("button", 15), "2x2"); // one tile on page 2
  const diff = diffDraft(base, draft);

  assert.equal(diff.sizePatches.length, 1);
  assert.deepEqual(diff.sizePatches, [{ kind: "button", id: 15, size: "2x2" }]);
  // A size change must never reshuffle slots on OTHER pages.
  for (const p of Object.keys(diff.reordersByPage)) assert.equal(p, "2");
  assert.deepEqual(diff.moves, []);
  assert.deepEqual(diff.detachments, []);
});

test("diff: an interrupted-drag revert (reorder then reorder back) yields an empty diff", () => {
  const base = createDraft(mixedDeck());
  const forward = reorder(base, pageKeys(base, 1)[0], pageKeys(base, 1)[2]);
  // Undo: move the same tile back to the front position it vacated.
  const p1 = pageKeys(forward, 1);
  const revert = reorder(forward, p1[2], p1[0]);
  assert.deepEqual(diffDraft(base, revert), EMPTY);
});

test("diff: discarding a mutated draft leaves the base deep-equal to its snapshot", () => {
  const items = [
    { kind: "button", id: 1, page_id: 1, slot: 0, size: "1x1" },
    { kind: "button", id: 2, page_id: 1, slot: 1, size: "1x1" },
    { kind: "widget", id: 9, page_id: 1, slot: 2, size: "2x2" },
    { kind: "button", id: 3, page_id: 2, slot: 0, size: "1x1" },
  ];
  const base = createDraft(items);
  const snapshot = structuredClone(base);

  let d = resize(base, key("button", 1), "2x1");
  d = reorder(d, key("button", 2), key("button", 1));
  d = moveToPage(d, key("widget", 9), 2);
  detach(d, key("button", 3), () => 555);

  assert.deepEqual(base, snapshot); // nothing leaked back into the base
});

test("diff: two no-op drafts from the same base report all four keys empty", () => {
  const base = createDraft(mixedDeck());
  const a = resize(base, key("button", 2), "1x1"); // identity resize
  const b = reorder(base, key("button", 1), key("button", 1)); // active === over
  assert.deepEqual(diffDraft(base, a), EMPTY);
  assert.deepEqual(diffDraft(base, b), EMPTY);
});
