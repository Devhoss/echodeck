/**
 * sshSource.js  —  host/src/widgets/sources/sshSource.js
 *
 * A remote Linux host over SSH as a data source.
 *
 * Shaped around three constraints:
 *
 * 1. **One connection, reused.** A fresh handshake per refresh is the thing to
 *    avoid, so the Client is kept alive with keepalive and reconnected only
 *    when it actually breaks.
 *
 * 2. **One command per refresh**, not one per metric. The sample the manager
 *    asks for runs a single exec that reads everything out of /proc.
 *
 * 3. **Authentication is public-key only.** No password is ever accepted,
 *    stored or attempted: without key-file or agent auth the source simply
 *    fails, and the failure names the reason. Falling back to an interactive
 *    prompt would hang the collector, and falling back to a stored password
 *    would be the plaintext-credentials problem the design set out to avoid.
 *
 *    On Windows the agent is the OpenSSH agent over its named pipe. ssh2
 *    supports that path (lib/agent.js routes a pipe-shaped agent path to
 *    OpenSSHAgent, which dials it with net.Socket). It is opt-in per source,
 *    and only offered once the pipe has been seen to exist, because a host
 *    whose agent service is disabled will otherwise report a confusing
 *    connect failure instead of "agent is off".
 */

const fs = require("fs");
const net = require("net");
const { Client } = require("ssh2");

const secureStore = require("../secureStore.js");
const { resolveKeyPath } = require("../keyPath.js");
const { parseProbeResult, remoteCommand, rateBetween } = require("../sshProbe.js");
const { normalizeSsh, parseProcStat } = require("../metrics.js");

// How Windows OpenSSH exposes its agent.
const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

// Timeouts. The exec one is the one that matters: a host that accepts the
// connection and then stalls must not hold a refresh open forever.
const CONNECT_TIMEOUT_MS = 12000;
const EXEC_TIMEOUT_MS = 10000;

function classifyError(err) {
  const msg = String(err?.message || err || "unknown error");
  const level = err?.level;
  // A configuration problem (no key file, unreadable key) is a setup mistake,
  // not a network one — telling the user the host is "offline" sends them
  // looking at the wrong end of the wire.
  if (level === "client-configuration" || /key file|no key/i.test(msg))
    return { status: "auth_error", message: msg };
  if (level === "client-authentication" || /authentication|permission denied/i.test(msg))
    return { status: "auth_error", message: "authentication failed — check the key and username" };
  if (/timed out|timeout|ETIMEDOUT/i.test(msg))
    return { status: "unreachable", message: "timed out" };
  if (/ENOENT|EACCES/i.test(msg)) return { status: "auth_error", message: msg };
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|connect/i.test(msg))
    return { status: "offline", message: msg };
  return { status: "offline", message: msg };
}

