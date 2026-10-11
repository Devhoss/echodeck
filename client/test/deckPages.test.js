// Visible-deck-pages tests (final-review fix, D3). Pure module, `node --test`, no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleDeckPages, pagesInOrder } from "../src/layout/deckPages.js";

test("empty input returns empty array", () => {
  assert.deepEqual(visibleDeckPages([]), []);
});

test("null/undefined input returns empty array", () => {
  assert.deepEqual(visibleDeckPages(null), []);
  assert.deepEqual(visibleDeckPages(undefined), []);
});

test("all-visible passthrough preserves order and identity", () => {
  const a = { id: 1, name: "Home" };
  const b = { id: 2, name: "Work" };
  const c = { id: 3, name: "Games" };
  const result = visibleDeckPages([a, b, c]);
  assert.deepEqual(result.map((p) => p.id), [1, 2, 3]);
  assert.equal(result[0], a);
  assert.equal(result[1], b);
  assert.equal(result[2], c);
});

test("hidden: true is omitted; hidden: false and absent hidden are kept", () => {
  const hidden = { id: 1, hidden: true };
  const shown = { id: 2, hidden: false };
  const plain = { id: 3 };
  assert.deepEqual(visibleDeckPages([hidden, shown, plain]), [shown, plain]);
});

test("mixed fixture keeps the visible subset in original order", () => {
  const pages = [{ id: 1 }, { id: 2, hidden: true }, { id: 3 }];
  assert.deepEqual(
    visibleDeckPages(pages).map((p) => p.id),
    [1, 3],
  );
});

// pagesInOrder: re-sort the visible page list by a draft's order without ever
// inventing or dropping a page. Pure module, `node --test`, no DOM.

test("pagesInOrder returns the listed order, preserving object identity", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const out = pagesInOrder([a, b], ["b", "a"]);
  assert.deepEqual(out.map((p) => p.id), ["b", "a"]);
  assert.equal(out[0], b);
});

test("pagesInOrder keeps an order-less list as-is", () => {
  const a = { id: "a" };
  assert.deepEqual(pagesInOrder([a], []), [a]);
  assert.deepEqual(pagesInOrder([a], null), [a]);
});

test("pagesInOrder trails pages the order does not mention, in their own order", () => {
  // A page created after the draft was seeded is new to the order list; it must
  // still render rather than vanish from the pager.
  const out = pagesInOrder(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    ["c", "a"],
  );
  assert.deepEqual(out.map((p) => p.id), ["c", "a", "b"]);
});

test("pagesInOrder drops ids the page list does not contain", () => {
  const out = pagesInOrder([{ id: "a" }], ["ghost", "a"]);
  assert.deepEqual(out.map((p) => p.id), ["a"]);
});

test("pagesInOrder survives null input", () => {
  assert.deepEqual(pagesInOrder(null, ["a"]), []);
});
