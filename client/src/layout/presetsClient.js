// Phase 6, Task 6.2 — the REST layer for layout presets
// (host/src/server.js:640-665: GET/POST/DELETE /api/layout-presets; there is
// deliberately NO PUT — a preset is immutable, change it by delete + recreate).
// Pure module, no React, mirroring the extracted-helpers precedent of
// layoutForm.js: the containers own state and toasts, this file owns only the
// wire shape. `config` travels as the {defaults?, pages?} object produced by
// LayoutSettingsForm's snapshot (layoutForm.buildPresetSnapshot); the host
// sanitizes it per scope and hands it back parsed, so nothing here parses.
//
// The baseUrl argument is built by the containers with the SAME helper their
// existing pages/settings calls are built with: getApiUrl() in constants.js
// (App.jsx's authFetch prepends exactly that; DesktopApp.jsx's api() is
// getApiUrl()). Do not invent another base here.
//
// Credential rule: the host gates every /api route behind the pairing token
// for non-loopback clients (see the authFetch docblock in constants.js — a
// token-less phone fetch gets a 401 JSON *object* where an array was
// expected). These helpers add the same X-EchoDeck-Token header authFetch
// does, via its own getPairedToken(), so both surfaces stay authenticated.
import { getPairedToken } from "../constants.js";

async function request(baseUrl, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getPairedToken();
  if (token) headers["X-EchoDeck-Token"] = token;
  if (options.body !== undefined && !headers["Content-Type"])
    headers["Content-Type"] = "application/json";

  const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* a non-JSON body (proxy error page) reads as no detail below */
  }
  if (!res.ok) {
    // The host signals failures as {error: "..."} — surface that text, since
    // it is the exact rule the container's toast shows ("Preset name
    // required", "Preset config must contain at least one valid layout
    // scope", …). Fall back to the status when there is none.
    const detail = data && typeof data.error === "string" ? data.error : null;
    throw new Error(detail || `layout-presets request failed (${res.status})`);
  }
  return data;
}

/** GET /api/layout-presets → the stored rows, newest-created first is NOT
 *  decided here — the container sorts, this function just returns the array.
 *  A non-array body (e.g. an object from some error path) reads as empty. */
export async function listPresets(baseUrl) {
  if (!baseUrl) return Promise.reject(new Error("not paired"));
  const data = await request(baseUrl, "/layout-presets");
  return Array.isArray(data) ? data : [];
}

/** POST /api/layout-presets with {name, config}; resolves to the stored row
 *  ({id, name, config, created_at}), config already parsed. Throws on 400. */
export async function createPreset(baseUrl, { name, config } = {}) {
  if (!baseUrl) return Promise.reject(new Error("not paired"));
  return request(baseUrl, "/layout-presets", {
    method: "POST",
    body: JSON.stringify({ name, config }),
  });
}

/** DELETE /api/layout-presets/:id → {ok}; ok:false means the id was gone. */
export async function deletePreset(baseUrl, id) {
  if (!baseUrl) return Promise.reject(new Error("not paired"));
  return request(
    baseUrl,
    `/layout-presets/${encodeURIComponent(String(id))}`,
    { method: "DELETE" },
  );
}
