# EchoDeck

> Modern Electron-based desktop control center featuring smart profiles, automation, live widgets, and contextual app-aware controls.

EchoDeck is a next-generation Stream Deck alternative built with Electron, React, and Node.js.

It combines:

- dynamic profiles
- automation
- app-aware switching
- live widgets
- macros
- desktop integrations
- real-time controls
- soundboard routing
- native tray integration

into a customizable desktop command center.

---

# Features

## Hold to Confirm

Buttons that do something you cannot undo — restart, shutdown, ending a stream —
can be set to require a deliberate press instead of a tap.

Turn on **Confirm before running** in the button editor. On the phone, a tap
then does nothing: the button has to be held for about three quarters of a
second, with a ring filling around the tile edge where your thumb does not
cover it. Letting go early cancels and leaves nothing armed, so there is never
a primed button waiting to fire on a later tap. Guarded buttons show a small
🔒 badge on both the phone and the desktop layout.

This is an accident guard in the interface, not a security control — the host
still runs any well-formed press it receives.

## Pairing

Phones pair by scanning a QR code from **Add Phone** in the top bar.

The code in the QR is short-lived and is replaced every time EchoDeck starts,
so an old screenshot stops working. On a successful pair the host issues that
phone its own credential, which is stored and survives restarts — pair once and
the phone reconnects on its own from then on.

**Paired Devices** in the top bar lists every phone that has paired, offline
ones included, with when it last connected:

- **Disconnect** ends the current session; the phone reconnects on its own
- **Revoke** removes the pairing entirely — that phone must scan a new QR code

The API and WebSocket both refuse unpaired devices, and requests from the
machine EchoDeck is running on are always trusted.

## Smart Auto Profile Switching

Automatically switch profiles depending on the active application on your PC.

### How It Works

Each page can have one **rule**. A rule is a list of conditions that describe when that page should activate. EchoDeck watches your currently focused window and evaluates all rules continuously.

A condition checks one thing about the focused window:

| Type | What it checks |
|---|---|
| **Process** | The `.exe` name (e.g. `Code.exe`, `chrome.exe`) |
| **Window title** | The text in the title bar |
| **Executable path** | The full file path on disk |

Each condition uses an operator to match against a value you type:
`equals` · `contains` · `starts_with` · `ends_with` · `regex` · `not_equals` · `not_contains` · `exists`

### Logic: AND vs OR

When a rule has multiple conditions:

- **AND** — all conditions must match for the page to activate
- **OR** — any one condition matching is enough

Most setups only need a single condition, so this only matters if you add a second one.

### Priority

If two pages have rules that both match your current app, **priority decides which one wins — lower number = higher priority**. A rule with priority `10` beats one with `100`. If all your pages target different apps, leave everything at `100`.

### Rule Enabled Toggle

The checkbox next to a rule lets you temporarily disable it without deleting it.

### Example

> You want your **Streaming** page when OBS is focused, and your **Coding** page when VS Code is open.
>
> - Streaming page rule: Process **equals** `obs64.exe`, priority `100`
> - Coding page rule: Process **equals** `Code.exe`, priority `100`
>
> Clicking into OBS flips the deck to Streaming. Clicking into VS Code flips it to Coding. Anything else — it stays on whatever page it was last on.

### Supported Condition Types

```
process
window_title
executable_path
```

### Supported Operators

```
equals
contains
starts_with
ends_with
regex
not_equals
not_contains
exists
```

### Example Rule (JSON)

```json
{
  "logic": "AND",
  "priority": 10,
  "conditions": [
    {
      "type": "process",
      "operator": "equals",
      "value": "Code.exe"
    }
  ]
}
```

---

## Real-Time Dashboard

Live WebSocket-powered dashboard with:

- instant profile switching
- button updates
- system monitoring (CPU, RAM, clock)
- volume control
- device state sync

---

## Dynamic Profiles

