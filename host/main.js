const {
  app,
  Tray,
  Menu,
  shell,  
  Notification,
  nativeImage,
} = require("electron");
const path = require("path");
const os = require("os");

let tray;
let serverStarted = false;
let serverError = null;

process.on("uncaughtException", (err) => {
  serverError = err?.message ?? String(err);
  console.error("Uncaught main-process error:", err);
});

process.on("unhandledRejection", (err) => {
  serverError = err?.message ?? String(err);
  console.error("Unhandled main-process rejection:", err);
});

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-http-cache");

// Prevent multiple instances — second launch just focuses the tray
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Get the local LAN IP so the tray menu shows the right address for mobile
function getLanIp() {
  const ifaces = os.networkInterfaces();

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      // Skip non-IPv4 and internal
      if (iface.family !== "IPv4" || iface.internal) continue;

      // Skip Windows self-assigned APIPA addresses
      if (iface.address.startsWith("169.254.")) continue;

      // Prefer real LAN IPs
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

const HOST = getLanIp();
const PORT = 9001;
const URL = `http://${HOST}:${PORT}`;

// Start the backend — wrap in try/catch so errors surface in the tray
function startServer() {
  try {
    require("./src/server");
    serverStarted = true;
  } catch (err) {
    serverError = err.message;
    console.error("Server failed to start:", err);
  }
}

app.whenReady().then(() => {
  startServer();

  const icon = nativeImage
    .createFromPath(path.join(__dirname, "assets", "icon.png"))
    .resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip(`Stream Deck — ${serverStarted ? URL : "ERROR"}`);

  buildMenu();

  // Show a notification on first launch so the user knows it's running
  if (serverStarted) {
    new Notification({
      title: "Stream Deck",
      body: `Running at ${URL}`,
      silent: true,
    }).show();
  } else {
    new Notification({
      title: "Stream Deck — Failed to start",
      body: serverError ?? "Unknown error. Check logs.",
    }).show();
  }
});

function buildMenu() {
  const statusLabel = serverStarted
    ? `● Running at ${URL}`
    : `✕ Server error: ${serverError ?? "unknown"}`;

  const menu = Menu.buildFromTemplate([
    // Status line — not clickable, just informational
    {
      label: statusLabel,
      enabled: false,
    },
    { type: "separator" },

    // Open in browser (useful for quick config on desktop)
    {
      label: "Open Dashboard",
      click: () => shell.openExternal(URL),
    },

    // Copy the LAN URL to clipboard — handy for pasting into phone browser
    {
      label: "Copy Mobile URL",
      click: () => {
        require("electron").clipboard.writeText(URL);
        tray.setToolTip(`Copied: ${URL}`);
        // Reset tooltip after 3s
        setTimeout(() => tray.setToolTip(`Stream Deck — ${URL}`), 3000);
      },
    },

    { type: "separator" },

    {
      label: "Restart Server",
      click: () => {
        // Give the server's WS connections 500ms to close cleanly
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 500);
      },
    },

    { type: "separator" },

    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(menu);
}

app.on("window-all-closed", (e) => {
  // Prevent Electron from quitting when there are no windows — we live in the tray
  e.preventDefault();
});

app.on("before-quit", () => {
  // Clean tray icon on quit so it doesn't linger in the taskbar
  tray?.destroy();
});
