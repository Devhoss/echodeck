/**
 * main.js  —  host/main.js
 *
 * Electron main process.
 * - Starts the Express/WS backend
 * - Manages the system tray
 * - Opens/hides the desktop dashboard window
 * - Injects the dynamic LAN IP into the renderer via a <script> tag
 *   so the phone URL and WS connection are always correct, even after
 *   network changes or publishing to other machines.
 *
 * No hardcoded IPs anywhere — all addresses come from network.js.
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  shell,
  Notification,
  nativeImage,
  ipcMain,
} = require("electron");
const path = require("path");

// ─── Shared IP/port ──────────────────────────────────────────────────────────
// Resolved once at startup; server.js requires the same module so they agree.
const { PORT, LAN_IP, LAN_URL, WS_URL } = require("./src/network");

// ─── State ───────────────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let serverStarted = false;
let serverError = null;

// ─── Error guards ─────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  serverError = err?.message ?? String(err);
  console.error("Uncaught main-process error:", err);
});
process.on("unhandledRejection", (err) => {
  serverError = err?.message ?? String(err);
  console.error("Unhandled main-process rejection:", err);
});

// ─── Electron flags ───────────────────────────────────────────────────────────
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-http-cache");

// ─── Single instance ──────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// If a second instance is launched, focus the existing window
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ─── Backend ──────────────────────────────────────────────────────────────────
function startServer() {
  try {
    process.env.ECHODECK_PACKAGED = app.isPackaged ? "1" : "0";
    require("./src/server");
    serverStarted = true;
  } catch (err) {
    serverError = err.message;
    console.error("Server failed to start:", err);
  }
}

// ─── BrowserWindow ────────────────────────────────────────────────────────────
function createWindow() {
  const isPackaged = app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "EchoDeck",
    backgroundColor: "#0d0d0d", // matches the app's dark background — no white flash
    show: false, // always start hidden — shown via tray notification on first launch,
    skipTaskbar: true, // or immediately after if not a startup launch
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // ── Load the app ──
  if (isPackaged) {
    mainWindow.loadFile(
      path.join(process.resourcesPath, "client", "dist", "index.html"),
    );
  } else {
    const devUrl = process.env.VITE_DEV_URL || null;
    if (devUrl) {
      mainWindow.loadURL(devUrl);
    } else {
      mainWindow.loadFile(path.join(__dirname, "../client/dist/index.html"));
    }
  }

  // ── Show window once content is painted ──
  // On a normal launch (user opened the app manually) we show immediately.
  // On a startup launch (--hidden flag set by openAsHidden) we stay in tray.
  mainWindow.once("ready-to-show", () => {
    if (!app.isStartingHidden) {
      mainWindow.show();
      mainWindow.setSkipTaskbar(false);
    }
  });

  // ── Clicking the close button hides to tray instead of quitting ──
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      mainWindow.setSkipTaskbar(true);
      if (!mainWindow._hideTipShown) {
        mainWindow._hideTipShown = true;
        tray?.displayBalloon?.({
          title: "EchoDeck is still running",
          content: "Right-click the tray icon to quit.",
          iconType: "info",
        });
      }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // ── Dev tools in development ──
  if (!isPackaged && process.env.NODE_ENV !== "production") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  const statusLabel = serverStarted
    ? `● Running  —  phone: ${LAN_URL}`
    : `✕ Server error: ${serverError ?? "unknown"}`;

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: "separator" },

    {
      label: "Open Dashboard",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.setSkipTaskbar(false);
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },

    {
      label: "Open in Browser",
      click: () => shell.openExternal(LAN_URL),
    },

    {
      label: "Copy Mobile URL",
      click: () => {
        require("electron").clipboard.writeText(LAN_URL);
        tray.setToolTip(`Copied: ${LAN_URL}`);
        setTimeout(() => tray.setToolTip(`EchoDeck  —  ${LAN_URL}`), 3000);
      },
    },

    { type: "separator" },

    {
      label: "Restart Server",
      click: () => {
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 500);
      },
    },

    { type: "separator" },

    {
      label: "Quit EchoDeck",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ─── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // ── Windows startup registration ──────────────────────────────────────────
  // Registers EchoDeck in HKCU Run so Windows launches it at login.
  // openAsHidden=true passes --hidden to the process, which we read below
  // to keep the window suppressed on boot (only the tray + notification show).
  if (process.platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
    });
  }

  // Detect whether this is a Windows startup launch (--hidden flag)
  // or a normal manual launch. Controls whether the window opens on boot.
  app.isStartingHidden =
    process.platform === "win32" &&
    app.getLoginItemSettings().wasOpenedAsHidden;

  startServer();

  // ── Tray icon ──
  const iconPath = path.join(__dirname, "assets", "icon.png");
  const icon = nativeImage
    .createFromPath(iconPath)
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(`EchoDeck  —  ${serverStarted ? LAN_URL : "ERROR"}`);

  // Single-click toggles the window
  tray.on("click", () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isVisible()) {
      mainWindow.hide();
      mainWindow.setSkipTaskbar(true);
    } else {
      mainWindow.show();
      mainWindow.setSkipTaskbar(false);
      mainWindow.focus();
    }
  });

  // Double-click always opens
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.setSkipTaskbar(false);
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  buildTrayMenu();

  // ── Create window (hidden on startup launch, visible on manual launch) ──
  createWindow();

  // ── Startup notification ──
  if (serverStarted) {
    new Notification({
      title: "EchoDeck",
      body: app.isStartingHidden
        ? `Started in tray — connect your phone to ${LAN_URL}`
        : `Running — connect your phone to ${LAN_URL}`,
      silent: true,
    }).show();
  } else {
    new Notification({
      title: "EchoDeck — Failed to start",
      body: serverError ?? "Unknown error. Check logs.",
    }).show();
  }
});

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle("get-network-config", () => ({
  lanIp: LAN_IP,
  port: PORT,
  lanUrl: LAN_URL,
  wsUrl: WS_URL,
}));

ipcMain.on("get-network-config-sync", (event) => {
  event.returnValue = {
    lanIp: LAN_IP,
    port: PORT,
    lanUrl: LAN_URL,
    wsUrl: WS_URL,
  };
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────
// Don't quit when all windows close — we live in the tray.
app.on("window-all-closed", (e) => {
  if (process.platform !== "darwin") {
    e.preventDefault?.();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  tray?.destroy();
});
