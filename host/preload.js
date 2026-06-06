/**
 * preload.js  —  host/preload.js
 *
 * Secure bridge between the Electron main process and the renderer.
 * Exposed on window.electronAPI via contextBridge.
 *
 * Two ways the renderer gets network config (both always work):
 *   1. window.__ECHODECK__   — injected by main.js before any JS runs
 *   2. window.electronAPI.getNetworkConfig()  — IPC call as fallback
 *
 * All data operations proxy to the existing REST API on localhost.
 * This means server.js needs zero changes — the renderer just calls
 * electronAPI instead of fetch(), and preload does the fetch internally
 * on localhost (no cross-origin issues, no IP dependency in renderer).
 */

const { contextBridge, ipcRenderer } = require("electron");

// ─── Synchronous __ECHODECK__ injection ───────────────────────────────────────
// This runs in the preload script BEFORE any page/React JS executes.
// ipcRenderer.sendSync blocks until main replies, guaranteeing the config
// is on window before the first module import resolves.
// This is the ONLY reliable way — executeJavaScript fires too late.
const networkConfig = ipcRenderer.sendSync("get-network-config-sync");

// ─── Internal helpers ─────────────────────────────────────────────────────────

const PORT = 9001;
const BASE = `http://localhost:${PORT}/api`;

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// Binary upload (icons, sounds) — body is an ArrayBuffer from the renderer
async function upload(path, buffer, mimeType) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Upload ${path} → ${res.status}`);
  return res.json();
}

contextBridge.exposeInMainWorld("__ECHODECK__", {
  lanIp: networkConfig.lanIp,
  port: networkConfig.port,
  lanUrl: networkConfig.lanUrl,
  wsUrl: networkConfig.wsUrl,
  isElectron: true,
});

// ─── Exposed API ──────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld("electronAPI", {
  // ── Network config ──────────────────────────────────────────────────────────
  // Belt-and-suspenders fallback — main.js already injects window.__ECHODECK__
  // before the renderer loads, but this IPC handle is always available too.
  getNetworkConfig: () => ipcRenderer.invoke("get-network-config"),

  // ── Pages ────────────────────────────────────────────────────────────────────
  pages: {
    list: () => api("GET", "/pages"),
    create: (name) => api("POST", "/pages", { name }),
    delete: (id) => api("DELETE", `/pages/${id}`),
  },

  // ── Buttons ──────────────────────────────────────────────────────────────────
  buttons: {
    list: (pageId) =>
      api("GET", "/pages").then((pages) => {
        // server returns pages with buttons embedded on GET /pages
        const page = pages.find((p) => p.id === pageId);
        return page?.buttons ?? [];
      }),

    create: (data) => api("POST", "/buttons", data),
    update: (id, fields) => api("PATCH", `/buttons/${id}`, fields),
    delete: (id) => api("DELETE", `/buttons/${id}`),

    reorder: (buttons) => {
      // server handles reorder via WS message, but we expose a REST-friendly
      // path here — server.js already handles PATCH /buttons/:id for position,
      // so we batch-update positions sequentially.
      return Promise.all(
        buttons.map(({ id, position }) =>
          api("PATCH", `/buttons/${id}`, { position }),
        ),
      );
    },

    // icon/sound uploads — renderer passes ArrayBuffer + mime type
    uploadIcon: (id, buffer, mime) =>
      upload(`/buttons/${id}/icon`, buffer, mime),
    uploadSound: (id, buffer, mime) =>
      upload(`/buttons/${id}/sound`, buffer, mime),
    deleteSound: (id) => api("DELETE", `/buttons/${id}/sound`),
  },

  // ── Settings ─────────────────────────────────────────────────────────────────
  settings: {
    get: () => api("GET", "/settings"),
    set: (key, value) => api("POST", "/settings", { key, value }),
  },

  // ── Profile rules ────────────────────────────────────────────────────────────
  rules: {
    list: () => api("GET", "/profile-rules"),
    create: (rule) => api("POST", "/profile-rules", rule),
    update: (id, fields) => api("PATCH", `/profile-rules/${id}`, fields),
    delete: (id) => api("DELETE", `/profile-rules/${id}`),
  },

  // ── System ───────────────────────────────────────────────────────────────────
  system: {
    getActiveWindow: () => api("GET", "/active-window"),
    getOpenWindows: () => api("GET", "/open-windows"),
    getAudioDevices: () => api("GET", "/audio-devices"),
    pickFile: () => api("GET", "/pick-file").then((r) => r.path),
  },

  // ── Real-time events from main process ───────────────────────────────────────
  // The desktop renderer subscribes to state changes pushed from the backend.
  // Valid channels mirror the eventBus events from the architecture doc.
  on: (channel, callback) => {
    const valid = [
      "state:event",
      "stats:update",
      "volume:update",
      "profile:switch",
      "button:updated",
      "page:changed",
    ];
    if (!valid.includes(channel)) {
      console.warn(`[preload] Unknown channel: ${channel}`);
      return;
    }
    const handler = (_, data) => callback(data);
    ipcRenderer.on(channel, handler);
    // Return an unsubscribe function so the renderer can clean up in useEffect
    return () => ipcRenderer.removeListener(channel, handler);
  },

  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
});
