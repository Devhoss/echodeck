// Loader for the native addon.
//
// The .node file is built twice with different layouts: node-gyp puts it in
// build/Release, and electron-builder repacks it under bin/ inside the asar
// unpack directory. Trying both keeps a dev run and a packaged install on the
// same code path.
const path = require("path");

const candidates = [
  path.join(__dirname, "build", "Release", "echoaudio.node"),
  path.join(__dirname, "build", "Debug", "echoaudio.node"),
  path.join(__dirname, "bin", "echoaudio.node"),
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

if (!addon) {
  // Thrown lazily rather than here: audio device switching is one feature among
  // many, and a host that cannot load it should still start and serve the deck.
  const message = loadError ? loadError.message : "echoaudio addon not found";
  const unavailable = () => {
    throw new Error(`Native audio support is unavailable: ${message}`);
  };
  module.exports = {
    available: false,
    loadError: message,
    listDevices: unavailable,
    getDefaultDevice: unavailable,
    setDefaultDevice: unavailable,
  };
} else {
  module.exports = {
    available: true,
    loadError: null,
    listDevices: addon.listDevices,
    getDefaultDevice: addon.getDefaultDevice,
    setDefaultDevice: addon.setDefaultDevice,
  };
}
