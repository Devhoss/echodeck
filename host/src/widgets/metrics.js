/**
 * metrics.js  —  host/src/widgets/metrics.js
 *
 * Turns whatever a collector produced into the one normalized shape every
 * widget renders. A widget never knows whether its numbers came from `os`,
 * from PowerShell or from a Linux host over SSH.
 *
 * The rule that keeps the UI simple: **only available metrics are present.**
 * A field the source could not measure is omitted from the object rather than
 * sent as null, so a tile that was never asked to show temperature is
 * indistinguishable from one on a machine with no sensors.
 */

const CPU_ABSURD = 200; // a percentage above this is a broken reading, not load
const TEMP_MIN = -50;
const TEMP_MAX = 150;

// ---- shared helpers ---------------------------------------------------------

function percent(used, total) {
  const u = Number(used);
  const t = Number(total);
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return null;
  return Math.min(100, Math.max(0, (u / t) * 100));
}

/** One decimal place, and null for anything that is not a real number. */
function round(value, places = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function clampPercent(value) {
  const n = round(value);
  if (n === null || n < 0 || n > CPU_ABSURD) return null;
  return Math.min(100, Math.max(0, n));
}

function assignMetric(target, key, value) {
  if (value === null || value === undefined) return;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  target[key] = value;
}

/** Percentages are rounded once, here, so no tile renders 12 decimal places. */
function roundedPercent(used, total) {
  const value = percent(used, total);
  return value === null ? null : round(value);
}

// ---- Linux /proc/stat CPU ---------------------------------------------------

/**
 * `user nice system idle iowait irq softirq steal guest guest_nice` from the
 * first line of /proc/stat → { idle, total }.
 *
 * The kernel counts guest time *inside* user, so subtracting it once from the
 * total is what stops a busy virtual machine from reading above 100%. It must
 * NOT be subtracted from idle: guest is not a subset of idle, and doing so
 * under-reports how idle the machine is.
 */
function parseProcStat(line) {
  const parts = String(line || "").trim().split(/\s+/);
  if (parts[0] !== "cpu" || parts.length < 5) return null;
  const nums = parts.slice(1).map(Number);
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait, irq = 0, softirq = 0, steal = 0, guest = 0] = nums;
  const total = user + nice + system + idle + iowait + irq + softirq + steal - guest;
  const idleAll = idle + iowait;
  return { idle: idleAll, total };
}

/** CPU% between two consecutive parseProcStat readings. */
function cpuDelta(prev, cur) {
  if (!prev || !cur) return null;
  const totalDelta = cur.total - prev.total;
  const idleDelta = cur.idle - prev.idle;
  if (totalDelta <= 0) return null;
  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

// ---- local source -----------------------------------------------------------

/**
 * @param {object} raw from systemStats.sampleLocal()
 * @param {object} ctx { source, now }
 */
function normalizeLocal(raw, ctx = {}) {
  const snap = baseSnapshot("local", ctx);
  const mem = raw?.memory;
  assignMetric(snap, "cpu", clampPercent(raw?.cpu));
  if (mem && Number(mem.total) > 0) {
    snap.memory = {
      used: Math.max(0, Math.round(Number(mem.used) || 0)),
      total: Math.round(Number(mem.total)),
      percent: roundedPercent(mem.used, mem.total),
    };
  }
  assignMetric(snap, "disks", normalizeDisks(raw?.disks));
  const net = normalizeNetwork(raw?.network);
  if (net) snap.network = net;
  assignMetric(snap, "uptime", normalizeUptime(raw?.uptime));
  assignMetric(snap, "temperature", normalizeTemperature(raw?.temperature));
  return snap;
}

// ---- remote SSH source ------------------------------------------------------

/**
 * @param {object} raw parsed probe output (already shell-parsed, not JSON)
 * @param {object} ctx { source, now, prevCpu }  ← prevCpu is the source's own
 *   previous reading, so the widget layer stays stateless.
 */
function normalizeSsh(raw, ctx = {}) {
  const snap = baseSnapshot("ssh", ctx);
  const cpu = cpuDelta(ctx.prevCpu, raw?.cpuStat);
  assignMetric(snap, "cpu", cpu);

  // Linux reports kB; everything downstream is bytes. MemAvailable is missing
  // on some kernels and inside containers — without it "used" is unknowable, so
  // the whole block is dropped rather than shipping NaN to the tile.
  const memTotalRaw = Number(raw?.mem?.MemTotal);
  const memAvailRaw = Number(raw?.mem?.MemAvailable);
  const memTotal = memTotalRaw * 1024;
  if (memTotal > 0 && Number.isFinite(memAvailRaw)) {
    const memAvail = memAvailRaw * 1024;
    const used = Math.max(0, memTotal - memAvail);
    snap.memory = {
      used: Math.round(used),
      total: Math.round(memTotal),
      percent: roundedPercent(used, memTotal),
    };
  }

  assignMetric(snap, "disks", normalizeDisks(raw?.disks));
  const net = normalizeNetwork(raw?.network);
  if (net) snap.network = net;
  assignMetric(snap, "uptime", normalizeUptime(raw?.uptime));
  assignMetric(snap, "temperature", normalizeTemperature(raw?.temperature));
  assignMetric(snap, "containers", normalizeContainers(raw?.containers));
  return snap;
}

function baseSnapshot(kind, ctx) {
  const now = Number.isFinite(ctx?.now) ? ctx.now : Date.now();
  return {
    source: ctx?.source ?? null,
    kind,
    status: "online",
    stale: false,
    lastUpdated: now,
    lastSeen: now,
  };
}

function normalizeDisks(disks) {
  if (!Array.isArray(disks)) return null;
  const out = [];
  for (const disk of disks) {
    const total = Number(disk?.total);
    if (!Number.isFinite(total) || total <= 0) continue;
    const used = Number.isFinite(Number(disk?.used)) ? Number(disk.used) : 0;
    out.push({
      mount: String(disk?.mount ?? "/"),
      used: Math.round(used),
      total: Math.round(total),
      percent: roundedPercent(used, total),
    });
  }
  return out.length ? out : null;
}

/**
 * Rates, not counters. Both directions are independent, so a source that only
 * reports one yields exactly that one.
 */
function normalizeNetwork(net) {
  if (!net || typeof net !== "object") return null;
  const rx = Number(net.rx);
  const tx = Number(net.tx);
  const out = {};
  if (Number.isFinite(rx) && rx >= 0) out.rx = Math.round(rx);
  if (Number.isFinite(tx) && tx >= 0) out.tx = Math.round(tx);
  return Object.keys(out).length ? out : null;
}

function normalizeUptime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function normalizeTemperature(celsius) {
  const n = round(celsius);
  if (n === null || n < TEMP_MIN || n > TEMP_MAX) return null;
  return n;
}

/**
 * Container counts, or an explicit reason they could not be read.
 *
 * The error branch is the point: dropping it would make "docker is not
 * installed" indistinguishable from "this metric was never requested", and the
 * row would silently vanish — which is exactly the bug this fixes.
 */
function normalizeContainers(containers) {
  if (!containers || typeof containers !== "object") return null;
  if (typeof containers.error === "string" && containers.error.trim())
    return { error: containers.error.trim().slice(0, 120) };
  const out = {};
  for (const key of ["running", "stopped", "unhealthy"]) {
    const n = Number(containers[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = Math.round(n);
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  percent,
  round,
  clampPercent,
  parseProcStat,
  cpuDelta,
  normalizeLocal,
  normalizeSsh,
  normalizeDisks,
  normalizeNetwork,
  normalizeUptime,
  normalizeTemperature,
  normalizeContainers,
};
