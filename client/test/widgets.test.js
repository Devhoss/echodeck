// Client-side widget unit tests. ESM, because client/package.json is a module.
// Only pure modules are imported — no JSX — so `node --test` needs no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellsFor,
  columnsFor,
  rowsFor,
  spanStyle,
  totalCells,
} from "../src/widgets/layout.js";
import {
  formatBytes,
  formatRate,
  formatPercent,
  formatUptime,
  formatTemperature,
  formatLastSeen,
  formatClock,
  statusLabel,
  isProblemStatus,
} from "../src/widgets/format.js";
import {
  visibleMetrics,
  widgetTypeById,
  WIDGET_TYPES,
  WIDGET_METRIC_IDS,
} from "../src/widgets/registry.js";

// ---- layout ----------------------------------------------------------------

test("cell counts match the spans the renderers apply", () => {
  assert.deepEqual(cellsFor("1x1"), { cols: 1, rows: 1 });
  assert.deepEqual(cellsFor("2x1"), { cols: 2, rows: 1 });
  assert.deepEqual(cellsFor("2x2"), { cols: 2, rows: 2 });
  assert.deepEqual(cellsFor("nonsense"), { cols: 1, rows: 1 });
});

test("totalCells counts cells, not items", () => {
  const items = [{ size: "1x1" }, { size: "2x1" }, { size: "2x2" }];
  assert.equal(totalCells(items), 1 + 2 + 4);
  assert.equal(totalCells([]), 0);
});

test("columnsFor degrades exactly like the old button heuristic", () => {
  // 8 keys → 4 columns, 9..15 → 5, 16+ → 7
  assert.equal(columnsFor([], 6), 4);
  assert.equal(columnsFor([], 8), 4);
  assert.equal(columnsFor([], 9), 5);
  assert.equal(columnsFor([], 15), 5);
  assert.equal(columnsFor([], 16), 7);
  assert.equal(columnsFor([], 40), 7);
  // A page of one small item never asks for four columns it cannot fill.
  assert.equal(columnsFor([], 1), 1);
});

test("a widget page is not squeezed by item count alone", () => {
  // Three keys plus one 2x2 widget is 7 cells — a 4-column grid holds it.
  const items = [{ size: "1x1" }, { size: "1x1" }, { size: "1x1" }, { size: "2x2" }];
  assert.equal(totalCells(items), 7);
  assert.equal(columnsFor(items), 4);
  assert.equal(rowsFor(7, 4), 2);
});

test("spanStyle is empty for a plain 1x1", () => {
  assert.deepEqual(spanStyle("1x1"), {});
  assert.deepEqual(spanStyle("2x2"), { gridColumn: "span 2", gridRow: "span 2" });
  assert.deepEqual(spanStyle("2x1"), { gridColumn: "span 2", gridRow: "span 1" });
});

// ---- formatting ------------------------------------------------------------

test("bytes use unit boundaries that read at a glance", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(2.5 * 1024 ** 3), "2.5 GB");
});

test("unusable values render as an em dash, never NaN", () => {
  for (const bad of [undefined, null, Number.NaN, "abc"]) {
    assert.equal(formatBytes(bad), "—");
    assert.equal(formatRate(bad), "—");
    assert.equal(formatPercent(bad), "—");
    assert.equal(formatUptime(bad), "—");
    assert.equal(formatTemperature(bad), "—");
    assert.equal(formatLastSeen(bad), "never");
  }
});

test("rates are labelled per second", () => {
  assert.equal(formatRate(1024), "1 KB/s");
  assert.equal(formatRate(2.1 * 1024 * 1024), "2.1 MB/s");
  assert.equal(formatRate(-5), "—");
});

test("percent clamps at 100", () => {
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(18.4), "18%");
  assert.equal(formatPercent(140), "100%");
});

