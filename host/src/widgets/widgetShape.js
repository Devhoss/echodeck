/**
 * widgetShape.js  —  host/src/widgets/widgetShape.js
 *
 * The persistence shape of a live widget and its data sources. Pure — no
 * better-sqlite3 import — so the validation, JSON encoding and whitelisting
 * that `db.js` relies on are unit-testable under a plain `node --test`.
 *
 * db.js requires better-sqlite3, which is compiled against Electron's ABI and
 * cannot be loaded by the system node that runs the tests. Keeping this module
 * dependency-free is what makes the persistence logic testable at all.
 */

// FEATURE: Live widgets — everything PATCH may change on a widget. The two
// deliberately absent: `id` (a row cannot be re-keyed) and `page_id` (a widget
// cannot be moved between pages by an edit; that is a move, not a patch).
const WIDGET_FIELDS = [
  "label",
  "icon",
  "color",
  "position",
  "size",
  "source_id",
  "config",
  "type",
];

// FEATURE: Live widgets — what PATCH may change on a data source. `auth` holds
// an encrypted passphrase blob produced by secureStore.js; it is never read
// back out through the API.
const SOURCE_FIELDS = [
  "name",
  "kind",
  "host",
  "port",
  "username",
  "key_path",
  "auth",
  "use_agent",
  "refresh_ms",
  "enabled",
];

// Columns a source row may never be sent to a client, with what replaces them.
// The blob itself is meaningless to anyone but this machine, and echoing it
// would leak the ciphertext of a user's passphrase into a WS frame.
const SOURCE_SECRET_FIELDS = ["auth"];

// Sizes a widget tile may occupy. Buttons support "1x1" and "2x2"; a widget
// adds "2x1" because a stat strip is the natural shape for a list of metrics.
const WIDGET_SIZES = ["1x1", "2x1", "2x2"];

const DEFAULT_WIDGET_SIZE = "2x2";
const DEFAULT_REFRESH_MS = 10000;
const MIN_REFRESH_MS = 2000;
const MAX_REFRESH_MS = 300000;

// The metrics a System Monitor can display, in display order. Used both to
// seed a new widget and to filter what arrives from a source, so a source that
// reports something the widget did not ask for costs nothing.
const WIDGET_METRICS = [
  "cpu",
  "memory",
  "disk",
  "network",
  "uptime",
  "temperature",
  "containers",
];

const DEFAULT_WIDGET_METRICS = ["cpu", "memory", "disk", "uptime"];

const WIDGET_TYPES = [
  // id must be unique; `icon` resolves against ACTION_ICONS in iconMap.js so
  // ButtonFace and the editor picker can both draw it.
  {
    id: "system_monitor",
    name: "System Monitor",
    icon: "server",
    source: "required",
  },
];

function widgetDefaults() {
  return {
    type: "system_monitor",
    size: DEFAULT_WIDGET_SIZE,
    label: "System Monitor",
    icon: "server",
    color: "#185FA5",
    source_id: null,
    position: 0,
    config: { metrics: [...DEFAULT_WIDGET_METRICS] },
  };
}

function sourceDefaults() {
  return {
    kind: "ssh",
    name: "New host",
    host: "",
    port: 22,
    username: "",
    key_path: "",
    auth: null,
    use_agent: 0,
    refresh_ms: DEFAULT_REFRESH_MS,
    enabled: 1,
  };
}

/**
 * Turns a caller's PATCH body into the values that may be written, coercing
 * each one to the storage form. Returns `{ values }` for a writable set or
 * `{ values: null, reason }` when nothing survives the filter, so callers can
 * early-return the unchanged row exactly like updateButton does.
 */
function buildWidgetUpdate(fields) {
  if (!fields || typeof fields !== "object") return { values: null, reason: "empty" };
  const values = {};

  for (const key of Object.keys(fields)) {
    if (!WIDGET_FIELDS.includes(key)) continue;
    switch (key) {
      case "position":
        values.position = normalizePosition(fields.position);
        break;
      case "size":
        values.size = WIDGET_SIZES.includes(fields.size) ? fields.size : null;
        break;
      case "config":
        values.config = stringifyConfig(fields.config);
        break;
      case "source_id":
        // null means "the local machine"; anything else is a source id.
        values.source_id =
          fields.source_id === null || fields.source_id === undefined
            ? null
            : String(fields.source_id);
        break;
      default:
        values[key] = normalizeText(fields[key]);
    }
  }

  // A size that is not one we can lay out is dropped rather than defaulted:
  // silently writing "1x1" would make the tile jump without the user asking.
  if ("size" in fields && fields.size !== undefined && values.size === null)
    return { values: null, reason: "unknown size" };
  if ("type" in fields && values.type !== "system_monitor")
    return { values: null, reason: "unknown type" };

  const keys = Object.keys(values);
  if (!keys.length) return { values: null, reason: "no writable fields" };
  return { values, keys };
}

