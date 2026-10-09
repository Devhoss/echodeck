/**
 * manager.js  —  host/src/widgets/manager.js
 *
 * Owns every live data source and pushes normalized snapshots to whoever is
 * listening. This is where reliability lives: a host that vanishes, sleeps, or
 * refuses a key must never take the deck, the socket, or another source with it.
 *
 * Invariants the UI depends on:
 *
 *   - A failed sample never throws. It is recorded, the last good snapshot is
 *     kept, and that snapshot is reported as `stale` once it is older than
 *     twice the source's refresh interval.
 *   - One source object per source id, however many widgets point at it, so two
 *     tiles watching the NAS cost one connection and one command per tick.
 *   - A disabled or unknown source degrades to an explicit status rather than
 *     disappearing, so a tile can say what went wrong instead of going blank.
 */

const { createLocalSource } = require("./sources/localSource.js");
const { createSshSource, classifyError } = require("./sources/sshSource.js");

// Backoff ladder in ms. A sleeping laptop does come back, but polling it every
// two seconds while it sleeps is what makes a deck look hung — and a refused
// key will never start working, so it backs off too.
const BACKOFF_STEPS = [5000, 15000, 30000, 60000];
const DEFAULT_REFRESH_MS = 10000;

function createWidgetManager({ db, log = console } = {}) {
  /** @type {Map<string, object>} source key -> live source object */
  const sources = new Map();
  /** @type {Map<string, object>} source key -> polling state */
  const state = new Map();
  /** @type {Set<(changed: Map<string, object>) => void>} */
  const listeners = new Set();

  // The local machine has no row, so it is addressed by a fixed key.
  const localKey = () => "local";
  const keyFor = (sourceId) => (sourceId ? String(sourceId) : localKey());
  const idForKey = (key) => (key === localKey() ? null : key);

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function emit(entries) {
    const payload = entries instanceof Map ? entries : new Map(entries);
    for (const fn of listeners) {
      try {
        fn(payload);
      } catch (e) {
        log.warn?.("[widgets] a listener threw:", e?.message);
      }
    }
  }

  /** Which metrics the widgets attached to a source actually display. */
  function metricsFor(sourceId, widgets = []) {
    const wanted = new Set();
    const key = keyFor(sourceId);
    for (const widget of widgets) {
      if (keyFor(widget.source_id) !== key) continue;
      for (const metric of widget.config?.metrics || []) wanted.add(metric);
    }
    return [...wanted];
  }

  function createSource(sourceId, widgets) {
    if (sourceId === null) {
      return createLocalSource({
        id: null,
        metrics: metricsFor(null, widgets),
        refreshMs: DEFAULT_REFRESH_MS,
      });
    }
    const row = db.getSource?.(sourceId);
    if (!row) return null; // deleted while we were running
    const config = {
      id: row.id,
      host: row.host,
      port: row.port,
      username: row.username,
      key_path: row.key_path,
      auth: row.auth,
      use_agent: row.use_agent,
      refresh_ms: row.refresh_ms,
      enabled: row.enabled,
    };
    if (Number(config.enabled) !== 1) return null;
    return createSshSource({
      ...config,
      metrics: metricsFor(sourceId, widgets),
      refreshMs: Number(row.refresh_ms) || DEFAULT_REFRESH_MS,
    });
  }

  /** (Re)reads configuration for a source and restarts its polling. */
  function syncSource(sourceId, widgets = []) {
    stopSource(sourceId);
    const key = keyFor(sourceId);
    const source = createSource(sourceId, widgets);
    if (!source) {
      // Reported rather than created, so a tile can show "source unavailable"
      // instead of silently never updating again.
      state.set(key, {
        source: null,
        timer: null,
        lastSnapshot: null,
        status: "unavailable",
        lastSeen: null,
        lastError: null,
        failures: 1,
        refreshMs: DEFAULT_REFRESH_MS,
      });
      emit([
        [
          key,
          {
            status: "unavailable",
            stale: true,
            lastError: "data source is disabled or no longer configured",
            lastSeen: null,
          },
        ],
      ]);
      return;
    }

    sources.set(key, source);
    // The local source keeps its own expensive-tier cache warm; starting it here
    // rather than inside the source keeps every source's lifecycle in one place.
    source.start?.();
    state.set(key, {
      source,
      timer: null,
      lastSnapshot: null,
      // "connecting" is honest for a remote host: the first sample has not
      // come back yet and we do not know whether it will.
      status: source.kind === "local" ? "online" : "connecting",
      lastSeen: source.kind === "local" ? Date.now() : null,
      lastError: null,
      failures: 0,
      refreshMs: Number(source.refreshMs) || DEFAULT_REFRESH_MS,
    });
    schedule(sourceId);
  }

  function stopSource(sourceId) {
    const key = keyFor(sourceId);
    const s = state.get(key);
    if (s?.timer) clearInterval(s.timer);
    state.delete(key);
    const source = sources.get(key);
    if (source) {
      try {
        source.close?.();
      } catch {}
      sources.delete(key);
    }
  }

  function schedule(sourceId) {
    const key = keyFor(sourceId);
    const s = state.get(key);
    if (!s?.source) return;
    if (s.timer) clearInterval(s.timer);
    s.timer = setInterval(() => {
      tick(sourceId).catch(() => {});
    }, s.refreshMs);
    // Never the reason the process stays alive.
    s.timer.unref?.();
    // First tick immediately: switching to a page should show numbers, not an
    // empty tile for one full interval.
    tick(sourceId).catch(() => {});
  }

  async function tick(sourceId) {
    const key = keyFor(sourceId);
    const s = state.get(key);
    const source = sources.get(key);
    if (!s || !source) return;

    try {
      const snapshot = await source.sample();
      s.lastSnapshot = snapshot;
      s.status = "online";
      s.lastSeen = Date.now();
      s.lastError = null;
      s.failures = 0;
      emit([[key, { ...snapshot, stale: false }]]);
    } catch (err) {
      const info = classifyError(err);
      s.failures += 1;
      s.status = info.status;
      s.lastError = info.message;
      // What the tile sees: last good values, clearly marked stale.
      emit([
        [
          key,
          {
            ...(s.lastSnapshot || { source: sourceId, kind: source.kind }),
            status: s.status,
            stale: true,
            lastError: info.message,
            lastSeen: s.lastSeen,
          },
        ],
      ]);
      backOff(sourceId, s);
    }
  }

  function backOff(sourceId, s) {
    if (s.timer) clearInterval(s.timer);
    const step = BACKOFF_STEPS[Math.min(s.failures, BACKOFF_STEPS.length) - 1];
    s.timer = setInterval(() => {
      tick(sourceId).catch(() => {});
    }, step);
    s.timer.unref?.();
  }

  function isStale(s) {
    if (!s?.lastSeen) return true;
    return Date.now() - s.lastSeen > 2 * (s.refreshMs || DEFAULT_REFRESH_MS);
  }

  /** Snapshot + status for a source, as sent in the state frame. */
  function snapshotFor(sourceId) {
    const key = keyFor(sourceId);
    const s = state.get(key);
    if (!s) return null;
    if (!s.lastSnapshot)
      return {
        source: sourceId ?? null,
        kind: sources.get(key)?.kind ?? null,
        status: s.status,
        stale: true,
        lastError: s.lastError,
        lastSeen: s.lastSeen,
      };
    return { ...s.lastSnapshot, status: s.status, stale: isStale(s), lastError: s.lastError };
  }

  function status(sourceId) {
    const s = state.get(keyFor(sourceId));
    if (!s)
      return { status: "unavailable", stale: true, lastSeen: null, lastError: null };
    return {
      status: s.status,
      stale: isStale(s),
      lastSeen: s.lastSeen,
      lastError: s.lastError,
    };
  }

  /** Rebuilds the whole set of pollers from a widget list. */
  function startAll(widgets = []) {
    const keys = new Set([localKey()]);
    for (const widget of widgets) keys.add(keyFor(widget.source_id));
    for (const key of keys) syncSource(idForKey(key), widgets);
  }

  function stopAll() {
    for (const source of sources.values()) {
      try {
        source.close?.();
      } catch {}
    }
    for (const s of state.values()) if (s.timer) clearInterval(s.timer);
    sources.clear();
    state.clear();
    listeners.clear();
  }

  return {
    onChange,
    syncSource,
    stopSource,
    startAll,
    stopAll,
    snapshotFor,
    status,
    keyFor,
    _state: state,
    _sources: sources,
  };
}

module.exports = { createWidgetManager, BACKOFF_STEPS, DEFAULT_REFRESH_MS };
