/**
 * localSource.js  —  host/src/widgets/sources/localSource.js
 *
 * The local machine as a data source. Thin on purpose: systemStats owns the
 * collection, metrics.js owns the shape, and this only decides what a sample
 * needs and when.
 *
 * The important property is that a sample resolves in a microtask. The expensive
 * tier (disk, network, temperature) shells out to PowerShell and takes hundreds
 * of milliseconds; if a sample awaited it, the manager's first tick would not
 * have landed by the time a freshly connected client asks for the state frame,
 * and the tile would paint empty. So:
 *
 *   sample()            — cheap() plus whatever the expensive cache already
 *                         holds. Never blocks, never awaits.
 *   background refresh  — its own timer keeps that cache warm at the source's
 *                         refresh interval.
 *
 * A tile therefore shows CPU and RAM instantly, and disk/network/temperature
 * appear on the same tick the cache warms — which is well before the interval
 * that follows.
 */

const systemStats = require("../../systemStats.js");
const { normalizeLocal } = require("../metrics.js");

const EXPENSIVE_METRICS = ["disk", "network", "temperature"];

function createLocalSource({ id, metrics = [], refreshMs = 10000 }) {
  const wanted = new Set(metrics);
  const needsExpensive = () => [...wanted].some((m) => EXPENSIVE_METRICS.includes(m));

  let timer = null;
  let stopped = false;

  async function warmExpensive() {
    if (stopped || !needsExpensive()) return;
    try {
      // systeminformation calls PowerShell; the TTL cache means two widgets
      // asking in the same tick still cost one process.
      await systemStats.expensive();
    } catch {
      /* a failed read leaves the previous value in place, which is the point */
    }
  }

  function sample(now = Date.now()) {
    const base = systemStats.cheap();
    const extra = needsExpensive() ? systemStats.cached() || {} : {};
    return normalizeLocal({ ...base, ...extra }, { source: id, now });
  }

  function start() {
    if (stopped) return;
    // Seed right away so the first frame a client receives already has the
    // expensive metrics rather than waiting a full interval for them.
    warmExpensive();
    if (timer) clearInterval(timer);
    timer = setInterval(warmExpensive, Math.max(refreshMs, 2000));
    timer.unref?.();
  }

  return {
    id,
    kind: "local",
    label: "This PC",
    refreshMs,
    sample,
    start,
    // Always available — there is nothing to connect to — but reported the same
    // way as a remote source so the editor's Test button needs no special case.
    async test() {
      return { ok: true, detail: "collected locally", snapshot: sample() };
    },
    close() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createLocalSource, EXPENSIVE_METRICS };