function buildSourceUpdate(fields) {
  if (!fields || typeof fields !== "object") return { values: null, reason: "empty" };
  const values = {};

  for (const key of Object.keys(fields)) {
    if (!SOURCE_FIELDS.includes(key)) continue;
    switch (key) {
      case "port":
        values.port = clampInt(fields.port, 1, 65535, 22);
        break;
      case "refresh_ms":
        values.refresh_ms = clampInt(
          fields.refresh_ms,
          MIN_REFRESH_MS,
          MAX_REFRESH_MS,
          DEFAULT_REFRESH_MS,
        );
        break;
      case "use_agent":
      case "enabled":
        values[key] = fields[key] ? 1 : 0;
        break;
      default:
        values[key] = normalizeText(fields[key]);
    }
  }

  // `kind` is fixed for now: the only collector that exists is SSH. Allowing a
  // caller to write any other value would store a source that can never work.
  if ("kind" in fields && values.kind !== "ssh")
    return { values: null, reason: "unknown source kind" };

  const keys = Object.keys(values);
  if (!keys.length) return { values: null, reason: "no writable fields" };
  return { values, keys };
}

/** JSON encodes the metrics list, falling back to the defaults when unusable. */
function stringifyConfig(config) {
  const metrics = Array.isArray(config?.metrics) ? config.metrics : null;
  if (!metrics) return JSON.stringify({ metrics: [...DEFAULT_WIDGET_METRICS] });
  const kept = metrics.filter((m) => WIDGET_METRICS.includes(m));
  // An empty selection is a valid state — a widget that shows nothing — but it
  // is far more likely to be a mistake, so it gets the defaults instead.
  return JSON.stringify({ metrics: kept.length ? kept : [...DEFAULT_WIDGET_METRICS] });
}

/**
 * Read-path deserializer, mirroring `deserializeButton`. A widget read out of
 * the database always has a parsed config, a bounded size and a source id that
 * is either null or a string — never whatever the last writer left behind.
 */
function deserializeWidget(row) {
  const config = safeJsonObject(row?.config);
  const metrics = Array.isArray(config.metrics)
    ? config.metrics.filter((m) => WIDGET_METRICS.includes(m))
    : [...DEFAULT_WIDGET_METRICS];
  return {
    ...row,
    size: WIDGET_SIZES.includes(row?.size) ? row.size : DEFAULT_WIDGET_SIZE,
    source_id: row?.source_id ?? null,
    config: { metrics: metrics.length ? metrics : [...DEFAULT_WIDGET_METRICS] },
  };
}

/** Read-path deserializer for a data source, with the secret blob removed. */
function deserializeSource(row) {
  const redacted = row ? { ...row } : null;
  if (!redacted) return null;
  for (const key of SOURCE_SECRET_FIELDS) delete redacted[key];
  return {
    ...redacted,
    port: clampInt(redacted.port, 1, 65535, 22),
    refresh_ms: clampInt(redacted.refresh_ms, MIN_REFRESH_MS, MAX_REFRESH_MS, DEFAULT_REFRESH_MS),
    use_agent: Number(redacted.use_agent) === 1,
    enabled: Number(redacted.enabled) === 1,
    // Whether a passphrase is stored, without any way to recover it here.
    has_passphrase: !!row.auth,
  };
}

/** The form the editor needs, with the password-shaped field expressed safely. */
function sourceToClient(row) {
  const source = deserializeSource(row);
  if (!source) return null;
  return source;
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length ? s : null;
}

function normalizePosition(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

module.exports = {
  WIDGET_FIELDS,
  SOURCE_FIELDS,
  WIDGET_SIZES,
  WIDGET_METRICS,
  DEFAULT_WIDGET_SIZE,
  DEFAULT_WIDGET_METRICS,
  DEFAULT_REFRESH_MS,
  MIN_REFRESH_MS,
  MAX_REFRESH_MS,
  WIDGET_TYPES,
  widgetDefaults,
  sourceDefaults,
  buildWidgetUpdate,
  buildSourceUpdate,
  deserializeWidget,
  deserializeSource,
  sourceToClient,
};
