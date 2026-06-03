# EchoDeck

> Modern Electron-based desktop control center featuring smart profiles, automation, live widgets, and contextual app-aware controls.

EchoDeck is a next-generation Stream Deck alternative built with Electron, React, and Node.js.

It combines:

* dynamic profiles
* automation
* app-aware switching
* live widgets
* macros
* desktop integrations
* real-time controls

into a customizable desktop command center.

---

# Features

## Smart Auto Profile Switching

Automatically switch profiles depending on the active application.

### Examples

* VS Code → Coding profile
* Discord → Voice profile
* OBS → Streaming profile
* Browser → Media profile

### Supports

* process matching
* window title matching
* executable path matching
* AND / OR logic
* priorities
* regex rules
* enabled / disabled rules

---

## Real-Time Dashboard

Live websocket-powered dashboard with:

* instant profile switching
* button updates
* system monitoring
* volume control
* device state sync

---

## Dynamic Profiles

Create unlimited profiles/pages:

* Main
* Coding
* Sounds
* Streaming
* Gaming
* Productivity
* AI tools
* Custom workflows

---

## Macro & Action System

Trigger:

* keyboard shortcuts
* applications
* URLs
* shell commands
* media controls
* system actions

---

## Live Widgets

### Current Widgets

* CPU usage
* RAM usage
* clock
* volume control

### Planned Widgets

* media playback
* YouTube live previews
* Twitch integration
* Home Assistant
* OBS stats
* AI widgets
* homelab monitoring

---

## Electron Desktop Integration

Native desktop functionality:

* tray integration
* startup launch
* active window detection
* native notifications
* native process monitoring

---

# Screenshots

## Main Dashboard

*Add screenshot here later*

## Config UI

*Add screenshot here later*

---

# Tech Stack

## Frontend

* React
* Vite
* Electron
* WebSockets

## Backend

* Node.js
* Express
* SQLite

## Desktop Features

* Electron Tray
* Native Window Detection
* Process Monitoring

---

# Project Structure

```bash
echodeck/
├── client/
│   ├── src/
│   │   ├── App.jsx
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
│   │   ├── activeWindow.js
│   │   └── ruleEngine.js
│   │
│   ├── main.js
│   ├── macro-deck.db
│   └── package.json
│
└── README.md
```

---

# Auto Profile Switching

EchoDeck includes a production-grade rule engine.

## Supported Condition Types

```txt
process
window_title
executable_path
```

## Supported Operators

```txt
equals
contains
starts_with
ends_with
regex
not_equals
not_contains
exists
```

## Example Rule

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

### Result

```txt
Focus VS Code → Switch to Coding profile
```

---

# Running The Project

## Install Dependencies

### Client

```bash
cd client
npm install
```

### Host

```bash
cd host
npm install
```

---

# Start Development

## Start Frontend

```bash
cd client
npm run dev
```

## Start Host

```bash
cd host
node src/server.js
```

## Start Electron

```bash
cd host
npm start
```

---

# Build

## Client Build

```bash
cd client
npm run build
```

---

# Current Status

## Completed

* Real-time dashboard
* WebSocket syncing
* Dynamic pages/profiles
* Auto profile switching
* Rule engine
* SQLite persistence
* Electron tray integration
* Volume controls
* Active window detection
* Running app picker
* Delayed app capture
* Config UI

---

## In Progress

* Full Electron desktop UI
* Better dashboard layout
* Plugin architecture
* Widget system
* Advanced profile editor

---

## Planned

* Browser-aware profiles
* YouTube live widgets
* Twitch integration
* OBS integration
* AI integrations
* Mobile companion app
* Plugin marketplace
* Multi-device syncing

---

# Vision

EchoDeck is not just a Stream Deck clone.

The goal is to build:

* a smart desktop command center
* contextual workflow automation platform
* live widget system
* creator productivity hub
* homelab & AI control panel

combining ideas from:

* Stream Deck
* Raycast
* OBS
* Home Assistant
* BetterTouchTool
* desktop automation tools

into a unified experience.

---

# Future Ideas

## Smart Browser Profiles

```txt
youtube.com → Media profile
github.com → Coding profile
figma.com → Design profile
```

---

## AI-Powered Controls

* AI-generated workflows
* voice commands
* smart suggestions
* contextual actions

---

## Live Integrations

* Discord
* Spotify
* Twitch
* YouTube
* OBS
* Home Assistant
* MQTT
* OpenClaw ecosystem

---

# License

MIT License

---

# Author

Built by Hoss.