/** Is the OpenSSH agent actually reachable right now? */
function agentPipeExists(pipe = WINDOWS_AGENT_PIPE) {
  return new Promise((resolve) => {
    const sock = net.connect(pipe);
    const done = (v) => {
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    sock.setTimeout(1500);
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}

/**
 * Whether agent auth is a real option on this machine right now. The editor
 * uses this to decide whether to offer the toggle at all: on a host whose
 * OpenSSH agent service is disabled there is no pipe, and offering a toggle
 * that can only fail is worse than saying why.
 */
async function agentStatus() {
  if (process.platform !== "win32")
    return { supported: false, reachable: false, reason: "not Windows" };
  const reachable = await agentPipeExists();
  return {
    supported: true,
    reachable,
    pipe: WINDOWS_AGENT_PIPE,
    reason: reachable
      ? null
      : "the Windows OpenSSH agent is not running — enable the ssh-agent service",
  };
}

function createSshSource(config) {
  const {
    id,
    host,
    port = 22,
    username = "",
    key_path: keyPath,
    auth,
    use_agent: useAgent = false,
  } = config;

  let conn = null;
  let connecting = null;
  let destroyed = false;
  let connected = false;
  let prevCpu = null;
  let prevNet = null;

  /** Builds the ssh2 connect options, or explains why auth is impossible. */
  function authOptions() {
    const options = { host, port: Number(port) || 22, username };
    const agentRequested = Number(useAgent) === 1;

    const key = resolveKeyPath(keyPath);
    if (key.ok) {
      try {
        options.privateKey = fs.readFileSync(key.path);
        const passphrase = auth ? secureStore.decrypt(auth) : null;
        if (passphrase) options.passphrase = passphrase;
        return { ok: true, options };
      } catch (e) {
        return { ok: false, reason: `could not read the key file: ${e.message}` };
      }
    }

    if (agentRequested) return { ok: true, options: { ...options, agent: WINDOWS_AGENT_PIPE } };

    if (!keyPath && !agentRequested) {
      // Say so plainly: an unconfigured source is a configuration problem, not
      // a network one, and the fix is different.
      return {
        ok: false,
        reason: "no key file configured — set a key path or enable the SSH agent",
      };
    }
    return { ok: false, reason: key.reason };
  }

  function connect() {
    if (conn) return Promise.resolve(conn);
    if (connecting) return connecting;

    const built = authOptions();
    if (!built.ok) {
      connecting = Promise.reject(Object.assign(new Error(built.reason), {
        level: "client-configuration",
      }));
      // Do not cache a configuration failure: fixing the path must work at once.
      connecting.catch(() => {});
      setTimeout(() => {
        connecting = null;
      }, 0);
      return connecting;
    }

    connecting = new Promise((resolve, reject) => {
      const client = new Client();
      const fail = (err) => {
        try {
          client.end();
        } catch {}
        connecting = null;
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(new Error(`connection to ${host} timed out`));
      }, CONNECT_TIMEOUT_MS);

      client
        .on("ready", () => {
          clearTimeout(timer);
          conn = client;
          connected = true;
          connecting = null;
          client.on("close", () => {
            conn = null;
            connected = false;
          });
          client.on("error", () => {
            conn = null;
            connected = false;
          });
          resolve(client);
        })
        .on("error", (err) => {
          clearTimeout(timer);
          fail(err);
        })
        .connect({
          ...built.options,
          tryKeyboard: false, // never prompt: a prompt would hang the collector
          readyTimeout: CONNECT_TIMEOUT_MS,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
        });
    }).catch((e) => {
    connecting = null;
    throw e;
  });

  return connecting;
  }

  async function runCommand(client, command, timeoutMs) {
    return new Promise((resolve, reject) => {
      let out = "";
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        done(reject, new Error(`command timed out after ${timeoutMs}ms`));
        try {
          client.end();
        } catch {}
      }, timeoutMs);

      client.exec(command, (err, stream) => {
        if (err) return done(reject, err);
        stream.on("data", (d) => (out += d.toString()));
        stream.stderr.on("data", () => {
          // stderr is deliberately dropped: a warning on the remote host must
          // not fail a sample whose stdout was complete.
        });
        stream.on("close", () => done(resolve, out));
        stream.on("error", (e) => done(reject, e));
      });
    });
  }

  async function sample(now = Date.now()) {
    if (destroyed) throw new Error("source closed");
    const client = await connect();
    const command = remoteCommand({ docker: true });
    const stdout = await runCommand(client, command, EXEC_TIMEOUT_MS);
    const parsed = parseProbeResult(stdout);
    if (!parsed.ok) throw new Error(parsed.error);

    const raw = parsed.raw;
    const snapshot = normalizeSsh(
      {
        cpuStat: raw.cpuStat ? parseProcStat(raw.cpuStat) : null,
        mem: raw.mem,
        disks: raw.disks,
        uptime: raw.uptime,
        temperature: raw.temperature,
        containers: raw.containers,
        network: raw.network
          ? (() => {
              // The probe reports counters; the widget shows a rate.
              const rx = rateBetween(prevNet, raw.network, "rxBytes");
              const tx = rateBetween(prevNet, raw.network, "txBytes");
              prevNet = raw.network;
              const out = {};
              if (rx !== null) out.rx = rx;
              if (tx !== null) out.tx = tx;
              return out;
            })()
          : null,
      },
      { source: id, now, prevCpu },
    );
    prevCpu = raw.cpuStat ? parseProcStat(raw.cpuStat) : prevCpu;
    return snapshot;
  }

  return {
    id,
    kind: "ssh",
    label: host,
    sample,
    async test() {
      const client = await connect();
      const stdout = await runCommand(client, remoteCommand({ docker: true }), EXEC_TIMEOUT_MS);
      const parsed = parseProbeResult(stdout);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      return { ok: true, detail: `${host} responded`, snapshot: null };
    },
    /** Whether the agent toggle is meaningful on this machine right now. */
    async agentStatus() {
      if (process.platform !== "win32") return { supported: false, reachable: false };
      const reachable = await agentPipeExists();
      return { supported: true, reachable };
    },
    status() {
      return connected ? "online" : "offline";
    },
    close() {
      destroyed = true;
      try {
        conn?.end();
      } catch {}
      conn = null;
      connecting = null;
    },
  };
}

module.exports = {
  createSshSource,
  WINDOWS_AGENT_PIPE,
  classifyError,
  agentPipeExists,
  agentStatus,
};
