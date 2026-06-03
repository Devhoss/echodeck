const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const path = require("path");
const { v4: uuid } = require("uuid");
const os = require("os");
const db = require("./db");
const { getActiveWindow, listOpenWindows } = require("./activeWindow");
const { findMatchingRule } = require("./ruleEngine");
const {
  executeAction,
  executeSequence,
  getVolume,
  getMuted,
  getAudioDevices,
  playAudioOnDevice, // FEATURE: Soundboard — PC-side ffplay playback
} = require("./actions");

const PORT = 9001;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- REST ---

app.get("/api/pages", (req, res) => {
  const pages = db.getPages();
  res.json(pages.map((p) => ({ ...p, buttons: db.getButtons(p.id) })));
});

// FEATURE: Audio output switching — list Windows playback devices
app.get("/api/audio-devices", async (req, res) => {
  try {
    res.json(await getAudioDevices());
  } catch (e) {
    console.error("audio-devices error:", e.message);
    res.json([]);
  }
});

// FEATURE: Settings — get/set global config (e.g. pc_sound_device)
// GET  /api/settings          → { pc_sound_device: "Voicemeeter Input ..." }
// POST /api/settings          → body { key, value }
app.get("/api/settings", (req, res) => {
  const pc_sound_device = db.getSetting("pc_sound_device") ?? "";
  const auto_profile_switching =
    db.getSetting("auto_profile_switching") ?? "1";
  res.json({
    pc_sound_device,
    auto_profile_switching: auto_profile_switching === "1",
  });
});

app.post("/api/settings", (req, res) => {
  const { key, value } = req.body;
  const allowed = ["pc_sound_device", "auto_profile_switching"];
  if (!allowed.includes(key))
    return res.status(400).json({ error: "Unknown setting" });
  db.setSetting(
    key,
    key === "auto_profile_switching" ? (value ? "1" : "0") : (value ?? ""),
  );
  res.json({ ok: true });
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
  const page = db.createPage(uuid(), req.body.name || "New Page", pages.length);
  res.json(page);
});

app.delete("/api/pages/:id", (req, res) => {
  db.deletePage(req.params.id);
  broadcastState();
  res.json({ ok: true });
});

// FEATURE: Animated icons
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

// FEATURE: Soundboard — upload audio clip for a button (stored as base64 data URL)
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

// FEATURE: Soundboard — remove sound from a button
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

// --- WebSocket ---
const clients = new Set();
let lastCpuTimes = os.cpus().map((c) => c.times);
let activeWindow = null;
let autoPageId = null;
let activeRuleId = null;
let manualSwitchPausedUntil = 0;

function getCpuPercent() {
  const current = os.cpus().map((c) => c.times);
  let totalIdle = 0,
    totalTick = 0;
  for (let i = 0; i < current.length; i++) {
    const prev = lastCpuTimes[i],
      curr = current[i];
    const idle = curr.idle - prev.idle;
    const tick =
      curr.user -
      prev.user +
      (curr.nice - prev.nice) +
      (curr.sys - prev.sys) +
      (curr.idle - prev.idle) +
      (curr.irq - prev.irq);
    totalIdle += idle;
    totalTick += tick;
  }
  lastCpuTimes = current;
  return totalTick === 0
    ? 0
    : Math.round(((totalTick - totalIdle) / totalTick) * 100);
}

const statsInterval = setInterval(async () => {
  if (clients.size === 0) return;
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const [volume, muted] = await Promise.all([getVolume(), getMuted()]);
  const msg = JSON.stringify({
    t: "stats",
    cpu: getCpuPercent(),
    ram_used: Math.round((usedMem / 1024 / 1024 / 1024) * 10) / 10,
    ram_total: Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10,
    time: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    volume: volume ?? null,
    muted: muted ?? null,
  });   
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}, 3000);