Create unlimited profiles/pages:

- Main · Coding · Sounds · Streaming · Gaming
- Productivity · AI Tools · Custom workflows

---

## Macro & Action System

Trigger:

- keyboard shortcuts
- applications & URLs
- shell commands
- media & volume controls (hold a volume button to ramp; step size is configurable)
- audio device switching
- soundboard (phone-only, PC-only, or both)
- multi-action sequences and two-stack switches

---

## Soundboard

Each button can play a sound file with three routing modes:

| Mode | Where it plays |
|---|---|
| 📱 Phone only | Out of the phone |
| 🖥️ PC only | Out of the PC, on the device you choose |
| 📱+🖥️ Both | Both at once |

Routing is a property of the button, so remember to hit **Save Changes** — an
"Unsaved changes" banner appears whenever the panel has edits pending.

### Choosing the output

**Audio Settings** in the top bar lists your real playback devices. Pick any
one; no Voicemeeter, no virtual audio software required for ordinary playback.

### Letting a call hear it

To get soundboard audio into Discord, OBS or any other app that captures a
microphone, you need a virtual audio device — Windows has no way to feed audio
into a mic input on its own, and Stream Deck has the same requirement.

1. Install a virtual cable ([VB-CABLE](https://vb-audio.com/Cable/) is free)
2. Set **PC output device** to `CABLE Input`
3. Set Discord's input device to `CABLE Output`

### Hearing it yourself at the same time

A virtual cable is not a speaker, so routing sounds into one means you stop
hearing them. Set **Also play on (monitor)** to your headset and each sound
plays to both at once — the cable for the call, your headphones for you.

---

## Live Widgets

A widget is a persistent tile that receives data rather than an action.
Add one exactly like a key: drag it from the **Live widgets** group in the
library onto the deck's add well.

### Current Widgets

**System Monitor** — two data sources, chosen per tile:

| | |
|---|---|
| **This PC** | CPU, RAM, uptime, disk, network, temperature where the machine reports it |
| **Remote host** | Any Linux host over SSH — hostname, username, private key, refresh interval, and which metrics to show |

Remote hosts are configured as *sources*, not as special cases, so the same
host can feed several tiles over one connection:

```
Homelab -> 192.168.100.36
NAS     -> another IP
VPS     -> another IP
```

Pick **＋ Add Remote Host…** in the widget's Source dropdown to add one: name,
host, port, username, private-key path (pre-filled with your default
`~/.ssh/id_ed25519` when it exists), optional agent auth and refresh interval.
**Test connection** runs the real probe before anything is saved, and saving
binds the host to the tile in the same step.

### Reliability

A remote host going away is a rendered state, not a dead tile. The widget keeps
its last known values, dims them, and says how long ago they were real.
Docker behaves the same way: if `docker` is missing or the daemon is
unreachable, the row says so — "docker daemon unreachable — check the user is
in the docker group" — rather than disappearing.

```
🟢 ONLINE          CPU 18%
CPU 18%            RAM 2.4 / 4.0 GB
RAM 2.4/4.0 GB     DISK 68%
DISK 68%           NET ↓ 2.1 MB/s ↑ 0.4 MB/s
NET ↓ 2.1 ↑ 0.4    UPTIME 3h 17m
UPTIME 3h 17m

                   🔴 OFFLINE
                   Last seen: 12:41 AM
```

SSH timeouts, authentication failures, a host sleeping and network loss all
land as `offline` / `auth_error` with the last values retained and flagged
stale. One connection per source is reused across refreshes, and each refresh
runs a single command rather than one per metric.

### Authentication

Public-key only — no password is ever stored. Point a source at a key file
(defaults to `~/.ssh/id_ed25519` or `id_rsa`); the file's contents are never
read into the UI or returned by the API. If the key is encrypted, the passphrase
is stored through the OS credential store (Electron `safeStorage` / DPAPI) and
is write-only over the API.

The Windows OpenSSH agent can be used instead, but only when it is actually
reachable — the editor checks the pipe before offering the toggle, and key-file
authentication always remains available.

### Planned Widgets

- Media playback
- Live Browser (YouTube previews, Twitch chat, Home Assistant, security cameras)
- OBS stats
- Docker / service / uptime / disk monitors (reuse the same source model)
- Tailscale status
- AI widgets

---

## Electron Desktop Integration

- **System tray** — runs silently in the background; single-click to toggle the window
- **Startup launch** — opt-in from the tray menu; when enabled, opens hidden to tray on boot
- **Active window detection** — powers auto profile switching
- **Native notifications** — startup confirmation, tray hints
- **Process monitoring** — real-time running app list for rule capture

---

# Screenshots

## Main Dashboard

*Add screenshot here*

## Config UI

*Add screenshot here*

---

# Tech Stack

## Frontend

- React · Vite · Electron · WebSockets

## Backend

- Node.js · Express · SQLite

## Desktop

- Electron Tray · Native Window Detection · Process Monitoring · Login Item Registration

---

# Project Structure

```
echodeck/
├── .github/
│   └── workflows/
│       └── android-release.yml   ← CI: builds APK + EXE on every tag push
│
├── client/                       ← React frontend + Capacitor Android app
│   ├── src/
│   │   ├── App.jsx
│   │   ├── desktop/
│   │   │   └── DesktopApp.jsx
│   │   ├── ConfigUI.jsx
│   │   ├── constants.js
│   │   └── index.css
│   ├── android/                  ← Capacitor Android project (generated)
│   └── package.json
│
├── host/                         ← Electron main process + Express backend
│   ├── scripts/
│   │   └── fetch-tools.mjs       ← downloads bundled binaries at build time
│   ├── src/
│   │   ├── server.js
│   │   ├── actions.js
│   │   ├── db.js
│   │   ├── network.js
│   │   ├── activeWindow.js
│   │   └── ruleEngine.js
│   ├── assets/
│   │   └── icon.png / icon.ico
│   ├── main.js
│   ├── preload.js
│   ├── macro-deck.db
│   └── package.json
│
├── build-android.ps1             ← Local Android build script (Windows)
└── README.md
```

---

# Running the Project

## Prerequisites

- [Node.js](https://nodejs.org/) v22 or later
- [Android Studio](https://developer.android.com/studio) (only needed for local Android builds)
- Windows OS (the desktop app is Windows-only for now)

## Install Dependencies

```bash
# Client
cd client && npm install

# Host
cd host && npm install
```

## Start Development

```bash
# 1. Start the frontend (Vite dev server)
cd client && npm run dev

# 2. Start the backend
cd host && node src/server.js

# 3. Start Electron (separate terminal)
cd host && npm start
```

## Build

```bash
# Build the React/Vite web bundle
cd client && npm run build

# Build the Windows installer (also runs the client build via predist)
cd host && npm run dist
```

`npm run dist` first runs `npm run fetch:tools`, which downloads `ffplay` into
`host/assets/tools/`. That binary is ~112 MB, so it is fetched at build time
rather than committed, and skipped on later builds once present. It is only
used to play soundboard audio when the desktop app is not running — for example
under `npm run dev`, which starts the server without Electron.

---

# Releases

EchoDeck uses **GitHub Actions** to automatically build and publish releases.
Every time a version tag is pushed, the CI pipeline builds both the Windows installer
and the Android APK in parallel, then attaches them to a GitHub Release.

## How it works

```
git tag v1.2.0 && git push origin v1.2.0
          ↓
GitHub Actions triggers two parallel jobs:
  ┌─────────────────────────┐   ┌──────────────────────────┐
  │  Build Android APK      │   │  Build Windows EXE       │
  │  ubuntu-latest          │   │  windows-latest          │
  │                         │   │                          │
  │  npm run build          │   │  npm run build (client)  │
  │  cap sync android       │   │  npm run dist (host)     │
  │  gradlew assembleDebug  │   │  electron-builder        │
  └────────────┬────────────┘   └─────────────┬────────────┘
               └──────────┬──────────────────┘
                          ↓
              GitHub Release: v1.2.0
              ├── EchoDeck-Setup.exe
              └── echodeck-v1.2.0.apk
```

## Cutting a release

Make sure everything is committed and pushed, then:

```bash
git tag v1.2.0
git push origin v1.2.0
```

That's it. Check the **Actions** tab on GitHub to watch the build, then **Releases** for the output.

## Version naming

```
v1.0.0  →  first stable build
v1.0.1  →  bug fix
v1.1.0  →  new feature
v2.0.0  →  major update
```

## Local Android build (Windows)

If you want to build the APK locally without pushing a tag:

```powershell
# From the repo root
.\build-android.ps1            # outputs echodeck-local.apk
.\build-android.ps1 v1.2.0    # outputs echodeck-v1.2.0.apk
```

## Notes for forks

- The workflow uses `GITHUB_TOKEN` which is automatically available — no secrets needed
- The APK is debug-signed, which is fine for sideloading
- Windows SmartScreen will warn on the EXE since it has no code signing certificate — click **More info → Run anyway**. This is expected for unsigned open-source apps
- If you fork and want your own releases, no changes are needed — the workflow uses `github.ref_name` so it picks up your own tags automatically

---

# Current Status

## Completed

- Real-time WebSocket dashboard
- Dynamic pages / profiles
- Auto profile switching with rule engine
- SQLite persistence
- Electron tray integration (single-click toggle, startup launch, hidden-on-boot)
- Volume controls & audio device switching
- Soundboard with 3-way routing (phone / PC / both)
- Soundboard output device selection, no Voicemeeter required
- Monitor output — hear a sound while it also goes to a virtual cable
- Hold-to-confirm guard for destructive buttons
- Persistent device pairing with per-device revocation
- Active window detection & running app picker
- Delayed app capture (3-second countdown)
- Full Electron desktop UI (Elgato-style layout)
- Drag-to-reorder buttons
- Per-profile key labels
- Configurable live widgets (System Monitor: this PC or any SSH host)
- Button toggle states
- Icon & sound file uploads
- QR code phone pairing
- Config UI (mobile-friendly)
- Audio settings panel
- Windows startup registration (opt-in from the tray)
- Android companion app
- Automated GitHub releases (APK + EXE via CI)

## In Progress

- Plugin architecture
- Widget system expansion
- Advanced profile editor

## Planned

- Live Browser button (page previews inside a key)
- Browser-aware profiles (switch by URL/tab)
- Twitch / YouTube integration
- OBS integration
- AI-powered controls & suggestions
- iOS companion app
- Plugin marketplace
- Multi-device syncing

---

# Vision

EchoDeck is not just a Stream Deck clone.

The goal is to build a **smart desktop command center** — a contextual workflow automation platform that knows what you're doing and surfaces the right controls at the right time.

Combining ideas from Stream Deck, Raycast, OBS, Home Assistant, BetterTouchTool, and desktop automation tools into one unified experience.

---

# Future Ideas

## Live Browser Buttons

Embed a live web view inside a deck key — updated snapshots or live iframes of:

- YouTube stream preview
- Twitch chat
- Home Assistant dashboard
- Security camera feeds
- Discord activity

## Smart Browser Profiles

```
youtube.com  →  Media profile
github.com   →  Coding profile
figma.com    →  Design profile
```

## AI-Powered Controls

- AI-generated workflows
- Voice commands
- Smart suggestions
- Contextual actions

## Live Integrations

Discord · Spotify · Twitch · YouTube · OBS · Home Assistant · MQTT

---

# License

MIT License

---

# Author

Built by Hoss.