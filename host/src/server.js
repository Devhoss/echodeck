const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const path = require("path");
const { v4: uuid } = require("uuid");
const { randomBytes, timingSafeEqual } = require("crypto");
const os = require("os");
const db = require("./db");
const { getActiveWindow, listOpenWindows } = require("./activeWindow");
const { findMatchingRule } = require("./ruleEngine");
const {
  listApplications,
  primeApplicationCache,
  getApplicationIcons,
} = require("./appDiscovery");
const { PORT, LAN_IP, LAN_URL } = require("./network");
const systemStats = require("./systemStats");
const { createWidgetManager } = require("./widgets/manager.js");
const { deserializeWidget, deserializeSource } = require("./widgets/widgetShape.js");
const { createSshSource, agentStatus } = require("./widgets/sources/sshSource.js");
const { testSourceConfig } = require("./widgets/testSource.js");
const { findDefaultKey } = require("./widgets/keyPath.js");
const {
  executeAction,
  executeSequence,
  getVolume,
  getMuted,
  getMicVolume,
  getMicMuted,
  getAudioSessions,
  getAudioSessionsSync,
  getAudioDevices,
  playAudioOnDevice,
} = require("./actions");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
});

const PING_INTERVAL = 15_000;
const PONG_TIMEOUT = 10_000;

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  // X-EchoDeck-Token is here because the phone app's origin is
  // http://localhost (Capacitor's androidScheme), so its REST calls are
  // cross-origin and preflighted. Omitting the header made the browser reject
  // every authenticated phone request before it was sent.
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, X-EchoDeck-Token",
  );
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- REST ---

// The pairing code shown in the QR, and nothing more. Deliberately in memory,
// so a restart expires any QR screenshot floating around. Devices that already
// paired are unaffected: they hold their own persisted token in paired_devices,
// which is what lets them reconnect across restarts.
const PAIR_TOKEN = randomBytes(24).toString("hex");

function isLocalAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function constantTimeEquals(a, b) {
  const supplied = Buffer.from(a);
  const expected = Buffer.from(b);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

// The rotating code shown in the QR. Only valid for the pairing handshake.
function hasValidPairToken(token) {
  if (typeof token !== "string") return false;
  return constantTimeEquals(token, PAIR_TOKEN);
}

// A credential minted when a device paired. Persisted, so restarting EchoDeck
// no longer kicks every paired phone into a reconnect loop.
function isKnownDeviceToken(token) {
  if (typeof token !== "string") return false;
  return db
    .getPairedDeviceTokens()
    .some((known) => constantTimeEquals(token, known));
}

// Either credential authorises a device: the pairing code covers the brief
// window during the handshake, the device token covers everything after.
function isAuthorizedToken(token) {
  return hasValidPairToken(token) || isKnownDeviceToken(token);
}

// Express only applies `app.use` to routes registered AFTER it, so every /api
// route must be declared below this gate. Declaring one above it silently
// publishes that route to the whole LAN with no token check.
app.use("/api", (req, res, next) => {
  if (isLocalAddress(req.socket.remoteAddress)) return next();
  if (req.path === "/pair/verify") return next();
  if (!isAuthorizedToken(req.get("X-EchoDeck-Token"))) {
    return res.status(401).json({ error: "Pair this device with EchoDeck first" });
  }
  next();
});

app.get("/api/pages", (req, res) => {
  const pages = db.getPages();
  // FEATURE: Live widgets — nested here exactly like buttons, so the editor's
  // reloadPages() finds a page's tiles with the same lookup it already uses for
  // its keys. The live snapshot is deliberately not attached here: that arrives
  // over the socket in the state frame, where it stays fresh.
  res.json(
    pages.map((p) => ({
      ...toDeckPage(p),
      buttons: db.getButtons(p.id),
      widgets: db.getWidgets(p.id),
    })),
  );
});

// Hands out the pairing token itself, so it must never answer a remote caller —
// the only legitimate consumer is the Electron UI drawing the QR code.
app.get("/api/pair-info", (req, res) => {
  if (!isLocalAddress(req.socket.remoteAddress)) {
    return res.status(403).json({ error: "Local requests only" });
  }
  res.json({ host: LAN_IP, port: PORT, token: PAIR_TOKEN });
});

app.post("/api/pair/verify", (req, res) => {
  if (!hasValidPairToken(req.body?.token)) {
    return res.status(401).json({ error: "Invalid pairing code" });
  }
  // Hand back a credential of the device's own so it survives restarts. The
  // pairing code it used stays short-lived and dies with this process.
  const device_token = randomBytes(32).toString("hex");
  db.createPairedDevice({
    id: uuid(),
    token: device_token,
    name: req.body?.name || req.get("user-agent") || "Paired device",
  });
  res.json({ ok: true, device_token });
});

app.get("/api/paired-devices", (req, res) => {
  res.json(db.listPairedDevices());
});

app.delete("/api/paired-devices/:id", (req, res) => {
  const removed = db.deletePairedDevice(req.params.id);
  // Drop any socket still using the revoked credential.
  clients.forEach((ws) => {
    if (ws.pairedDeviceId === req.params.id) ws.close(1008, "Device revoked");
  });
  res.json({ ok: removed });
});

// FEATURE: Launch App — installed applications for the picker. Enumeration is
// slow (2-3s), so this serves a cache; ?refresh=1 rebuilds it, which is what the
// picker's refresh control calls after the user installs something.
app.get("/api/applications", async (req, res) => {
  try {
    res.json(await listApplications({ refresh: req.query.refresh === "1" }));
  } catch (e) {
    console.error("applications error:", e.message);
    res.json([]);
  }
});

// POST rather than GET: identifiers carry backslashes, braces and exclamation
// marks, and a picker asks for thirty at once — a query string is the wrong
// shape for both. Extraction costs ~180ms per icon, so only the ones actually
// on screen are ever requested, and the host caches what it has resolved.
app.post("/api/applications/icons", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 120) : [];
    res.json(await getApplicationIcons(ids));
  } catch (e) {
    console.error("application icons error:", e.message);
    res.json({});
  }
});

