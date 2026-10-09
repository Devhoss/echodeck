// Tests for the complete Docker metric path: probe -> parse -> normalize ->
// what the client would render. The separator regression that hid this metric
// entirely is covered by a case that mirrors the command the probe actually
// emits, not the shape an earlier test happened to assume.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseProbeResult,
  remoteCommand,
  DOCKER_ERRORS,
} = require("../src/widgets/sshProbe.js");
const { normalizeSsh } = require("../src/widgets/metrics.js");

const BASE = ["cpu|cpu  100 0 50 850 0 0 0 0", "up|11820.5"].join("\n");

function containersFor(dockLine) {
  const parsed = parseProbeResult(`${BASE}\n${dockLine}`);
  assert.equal(parsed.ok, true, parsed.error);
  return normalizeSsh(parsed.raw, { now: 1 }).containers;
}

test("the probe emits space-separated counts, and that is what parses", () => {
  // This is the shape remoteCommand() actually produces. It used to be
  // pipe-separated, which the tag parser read back as one "8|8|8" token ->
  // Number() -> NaN -> the whole metric silently dropped.
  const cmd = remoteCommand();
  assert.match(cmd, /docker ps -q \| wc -l\) /, "counts are space-separated");

  const containers = containersFor("dock|5 2 0");
  assert.deepEqual(containers, { running: 5, stopped: 2, unhealthy: 0 });
});

test("real counts survive normalization with the right types", () => {
  const containers = containersFor("dock|12 3 1");
  assert.equal(typeof containers.running, "number");
  assert.equal(containers.running, 12);
  assert.equal(containers.stopped, 3);
  assert.equal(containers.unhealthy, 1);
});

test("an empty host reports zero containers, which is still data", () => {
  const containers = containersFor("dock|0 0 0");
  assert.deepEqual(containers, { running: 0, stopped: 0, unhealthy: 0 });
  // A host with nothing running must not be treated as "no docker".
  assert.notEqual(containers, null);
});

test("docker missing entirely is reported as an explicit error", () => {
  const containers = containersFor("dockerr|not-installed");
  assert.ok(containers, "the metric must survive so the row can render");
  assert.equal(containers.error, "docker not installed");
  assert.equal(containers.running, undefined);
});

test("a daemon the user cannot reach is reported with the group hint", () => {
  // The classic case: docker exists, the user is not in the docker group.
  const containers = containersFor("dockerr|daemon-unreachable");
  assert.equal(containers.error, DOCKER_ERRORS["daemon-unreachable"]);
  assert.match(containers.error, /docker group/);
});

test("an unknown error code still renders something human", () => {
  const containers = containersFor("dockerr|socket-permission");
  assert.equal(containers.error, "docker: socket-permission");
});

test("a partial dock line keeps whatever counts are readable", () => {
  const parsed = parseProbeResult(`${BASE}\ndock|7`);
  const containers = normalizeSsh(parsed.raw, { now: 1 }).containers;
  assert.equal(containers.running, 7);
  assert.equal(containers.stopped, undefined);
});

test("a garbage dock line does not poison the rest of the sample", () => {
  // The other metrics must survive a broken docker, not the whole snapshot.
  // (cpu is absent because a single /proc/stat reading has nothing to delta
  // against — that is normal, not damage.)
  const parsed = parseProbeResult(`${BASE}\ndock|-- -- --`);
  assert.equal(parsed.ok, true);
  const snap = normalizeSsh(parsed.raw, { now: 1 });
  assert.equal(snap.uptime, 11821);
  // Garbage is dropped entirely, so the key is absent rather than null.
  assert.equal("containers" in snap, false);
});

test("no dock line at all yields no containers key", () => {
  const parsed = parseProbeResult(BASE);
  assert.equal(parsed.ok, true);
  const snap = normalizeSsh(parsed.raw, { now: 1 });
  assert.equal("containers" in snap, false);
});

test("the docker branch is gated off when a widget does not show it", () => {
  // Only appended when asked for, to avoid two extra remote process spawns.
  assert.match(remoteCommand({ docker: true }), /dock\|/);
  assert.doesNotMatch(remoteCommand({ docker: false }), /dock/);
});

test("the command contains no single quote that would break the sh -c wrapper", () => {
  const inner = remoteCommand().slice("sh -c '".length, -1);
  assert.ok(!inner.includes("'"), "a single quote would terminate the wrapper");
});
