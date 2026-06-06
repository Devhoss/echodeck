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

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (iface.address.startsWith("169.254.")) continue;
      if (
        iface.address.startsWith("192.168.") ||
        iface.address.startsWith("10.") ||
        iface.address.startsWith("172.")
      ) {
        return iface.address;
      }
    }
  }

  return "localhost";
}

// Resolved once at process startup — consistent for the entire session.
// Both main.js and server.js require() this module, so Node's module
// cache guarantees they share the exact same value.
const LAN_IP = getLanIp();
const LAN_URL = `http://${LAN_IP}:${PORT}`;
const WS_URL = `ws://${LAN_IP}:${PORT}`;

module.exports = { PORT, LAN_IP, LAN_URL, WS_URL };
