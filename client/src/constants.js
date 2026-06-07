const PORT = 9001;
const PAIR_STORAGE_KEY = "echodeck_pair";

// In-memory store (localStorage is blocked in Capacitor WebView sandboxes)
let _pairedHost = null;
let _pairedPort = null;
let _pairedToken = null;

function getStorage() {
  // localStorage persists across app restarts in Capacitor
  // sessionStorage does NOT persist — app kill clears it
  try {
    if (window.localStorage) return window.localStorage;
  } catch {
    /* storage unavailable in this WebView sandbox */
  }
  return null;
}

export function setPairConfig(host, port, token) {
  _pairedHost = host;
  _pairedPort = port || PORT;
  _pairedToken = token || null;
  try {
    getStorage()?.setItem(
      PAIR_STORAGE_KEY,
      JSON.stringify({ host, port: _pairedPort, token }),
    );
  } catch {
    /* storage unavailable in this WebView sandbox */
  }
}

export function loadPairConfig() {
  if (_pairedHost) return true;
  try {
    const raw = getStorage()?.getItem(PAIR_STORAGE_KEY);
    if (raw) {
      const { host, port, token } = JSON.parse(raw);
      _pairedHost = host;
      _pairedPort = port || PORT;
      _pairedToken = token;
      return true;
    }
  } catch {
    /* storage unavailable in this WebView sandbox */
  }
  return false;
}

export function clearPairConfig() {
  _pairedHost = null;
  _pairedPort = null;
  _pairedToken = null;
  try {
    getStorage()?.removeItem(PAIR_STORAGE_KEY);
  } catch {
    /* storage unavailable in this WebView sandbox */
  }
}

export function getPairedToken() {
  return _pairedToken;
}

function isNativeMobile() {
  return (
    typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.()
  );
}

function resolveHost() {
  // 1. Electron desktop: always localhost
  if (typeof window !== "undefined" && window.__ECHODECK__?.isElectron) {
    return "localhost";
  }

  // 2. Native mobile: must use explicitly paired host
  if (isNativeMobile()) {
    loadPairConfig();
    return _pairedHost || null; // null = not yet paired
  }

  // 3. Plain browser (phone browser opened to LAN URL): use window.location.hostname
  if (
    typeof window !== "undefined" &&
    window.location.hostname &&
    window.location.hostname !== "localhost"
  ) {
    return window.location.hostname;
  }

  // 4. Vite dev env variable
  if (import.meta.env?.VITE_HOST) {
    return import.meta.env.VITE_HOST;
  }

  return "localhost";
}

function resolvePort() {
  if (typeof window !== "undefined" && window.__ECHODECK__?.isElectron) {
    return window.__ECHODECK__.port || PORT;
  }

  if (isNativeMobile()) {
    loadPairConfig();
    return _pairedPort || PORT;
  }

  if (import.meta.env?.VITE_PORT) {
    return parseInt(import.meta.env.VITE_PORT, 10);
  }

  return PORT;
}

export function isPaired() {
  if (!isNativeMobile()) return true; // Desktop/browser doesn't need pairing
  loadPairConfig();
  return !!_pairedHost;
}

export function getWsUrl() {
  const host = resolveHost();
  if (!host) return null;
  return `ws://${host}:${resolvePort()}`;
}

export function getApiUrl() {
  const host = resolveHost();
  if (!host) return null;
  return `http://${host}:${resolvePort()}/api`;
}

export function isElectron() {
  return typeof window !== "undefined" && !!window.__ECHODECK__?.isElectron;
}
