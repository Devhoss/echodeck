/**
 * sshProbe.js  —  host/src/widgets/sshProbe.js
 *
 * The one command run against a remote Linux host, and the parser that turns
 * its output into the raw shape `metrics.normalizeSsh` consumes.
 *
 * Two rules shaped this file:
 *
 * 1. **One command, one process, per refresh.** The alternative — running a
 *    separate command per metric — spawns a handful of processes every few
 *    seconds per host for data that is all in the same /proc tree.
 *
 * 2. **No jq.** It is absent from plenty of otherwise normal Linux installs, so
 *    the remote side emits tagged lines and does the formatting here, where it
 *    can be unit-tested against captured output.
 *
 * Output format — `tag|payload`, one per line, tags in no particular order:
 *   cpu|cpu  1234 0 567 89012 0 0 0 0 0 0
 *   mem|MemTotal: 3941244 kB;MemAvailable: 1313748 kB;
 *   up|11820.5
 *   net|  eth0: 12345 0 0 0 0 0 0 0 23456 0 0 0 0 0 0;
 *   disk|/dev/sda1 20971520 8192000 11718640 42% /;
 *   temp|52000                        (millidegrees)
 *   dock|5 2 0                        (running stopped unhealthy, optional)
 */

const REMOTE_SCRIPT_BASE = [
  'echo "cpu|$(head -n1 /proc/stat)"',
  'echo "mem|$(grep -E "^(MemTotal|MemAvailable):" /proc/meminfo | tr "\\n" ";")"',
  'echo "up|$(cut -d" " -f1 /proc/uptime)"',
  'echo "net|$(tail -n +3 /proc/net/dev | tr "\\n" ";")"',
  'echo "disk|$(df -P -k 2>/dev/null | tail -n +2 | tr "\\n" ";")"',
  'echo "temp|$(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -n1)"',
];

// Docker is optional, and it is also the one probe that can legitimately fail
// on a host that is otherwise perfectly healthy: `docker ps` needs the user in
// the docker group, and the Docker Desktop WSL shim can fail while writing
// nothing at all. So:
//   * the counts are space-separated — never `|`, which is this protocol's own
//     field separator and turned "8|8|8" into a single NaN token;
//   * a failure emits a stable code rather than scraped prose. Parsing a
//     daemon's English is locale- and client-dependent; a code is not, and the
//     widget can render a proper sentence from it.
const REMOTE_SCRIPT_DOCKER = [
  'if ! command -v docker >/dev/null 2>&1; then echo "dockerr|not-installed";',
  'elif docker ps -q >/dev/null 2>&1; then',
  '  echo "dock|$(docker ps -q | wc -l) $(docker ps -a --filter status=exited --filter status=created -q | wc -l) $(docker ps --filter health=unhealthy -q | wc -l)";',
  'else',
  '  echo "dockerr|daemon-unreachable";',
  'fi',
].join("\n");

function remoteCommand({ docker = true } = {}) {
  const lines = docker
    ? [...REMOTE_SCRIPT_BASE, REMOTE_SCRIPT_DOCKER]
    : REMOTE_SCRIPT_BASE;
  return `sh -c '${lines.join("\n")}'`;
}

/** The full command, for tests and for the editor's "what we run" disclosure. */
const REMOTE_SCRIPT = [...REMOTE_SCRIPT_BASE, REMOTE_SCRIPT_DOCKER].join("\n");

/** Stable docker failure codes, mapped to wording the widget shows. */
const DOCKER_ERRORS = {
  "not-installed": "docker not installed",
  "daemon-unreachable": "docker daemon unreachable — check the user is in the docker group",
};

/**
 * @param {string} stdout
 * @returns {{ok: true, raw: object} | {ok: false, error: string}}
 */
