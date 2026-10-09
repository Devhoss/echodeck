/**
 * keyPath.js  —  host/src/widgets/keyPath.js
 *
 * Resolves where a remote host's private key lives. A path, never contents:
 * the file is read by the SSH client at connect time and is never copied,
 * echoed, or returned by the API.
 *
 * Defaults matter because the common setup is nothing special — an
 * `id_ed25519` in the user's .ssh directory — and asking someone to type that
 * in is friction for no gain.
 */

const os = require("os");
const path = require("path");

// The names OpenSSH generates by default, in the order ssh tries them.
const DEFAULT_KEY_NAMES = ["id_ed25519", "id_rsa", "id_ecdsa"];

/** Expands ~, %VAR% and environment variables, without touching the filesystem. */
function expandHome(input) {
  let p = String(input || "").trim();
  if (!p) return null;

  // %USERPROFILE%\.ssh\id_ed25519 — how a Windows OpenSSH path is usually written
  p = p.replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name];
    return v === undefined ? m : v;
  });

  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.normalize(p);
}

/** The candidate a host should default to, or null when nothing is there. */
function findDefaultKey(existsSync = (p) => require("fs").existsSync(p)) {
  const sshDir = path.join(os.homedir(), ".ssh");
  for (const name of DEFAULT_KEY_NAMES) {
    const candidate = path.join(sshDir, name);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* unreadable directory — keep trying the rest */
    }
  }
  return null;
}

/**
 * Resolves a stored path to something readable, or explains why it is not.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
function resolveKeyPath(stored, existsSync = (p) => require("fs").existsSync(p)) {
  const expanded = expandHome(stored);
  if (!expanded) return { ok: false, reason: "no key path configured" };
  try {
    if (!existsSync(expanded)) {
      return { ok: false, reason: `key file not found: ${expanded}` };
    }
  } catch {
    return { ok: false, reason: "key file is not readable" };
  }
  return { ok: true, path: expanded };
}

module.exports = {
  DEFAULT_KEY_NAMES,
  expandHome,
  findDefaultKey,
  resolveKeyPath,
};