test("uptime uses the two most useful units", () => {
  assert.equal(formatUptime(59), "<1m");
  assert.equal(formatUptime(720), "12m");
  assert.equal(formatUptime(3 * 3600 + 17 * 60), "3h 17m");
  assert.equal(formatUptime(4 * 86400 + 3 * 3600), "4d 3h");
  assert.equal(formatUptime(-10), "—");
});

test("last seen reads as a relative age and a wall clock", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatLastSeen(now - 30_000, now), "30s ago");
  assert.equal(formatLastSeen(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatLastSeen(now - 3 * 3600_000, now), "3h ago");
  assert.equal(formatLastSeen(now - 2 * 86400_000, now), "2d ago");
  assert.equal(formatLastSeen(0, now), "never");
  const clock = formatClock(now);
  assert.match(clock, /\d/, "a clock renders digits");
});

test("status words distinguish the failure modes a user can act on", () => {
  assert.equal(statusLabel("online"), "ONLINE");
  assert.equal(statusLabel("connecting"), "CONNECTING");
  assert.equal(statusLabel("auth_error"), "AUTH ERROR");
  assert.equal(statusLabel("offline"), "OFFLINE");
  assert.equal(isProblemStatus("online"), false);
  assert.equal(isProblemStatus("auth_error"), true);
  assert.equal(isProblemStatus(undefined), true);
});

// ---- registry --------------------------------------------------------------

test("only metrics the source actually reports are rendered", () => {
  const widget = { config: { metrics: WIDGET_METRIC_IDS } };
  const partial = { cpu: 12, memory: { used: 1, total: 2, percent: 50 }, uptime: 90 };
  assert.deepEqual(
    visibleMetrics(widget, partial).map((m) => m.id),
    ["cpu", "memory", "uptime"],
  );
});

test("a metric nobody asked for stays hidden even if the source reports it", () => {
  const widget = { config: { metrics: ["cpu"] } };
  const data = { cpu: 5, temperature: 40, containers: { running: 1 } };
  assert.deepEqual(
    visibleMetrics(widget, data).map((m) => m.id),
    ["cpu"],
  );
});

test("docker renders its row when counts exist AND when it failed", () => {
  const widget = { config: { metrics: WIDGET_METRIC_IDS } };
  // Real counts.
  assert.ok(
    visibleMetrics(widget, { containers: { running: 3, stopped: 2, unhealthy: 1 } }).some(
      (m) => m.id === "containers",
    ),
  );
  // An explicit failure must still occupy the row, or the metric silently
  // vanishes and the user cannot tell "no docker" from "not requested".
  assert.ok(
    visibleMetrics(widget, { containers: { error: "docker not installed" } }).some(
      (m) => m.id === "containers",
    ),
  );
});

test("a host with no docker at all still has no containers key", () => {
  const widget = { config: { metrics: WIDGET_METRIC_IDS } };
  assert.equal(
    visibleMetrics(widget, { cpu: 5, memory: { used: 1, total: 2 } }).some(
      (m) => m.id === "containers",
    ),
    false,
  );
});

test("an offline source renders no metric rows at all", () => {
  const widget = { config: { metrics: WIDGET_METRIC_IDS } };
  assert.deepEqual(visibleMetrics(widget, {}), []);
  assert.deepEqual(visibleMetrics(widget, { status: "offline" }), []);
});

test("the widget registry is self-consistent", () => {
  assert.ok(WIDGET_TYPES.length >= 1);
  for (const type of WIDGET_TYPES) {
    assert.ok(type.id, "a type needs an id");
    assert.ok(type.icon, "a type needs an icon");
    assert.ok(type.defaultSize, "a type needs a default size");
    for (const metric of type.defaultMetrics) {
      assert.ok(WIDGET_METRIC_IDS.includes(metric), `${type.id} defaults to unknown metric ${metric}`);
    }
  }
  assert.deepEqual(widgetTypeById("nope").id, WIDGET_TYPES[0].id);
});
