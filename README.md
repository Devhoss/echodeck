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
- media & volume controls
- audio device switching
- soundboard (phone-only, PC-only, or both)

---

## Soundboard

Each button can play a sound file with three routing modes:

| Mode | Who hears it |
|---|---|
| 📱 Phone only | You hear it |
| 🖥️ PC only | Your call/stream hears it (via Voicemeeter) |
| 📱+🖥️ Both | Everyone hears it |

Configure the PC output device under **Audio Settings** in the top bar.

---

## Live Widgets

### Current Widgets

- CPU usage
- RAM usage
- Clock
- Volume control

### Planned Widgets

- Media playback
- Live Browser (YouTube previews, Twitch chat, Home Assistant, security cameras)
- OBS stats
- AI widgets
- Homelab monitoring

---

## Electron Desktop Integration

- **System tray** — runs silently in the background; single-click to toggle the window
- **Startup launch** — registers with Windows at install, opens hidden to tray on boot
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
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── desktop/
│   │   │   └── DesktopApp.jsx
│   │   ├── ConfigUI.jsx
│   │   ├── constants.js
│   │   └── index.css
│   └── package.json
│
├── host/
│   ├── src/
│   │   ├── server.js
│   │   ├── actions.js
│   │   ├── db.js
│   │   ├── network.js
│   │   ├── activeWindow.js
│   │   └── ruleEngine.js
│   │
│   ├── main.js
│   ├── preload.js
│   ├── macro-deck.db
│   └── package.json
│
└── README.md
```

---

# Running the Project

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

# 3. Start Electron
cd host && npm start
```

## Build

```bash
cd client && npm run build
```

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
- Active window detection & running app picker
- Delayed app capture (3-second countdown)
- Full Electron desktop UI (Elgato-style layout)
- Drag-to-reorder buttons
- Button toggle states
- Icon & sound file uploads
- QR code phone pairing
- Config UI (mobile-friendly)
- Audio settings panel
- Windows startup registration
- Mobile companion app only Android for now

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