// Visible-deck-pages tests (final-review fix, D3). Pure module, `node --test`, no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleDeckPages } from "../src/layout/deckPages.js";

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
