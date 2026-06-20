/**
 * network.js  —  host/src/network.js
 *
 * Single source of truth for LAN IP + port.
 * Required by both main.js (tray label, preload injection)
 * and server.js (startup log, /api/host-info endpoint).
 *
 * No hardcoded IPs anywhere. getLanIp() walks every network interface
 * at runtime and picks the first real LAN address.
 */

const os = require("os");

const PORT = 9001;

/**
 * Returns the best available LAN IPv4 address, or "localhost" as fallback.
 * Prefers 192.168.x / 10.x / 172.16–31.x ranges.
 * Skips loopback and Windows APIPA (169.254.x).
 */
function getLanIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (iface.address.startsWith("169.254.")) continue;

      if (iface.address.startsWith("192.168.")) {
        candidates.push({ priority: 0, address: iface.address });
      } else if (iface.address.startsWith("10.")) {
        candidates.push({ priority: 1, address: iface.address });
      } else if (/^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)) {
        // Only real private 172.16–172.31, skip Docker/Hyper-V
        candidates.push({ priority: 2, address: iface.address });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.address ?? "localhost";
}

// Resolved once at process startup — consistent for the entire session.
// Both main.js and server.js require() this module, so Node's module
// cache guarantees they share the exact same value.
const LAN_IP = getLanIp();
const LAN_URL = `http://${LAN_IP}:${PORT}`;
const WS_URL = `ws://${LAN_IP}:${PORT}`;

module.exports = { PORT, LAN_IP, LAN_URL, WS_URL };
