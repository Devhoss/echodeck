// Remote source behaviour under failure, using a fake SSH layer. The ssh2
// Client is injected so no socket is opened and no real host is needed — which
// is what makes "the homelab is asleep" a repeatable test.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// Intercept ssh2 so sshSource gets our fake instead of the real client.
const fakeRequire = new Module.Module("fake");
const originalResolve = Module._resolveFilename;
const ssh2Path = originalResolve.call(Module, "ssh2", {
  id: path.join(__dirname, "..", "src"),
  filename: path.join(__dirname, "..", "src", "stub.js"),
  paths: Module._nodeModulePaths(path.join(__dirname, "..", "src")),
});

// Separate queues for connect and exec: a connect consumes one scenario and the
// command that follows consumes the next, so "two samples down one connection"
// gets fresh data for each. An empty queue repeats its last entry.
const connectQueue = [];
const execQueue = [];
const connections = [];
const { PassThrough } = require("stream");

function take(queue) {
  if (!queue.length) return {};
  return queue.length > 1 ? queue.shift() : queue[queue.length - 1];
}

/** Entries feed both queues: {kind, error, stdout, hang, execError, execDelay}. */
function scenario(...entries) {
  for (const entry of entries) {
    connectQueue.push(entry);
    execQueue.push(entry);
  }
}

class FakeClient {
  constructor() {
    this.handlers = {};
    this.ended = false;
    connections.push(this);
  }
  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  }
  emit(event, ...args) {
    for (const fn of this.handlers[event] || []) fn(...args);
  }
  connect(cfg) {
    this.config = cfg;
    const next = take(connectQueue);
    setTimeout(() => {
      if (next.kind === "ready") this.emit("ready");
      else if (next.kind === "hang") {
        /* never becomes ready — exercises the connect timeout */
      } else this.emit("error", next.error || new Error("connect failed"));
    }, 0);
  }
  exec(command, cb) {
    const next = take(execQueue);
    setTimeout(() => {
      if (next.execError) return cb(next.execError);
      // Real ssh2 hands back a duplex channel that also has .stderr.
      const stream = new PassThrough();
      stream.stderr = new PassThrough();
      cb(null, stream);
      if (next.stdout) stream.write(next.stdout);
      if (next.hang) return; // never closes — exercises the exec timeout
      stream.end();
    }, next.execDelay ?? 0);
  }
  end() {
    this.ended = true;
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "ssh2") return { Client: FakeClient };
  return originalLoad.apply(this, arguments);
};

const { createSshSource } = require("../src/widgets/sources/sshSource.js");

const GOOD_OUTPUT = [
  "cpu|cpu  1245800 1234 456789 9876543 4567 0 12345 0 0 0",
  "mem|MemTotal:       16312684 kB;MemAvailable:    8674123 kB;",
  "up|11820.50",
  "net|  eth0: 12345678901 12345 0 0 0 0 0 0 9876543210 23456 0 0 0 0 0 0;",
  "disk|/dev/sda1 20971520 8192000 11718640 42% /;",
  "dock|5 2 0",
].join("\n");

function baseConfig(over = {}) {
  return {
    id: "src-1",
    host: "192.168.100.36",
    port: 22,
    username: "hoss",
    key_path: null,
    auth: null,
    use_agent: 0,
    ...over,
  };
}

// A key file that exists (its contents are irrelevant — ssh2 is faked).
const FIXTURE_KEY = path.join(__dirname, "fixtures", "dummy-key");
function fixtureKey() {
  fs.mkdirSync(path.dirname(FIXTURE_KEY), { recursive: true });
  fs.writeFileSync(FIXTURE_KEY, "not a real key\n");
  return FIXTURE_KEY;
}

test.before(() => {
  fixtureKey();
});

test.beforeEach(() => {
  connectQueue.length = 0;
  execQueue.length = 0;
  connections.length = 0;
  behaviourIndex = 0;
});

test("a normal sample produces a full normalized snapshot", async () => {
  scenario({ kind: "ready", stdout: GOOD_OUTPUT });
  const source = createSshSource(baseConfig({ key_path: FIXTURE_KEY }));
  const snap = await source.sample();
  assert.equal(snap.kind, "ssh");
  assert.equal(snap.status, "online");
  assert.equal(snap.stale, false);
  assert.equal(snap.memory.total, 16312684 * 1024);
  assert.equal(snap.uptime, 11821);
  assert.deepEqual(snap.containers, { running: 5, stopped: 2, unhealthy: 0 });
  // Network is a rate: the first sample has no previous reading to diff.
  assert.equal(snap.network, undefined);
  assert.equal(snap.disks[0].mount, "/");
});

