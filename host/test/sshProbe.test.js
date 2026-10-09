// Tests for the remote probe command and its parser, using captured output
// shapes from a real Debian host. CommonJS: host/package.json is commonjs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDf,
  parseNet,
  parseProbeResult,
  remoteCommand,
  REMOTE_SCRIPT,
  rateBetween,
} = require("../src/widgets/sshProbe.js");

const GOOD = [
  "cpu|cpu  1245800 1234 456789 9876543 4567 0 12345 0 0 0",
  "mem|MemTotal:       16312684 kB;MemAvailable:    8674123 kB;",
  "up|11820.50",
  "net|  eth0: 12345678901 12345 0 0 0 0 0 0 9876543210 23456 0 0 0 0 0 0;",
  "net|    lo: 99887766 100 0 0 0 0 0 0 99887766 100 0 0 0 0 0 0;",
  "disk|/dev/sda1 20971520 8192000 11718640 42% /;",
  "disk|tmpfs 8146344 0 8146344 0% /dev/shm;",
  "disk|/dev/mapper/vg-home 41943040 12582912 27262976 32% /home;",
  "temp|52000",
  "dock|5 2 0",
].join("\n");

test("the command is a single exec with no single quotes inside", () => {
  const cmd = remoteCommand();
  assert.ok(cmd.startsWith("sh -c '"), "must be wrapped for the remote shell");
  assert.ok(cmd.endsWith("'"), "must be closed");
  const inner = cmd.slice("sh -c '".length, -1);
  assert.ok(!inner.includes("'"), "a single quote inside would terminate the wrapper");
  // Every tool the script needs is standard on any Linux.
  for (const tool of ["/proc/stat", "/proc/meminfo", "/proc/uptime", "/proc/net/dev", "df -P -k"]) {
    assert.ok(inner.includes(tool), `expected ${tool} in the script`);
  }
  assert.ok(REMOTE_SCRIPT.includes("command -v docker"), "docker must be probed, not assumed");
});

test("captured good output parses completely", () => {
  const res = parseProbeResult(GOOD);
  assert.equal(res.ok, true, res.error);
  const { raw } = res;
  assert.equal(raw.cpuStat, "cpu  1245800 1234 456789 9876543 4567 0 12345 0 0 0");
  assert.equal(raw.mem.MemTotal, 16312684);
  assert.equal(raw.mem.MemAvailable, 8674123);
  assert.equal(raw.uptime, 11820.5);
  assert.equal(raw.temperature, 52); // millidegrees → celsius
  assert.deepEqual(raw.containers, { running: 5, stopped: 2, unhealthy: 0 });
  assert.deepEqual(raw.disks, [
    { mount: "/", used: 8192000 * 1024, total: 20971520 * 1024 },
    { mount: "/home", used: 12582912 * 1024, total: 41943040 * 1024 },
  ]);
});

test("repeated tags accumulate instead of the last one winning", () => {
  const res = parseProbeResult(
    [
      "disk|/dev/sda1 20971520 8192000 11718640 42% /;",
      "disk|/dev/mapper/vg-home 41943040 12582912 27262976 32% /home;",
      "net|  eth0: 100 0 0 0 0 0 0 0 40 0 0 0 0 0 0;",
      "net| wlan0: 200 0 0 0 0 0 0 0 80 0 0 0 0 0 0;",
      "up|1.0",
    ].join("\n"),
  );
  assert.equal(res.raw.disks.length, 2);
  assert.deepEqual(
    res.raw.disks.map((d) => d.mount),
    ["/", "/home"],
  );
  assert.equal(res.raw.network.rxBytes, 300);
  assert.equal(res.raw.network.txBytes, 120);
});

test("loopback is excluded from network counters", () => {
  const net = parseNet("  eth0: 100 0 0 0 0 0 0 0 40 0 0 0 0 0 0;    lo: 999 1 0 0 0 0 0 0 888 1 0 0 0 0 0;");
  assert.deepEqual(net, { rxBytes: 100, txBytes: 40 });
});

