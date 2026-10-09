/**
 * systemStats.js  —  host/src/systemStats.js
 *
 * The single source of truth for local machine metrics. It exists so the header
 * pills and the System Monitor widget read the *same* numbers: CPU used to live
 * inside server.js's stats interval and RAM was computed inline in it, which
 * made a second implementation for the widget inevitable.
 *
 * Two tiers, deliberately:
 *
 *   cheap()     — os.cpus() and os.freemem(). No processes, no syscalls beyond
 *                 the kernel's own counters. Safe to call every 3s.
 *   expensive() — disk, network, temperature, via systeminformation. Those call
 *                 out to PowerShell, so they sit behind a TTL cache and are
 *                 only ever refreshed by a widget that asked for them. The
 *                 header ticks cheap() alone and must never pay for them.
 */
const os = require("os");

let si = null;
let siDisabled = false;
function systeminformation() {
  if (siDisabled) return null;
  if (si) return si;
  try {
    si = require("systeminformation");
    return si;
  } catch (e) {
    // Optional by design: a host without it still gets CPU/RAM/uptime.
    siDisabled = true;
    console.warn("⚠️  systeminformation unavailable — disk/network/temperature off:", e.message);
    return null;
  }
}

// ---- cheap tier -------------------------------------------------------------

let lastCpuTimes = os.cpus().map((c) => c.times);

function cpuPercent() {
  const times = os.cpus().map((c) => c.times);
  let totalIdle = 0;
  let totalTick = 0;
  for (let i = 0; i < times.length; i++) {
    const prev = lastCpuTimes[i];
    const curr = times[i];
    if (!prev) continue;
    totalIdle += curr.idle - prev.idle;
    totalTick +=
      curr.user - prev.user + (curr.nice - prev.nice) + (curr.sys - prev.sys) +
      (curr.irq - prev.irq) + curr.idle - prev.idle;
  }
  lastCpuTimes = times;
  if (totalTick === 0) return 0;
  // Same rounding and same formula the header has always shipped, so the pills
  // do not flicker by a digit because the code moved.
  return Math.round(((totalTick - totalIdle) / totalTick) * 100);
}

function memory() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return { used, total };
}

function cheap() {
  return { cpu: cpuPercent(), memory: memory() };
}

// ---- expensive tier ---------------------------------------------------------

let cache = { at: 0, value: null, inflight: null };
const DEFAULT_TTL_MS = 5000;

/**
 * Disk, network and temperature, cached for `ttlMs`. Concurrent callers share
 * one in-flight read rather than racing three PowerShell processes.
 */
async function expensive(ttlMs = DEFAULT_TTL_MS) {
  const siLib = systeminformation();
  if (!siLib) return cache.value ?? {};

  const now = Date.now();
  if (cache.value && now - cache.at < ttlMs) return cache.value;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    const out = { disks: null, network: null, temperature: null };
    try {
      out.disks = normalizeDisks(await siLib.fsSize());
    } catch (e) {
      console.warn("⚠️  fsSize failed:", e.message);
    }
    try {
      out.network = await networkRate();
    } catch (e) {
      console.warn("⚠️  networkStats failed:", e.message);
    }
    try {
      out.temperature = (await siLib.cpuTemperature())?.main ?? null;
    } catch (e) {
      // Expected on most Windows machines: MSAcpi_ThermalZoneTemperature is
      // usually unreadable without admin. Not worth a warning.
      out.temperature = null;
    }
    cache = { at: Date.now(), value: out, inflight: null };
    return out;
  })();

  return cache.inflight;
}

// systeminformation hands back objects per interface with counters that climb
// forever. Convert them to bytes/second here, keeping the counters between
// calls, so every consumer sees a rate like the remote source produces.
let lastNet = { at: 0, byName: new Map() };

function normalizeDisks(disks) {
  if (!Array.isArray(disks)) return null;
  const out = [];
  for (const disk of disks) {
    const total = Number(disk.size);
    const used = Number(disk.used);
    if (!Number.isFinite(total) || total <= 0) continue;
    const mount = disk.mount || disk.fs || "/";
    out.push({ mount, used: Number.isFinite(used) ? used : 0, total });
  }
  return out.length ? out : null;
}

async function networkRate() {
  const siLib = systeminformation();
  const stats = await siLib.networkStats();
  if (!Array.isArray(stats)) return null;

  const now = Date.now();
  const byName = new Map();
  let rx = 0;
  let tx = 0;
  let found = false;

  for (const iface of stats) {
    const name = iface.iface;
    if (!name || name.toLowerCase() === "loopback") continue;
    const rxNow = Number(iface.rx_bytes) || 0;
    const txNow = Number(iface.tx_bytes) || 0;
    byName.set(name, { rx: rxNow, tx: txNow });
    found = true;

    const prev = lastNet.byName.get(name);
    const seconds = (now - lastNet.at) / 1000;
    // First reading, or a gap long enough that the rate would be noise, or a
    // counter that went backwards (interface reset): report the counters we
    // have and let the next tick produce a real rate.
    if (prev && lastNet.at > 0 && seconds > 0) {
      const dRx = rxNow - prev.rx;
      const dTx = txNow - prev.tx;
      if (dRx >= 0) rx += dRx / seconds;
      if (dTx >= 0) tx += dTx / seconds;
    }
  }

  lastNet = { at: now, byName };
  if (!found) return null;
  return { rx: Math.round(rx), tx: Math.round(tx) };
}

/** Everything the widget layer needs, in one call. */
async function sampleLocal() {
  const base = cheap();
  const extra = await expensive();
  return { ...base, ...extra, uptime: os.uptime() };
}

/** The last expensive-tier reading, or null before the first one lands. */
function cached() {
  return cache.value;
}

module.exports = {
  cheap,
  expensive,
  cached,
  sampleLocal,
  cpuPercent,
  memory,
  // Test seams: reset the delta state so a test can control both samples.
  _reset() {
    lastCpuTimes = os.cpus().map((c) => c.times);
    lastNet = { at: 0, byName: new Map() };
    cache = { at: 0, value: null, inflight: null };
  },
  _cache: () => cache,
};
