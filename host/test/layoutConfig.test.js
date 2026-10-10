// Unit tests for the pure layout-config/size validation layer. Mirrors
// widgetShape.test.js: db.js cannot be loaded under system node
// (better-sqlite3 is compiled against Electron's ABI), so the whitelist math
// lives in layoutConfig.js and is tested here with plain objects.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  BUTTON_SIZES,
  isValidButtonSize,
  sanitizeLayoutFields,
  sanitizeLayoutConfig,
  parseLayoutConfig,
  sanitizePresetConfig,
} = require("../src/layoutConfig.js");

// --- sanitizeLayoutConfig: whitelist + drop-don't-default -------------------

test("a valid config passes through unchanged as JSON text", () => {
  const out = sanitizeLayoutConfig({
    mode: "custom",
    preset: "large",
    cols: 6,
    minCell: 48,
    maxCell: 160,
    gap: 8,
  });
  assert.equal(
    out,
    JSON.stringify({
      mode: "custom",
      preset: "large",
      cols: 6,
      minCell: 48,
      maxCell: 160,
      gap: 8,
    }),
  );
});

test("unknown keys are dropped and the valid survivors are kept", () => {
  const out = sanitizeLayoutConfig({ mode: "auto", theme: "neon", rows: 4 });
  assert.equal(out, JSON.stringify({ mode: "auto" }));
});

test("an invalid value drops its key rather than substituting a default", () => {
  // buildWidgetUpdate's rule: silently writing a guessed value would move the
  // user's deck. mode="diagonal" must vanish, not become "auto".
  const out = sanitizeLayoutFields({ mode: "diagonal", preset: "compact" });
  assert.deepEqual(out, { preset: "compact" });
});

test("cols outside 1..12 is rejected, not clamped", () => {
  assert.equal(sanitizeLayoutFields({ cols: 13 }), null);
  assert.equal(sanitizeLayoutFields({ cols: 0 }), null);
  assert.equal(sanitizeLayoutFields({ cols: -2 }), null);
  assert.equal(sanitizeLayoutFields({ cols: 3.5 }), null);
  assert.deepEqual(sanitizeLayoutFields({ cols: 1 }), { cols: 1 });
  assert.deepEqual(sanitizeLayoutFields({ cols: 12 }), { cols: 12 });
});

test("explicit nulls survive as clears; non-positive cells and gaps are dropped", () => {
  assert.deepEqual(
    sanitizeLayoutFields({ cols: null, minCell: null, gap: null }),
    { cols: null, minCell: null, gap: null },
  );
  assert.deepEqual(sanitizeLayoutFields({ minCell: 0, gap: -4, maxCell: 90 }), {
    maxCell: 90,
  });
  assert.equal(sanitizeLayoutFields({ minCell: 2.5 }), null);
});

test("a config with nothing valid left collapses to null, not '{}'", () => {
  assert.equal(sanitizeLayoutConfig({ nonsense: true }), null);
  assert.equal(sanitizeLayoutConfig("not json"), null);
  assert.equal(sanitizeLayoutConfig(null), null);
  assert.equal(sanitizeLayoutConfig([1, 2]), null);
});

test("a JSON string input is parsed before sanitizing", () => {
  assert.equal(
    sanitizeLayoutConfig('{"mode":"auto","junk":1}'),
    JSON.stringify({ mode: "auto" }),
  );
});

// --- round trip --------------------------------------------------------------

test("parseLayoutConfig reads back what sanitize stored, and null otherwise", () => {
  const stored = sanitizeLayoutConfig({ cols: 4 });
  assert.deepEqual(parseLayoutConfig(stored), { cols: 4 });
  assert.equal(parseLayoutConfig(""), null);
  assert.equal(parseLayoutConfig("{oops"), null);
  assert.equal(parseLayoutConfig("[1,2]"), null);
  assert.equal(parseLayoutConfig(null), null);
});

// --- button size whitelist ----------------------------------------------------

test("BUTTON_SIZES mirrors the client's TILE_SIZES exactly", () => {
  assert.deepEqual(BUTTON_SIZES, ["1x1", "2x1", "1x2", "2x2"]);
});

test("isValidButtonSize accepts the four grid shapes and nothing else", () => {
  for (const size of BUTTON_SIZES) assert.equal(isValidButtonSize(size), true);
  assert.equal(isValidButtonSize("3x3"), false);
  assert.equal(isValidButtonSize("1x3"), false);
  assert.equal(isValidButtonSize(""), false);
  assert.equal(isValidButtonSize(undefined), false);
  assert.equal(isValidButtonSize(null), false);
});

// --- preset payloads -----------------------------------------------------------

test("a preset keeps only the scopes whose contents are valid", () => {
  const out = sanitizePresetConfig({
    name: "should-be-ignored",
    defaults: { mode: "auto", junk: 1 },
    pages: { page_a: { cols: 5 }, page_b: { cols: 99 } },
  });
  assert.deepEqual(out, {
    defaults: { mode: "auto" },
    pages: { page_a: { cols: 5 } },
  });
});

test("a preset with no valid scope anywhere is rejected", () => {
  assert.equal(sanitizePresetConfig({}), null);
  assert.equal(sanitizePresetConfig({ defaults: { mode: "turbo" } }), null);
  assert.equal(sanitizePresetConfig({ pages: { p: { cols: 0 } } }), null);
  assert.equal(sanitizePresetConfig("string"), null);
});
