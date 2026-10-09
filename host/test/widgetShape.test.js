// Unit tests for widget/source persistence shape — whitelisting, coercion and
// redaction. No sqlite is loaded, which is the point: the SQL-adjacent logic
// lives here precisely so it is testable under a plain node --test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  WIDGET_FIELDS,
  SOURCE_FIELDS,
  buildSourceUpdate,
  buildWidgetUpdate,
  deserializeSource,
  deserializeWidget,
  sourceToClient,
  widgetDefaults,
} = require("../src/widgets/widgetShape.js");

test("widget PATCH only writes whitelisted columns", () => {
  const { values, keys } = buildWidgetUpdate({
    label: "NAS",
    page_id: "some-other-page", // must be ignored: a widget cannot be reparented
    id: "rewrite-me", // nor re-keyed
    position: 3,
    size: "2x1",
    bogus: "x",
  });
  assert.deepEqual(keys.sort(), ["label", "position", "size"]);
  assert.deepEqual(values, { label: "NAS", position: 3, size: "2x1" });
});

test("a widget PATCH with nothing writable is rejected, not silently applied", () => {
  const result = buildWidgetUpdate({ page_id: "x" });
  assert.equal(result.values, null);
  assert.match(result.reason, /no writable fields/);
});

test("an unknown size is refused rather than defaulted", () => {
  const result = buildWidgetUpdate({ size: "3x3" });
  assert.equal(result.values, null);
  assert.equal(result.reason, "unknown size");
});

test("an unknown widget type is refused", () => {
  const result = buildWidgetUpdate({ type: "haxx" });
  assert.equal(result.values, null);
  assert.equal(result.reason, "unknown type");
});

test("source_id null means the local machine", () => {
  assert.deepEqual(buildWidgetUpdate({ source_id: null }).values, { source_id: null });
  assert.deepEqual(buildWidgetUpdate({ source_id: "abc" }).values, { source_id: "abc" });
});

test("config is normalised to the metric whitelist", () => {
  const { values } = buildWidgetUpdate({ config: { metrics: ["cpu", "nonsense"] } });
  assert.deepEqual(JSON.parse(values.config), { metrics: ["cpu"] });
  // An empty selection means "show nothing", which is always a mistake —
  // the defaults stand in so the tile never comes back blank.
  const empty = buildWidgetUpdate({ config: { metrics: [] } });
  assert.ok(JSON.parse(empty.values.config).metrics.length > 0);
});

test("refresh interval is clamped into something sane", () => {
  assert.equal(buildSourceUpdate({ refresh_ms: 10 }).values.refresh_ms, 2000);
  assert.equal(buildSourceUpdate({ refresh_ms: 999999 }).values.refresh_ms, 300000);
  assert.equal(buildSourceUpdate({ refresh_ms: 15000 }).values.refresh_ms, 15000);
  assert.equal(buildSourceUpdate({ refresh_ms: "abc" }).values.refresh_ms, 10000);
});

test("port is clamped and booleans are stored as 0/1", () => {
  assert.equal(buildSourceUpdate({ port: 0 }).values.port, 1);
  assert.equal(buildSourceUpdate({ port: 70000 }).values.port, 65535);
  assert.equal(buildSourceUpdate({ port: "nope" }).values.port, 22);
  assert.equal(buildSourceUpdate({ use_agent: true }).values.use_agent, 1);
  assert.equal(buildSourceUpdate({ enabled: false }).values.enabled, 0);
});

test("a source's kind cannot be rewritten to a collector that does not exist", () => {
  const result = buildSourceUpdate({ kind: "snmp" });
  assert.equal(result.values, null);
  assert.equal(result.reason, "unknown source kind");
});

test("reading a source back never exposes the stored passphrase blob", () => {
  const row = {
    id: "s1",
    kind: "ssh",
    name: "Homelab",
    host: "192.168.100.36",
    port: "22",
    username: "hoss",
    key_path: "C:\\Users\\h\\.ssh\\id_ed25519",
    auth: "ENCRYPTED:BASE64:CIPHERTEXT",
    use_agent: 1,
    enabled: 1,
    refresh_ms: "10000",
  };
  const client = sourceToClient(row);
  assert.equal(client.auth, undefined);
  assert.equal("auth" in client, false);
  assert.equal(client.has_passphrase, true);
  assert.equal(client.use_agent, true);
  assert.equal(client.port, 22);
  assert.equal(client.host, "192.168.100.36");
  assert.equal(client.username, "hoss");
  const withoutSecret = sourceToClient({ ...row, auth: null });
  assert.equal(withoutSecret.has_passphrase, false);
});

test("an unrecognised stored size falls back rather than breaking layout", () => {
  const w = deserializeWidget({
    id: "w1",
    page_id: "p1",
    size: "9x9",
    config: '{"metrics":["cpu","junk"]}',
    source_id: null,
  });
  assert.equal(w.size, "2x2");
  assert.deepEqual(w.config.metrics, ["cpu"]);
  assert.equal(w.source_id, null);
});

test("corrupt config JSON does not throw on read", () => {
  const w = deserializeWidget({ id: "w", config: "not json at all" });
  assert.deepEqual(w.config.metrics, ["cpu", "memory", "disk", "uptime"]);
});

test("defaults are complete enough to render a widget immediately", () => {
  const d = widgetDefaults();
  for (const key of ["type", "size", "label", "icon", "color", "source_id", "position"]) {
    assert.ok(key in d, `missing default for ${key}`);
  }
  assert.equal(d.source_id, null); // local machine by default
  assert.ok(d.config.metrics.includes("cpu"));
  assert.equal(SOURCE_FIELDS.includes("password"), false, "there is no password field");
  assert.equal(WIDGET_FIELDS.includes("page_id"), false);
});
