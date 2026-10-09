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
  const token = getPairedToken();
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  return `ws://${host}:${resolvePort()}${suffix}`;
}

export function getApiUrl() {
  const host = resolveHost();
  if (!host) return null;
  return `http://${host}:${resolvePort()}/api`;
}

/**
 * A phone-side REST call that carries this device's credential.
 *
 * The host gates every /api route behind a token for anything that is not
 * loopback, so a phone's plain fetch() is answered 401 with a JSON *object* —
 * and a caller that assumes an array then poisons its state with it. The
 * desktop does not need this (it is loopback and bypasses the gate), which is
 * exactly why the bug only ever showed on Android.
 */
export function authFetch(path, options = {}) {
  loadPairConfig();
  const base = getApiUrl();
  if (!base) return Promise.reject(new Error("not paired"));

  const headers = { ...(options.headers || {}) };
  const token = getPairedToken();
  if (token) headers["X-EchoDeck-Token"] = token;
  if (options.body !== undefined && !headers["Content-Type"])
    headers["Content-Type"] = "application/json";

  return fetch(`${base}${path}`, { ...options, headers });
}

/** A JSON body that is guaranteed to be an array, whatever arrived. */
export async function jsonArray(response) {
  try {
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

export function isElectron() {
  return typeof window !== "undefined" && !!window.__ECHODECK__?.isElectron;
}
