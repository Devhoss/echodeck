// Unit tests for widget metric normalization. Pure functions only, so they run
// under the system node without Electron's ABI (better-sqlite3 is never loaded).
// CommonJS because host/package.json is "type": "commonjs".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  cpuDelta,
  normalizeContainers,
  normalizeDisks,
  normalizeLocal,
  normalizeNetwork,
  normalizeSsh,
  normalizeTemperature,
  normalizeUptime,
  parseProcStat,
  percent,
} = require("../src/widgets/metrics.js");

test("percent handles the impossible gracefully", () => {
  assert.equal(percent(50, 100), 50);
  assert.equal(percent(0, 0), null); // division by zero must not leak NaN
  assert.equal(percent(50, "abc"), null);
  assert.equal(percent(-5, 100), 0); // clamped at the bottom
  assert.equal(percent(200, 100), 100); // and at the top
});

test("a local snapshot carries only what it measured", () => {
  const snap = normalizeLocal(
    { cpu: 71.06, memory: { used: 3000000000, total: 8000000000 } },
    { source: null, now: 1000 },
  );
  assert.equal(snap.source, null);
  assert.equal(snap.kind, "local");
  assert.equal(snap.status, "online");
  assert.equal(snap.stale, false);
  assert.equal(snap.lastUpdated, 1000);
  assert.equal(snap.cpu, 71.1);
  assert.equal(snap.memory.percent, 37.5);
  assert.equal(snap.memory.used, 3000000000);
  assert.deepEqual(Object.keys(snap).sort(), [
    "cpu",
    "kind",
    "lastSeen",
    "lastUpdated",
    "memory",
    "source",
    "stale",
    "status",
  ]);
});

test("an empty local reading produces no metric keys at all", () => {
  const snap = normalizeLocal({}, { now: 1 });
  assert.equal(snap.cpu, undefined);
  assert.equal(snap.memory, undefined);
  assert.equal(snap.disks, undefined);
  assert.equal(snap.network, undefined);
  assert.equal(snap.uptime, undefined);
});

test("cpu readings outside reality are dropped, not clamped into a lie", () => {
  assert.equal(normalizeLocal({ cpu: 400 }, { now: 1 }).cpu, undefined);
  assert.equal(normalizeLocal({ cpu: Number.NaN }, { now: 1 }).cpu, undefined);
  assert.equal(normalizeLocal({ cpu: -20 }, { now: 1 }).cpu, undefined);
  assert.equal(normalizeLocal({ cpu: 0 }, { now: 1 }).cpu, 0); // 0 is real
});

test("proc stat parsing subtracts guest so a busy VM cannot exceed 100%", () => {
  // guest=25 lives inside user=100, so it is removed from the total once
  const parsed = parseProcStat("cpu  100 0 50 500 0 0 0 0 25 0");
  assert.deepEqual(parsed, { idle: 500, total: 625 });
  // 40 ticks elapsed, none of them idle → fully busy
  assert.equal(cpuDelta(parsed, parseProcStat("cpu 140 0 70 500 0 0 0 0 25 0")), 100);
});

test("proc stat idle is not reduced by guest time", () => {
  // Adding guest time changes the total but must not change how idle we are:
  // a machine that idled 500 ticks is still one that idled 500 ticks.
  const before = parseProcStat("cpu 100 0 50 500 0 0 0 0 0");
  const after = parseProcStat("cpu 100 0 50 500 0 0 0 0 90");
  assert.equal(after.idle, before.idle);
});

test("proc stat rejects non-cpu lines instead of reading 0%", () => {
  assert.equal(parseProcStat("cpu0 1 2 3 4 5"), null);
  assert.equal(parseProcStat(""), null);
  assert.equal(parseProcStat(null), null);
  assert.equal(cpuDelta(null, parseProcStat("cpu 1 2 3 4")), null);
});

test("cpuDelta ignores a forward jump with no total elapsed time", () => {
  const a = parseProcStat("cpu 10 0 10 90 0 0 0 0");
  assert.equal(cpuDelta(a, a), null);
});