test("network totals across every real interface", () => {
  const net = parseNet("  eth0: 100 0 0 0 0 0 0 0 40 0 0 0 0 0 0; wlan0: 200 0 0 0 0 0 0 0 80 0 0 0 0 0 0;");
  assert.equal(net.rxBytes, 300);
  assert.equal(net.txBytes, 120);
});

test("a host with no network counters yields null, not zeros", () => {
  assert.equal(parseNet("  eth0: nope;"), null);
  assert.equal(parseNet(""), null);
});

test("df columns convert from 1k blocks to bytes", () => {
  const disks = parseDf("/dev/sda1 2048000 1024000 921600 51% /;");
  assert.deepEqual(disks, [{ mount: "/", used: 1024000 * 1024, total: 2048000 * 1024 }]);
});

test("pseudo filesystems and zero-block devices are dropped", () => {
  const disks = parseDf("tmpfs 0 0 0 0% /dev;udev 8146344 0 8146344 0% /dev;");
  assert.equal(disks.length, 0);
  const leaves = parseDf("tmpfs 8146344 0 8146344 0% /dev/shm;tmpfs 8146344 1200 8145000 1% /run/lock;");
  assert.equal(leaves.length, 0);
});

test("a mount path containing spaces survives", () => {
  const disks = parseDf("/dev/sdb1 1000 200 800 20% /mnt/my backup drive;");
  assert.equal(disks[0].mount, "/mnt/my backup drive");
});

test("missing sections degrade rather than fail the sample", () => {
  const res = parseProbeResult(["cpu|cpu  100 0 50 850 0 0 0 0", "up|42.0"].join("\n"));
  assert.equal(res.ok, true);
  assert.equal(res.raw.disks.length, 0);
  assert.equal(res.raw.temperature, undefined);
  assert.equal(res.raw.network, undefined);
  assert.equal(res.raw.containers, undefined);
});

test("a host without docker emits no dock line", () => {
  const res = parseProbeResult(["cpu|cpu  100 0 50 850 0 0 0 0", "up|42.0"].join("\n"));
  assert.equal(res.ok, true);
  assert.equal(res.raw.containers, undefined);
});

test("login banners, MOTD junk and empty output are refused", () => {
  const banner =
    "Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-41-generic x86_64)\n * Documentation:  https://help.ubuntu.com";
  assert.equal(parseProbeResult(banner).ok, false);
  assert.equal(parseProbeResult("").ok, false);
  assert.equal(parseProbeResult("   \n\n").ok, false);
});

test("a cpu line alone is recognisable output", () => {
  assert.equal(parseProbeResult("cpu|cpu  1 2 3 4").ok, true);
});

test("an unrecognised payload with nothing identifiable is refused", () => {
  const res = parseProbeResult("weird|data\nother|stuff");
  assert.equal(res.ok, false, "no uptime and no cpu line means it is not our output");
});

test("an unrecognised payload with nothing identifiable is refused", () => {
  const res = parseProbeResult("weird|data\nother|stuff");
  assert.equal(res.ok, false, "no uptime and no cpu line means it is not our output");
});

test("unknown tags are skipped so a newer host cannot break an older build", () => {
  const res = parseProbeResult(
    ["cpu|cpu  100 0 50 850 0 0 0 0", "up|9.5", "future|whatever"].join("\n"),
  );
  assert.equal(res.ok, true);
  assert.equal(res.raw.future, undefined);
});

test("CRLF line endings from a misconfigured shell are handled", () => {
  const res = parseProbeResult("cpu|cpu  100 0 50 850 0 0 0 0\r\nup|9.5\r\n");
  assert.equal(res.ok, true);
  assert.equal(res.raw.uptime, 9.5);
  assert.equal(res.raw.cpuStat, "cpu  100 0 50 850 0 0 0 0");
});

test("rate between two readings is a byte delta, never negative", () => {
  assert.equal(rateBetween({ rxBytes: 100 }, { rxBytes: 250 }, "rxBytes"), 150);
  assert.equal(rateBetween({ rxBytes: 250 }, { rxBytes: 100 }, "rxBytes"), null); // counter reset
  assert.equal(rateBetween(null, { rxBytes: 250 }, "rxBytes"), null);
  assert.equal(rateBetween({ rxBytes: 100 }, { rxBytes: 100 }, "rxBytes"), 0);
});
