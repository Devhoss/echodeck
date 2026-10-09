// Regression test for the Android blank-screen crash.
//
// A phone's REST call that does not carry the pairing token is answered 401
// with a JSON *object* (`{"error":"..."}`), not an array. That object was stored
// as the source list, and WidgetTile then called `.find()` on it — a TypeError
// that unmounted React and left a blank app the moment a page with a widget
// appeared. The desktop never hit it because loopback bypasses the host's gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonArray } from "../src/widgets/../constants.js";

/** A fetch Response stand-in, since these run without a DOM. */
function fakeResponse(body, init = {}) {
  return {
    status: init.status ?? 200,
    json: async () => {
      if (typeof body === "string") throw new SyntaxError("not json");
      return body;
    },
  };
}

test("an array body is returned as-is", async () => {
  const list = [{ id: "a", host: "192.168.100.36" }];
  assert.deepEqual(await jsonArray(fakeResponse(list)), list);
});

test("a 401 auth error object becomes an empty list, not a poisoned one", async () => {
  // This is the exact payload the phone received, and the exact crash.
  const body = { error: "Pair this device with EchoDeck first" };
  const result = await jsonArray(fakeResponse(body, { status: 401 }));
  assert.deepEqual(result, []);
  assert.ok(Array.isArray(result), "must be an array for the tile's .find");
});

test("any non-array object settles to an empty list", async () => {
  for (const body of [{}, { error: "boom" }, null, "text", 42, true]) {
    const result = await jsonArray(fakeResponse(body));
    assert.deepEqual(result, [], `body ${JSON.stringify(body)} should normalise to []`);
  }
});

test("unparseable HTML (a SPA catch-all) also settles to an empty list", async () => {
  const result = await jsonArray(fakeResponse("<!DOCTYPE html>"));
  assert.deepEqual(result, []);
});

test("an empty response body is tolerated", async () => {
  assert.deepEqual(await jsonArray(fakeResponse([])), []);
});