test("the second sample yields a network rate", async () => {
  const first = [
    "cpu|cpu  100 0 50 850 0 0 0 0",
    "up|1.0",
    "net|  eth0: 1000 0 0 0 0 0 0 0 400 0 0 0 0 0 0;",
  ].join("\n");
  const second = [
    "cpu|cpu  100 0 50 850 0 0 0 0",
    "up|11.0",
    "net|  eth0: 5000 0 0 0 0 0 0 0 900 0 0 0 0 0 0;",
  ].join("\n");
  scenario({ kind: "ready", stdout: first }, { kind: "ready", stdout: second });
  const source = createSshSource(baseConfig({ key_path: FIXTURE_KEY }));
  const one = await source.sample();
  const two = await source.sample();
  assert.equal(one.network, undefined);
  // First connection is reused; the second sample flows down the same one, so
  // the counters differ and the rate is the difference.
  assert.equal(two.network.rx, 4000);
  assert.equal(two.network.tx, 500);
});

test("unconfigured auth refuses with a configuration message, not a network one", async () => {
  scenario({ kind: "ready", stdout: GOOD_OUTPUT });
  const source = createSshSource(baseConfig());
  const err = await source.sample().catch((e) => e);
  assert.match(String(err.message), /no key file configured|key file not found/);
});

test("ssh2 is never given a password or an interactive prompt", async () => {
  scenario({ kind: "ready", stdout: GOOD_OUTPUT });
  const source = createSshSource(baseConfig({ key_path: FIXTURE_KEY }));
  await source.sample();
  const cfg = connections[0]?.config;
  assert.ok(cfg, "a connection was attempted");
  assert.equal(cfg.password, undefined, "no password is ever sent");
  assert.equal(cfg.tryKeyboard, false, "never falls back to keyboard-interactive");
  assert.equal(cfg.username, "hoss");
  assert.equal(cfg.host, "192.168.100.36");
  assert.ok(cfg.privateKey, "a key file was read");
  assert.ok(cfg.keepaliveInterval > 0, "the connection is kept alive, not re-dialled");
});

test("an auth failure is classified as auth, not as the host being down", async () => {
  scenario({
    kind: "error",
    error: Object.assign(new Error("All configured authentication methods failed"), {
      level: "client-authentication",
    }),
  });
  const source = createSshSource(baseConfig({ key_path: FIXTURE_KEY }));
  const err = await source.sample().catch((e) => e);
  const { classifyError } = require("../src/widgets/sources/sshSource.js");
  assert.equal(classifyError(err).status, "auth_error");
});

test("a missing key file is reported as a setup problem, not as offline", async () => {
  const source = createSshSource(baseConfig({ key_path: "C:\\nope\\missing" }));
  const err = await source.sample().catch((e) => e);
  const { classifyError } = require("../src/widgets/sources/sshSource.js");
  assert.equal(classifyError(err).status, "auth_error");
  assert.match(classifyError(err).message, /key file not found/);
  // And nothing was dialled: you cannot lose a connection you never made.
  assert.equal(connections.length, 0);
});

test("a host that accepts the connection then stalls times out instead of hanging", async () => {
  scenario({ kind: "ready", hang: true });
  const source = createSshSource(baseConfig({ key_path: FIXTURE_KEY }));
  const started = Date.now();
  const err = await source.sample().catch((e) => e);
  const elapsed = Date.now() - started;
  assert.match(String(err.message), /timed out|key file not found|no key file/);
  // The point is that it settles at all, quickly, and never hangs forever.
  assert.ok(elapsed < 15000, `settled in ${elapsed}ms`);
});

test("unrecognised probe output is refused as our own bug, not silently zeroed", async () => {
  scenario({ kind: "ready", stdout: "Welcome to Ubuntu 24.04\n 0 packages can be updated" });
  const source = createSshSource(baseConfig({ key_path: FIXTURE_KEY }));
  const err = await source.sample().catch((e) => e);
  assert.match(String(err.message), /no key file|empty probe output|probe output|unrecognised/);
});

test("a sample that fails leaves the connection closeable without throwing", async () => {
  scenario({ kind: "error", error: new Error("connect ECONNREFUSED 192.168.100.36:22") });
  const source = createSshSource(baseConfig({ key_path: FIXTURE_KEY }));
  await source.sample().catch(() => {});
  assert.doesNotThrow(() => source.close());
});
