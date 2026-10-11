/**
 * Page-order tests (final polish, page reordering). Pure module, `node --test`,
 * no DB: db.js loads better-sqlite3 compiled against Electron's ABI, so all page
 * order math lives here (the itemOrder.js precedent, see its header).
 *
 * `applyPageOrder` reads only { id, hidden } from existing rows. `hidden` is
 * accepted as either a 0/1 integer (raw SELECT rows) or a boolean (post
 * toDeckPage) — both are tested.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyPageOrder, firstVisiblePage } = require("../src/pageOrder");

const P = (...specs) => specs.map(([id, hidden]) => ({ id, hidden }));

// --- applyPageOrder: success ---

test("applyPageOrder rewrites positions in submitted order", () => {
  const rows = P(["a", 0], ["b", 0], ["c", 0]);
  const { positions, error } = applyPageOrder(rows, ["c", "a", "b"]);
  assert.equal(error, undefined);
  assert.deepEqual([...positions], [["c", 0], ["a", 1], ["b", 2]]);
});

test("applyPageOrder accepts a single visible page unchanged", () => {
  const { positions, error } = applyPageOrder(P(["a", 0]), ["a"]);
  assert.equal(error, undefined);
  assert.deepEqual([...positions], [["a", 0]]);
});

test("applyPageOrder pins hidden pages after every visible one, keeping their relative order", () => {
  // The invariant that keeps pages[0] non-hidden however the client reorders.
  const rows = P(["a", 0], ["u", 1], ["b", 0], ["v", 1]);
  const { positions, error } = applyPageOrder(rows, ["b", "a"]);
  assert.equal(error, undefined);
  assert.equal(positions.get("b"), 0);
  assert.equal(positions.get("a"), 1);
  assert.equal(positions.get("u"), 2); // hidden block starts at visibleCount
  assert.equal(positions.get("v"), 3); // …and keeps u-before-v
});

test("applyPageOrder treats boolean hidden the same as 0/1 hidden", () => {
  const rows = [{ id: "a" }, { id: "b", hidden: false }, { id: "u", hidden: true }];
  const { positions, error } = applyPageOrder(rows, ["b", "a"]);
  assert.equal(error, undefined);
  assert.deepEqual([...positions], [["b", 0], ["a", 1], ["u", 2]]);
});

// --- applyPageOrder: rejections ---

test("applyPageOrder rejects a batch that misses a visible page", () => {
  const rows = P(["a", 0], ["b", 0], ["c", 0]);
  const result = applyPageOrder(rows, ["a", "b"]);
  assert.equal(result.positions, undefined);
  assert.match(result.error, /must cover every visible page/);
});

test("applyPageOrder rejects a batch that covers more pages than exist", () => {
  const result = applyPageOrder(P(["a", 0], ["b", 0]), ["a", "b", "c"]);
  assert.match(result.error, /unknown page id "c"/);
});

test("applyPageOrder rejects an unknown id before the coverage check", () => {
  const result = applyPageOrder(P(["a", 0]), ["z"]);
  assert.match(result.error, /unknown page id "z"/);
});

test("applyPageOrder rejects a duplicate id", () => {
  const result = applyPageOrder(P(["a", 0], ["b", 0]), ["a", "a"]);
  assert.match(result.error, /duplicate page id "a"/);
});

test("applyPageOrder rejects a hidden id inside the submitted batch", () => {
  // The batch describes the VISIBLE order; Unfiled is never a drag target.
  const rows = P(["a", 0], ["b", 0], ["u", 1]);
  const result = applyPageOrder(rows, ["u", "a", "b"]);
  assert.match(result.error, /hidden page "u" is not part of the visible order/);
});

test("applyPageOrder rejects non-string ids and non-arrays", () => {
  assert.match(applyPageOrder(P(["a", 0]), [1]).error, /must be strings/);
  assert.match(applyPageOrder(P(["a", 0]), "a").error, /must be an array/);
  assert.match(applyPageOrder("nope", ["a"]).error, /must be an array/);
});

test("applyPageOrder tolerates an empty existing set and an empty batch", () => {
  const { positions, error } = applyPageOrder([], []);
  assert.equal(error, undefined);
  assert.equal(positions.size, 0);
});

// --- firstVisiblePage ---

test("firstVisiblePage returns the first non-hidden row", () => {
  assert.equal(firstVisiblePage(P(["u", 1], ["a", 0], ["b", 0])).id, "a");
});

test("firstVisiblePage returns null for empty, null, and all-hidden input", () => {
  assert.equal(firstVisiblePage([]), null);
  assert.equal(firstVisiblePage(null), null);
  assert.equal(firstVisiblePage(P(["u", 1])), null);
});
