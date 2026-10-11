/**
 * reorder_pages frame-contract test (final polish). The normalisation under
 * test is the PRODUCTION one, not a copy: pageOrder.normalizeSubmittedPageIds
 * is what the handler in src/server.js (`msg.t === "reorder_pages"`) calls
 * before db.applyPageReorder (src/db.js) forwards to pageOrder.applyPageOrder.
 * Like reorderItemsHandler.test.js this cannot import server.js or db.js
 * (better-sqlite3 is compiled against Electron's ABI), but the two halves of
 * this contract now share one function, so deleting or skewing the handler's
 * normalisation breaks this test instead of passing it silently.
 * The writer it feeds is validated by test/pageOrder.test.js.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  applyPageOrder,
  normalizeSubmittedPageIds,
} = require("../src/pageOrder.js");

// handle() mirrors server.js's reorder_pages block exactly: normalise the
// frame's page_ids, then feed applyPageOrder (via db.applyPageReorder in
// production). Both now call the same exported normaliser.
function handle(msg, pages) {
  return applyPageOrder(pages, normalizeSubmittedPageIds(msg.page_ids));
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

// --- normalizeSubmittedPageIds, tested directly (the production function) ---

test("normalizeSubmittedPageIds: non-array batches pass through for applyPageOrder to report", () => {
  assert.equal(normalizeSubmittedPageIds("a"), "a");
  assert.deepEqual(normalizeSubmittedPageIds({}), {});
  // …and the validator's type guard fires on them, not a coverage error.
  const pages = [{ id: "a", hidden: 0 }];
  assert.match(handle({ page_ids: {} }, pages).error, /must be an array/);
});

test("normalizeSubmittedPageIds: null/undefined normalise to an empty batch", () => {
  assert.deepEqual(normalizeSubmittedPageIds(null), []);
  assert.deepEqual(normalizeSubmittedPageIds(undefined), []);
});

test("normalizeSubmittedPageIds: arrays are filtered to strings only", () => {
  assert.deepEqual(normalizeSubmittedPageIds([1, "a", null]), ["a"]);
});