app.get("/api/audio-sessions", async (req, res) => {
  try {
    res.json(await getAudioSessions());
  } catch (e) {
    console.error("audio-sessions error:", e.message);
    res.json([]);
  }
});

app.get("/api/audio-devices", async (req, res) => {
  try {
    // Defaults to output so the existing callers keep working unchanged.
    res.json(await getAudioDevices(req.query.direction === "input" ? "input" : "output"));
  } catch (e) {
    console.error("audio-devices error:", e.message);
    res.json([]);
  }
});

app.get("/api/settings", (req, res) => {
  const pc_sound_device = db.getSetting("pc_sound_device") ?? "";
  // FEATURE: Soundboard — optional second output so you can hear a sound that
  // is also being routed into a virtual cable for a call.
  const pc_monitor_device = db.getSetting("pc_monitor_device") ?? "";
  const auto_profile_switching = db.getSetting("auto_profile_switching") ?? "1";
  const auto_switch_delay = db.getSetting("auto_switch_delay") ?? "0";
  res.json({
    pc_sound_device,
    pc_monitor_device,
    auto_profile_switching: auto_profile_switching === "1",
    auto_switch_delay: Number(auto_switch_delay),
  });
});

app.post("/api/settings", (req, res) => {
  const { key, value } = req.body;
  const allowed = [
    "pc_sound_device",
    "pc_monitor_device",
    "auto_profile_switching",
    "auto_switch_delay",
  ];
  if (!allowed.includes(key))
    return res.status(400).json({ error: "Unknown setting" });
  db.setSetting(
    key,
    key === "auto_profile_switching"
      ? value
        ? "1"
        : "0"
      : String(value ?? ""),
  );
  res.json({ ok: true });
});

app.get("/api/clients", (req, res) => {
  const list = [];
  clients.forEach((ws) => {
    if (ws.readyState === 1) {
      list.push({
        id: ws.clientId,
        ip: ws.clientIp,
        connectedAt: ws.connectedAt,
        currentPage: ws.currentPage || null,
        userAgent: ws.userAgent || null,
        // Lets the UI line a live socket up with the credential it used, so
        // one row can offer both "kick this session" and "revoke this device".
        pairedDeviceId: ws.pairedDeviceId || null,
      });
    }
  });
  res.json(list);
});

app.delete("/api/clients/:id", (req, res) => {
  let found = false;
  clients.forEach((ws) => {
    if (ws.clientId === req.params.id) {
      ws.terminate();
      found = true;
    }
  });
  res.json({ ok: found });
});

app.get("/api/active-window", async (req, res) => {
  activeWindow = (await getActiveWindow()) || activeWindow;
  res.json(activeWindow || {});
});

app.get("/api/open-windows", async (req, res) => {
  res.json(await listOpenWindows());
});

app.get("/api/profile-rules", (req, res) => {
  res.json(db.getProfileRules());
});

app.post("/api/profile-rules", (req, res) => {
  const rule = db.createProfileRule({
    id: uuid(),
    page_id: req.body.page_id,
    enabled: req.body.enabled !== false,
    priority: req.body.priority ?? 100,
    logic: req.body.logic || "AND",
    conditions: req.body.conditions || [],
  });
  broadcastRules();
  res.json(rule);
});

