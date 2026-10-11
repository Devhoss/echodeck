/**
 * reorder_pages frame-contract test (final polish). Like
 * reorderItemsHandler.test.js this cannot import server.js or db.js (ABI), so
 * the handler's normalisation step is mirrored here VERBATIM from server.js —
 * edit both together if the frame shape changes. The writer it feeds is
 * validated by test/pageOrder.test.js.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyPageOrder } = require("../src/pageOrder");

// verbatim from server.js: missing page_ids coerces to [] and every submitted
// entry is filtered to strings, so a malformed frame rejects cleanly instead of
// throwing; any other non-array batch is passed through untouched so
// applyPageOrder's own type guard reports it.
function normalizePageIds(msg) {
  const submitted = msg.page_ids;
  return Array.isArray(submitted)
    ? submitted.filter((id) => typeof id === "string")
    : (submitted ?? []);
}

function handle(msg, pages) {
  return applyPageOrder(pages, normalizePageIds(msg));
}

test("reorder_pages: a complete visible batch yields dense positions", () => {
  const pages = [
    { id: "a", hidden: 0 },
    { id: "b", hidden: 0 },
  ];
  const { positions, error } = handle({ page_ids: ["b", "a"] }, pages);
  assert.equal(error, undefined);
  assert.deepEqual([...positions], [["b", 0], ["a", 1]]);
});

test("reorder_pages: a missing string id is filtered, so the batch under-covers and rejects", () => {
  const pages = [{ id: "a", hidden: 0 }, { id: "b", hidden: 0 }];
  const result = handle({ page_ids: ["b", 7] }, pages);
  assert.equal(result.positions, undefined);
  assert.match(result.error, /must cover every visible page/);
});

test("reorder_pages: a missing or non-array page_ids rejects instead of throwing", () => {
  const pages = [{ id: "a", hidden: 0 }];
  assert.match(handle({}, pages).error, /must cover every visible page/);
  assert.match(handle({ page_ids: "a" }, pages).error, /must be an array/);
});

test("reorder_pages: an attempt to reorder Unfiled into the visible deck rejects", () => {
  const pages = [
    { id: "a", hidden: 0 },
    { id: "u", hidden: 1 },
  ];
  const result = handle({ page_ids: ["u", "a"] }, pages);
  assert.match(result.error, /hidden page "u"/);
});

test("reorder_pages: hidden pages keep tail positions regardless of the batch", () => {
  const pages = [
    { id: "a", hidden: 0 },
    { id: "b", hidden: 0 },
    { id: "c", hidden: 0 },
    { id: "u", hidden: 1 },
  ];
  const { positions } = handle({ page_ids: ["c", "a", "b"] }, pages);
  assert.deepEqual(
    [...positions].map(([id, p]) => `${id}=${p}`),
    ["c=0", "a=1", "b=2", "u=3"],
  );
});
