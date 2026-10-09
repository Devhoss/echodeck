// Tests for the shared connection-test helper used by both REST routes: a
// saved host, and one still being typed. Uses the same injected fake SSH layer
// as sshSource.test.js, so no socket is opened.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const { PassThrough } = require("stream");

const connectQueue = [];
const execQueue = [];
const connections = [];

function take(queue) {
  if (!queue.length) return {};
  return queue.length > 1 ? queue.shift() : queue[queue.length - 1];
}
function scenario(...entries) {
  for (const e of entries) {
    connectQueue.push(e);
    execQueue.push(e);
  }
}

class FakeClient {
  constructor() {
    this.handlers = {};
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
      else if (next.kind === "hang") return;
      else this.emit("error", next.error || new Error("connect failed"));
    }, 0);
  }
  exec(command, cb) {
    const next = take(execQueue);
    setTimeout(() => {
      if (next.execError) return cb(next.execError);
      const stream = new PassThrough();
      stream.stderr = new PassThrough();
      cb(null, stream);
      if (next.stdout) stream.write(next.stdout);
      if (next.hang) return;
      stream.end();
    }, next.execDelay ?? 0);
  }
  end() {
    this.ended = true;
  }
}

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "ssh2") return { Client: FakeClient };
  return originalLoad.apply(this, arguments);
};

const { testSourceConfig } = require("../src/widgets/testSource.js");

const PROBE_OUT = [
  "cpu|cpu  100 0 50 850 0 0 0 0",
  "mem|MemTotal: 3941244 kB;MemAvailable: 1313748 kB;",
  "up|11820.5",
  "disk|/dev/sda1 20971520 8192000 11718640 42% /;",
  "dock|5 2 0",
].join("\n");

const FIXTURE_KEY = path.join(__dirname, "fixtures", "probe-key");
function key() {
  const fs = require("fs");
  fs.mkdirSync(path.dirname(FIXTURE_KEY), { recursive: true });
  fs.writeFileSync(FIXTURE_KEY, "not a real key\n");
  return FIXTURE_KEY;
}

test.before(() => key());
test.beforeEach(() => {
  connectQueue.length = 0;
  execQueue.length = 0;
  connections.length = 0;
});

const baseConfig = (over = {}) => ({
  id: "src-1",
  name: "Homelab",
  host: "192.168.100.36",
  port: 22,
  username: "hoss",
  key_path: FIXTURE_KEY,
  auth: null,
  use_agent: 0,
  refresh_ms: 10000,
  ...over,
});

test("a reachable host reports success", async () => {
  scenario({ kind: "ready", stdout: PROBE_OUT });
  const result = await testSourceConfig(baseConfig());
  assert.equal(result.ok, true);
  assert.match(result.detail, /192\.168\.100\.36/);
});

test("the test never disturbs the live poller", async () => {
  scenario({ kind: "ready", stdout: PROBE_OUT });
  await testSourceConfig(baseConfig());
  // Every connection it opened is closed again, or a rejected host would leak
  // sockets until the app ran out of them.
  assert.equal(connections.length, 1);
  assert.equal(connections[0].ended, true);
});

test("an authentication failure is reported as auth, not as the host being down", async () => {
  scenario({
    kind: "error",
    error: Object.assign(new Error("All configured authentication methods failed"), {
      level: "client-authentication",
    }),
  });
  const result = await testSourceConfig(baseConfig());
  assert.equal(result.ok, false);
  assert.equal(result.status, "auth_error");
  assert.match(result.reason, /authentication failed/i);
});

test("a missing key file is reported as a setup problem", async () => {
  const result = await testSourceConfig(baseConfig({ key_path: "C:\\nope\\missing" }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "auth_error");
  assert.match(result.reason, /key file not found/);
  // Nothing was dialled: you cannot fail to connect to a host you never tried.
  assert.equal(connections.length, 0);
});

test("an unreachable host is reported as offline", async () => {
  scenario({ kind: "error", error: new Error("connect ECONNREFUSED 192.168.100.36:22") });
  const result = await testSourceConfig(baseConfig());
  assert.equal(result.ok, false);
  assert.equal(result.status, "offline");
  assert.match(result.reason, /ECONNREFUSED/);
});

test("a host that accepts then stalls reports a timeout rather than hanging", async () => {
  scenario({ kind: "ready", hang: true });
  const started = Date.now();
  const result = await testSourceConfig(baseConfig());
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out/i);
  assert.ok(Date.now() - started < 15000, "it settles");
});

test("a config with no host is refused before any connection is attempted", async () => {
  const result = await testSourceConfig(baseConfig({ host: "" }));
  assert.equal(result.ok, false);
  assert.equal(connections.length, 0);
  const empty = await testSourceConfig(null);
  assert.equal(empty.ok, false);
});

test("the agent flag is passed through as a boolean", async () => {
  scenario({ kind: "ready", stdout: PROBE_OUT });
  await testSourceConfig(baseConfig({ use_agent: 1, key_path: null }));
  assert.equal(typeof connections[0].config.use_agent, "undefined");
});