function parseProbeResult(stdout) {
  const text = String(stdout || "").replace(/\r/g, "");
  if (!text.trim()) return { ok: false, error: "empty probe output" };

  const raw = { mem: {}, disks: [] };
  // Accumulators: a host that emits the same tag twice — a second network
  // device group, a wrapped line — must add to what came before rather than
  // silently replacing it, which is how the last interface wins.
  const net = { rxBytes: 0, txBytes: 0, seen: false };
  let sawAnything = false;

  for (const line of text.split("\n")) {
    // Split on the first pipe only: a mount point may legitimately contain one.
    const bar = line.indexOf("|");
    if (bar < 1) continue;
    const tag = line.slice(0, bar).trim();
    const payload = line.slice(bar + 1).trim();
    if (!payload) continue;
    sawAnything = true;

    switch (tag) {
      case "cpu":
        raw.cpuStat = payload;
        break;
      case "mem":
        for (const entry of payload.split(";")) {
          const m = entry.match(/^(MemTotal|MemAvailable):\s+(\d+)\s*kB/i);
          if (m) raw.mem[m[1]] = Number(m[2]);
        }
        break;
      case "up":
        raw.uptime = Number(payload);
        break;
      case "net": {
        const parsed = parseNet(payload);
        if (parsed) {
          net.rxBytes += parsed.rxBytes;
          net.txBytes += parsed.txBytes;
          net.seen = true;
        }
        break;
      }
      case "disk":
        raw.disks = raw.disks.concat(parseDf(payload));
        break;
      case "temp":
        // /sys reports millidegrees; the normalized shape is celsius.
        raw.temperature = Number(payload) / 1000;
        break;
      case "dock":
        // Space-separated, because `|` is the protocol's field separator and a
        // payload of "8|8|8" parses to a single NaN token.
        {
          const [running, stopped, unhealthy] = payload.split(/\s+/).map(Number);
          raw.containers = { running, stopped, unhealthy };
        }
        break;
      case "dockerr":
        // An explicit failure is still data: the widget renders the reason
        // rather than pretending the metric does not exist.
        raw.containers = { error: DOCKER_ERRORS[payload] || `docker: ${payload}` };
        break;
      default:
        // An unknown tag is skipped: a newer host may emit tags an older host
        // build does not understand, and that must not fail the whole sample.
        break;
    }
  }

  if (net.seen) raw.network = net;

  if (!sawAnything) return { ok: false, error: "no tagged lines in probe output" };

  // Every host must at least report uptime; if even that is missing the output
  // was not ours (a login banner, a sudo prompt, a MOTD edit failure).
  if (raw.uptime === undefined && raw.cpuStat === undefined)
    return { ok: false, error: "probe output unrecognised" };

  return { ok: true, raw };
}

/**
 * /proc/net/dev lines: `  eth0: rx_bytes ... tx_bytes ...`. The interface name
 * is joined to the colon with no space, and the counters are 16 (rx) then 16
 * (tx) with only the first few of each being real.
 */
function parseNet(payload) {
  let rxBytes = 0;
  let txBytes = 0;
  let found = false;

  for (const line of payload.split(";")) {
    const clean = line.trim();
    if (!clean) continue;
    const m = clean.match(/^([^:\s]+):?\s+(.+)$/);
    if (!m) continue;
    const name = m[1];
    const counters = m[2].trim().split(/\s+/).map(Number);
    if (counters.length < 10) continue;
    // Loopback is not network traffic anyone watches on a deck.
    if (name === "lo") continue;
    rxBytes += counters[0];
    txBytes += counters[8];
    found = true;
  }

  if (!found) return null;
  return { rxBytes, txBytes };
}

/**
 * `df -P -k` rows: `Filesystem blocks Used Available Capacity Mounted on`. The
 * mount point is everything after the fifth field, because it may contain
 * spaces and the other columns never do.
 */
// Mounts nobody monitors: ephemeral pseudo filesystems that a deck tile has no
// room for. Matched on the path, not the device name, because "tmpfs" is only
// sometimes the device and /dev/shm is always the thing you did not ask for.
const SKIP_MOUNT_PREFIXES = ["/dev/", "/run", "/sys/", "/proc/", "/boot/efi"];

function parseDf(payload) {
  const disks = [];
  for (const line of payload.split(";")) {
    const row = line.trim();
    if (!row) continue;
    const parts = row.split(/\s+/);
    if (parts.length < 6) continue;
    const total = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const mount = parts.slice(5).join(" ");
    if (!Number.isFinite(total) || total <= 0) continue;
    if (SKIP_MOUNT_PREFIXES.some((p) => mount === p.slice(0, -1) || mount.startsWith(p)))
      continue;
    disks.push({ mount, used, total });
  }
  return disks;
}

/** Bytes/second from two consecutive readings. */
function rateBetween(prev, cur, key) {
  if (!prev || !cur) return null;
  const delta = cur[key] - prev[key];
  if (!Number.isFinite(delta) || delta < 0) return null;
  return delta;
}

module.exports = {
  DOCKER_ERRORS,
  REMOTE_SCRIPT,
  remoteCommand,
  parseProbeResult,
  parseNet,
  parseDf,
  rateBetween,
};