const holdIntervals = new Map();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`Client connected. Total: ${clients.size}`);
  sendState(ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === "press") {
      const btn = db.getButton(msg.id);
      if (!btn) return;

      // FEATURE: Soundboard — route audio based on sound_target
      if (btn.sound_file) {
        const target = btn.sound_target || "phone";

        // Send to phone (the client that pressed)
        if (target === "phone" || target === "both") {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({ t: "play_sound", sound_file: btn.sound_file }),
            );
          }
        }

        // Play on PC via ffplay → Voicemeeter virtual input
        // pc_sound_device setting holds the Voicemeeter device name
        // e.g. "Voicemeeter Input (VB-Audio Voicemeeter VAIO)"
        if (target === "pc" || target === "both") {
          const pcDevice = db.getSetting("pc_sound_device") ?? "";
          playAudioOnDevice(btn.sound_file, pcDevice).catch((e) =>
            console.error("PC sound error:", e.message),
          );
        }
      }

      // FEATURE: Multi-action buttons
      if (btn.actions && btn.actions.length > 0) {
        console.log(`Multi-action: ${btn.label} (${btn.actions.length} steps)`);
        executeSequence(btn.actions);
        return;
      }

      // FEATURE: Toggle buttons
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

      // Standard action
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
      const { direction, step = 2 } = msg;
      const actionType = direction === "up" ? "volume_up" : "volume_down";
      executeAction(actionType, String(step)).then(() => broadcastVolumeNow());
      const interval = setInterval(() => {
        executeAction(actionType, String(step)).then(() =>
          broadcastVolumeNow(),
        );
      }, 80);
      holdIntervals.set(ws, interval);
    }

    if (msg.t === "volume_hold_stop") {
      const interval = holdIntervals.get(ws);
      if (interval) {
        clearInterval(interval);
        holdIntervals.delete(ws);
      }
    }

    if (msg.t === "switch_page") {
      manualSwitchPausedUntil = Date.now() + 15000;
      ws.currentPage = msg.page_id;
      sendState(ws, msg.page_id);
    }

    if (msg.t === "reorder_buttons") {
      db.reorderButtons(msg.buttons);
      broadcastState();
    }
  });

  const cleanup = () => {
    const interval = holdIntervals.get(ws);
    if (interval) {
      clearInterval(interval);
      holdIntervals.delete(ws);
    }
    clients.delete(ws);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

async function broadcastVolumeNow() {
  if (clients.size === 0) return;
  const [volume, muted] = await Promise.all([getVolume(), getMuted()]);
  const msg = JSON.stringify({ t: "volume", volume, muted });
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function sendState(ws, page_id) {
  const pages = db.getPages();
  const targetPage = page_id || autoPageId || pages[0]?.id;
  const buttons = targetPage ? db.getButtons(targetPage).map(toDeckButton) : [];
  ws.send(
    JSON.stringify({
      v: 1,
      t: "state",
      pages,
      current_page: targetPage,
      buttons,
      auto_switch: {
        active_page: autoPageId,
        active_rule: activeRuleId,
        active_window: activeWindow,
      },
    }),
  );
}

function toDeckButton(btn) {
  return {
    ...btn,
    sound_file: !!btn.sound_file,
  };
}

function broadcastState() {
  clients.forEach((ws) => {
    if (ws.readyState === 1) sendState(ws, ws.currentPage);
  });
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

  const pages = db.getPages();
  if (!pages.length) return;

  const nextWindow = await getActiveWindow();
  if (!nextWindow) return;
  activeWindow = nextWindow;

  const rule = findMatchingRule(db.getProfileRules(), activeWindow);
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
}, 1000);

function broadcastUpdate(id, fields) {
  const msg = JSON.stringify({ t: "update", id, ...fields });
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

const isPackaged = process.mainModule.filename.includes("app.asar");
const clientPath = isPackaged
  ? path.join(process.resourcesPath, "client", "dist")
  : path.join(__dirname, "../../client/dist");

app.use(express.static(clientPath));
app.use((req, res) => res.sendFile(path.join(clientPath, "index.html")));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Macro Deck running on http://192.168.100.10:${PORT}`);
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