app.patch("/api/profile-rules/:id", (req, res) => {
  const rule = db.updateProfileRule(req.params.id, req.body);
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  broadcastRules();
  res.json(rule);
});

app.delete("/api/profile-rules/:id", (req, res) => {
  db.deleteProfileRule(req.params.id);
  broadcastRules();
  res.json({ ok: true });
});

app.get("/api/pick-file", (req, res) => {
  const { exec } = require("child_process");
  const fs = require("fs");
  const scriptPath = path.join(os.tmpdir(), "macro_picker.ps1");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Filter = 'Executables (*.exe)|*.exe|All Files (*.*)|*.*'
$f.Title = 'Select Application'
$null = $f.ShowDialog()
Write-Output $f.FileName
`.trim();
  fs.writeFileSync(scriptPath, script, "utf8");
  exec(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
    (err, stdout) => {
      if (err) {
        console.error("Picker error:", err.message);
        return res.json({ path: null });
      }
      res.json({ path: stdout.trim() || null });
    },
  );
});

app.post("/api/pages", (req, res) => {
  const pages = db.getPages();
  // FEATURE: Key labels — a new profile inherits the flag from the profile it
  // was created from, so a variant of a labelled page does not have to be
  // re-set by hand. Callers that name no parent get the stored default.
  const parent = pages.find((p) => p.id === req.body.from_page_id);
  const page = db.createPage(
    uuid(),
    req.body.name || "New Page",
    pages.length,
    parent ? parent.show_labels : req.body.show_labels,
  );
  // Broadcast: the new profile has to reach the phone's page dots too, which
  // otherwise wait for the next unrelated edit to paint.
  broadcastState();
  res.json(toDeckPage(page));
});

app.patch("/api/pages/:id", (req, res) => {
  const page = db.updatePage(req.params.id, req.body);
  if (!page) return res.status(404).json({ error: "Page not found" });
  // A label toggle is a per-page preference, so every surface — the editor it
  // was toggled in and every phone currently on that page — redraws from this
  // one broadcast.
  broadcastState();
  res.json(toDeckPage(page));
});

app.delete("/api/pages/:id", (req, res) => {
  db.deletePage(req.params.id);
  broadcastState();
  res.json({ ok: true });
});

app.post(
  "/api/buttons/:id/icon",
  express.raw({ type: ["image/*", "video/*"], limit: "10mb" }),
  (req, res) => {
    const mime = req.headers["content-type"];
    const dataUrl = `data:${mime};base64,${req.body.toString("base64")}`;
    const btn = db.updateButton(req.params.id, { icon_data: dataUrl });
    broadcastState();
    res.json(btn);
  },
);

app.post(
  "/api/buttons/:id/sound",
  express.raw({ type: "audio/*", limit: "5mb" }),
  (req, res) => {
    const mime = req.headers["content-type"];
    if (!mime?.startsWith("audio/"))
      return res.status(400).json({ error: "Only audio/* files accepted" });
    const dataUrl = `data:${mime};base64,${req.body.toString("base64")}`;
    const btn = db.updateButton(req.params.id, { sound_file: dataUrl });
    broadcastState();
    res.json(btn);
  },
);

app.delete("/api/buttons/:id/sound", (req, res) => {
  const btn = db.updateButton(req.params.id, { sound_file: null });
  broadcastState();
  res.json(btn);
});

app.post("/api/buttons", (req, res) => {
  const { page_id, label, icon, color, action_type, action_value } = req.body;
  const buttons = db.getButtons(page_id);
  const btn = db.createButton({
    id: uuid(),
    page_id,
    label: label || "New Button",
    icon: icon || "⚡",
    color: color || "#5B4FCF",
    position: buttons.length,
    action_type: action_type || "keystroke",
    action_value: action_value || "",
    size: "1x1",
    is_toggle: 0,
    toggle_state: 0,
    toggle_action_type: "keystroke",
    toggle_action_value: "",
    actions: null,
    button_mode: "single",
    switch_actions_a: null,
    switch_actions_b: null,
    switch_state: 0,
    sound_file: null,
    sound_target: "phone",
    audio_device: null,
  });
  broadcastState();
  res.json(btn);
});

app.patch("/api/buttons/:id", (req, res) => {
  const btn = db.updateButton(req.params.id, req.body);
  broadcastState();
  res.json(btn);
});

app.delete("/api/buttons/:id", (req, res) => {
  db.deleteButton(req.params.id);
  broadcastState();
  res.json({ ok: true });
});

// --- Live widgets ---
// FEATURE: Live widgets — a tile that receives data instead of an action.
// Deliberately shaped after the button endpoints: same validate-in-db pattern,
// same broadcastState() after every mutation, so the editor and every phone
// agree on what the deck looks like.

app.get("/api/widgets", (req, res) => {
  res.json(db.getAllWidgets().map(deserializeWidget));
});

app.get("/api/widgets/:id", (req, res) => {
  const widget = db.getWidget(req.params.id);
  if (!widget) return res.status(404).json({ error: "Widget not found" });
  res.json(widget);
});

app.post("/api/widgets", (req, res) => {
  const widget = db.createWidget({
    id: uuid(),
    page_id: req.body.page_id,
    position: (db.getWidgets(req.body.page_id) || []).length,
    ...req.body,
  });
  syncWidgets();
  broadcastState();
  res.json(widget);
});

app.patch("/api/widgets/:id", (req, res) => {
  const widget = db.updateWidget(req.params.id, req.body);
  if (!widget) return res.status(404).json({ error: "Widget not found" });
  // A change of source, metrics or refresh interval has to rebuild the poller
  // before the state frame goes out, or the frame would carry stale data.
  syncWidgets();
  broadcastState();
  res.json(widget);
});

app.delete("/api/widgets/:id", (req, res) => {
  db.deleteWidget(req.params.id);
  syncWidgets();
  broadcastState();
  res.json({ ok: true });
});

// --- Live widget data sources ---
// FEATURE: Live widgets — where metrics come from. `auth` (an encrypted
// passphrase) is write-only here: PATCH may set it, GET never returns it.

app.get("/api/widget-sources", (req, res) => {
  res.json(db.getSources().map(deserializeSource));
});

app.post("/api/widget-sources", (req, res) => {
  const source = db.createSource({ id: uuid(), ...req.body });
  syncWidgets();
  broadcastState();
  res.json(deserializeSource(source));
});

app.patch("/api/widget-sources/:id", (req, res) => {
  const source = db.updateSource(req.params.id, req.body);
  if (!source) return res.status(404).json({ error: "Source not found" });
  syncWidgets();
  broadcastState();
  res.json(deserializeSource(source));
});

app.delete("/api/widget-sources/:id", (req, res) => {
  db.deleteSource(req.params.id);
  syncWidgets();
  broadcastState();
  res.json({ ok: true });
});

// Runs the remote command once, on demand, so the editor can tell the user
// whether a host is reachable before they walk away from the panel. The same
// helper backs both routes: a host that is already saved, and one the user is
// still filling in (which must be testable *before* it is written to disk).
app.post("/api/widget-sources/:id/test", async (req, res) => {
  const row = db.getSource(req.params.id);
  if (!row) return res.status(404).json({ error: "Source not found" });
  res.json(await testSourceConfig({ ...deserializeSource(row), auth: row.auth }));
});

app.post("/api/widget-sources/test", async (req, res) => {
  res.json(await testSourceConfig(req.body || {}));
});

/** Whether the SSH agent can be used on this machine at all. */
app.get("/api/widget-sources/agent-status", (req, res) => {
  agentStatus()
    .then((status) => res.json(status))
    .catch(() => res.json({ supported: false, reachable: false }));
});

// Where a key file is expected by default, expanded to an absolute path. The
// client cannot know this reliably — it depends on the profile the host runs
// under — and handing ssh2 a `~` path it will not expand is exactly the bug
// this endpoint exists to avoid.
app.get("/api/widget-sources/default-key", (req, res) => {
  res.json({ path: findDefaultKey() });
});

// --- WebSocket ---
const clients = new Set();
let activeWindow = null;
let autoPageId = null;
let activeRuleId = null;
let manualSwitchPausedUntil = 0;
let autoSwitchDebounceTimer = null;

// Debounced broadcastState — batches rapid desktop edits into a single
// push so the phone isn't flooded with back-to-back full-state messages.
let broadcastStateTimer = null;
function broadcastState(delayMs = 50) {
  clearTimeout(broadcastStateTimer);
  broadcastStateTimer = setTimeout(() => {
    clients.forEach((ws) => {
      if (ws.readyState !== 1) return;
      trySend(ws, () => sendState(ws, ws.currentPage));
    });
  }, delayMs);
}

// Safe send helper — never terminates the socket on serialisation errors.
// Only hard-closes if the socket itself is already in a broken state.
function trySend(ws, buildFn) {
  try {
    buildFn();
  } catch (err) {
    console.warn(`[trySend] error for client ${ws.clientId}:`, err.message);
    // Don't terminate — a serialisation glitch shouldn't kill the phone session.
  }
}

function broadcastClients() {
  const list = [];
  clients.forEach((ws) => {
    if (ws.readyState === 1) {
      list.push({
        id: ws.clientId,
        ip: ws.clientIp,
        connectedAt: ws.connectedAt,
        currentPage: ws.currentPage || null,
        userAgent: ws.userAgent || null,
        // Lets the UI line a live socket up with the credential it used, so
        // one row can offer both "kick this session" and "revoke this device".
        pairedDeviceId: ws.pairedDeviceId || null,
      });
    }
  });
  const msg = JSON.stringify({ t: "clients", clients: list });
  clients.forEach((ws) => {
    if (ws.readyState === 1 && ws.isDesktop) ws.send(msg);
  });
}

// Only the three fields a key face needs. The full session objects carry a pid,
// a display name and a state that nothing on the client reads, and this goes
// out every three seconds to every device.
// --- Live widgets ---
// FEATURE: Live widgets — one manager owns every source, and every client hears
// about the sources its own page uses. Reuses the existing socket and the
// existing debounced broadcast rather than growing a second push path.

// Widget ids per page, and the source key behind each widget. Both are cached
// because the fan-out below runs on every source tick, for every client.
let widgetIdsByPage = new Map();
let sourceKeyByWidget = new Map();

function currentWidgetIds(page_id) {
  if (!page_id) return [];
  return widgetIdsByPage.get(page_id) || [];
}

function refreshWidgetIndex() {
  const byPage = new Map();
  const byWidget = new Map();
  for (const widget of db.getAllWidgets()) {
    if (!byPage.has(widget.page_id)) byPage.set(widget.page_id, []);
    byPage.get(widget.page_id).push(widget.id);
    byWidget.set(widget.id, widgetManager.keyFor(widget.source_id));
  }
  widgetIdsByPage = byPage;
  sourceKeyByWidget = byWidget;
}

const widgetManager = createWidgetManager({ db });

/** Rebuilds the pollers from the database and refreshes the page index. */
function syncWidgets() {
  refreshWidgetIndex();
  widgetManager.startAll(db.getAllWidgets());
}

// A source tick only interests clients looking at a page with a widget fed by
// it, so the frame is filtered per socket. The manager keys its snapshot by
// source; this maps back to the widget ids that consume it.
widgetManager.onChange((changed) => {
  clients.forEach((ws) => {
    if (ws.readyState !== 1) return;
    const data = {};
    for (const id of currentWidgetIds(ws.currentPage)) {
      const sourceKey = sourceKeyByWidget.get(id);
      if (sourceKey && changed.has(sourceKey)) data[id] = changed.get(sourceKey);
    }
    if (!Object.keys(data).length) return;
    trySend(ws, () => ws.send(JSON.stringify({ t: "widget_data", data })));
  });
});

function sessionLevels() {
  try {
    return getAudioSessionsSync().map((s) => ({
      app: s.processName,
      volume: s.volume,
      muted: s.muted,
    }));
  } catch {
    return [];
  }
}

const statsInterval = setInterval(async () => {
  if (clients.size === 0) return;
  let volume, muted;
  try {
    [volume, muted] = await Promise.all([getVolume(), getMuted()]);
  } catch (e) {
    console.error(
      "[statsInterval] getVolume/getMuted threw — skipping this tick:",
      e.message,
    );
    return; // previously this would have silently aborted before reaching clients.forEach
  }
  // FEATURE: Live widgets — one local collector now feeds both this tick and
  // the System Monitor widget, so the header pills and a tile can never
  // disagree about CPU or RAM. cheap() only: the expensive tier (disk, network,
  // temperature) costs a PowerShell process and belongs to a widget refresh,
  // not to a tick that runs every three seconds.
  const { cpu, memory } = systemStats.cheap();
  const msg = JSON.stringify({
    t: "stats",
    cpu,
    ram_used: Math.round((memory.used / 1024 / 1024 / 1024) * 10) / 10,
    ram_total: Math.round((memory.total / 1024 / 1024 / 1024) * 10) / 10,
    time: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    volume: volume ?? null,
    muted: muted ?? null,
    // Synchronous native reads, unlike the speaker pair above which may await
    // Voicemeeter — so these need no try/catch of their own and cannot stall
    // the tick.
    mic_volume: getMicVolume(),
    mic_muted: getMicMuted(),
    sessions: sessionLevels(),
  });
  clients.forEach((ws) => {
    if (ws.readyState !== 1) return;
    try {
      ws.send(msg);
    } catch (e) {
      // A failed send is worth hearing about; a successful one fires every
      // three seconds per client and drowns everything else.
      console.error(
        `Stats push failed for ${ws.clientId} (${ws.clientIp}):`,
        e.message,
      );
    }
  });
}, 3000);

const holdIntervals = new Map();
// FEATURE: Volume controls — generation counter per client. volume_hold_start
// awaits a real volume read before it can install its interval, and a release
// arriving during that await would otherwise find an empty holdIntervals map
// and leave the interval running with no handle to stop it.
const holdGenerations = new Map();

wss.on("connection", (ws, req) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const isLocalClient = isLocalAddress(req.socket.remoteAddress);
  const suppliedToken = requestUrl.searchParams.get("token");
  if (!isLocalClient && !isAuthorizedToken(suppliedToken)) {
    ws.close(1008, "Pair this device with EchoDeck first");
    return;
  }
  if (!isLocalClient && suppliedToken) {
    try {
      // Remember which credential this socket used so revoking that device can
      // drop it immediately instead of waiting for it to reconnect.
      ws.pairedDeviceId = db.getPairedDeviceIdByToken(suppliedToken);
      db.touchPairedDevice(suppliedToken);
    } catch {
      /* last_seen is informational only */
    }
  }

  ws.clientId = uuid();
  ws.clientIp = req.socket.remoteAddress?.replace("::ffff:", "") || "unknown";
  ws.connectedAt = new Date().toISOString();
  ws.userAgent = req.headers["user-agent"] || null;
  ws.isDesktop = isLocalClient;
  ws.isAlive = true;

  // Heartbeat: ping every PING_INTERVAL ms.
  // If no pong arrives within PONG_TIMEOUT ms, terminate.
  // Using an explicit pong-deadline timer instead of the simple boolean
  // flag prevents a race where isAlive gets reset before the check fires.
  let pongDeadlineTimer = null;

  const pingTimer = setInterval(() => {
    if (ws.readyState !== 1) return;

    // Set a hard deadline — if pong doesn't arrive in time, close.
    pongDeadlineTimer = setTimeout(() => {
      console.warn(
        `[heartbeat] no pong from ${ws.clientId} within ${PONG_TIMEOUT}ms — terminating`,
      );
      ws.terminate();
    }, PONG_TIMEOUT);

    ws.ping();
  }, PING_INTERVAL);

  ws.on("pong", () => {
    // Cancel the deadline — connection is still alive.
    clearTimeout(pongDeadlineTimer);
    pongDeadlineTimer = null;
  });

  clients.add(ws);
  console.log(
    `Client connected [${ws.clientId}] from ${ws.clientIp}. Total: ${clients.size}`,
  );

  // Initial state push — guard against the socket already being gone.
  setTimeout(() => {
    if (ws.readyState === 1) {
      trySend(ws, () => sendState(ws));
    }
  }, 300);

  broadcastClients();

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === "press") {
      const btn = db.getButton(msg.id);
      if (!btn) return;

      if (btn.sound_file) {
        const target = btn.sound_target || "phone";
        if (target === "phone" || target === "both") {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                t: "play_sound",
                id: btn.id,
                sound_file: btn.sound_file,
              }),
            );
          }
        }
        if (target === "pc" || target === "both") {
          // The Electron renderer is always connected locally and can play
          // sound through Chromium without requiring a machine-wide ffplay.
          // Keep ffplay as a fallback for headless/server-only operation.
          const desktopClients = [...clients].filter(
            (client) => client.isDesktop && client.readyState === 1,
          );
          const pcDevice =
            btn.audio_device || db.getSetting("pc_sound_device") || "";
          if (desktopClients.length) {
            // The renderer routes this with setSinkId. An unknown device name
            // falls back to the default output rather than going silent.
            const soundMessage = JSON.stringify({
              t: "play_sound",
              id: btn.id,
              sound_file: btn.sound_file,
              device: pcDevice,
              monitor: db.getSetting("pc_monitor_device") || "",
            });
            desktopClients.forEach((client) => client.send(soundMessage));
          } else {
            playAudioOnDevice(btn.sound_file, pcDevice).catch((e) =>
              console.error("PC sound error:", e.message),
            );
          }
        }
      }

      if (btn.button_mode === "multi_switch") {
        const nextState = btn.switch_state ? 0 : 1;
        const stack = nextState ? btn.switch_actions_a : btn.switch_actions_b;
        db.updateButton(btn.id, { switch_state: nextState });
        broadcastUpdate(btn.id, { switch_state: nextState });
        console.log(
          `Multi-action switch: ${btn.label} → ${nextState ? "A" : "B"} (${stack.length} steps)`,
        );
        executeSequence(stack).then(() => broadcastVolumeNow());
        return;
      }

      if (btn.actions && btn.actions.length > 0) {
        console.log(`Multi-action: ${btn.label} (${btn.actions.length} steps)`);
        executeSequence(btn.actions).then(() => broadcastVolumeNow());
        return;
      }

      if (btn.is_toggle) {
        const newState = btn.toggle_state ? 0 : 1;
        db.updateButton(btn.id, { toggle_state: newState });
        const type = newState === 1 ? btn.action_type : btn.toggle_action_type;
        const value =
          newState === 1 ? btn.action_value : btn.toggle_action_value;
        console.log(`Toggle: ${btn.label} → ${newState ? "ON" : "OFF"}`);
        executeAction(type, value);
        broadcastUpdate(btn.id, { toggle_state: newState });
        return;
      }

      console.log(
        `Press: ${btn.label} (${btn.action_type}: ${btn.action_value})`,
      );
      executeAction(btn.action_type, btn.action_value).then(() =>
        broadcastVolumeNow(),
      );
    }

    if (msg.t === "volume_hold_start") {
      const existing = holdIntervals.get(ws);
      if (existing) clearInterval(existing);

      // Claim this hold before the await below. A stop (or another start)
      // arriving mid-await bumps the generation, telling us to abandon.
      const generation = (holdGenerations.get(ws) ?? 0) + 1;
      holdGenerations.set(ws, generation);

      const { direction } = msg;
      // Clamp to the same range the editor offers. Older phone builds send a
      // hardcoded 2 and omit nothing, so a missing step still needs a default.
      const step = Math.min(
        20,
        Math.max(1, parseInt(msg.step, 10) || 5),
      );
      // Older phone builds predate mic keys and send no target at all, so the
      // speaker has to remain the default.
      const isMic = msg.target === "mic";
      const actionType = isMic
        ? direction === "up"
          ? "mic_volume_up"
          : "mic_volume_down"
        : direction === "up"
          ? "volume_up"
          : "volume_down";

      // One real OS read to seed our local estimate
      let localVolume = (isMic ? getMicVolume() : await getVolume()) ?? 50;

      // Released or restarted while that read was in flight — installing the
      // interval now would strand it, so leave without starting anything.
      if (holdGenerations.get(ws) !== generation) return;

      const tick = () => {
        executeAction(actionType, String(step)); // fire-and-forget, no await/broadcast
        localVolume =
          direction === "up"
            ? Math.min(100, localVolume + step)
            : Math.max(0, localVolume - step);
        const msgOut = JSON.stringify(
          isMic
            ? { t: "volume", mic_volume: localVolume, mic_muted: false }
            : { t: "volume", volume: localVolume, muted: false },
        );
        if (ws.readyState === 1) ws.send(msgOut); // only this client, optimistic
      };

      tick(); // immediate first step
      const interval = setInterval(tick, 80);
      holdIntervals.set(ws, interval);
    }

    if (msg.t === "volume_hold_stop") {
      // Invalidate any start still waiting on its seeding read.
      holdGenerations.set(ws, (holdGenerations.get(ws) ?? 0) + 1);
      const interval = holdIntervals.get(ws);
      if (interval) {
        clearInterval(interval);
        holdIntervals.delete(ws);
      }
      // One real OS read to resync everyone (other clients, desktop UI, etc.)
      broadcastVolumeNow();
    }

    if (msg.t === "switch_page") {
      manualSwitchPausedUntil = Date.now() + 15000;
      ws.currentPage = msg.page_id;
      sendState(ws, msg.page_id);
      broadcastClients();
    }

    if (msg.t === "reorder_buttons") {
      db.reorderButtons(msg.buttons);
      broadcastState();
    }
  });

  const cleanup = () => {
    clearInterval(pingTimer);
    clearTimeout(pongDeadlineTimer);
    const interval = holdIntervals.get(ws);
    if (interval) {
      clearInterval(interval);
      holdIntervals.delete(ws);
    }
    holdGenerations.delete(ws);
    clients.delete(ws);
    console.log(`Client disconnected [${ws.clientId}]. Total: ${clients.size}`);
    broadcastClients();
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

async function broadcastVolumeNow() {
  if (clients.size === 0) return;
  const [volume, muted] = await Promise.all([getVolume(), getMuted()]);
  const msg = JSON.stringify({
    t: "volume",
    volume,
    muted,
    mic_volume: getMicVolume(),
    mic_muted: getMicMuted(),
    sessions: sessionLevels(),
  });
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function sendState(ws, page_id) {
  const pages = db.getPages().map(toDeckPage);
  const targetPage = page_id || autoPageId || pages[0]?.id;
  // Remember the page this socket is actually looking at. It is what the
  // widget fan-out filters on, and without it a freshly connected client has
  // no page and silently receives no live data until it switches.
  if (targetPage) ws.currentPage = targetPage;
  const page = pages.find((p) => p.id === targetPage);
  const buttons = targetPage ? db.getButtons(targetPage).map(toDeckButton) : [];
  // FEATURE: Live widgets — the tiles on this page, each carrying the last
  // known snapshot with its status. A fresh connection therefore paints real
  // numbers immediately, including a host that is currently offline: the last
  // values plus the fact that they are stale is exactly what the tile should
  // show while it waits for the next tick.
  const widgets = targetPage
    ? db.getWidgets(targetPage).map((widget) => {
        const sourceKey = widgetManager.keyFor(widget.source_id);
        const snapshot = widgetManager.snapshotFor(widget.source_id);
        const status = widgetManager.status(widget.source_id);
        return {
          ...widget,
          data: snapshot,
          status: status.status,
          stale: status.stale,
          lastError: status.lastError,
          lastSeen: status.lastSeen,
          sourceKey,
        };
      })
    : [];
  ws.send(
    JSON.stringify({
      v: 1,
      t: "state",
      pages,
      current_page: targetPage,
      buttons,
      widgets,
      // Kept for clients that predate per-page labels: it mirrors the flag of
      // the page being sent, so those builds follow the page too rather than
      // freezing on the last deck-wide value they were given.
      show_labels: page?.show_labels === true,
      auto_switch: {
        active_page: autoPageId,
        active_rule: activeRuleId,
        active_window: activeWindow,
      },
    }),
  );
}

function toDeckButton(btn) {
  return { ...btn, sound_file: !!btn.sound_file };
}

function toDeckPage(page) {
  return { ...page, show_labels: Number(page.show_labels) === 1 };
}

function broadcastRules() {
  const msg = JSON.stringify({
    t: "profile_rules",
    rules: db.getProfileRules(),
  });
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

async function evaluateAutoSwitch() {
  if (Date.now() < manualSwitchPausedUntil) return;
  if (db.getSetting("auto_profile_switching") === "0") return;

  const nextWindow = await getActiveWindow();
  if (!nextWindow) return;

  if (
    nextWindow.process === activeWindow?.process &&
    nextWindow.windowTitle === activeWindow?.windowTitle
  )
    return;

  activeWindow = nextWindow;

  const pages = db.getPages();
  if (!pages.length) return;
  const rule = findMatchingRule(db.getProfileRules(), activeWindow);
  const delayMs = Number(rule?.switch_delay ?? 0);

  clearTimeout(autoSwitchDebounceTimer);

  if (delayMs <= 0) {
    performSwitch(pages, rule);
  } else {
    autoSwitchDebounceTimer = setTimeout(() => {
      performSwitch(pages, rule);
    }, delayMs);
  }
}

function performSwitch(pages, rule) {
  const nextPageId = rule?.page_id || pages[0].id;
  const nextRuleId = rule?.id || null;
  if (nextPageId === autoPageId && nextRuleId === activeRuleId) return;

  autoPageId = nextPageId;
  activeRuleId = nextRuleId;
  clients.forEach((ws) => {
    ws.currentPage = nextPageId;
    if (ws.readyState === 1) sendState(ws, nextPageId);
  });
}

const autoSwitchInterval = setInterval(() => {
  evaluateAutoSwitch().catch((e) =>
    console.warn("Auto profile switch error:", e.message),
  );
}, 300);

function broadcastUpdate(id, fields) {
  const msg = JSON.stringify({ t: "update", id, ...fields });
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

const isPackaged = process.env.ECHODECK_PACKAGED === "1";
const clientPath = isPackaged
  ? path.join(process.resourcesPath, "client", "dist")
  : path.join(__dirname, "../../client/dist");

app.use(express.static(clientPath));
app.use((req, res) => res.sendFile(path.join(clientPath, "index.html")));

server.listen(PORT, "0.0.0.0", () => {
  // FEATURE: Live widgets — build the pollers before the first client can
  // connect, so a phone that opens a page with a widget on it never waits a
  // whole refresh interval for its first numbers.
  syncWidgets();
  // Warm the application list in the background so the first time someone opens
  // the picker it is already there. Never awaited: a slow enumeration must not
  // hold up the host.
  primeApplicationCache();
  console.log(`✅ EchoDeck running on ${LAN_URL}`);
  console.log(`   Phone URL:    ${LAN_URL}`);
  console.log(`   Local URL:    http://localhost:${PORT}`);
});

process.on("SIGTERM", () => {
  clearInterval(statsInterval);
  clearInterval(autoSwitchInterval);
  process.exit(0);
});
process.on("SIGINT", () => {
  clearInterval(statsInterval);
  clearInterval(autoSwitchInterval);
  process.exit(0);
});
