// Manager behaviour under failure. Real timers, real local collector, fake db.
// The remote path fails on a missing key file, which is enough to prove the
// guarantees: no throw, last-known values retained, stale flagged, and the
// poller keeps going rather than silently dying.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWidgetManager } = require("../src/widgets/manager.js");

const now = () => Date.now();

function fakeWidgets(list) {
  return list.map((w, i) => ({
    id: w.id || `w${i}`,
    page_id: "p1",
    type: "system_monitor",
    position: i,
    size: "2x2",
    label: "Widget",
    icon: "server",
    color: "#185FA5",
    source_id: w.source_id ?? null,
    config: { metrics: w.metrics || ["cpu", "memory"] },
  }));
}

test("a local widget collects and emits a real snapshot", async () => {
  const manager = createWidgetManager({ db: {} });
  const seen = [];
  manager.onChange((changed) => seen.push([...changed.entries()]));

  manager.syncSource(null, fakeWidgets([{ metrics: ["cpu", "memory"] }]));
  // The first tick is immediate, so give it a moment to land.
  await new Promise((r) => setTimeout(r, 400));

  const flat = seen.flat();
  assert.ok(flat.length > 0, "the local source emitted something");
  const [key, snapshot] = flat[0];
  assert.equal(key, "local");
  assert.equal(snapshot.kind, "local");
  assert.equal(snapshot.status, "online");
  assert.equal(snapshot.stale, false);
  assert.equal(typeof snapshot.cpu, "number");
  assert.ok(snapshot.memory.total > 0, "memory came through");
  assert.ok(snapshot.lastUpdated <= now() + 1000, "timestamps are sane");
  manager.stopAll();
});

test("two widgets on one source share a single collector", () => {
  let gets = 0;
  const db = {
    getSource: () => {
      gets += 1;
      return { id: "s1", host: "10.0.0.9", port: 22, username: "u", key_path: null, auth: null, use_agent: 0, refresh_ms: 2000, enabled: 1 };
    },
  };
  const manager = createWidgetManager({ db });
  manager.syncSource("s1", fakeWidgets([{ source_id: "s1" }, { source_id: "s1" }]));
  assert.equal(manager._sources.size, 1, "one source object for both tiles");
  assert.deepEqual(manager._sources.get("s1").id, "s1");
  manager.stopAll();
});

test("a source that cannot authenticate reports auth_error and keeps polling", async () => {
  const db = {
    getSource: () => ({ id: "s1", host: "192.168.100.36", port: 22, username: "hoss", key_path: "C:\\nope\\missing", auth: null, use_agent: 0, refresh_ms: 2000, enabled: 1 }),
  };
  const manager = createWidgetManager({ db });
  const seen = [];
  manager.onChange((changed) => seen.push([...changed.entries()]));

  manager.syncSource("s1", fakeWidgets([{ source_id: "s1" }]));
  await new Promise((r) => setTimeout(r, 300));

  const [, snapshot] = seen.flat()[0];
  assert.equal(snapshot.status, "auth_error");
  assert.equal(snapshot.stale, true, "a failed first sample is stale by definition");
  assert.match(snapshot.lastError, /key file not found/);
  assert.equal(snapshot.lastSeen, null, "the host was never reached");
  // The poller survived the failure.
  assert.ok(manager._state.get("s1")?.timer, "polling continues after a failure");
  manager.stopAll();
});

test("a disabled source is reported as unavailable, not polled into the ground", () => {
  const db = { getSource: () => ({ id: "s1", enabled: 0 }) };
  const manager = createWidgetManager({ db });
  const seen = [];
  manager.onChange((changed) => seen.push([...changed.entries()]));
  manager.syncSource("s1", fakeWidgets([{ source_id: "s1" }]));

  assert.equal(manager._sources.size, 0, "no collector is created");
  const [, unavailable] = seen.flat()[0];
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.stale, true);
  assert.match(unavailable.lastError, /disabled|no longer configured/);
  assert.equal(manager._state.get("s1").timer, null, "nothing is scheduled");
  manager.stopAll();
});

test("a deleted source is reported, not created", () => {
  const manager = createWidgetManager({ db: { getSource: () => null } });
  manager.syncSource("ghost", fakeWidgets([{ source_id: "ghost" }]));
  assert.equal(manager._sources.size, 0);
  assert.equal(manager.status("ghost").status, "unavailable");
  assert.equal(manager.snapshotFor("ghost").stale, true);
  manager.stopAll();
});

test("a listener that throws cannot break the manager or other listeners", async () => {
  const manager = createWidgetManager({ db: {} });
  const survived = [];
  manager.onChange(() => {
    throw new Error("listener exploded");
  });
  manager.onChange((changed) => survived.push([...changed.keys()][0]));

  await assert.doesNotReject(async () => {
    manager.syncSource(null, fakeWidgets([]));
    await new Promise((r) => setTimeout(r, 300));
  });
  assert.deepEqual(survived, ["local"], "the second listener still ran");
  manager.stopAll();
});

test("stopAll clears every timer so the process can exit", async () => {
  const manager = createWidgetManager({ db: {} });
  manager.syncSource(null, fakeWidgets([]));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(manager._state.get("local").timer);
  manager.stopAll();
  assert.equal(manager._state.size, 0);
  assert.equal(manager._sources.size, 0);
});