test("cpuDelta computes real utilisation between two samples", () => {
  const before = parseProcStat("cpu 100 0 50 850 0 0 0 0"); // idle 850 of 1000
  const idle = parseProcStat("cpu 100 0 50 890 0 0 0 0"); // +40 total, +40 idle
  assert.equal(cpuDelta(before, idle), 0);
  const busy = parseProcStat("cpu 140 0 50 850 0 0 0 0"); // +40 total, +0 idle
  assert.equal(cpuDelta(before, busy), 100);
  const half = parseProcStat("cpu 120 0 50 870 0 0 0 0"); // +40 total, +20 idle
  assert.equal(cpuDelta(before, half), 50);
});

test("ssh snapshots convert kB to bytes and derive percentages", () => {
  const snap = normalizeSsh(
    {
      cpuStat: parseProcStat("cpu 500 0 100 400 0 0 0 0"),
      mem: { MemTotal: 3941244, MemAvailable: 1313748 },
      disks: [{ mount: "/", used: 100000, total: 200000 }],
      uptime: 11820.5,
      // the probe has already divided millidegrees by 1000
      temperature: 52,
      containers: { running: 5, stopped: 2, unhealthy: 0 },
    },
    { now: 42, prevCpu: parseProcStat("cpu 100 0 50 850 0 0 0 0") },
  );
  assert.equal(snap.kind, "ssh");
  assert.equal(snap.memory.total, 3941244 * 1024);
  assert.equal(snap.memory.used, (3941244 - 1313748) * 1024);
  assert.equal(
    snap.memory.percent,
    Number((((3941244 - 1313748) / 3941244) * 100).toFixed(1)),
  );
  assert.equal(snap.disks[0].percent, 50);
  assert.equal(snap.uptime, 11821);
  assert.equal(snap.containers.running, 5);
  assert.equal(snap.containers.unhealthy, 0);
  assert.equal(snap.temperature, 52);
});

test("a host with no MemAvailable yields no memory block", () => {
  const snap = normalizeSsh(
    { cpuStat: parseProcStat("cpu 1 2 3 4"), mem: { MemTotal: 3941244 } },
    { now: 1 },
  );
  assert.equal(snap.memory, undefined);
});

test("disk entries with no size are dropped, not shown as 0/0", () => {
  const disks = normalizeDisks([
    { mount: "/", used: 1, total: 0 },
    { mount: "/boot", used: 100, total: 1000 },
    { mount: null },
    "garbage",
  ]);
  assert.equal(disks.length, 1);
  assert.equal(disks[0].mount, "/boot");
  assert.equal(disks[0].percent, 10);
});

test("network rates may arrive independently", () => {
  assert.deepEqual(normalizeNetwork({ rx: 2048 }), { rx: 2048 });
  assert.deepEqual(normalizeNetwork({ rx: -1, tx: 10 }), { tx: 10 });
  assert.equal(normalizeNetwork({ rx: "fast" }), null);
  assert.equal(normalizeNetwork(null), null);
});

test("temperature beyond plausible range is dropped", () => {
  assert.equal(normalizeTemperature(200), null); // impossible
  assert.equal(normalizeTemperature(-100), null);
  assert.equal(normalizeTemperature("52.4"), 52.4);
  assert.equal(normalizeTemperature(undefined), null);
});

test("uptime is whole seconds and never negative", () => {
  assert.equal(normalizeUptime(3.6), 4);
  assert.equal(normalizeUptime(-1), null);
  assert.equal(normalizeUptime("nope"), null);
});

test("containers appears only when at least one count is real", () => {
  assert.deepEqual(normalizeContainers({ running: 0 }), { running: 0 });
  assert.deepEqual(normalizeContainers({ running: 2, stopped: 0, unhealthy: 1 }), {
    running: 2,
    stopped: 0,
    unhealthy: 1,
  });
  assert.equal(normalizeContainers({ running: -1 }), null);
  assert.equal(normalizeContainers(undefined), null);
});
