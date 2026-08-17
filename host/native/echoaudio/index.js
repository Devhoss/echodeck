// Loader for the native addon.
//
// The .node file is built twice with different layouts: node-gyp puts it in
// build/Release, and @electron/rebuild caches a per-ABI copy under bin/. Trying
// each in turn keeps a dev run and a packaged install on the same code path.
const path = require("path");

const candidates = [
  path.join(__dirname, "build", "Release", "echoaudio.node"),
  path.join(__dirname, "build", "Debug", "echoaudio.node"),
  path.join(__dirname, "bin", "echoaudio.node"),
];

// Every function the addon exports, so adding one to the C++ needs no change
// here — listing them by hand meant a new binding silently went missing.
const API = [
  "listDevices",
  "getDefaultDevice",
  "setDefaultDevice",
  "listSessions",
  "setSessionVolume",
  "setSessionMute",
];

let addon = null;
let loadError = null;

for (const candidate of candidates) {
  try {
    addon = require(candidate);
    break;
  } catch (err) {
    loadError = err;
  }
}

if (addon) {
  const missing = API.filter((name) => typeof addon[name] !== "function");
  if (missing.length) {
    // A stale .node from an earlier build is worse than none: the caller sees
    // undefined rather than a diagnosable failure. Say which ones are absent.
    console.warn(
      `⚠️  echoaudio is out of date — rebuild it (missing: ${missing.join(", ")})`,
    );
  }
  module.exports = { available: true, loadError: null };
  for (const name of API) {
    module.exports[name] = addon[name];
  }
} else {
  // Thrown lazily rather than at require time: audio is one feature among many,
  // and a host that cannot load it should still start and serve the deck.
  const message = loadError ? loadError.message : "echoaudio addon not found";
  const unavailable = () => {
    throw new Error(`Native audio support is unavailable: ${message}`);
  };
  module.exports = { available: false, loadError: message };
  for (const name of API) {
    module.exports[name] = unavailable;
  }
}
