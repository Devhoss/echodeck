const robot = require("robotjs");
const os = require("os");
const fs = require("fs");
const path = require("path");

const VOICEMEETER_REMOTE_REG_KEY =
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VB:Voicemeeter {17359A74-1236-5467}";

function hasVoicemeeterRemoteRegistry() {
  if (process.platform !== "win32") return false;
  try {
    const { execFileSync } = require("child_process");
    execFileSync("reg", [
      "query",
      VOICEMEETER_REMOTE_REG_KEY,
      "/v",
      "UninstallString",
    ]);
    return true;
  } catch {
    return false;
  }
}

// FEATURE: Volume controls — win-audio (Windows Core Audio fallback).
// Native addon: reads/writes happen in-process. The previous `loudness`
// package shelled out to a helper .exe per call, which piled up hundreds of
// processes during a volume hold and made read-modify-write non-atomic.
let speaker;
let mic;
try {
  ({ speaker, mic } = require("win-audio"));
} catch {
  console.warn(
    "⚠️  win-audio not installed — volume actions won't work. Run: npm install win-audio",
  );
}

// FEATURE: Volume controls — Voicemeeter API (primary when Voicemeeter is running)
// voicemeeter-connector talks directly to Voicemeeter's COM API
// If Voicemeeter is not installed/running, all calls gracefully fall back to win-audio
let voicemeeter;
let Voicemeeter;
let BusProperties;
let lastVoicemeeterError = "";
let voicemeeterInitPromise = null;
let voicemeeterDisabled = !hasVoicemeeterRemoteRegistry();
if (voicemeeterDisabled) {
  console.warn(
    "⚠️  VoiceMeeter not installed — using Windows volume fallback.",
  );
} else {
  try {
    voicemeeter = require("voicemeeter-connector");
    ({ Voicemeeter, BusProperties } = voicemeeter);
  } catch {
    voicemeeterDisabled = true;
    console.warn(
      "⚠️  voicemeeter-connector not installed — will use win-audio for volume. Run: npm install voicemeeter-connector",
    );
  }
}

// ---------------------------------------------------------------------------
// FEATURE: Volume controls — Voicemeeter volume/mute via its API
// Voicemeeter Bus[0] = A1 master output (what you hear)
// We control Bus[0].Gain (-60 to +12 dB, 0 = unity) and Bus[0].Mute
// ---------------------------------------------------------------------------

// Convert linear 0-100 volume to Voicemeeter gain dB
// 100% → 0 dB, 50% → -20 dB, 0% → -60 dB (mute)
function volumeToGain(vol) {
  if (vol <= 0) return -60;
  if (vol >= 100) return 0;
  // Simple linear mapping: 0→-60, 100→0
  return -60 + (vol / 100) * 60;
}

// Convert Voicemeeter gain dB back to 0-100 volume
function gainToVolume(gain) {
  if (gain <= -60) return 0;
  if (gain >= 0) return 100;
  return Math.round(((gain + 60) / 60) * 100);
}

// Run a Voicemeeter API operation safely — connects, runs fn, disconnects
// Returns null on any failure (Voicemeeter not running, API error, etc.)
async function getVoicemeeter() {
  if (!Voicemeeter || voicemeeterDisabled) return null;
  if (!voicemeeterInitPromise) {
    try {
      voicemeeterInitPromise = Promise.resolve(Voicemeeter.init()).catch(
        (e) => {
          const message = e?.message ?? String(e);
          voicemeeterInitPromise = null;
          if (isVoicemeeterInstallError(message)) {
            voicemeeterDisabled = true;
          }
          throw e;
        },
      );
    } catch (e) {
      const message = e?.message ?? String(e);
      voicemeeterInitPromise = null;
      if (isVoicemeeterInstallError(message)) {
        voicemeeterDisabled = true;
      }
      throw e;
    }
  }
  return voicemeeterInitPromise;
}

function isVoicemeeterInstallError(message) {
  return /registry key|registry value|UninstallString|not installed/i.test(
    message,
  );
}

async function withVoicemeeter(fn) {
  if (!Voicemeeter || voicemeeterDisabled) return null;
  try {
    const vm = await getVoicemeeter();
    if (!vm) return null;
    if (!vm.isConnected) vm.connect();
    const result = await fn(vm);
    return result;
  } catch (e) {
    const message = e?.message ?? String(e);
    if (message !== lastVoicemeeterError) {
      lastVoicemeeterError = message;
      console.warn("⚠️  VoiceMeeter API unavailable; falling back:", message);
    }
    if (isVoicemeeterInstallError(message)) {
      voicemeeterDisabled = true;
    }
    if (!message.includes("Duplicate type name")) {
      voicemeeterInitPromise = null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exported volume functions — Voicemeeter-first, win-audio fallback
// ---------------------------------------------------------------------------

async function getVolume() {
  const vol = await withVoicemeeter(async (vm) => {
    const gain = vm.getBusParameter(0, BusProperties.Gain);
    const muted = vm.getBusParameter(0, BusProperties.Mute);
    if (muted) return 0;
    return gainToVolume(gain);
  });
  if (vol !== null) return vol;

  // Fallback: win-audio (synchronous, no process spawn)
  if (!speaker) return null;
  try {
    return speaker.get();
  } catch {
    return null;
  }
}

async function getMuted() {
  const muted = await withVoicemeeter(async (vm) => {
    return !!vm.getBusParameter(0, BusProperties.Mute);
  });
  if (muted !== null) return muted;

  if (!speaker) return null;
  try {
    return speaker.isMuted();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FEATURE: Microphone controls
//
// Deliberately not routed through Voicemeeter: bus 0 is an output bus, so the
// Voicemeeter path above would move the wrong thing. The capture endpoint is
// always read and written directly.
// ---------------------------------------------------------------------------

function getMicVolume() {
  if (!mic) return null;
  try {
    return mic.get();
  } catch {
    return null;
  }
}

function getMicMuted() {
  if (!mic) return null;
  try {
    return mic.isMuted();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FEATURE: Audio device switching — Windows Core Audio via the echoaudio addon
//
// This previously drove a long-lived PowerShell process that imported the
// AudioDeviceCmdlets module. That module is a separate manual install, so the
// action failed outright on any machine without it — including this one. The
// helper also cost a process to supervise and a multi-second cold start on the
// first press. The addon runs in-process, so neither applies.
// ---------------------------------------------------------------------------

let nativeAudio = null;
try {
  nativeAudio = require("echoaudio");
  if (!nativeAudio.available) {
    console.warn(
      "⚠️  Native audio support did not load — device switching is disabled:",
      nativeAudio.loadError,
    );
  }
} catch (e) {
  console.warn(
    "⚠️  echoaudio addon is missing — device switching is disabled:",
    e.message,
  );
}

function nativeAudioReady() {
  return !!nativeAudio && nativeAudio.available;
}

// A device is usable if Windows can actually route to it right now. Devices in
// any other state stay in the list so a button configured for a headset that is
// currently off still shows its name, but they lose to a present device when
// resolving an ambiguous name.
function isPresent(device) {
  return device.state === "active";
}

// ---------------------------------------------------------------------------
// FEATURE: Audio device switching — list endpoints
// ---------------------------------------------------------------------------
async function getAudioDevices(direction = "output") {
  if (!nativeAudioReady()) return [];
  try {
    return nativeAudio.listDevices(direction === "input" ? "input" : "output");
  } catch (e) {
    console.warn("⚠️  Could not enumerate audio devices:", e.message);
    return [];
  }
}

// Buttons save the device *name*, not its id — that is what the property panel
// puts in the option value, and there are saved buttons in the wild already. So
// a name has to keep resolving, and it has to survive Windows appending or
// renumbering the interface part ("Speakers (2- Conexant)" today, "(3- ...)"
// after a reinstall). Present devices win, so an off headset never shadows a
// live one with a similar name.
function findDevice(devices, wanted) {
  if (!wanted) return null;
  const needle = String(wanted).trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();

  const byRank = (matches) =>
    matches.find(isPresent) ?? matches[0] ?? null;

  const exactId = devices.filter((d) => d.id === needle);
  if (exactId.length) return byRank(exactId);

  const exactName = devices.filter((d) => d.name.toLowerCase() === lower);
  if (exactName.length) return byRank(exactName);

  const partial = devices.filter(
    (d) =>
      d.name.toLowerCase().includes(lower) ||
      lower.includes(d.name.toLowerCase()),
  );
  return byRank(partial);
}

// ---------------------------------------------------------------------------
// FEATURE: Audio device switching — move the default endpoint
// ---------------------------------------------------------------------------
async function switchAudioDevice(wanted, direction = "output") {
  if (!wanted) return;
  if (!nativeAudioReady()) {
    console.error("⚠️  Audio switch failed: native audio support is unavailable.");
    return;
  }

  const flow = direction === "input" ? "input" : "output";

  try {
    const devices = nativeAudio.listDevices(flow);
    const match = findDevice(devices, wanted);

    if (!match) {
      console.error(`⚠️  Audio switch failed: no ${flow} device matching "${wanted}".`);
      return;
    }
    if (!isPresent(match)) {
      console.error(
        `⚠️  Audio switch failed: "${match.name}" is ${match.state}, not connected.`,
      );
      return;
    }

    nativeAudio.setDefaultDevice(match.id);
    console.log(`🔊 Switched ${flow} to: ${match.name}`);
  } catch (e) {
    console.error("⚠️  Audio switch failed:", e.message);
  }
}

// ---------------------------------------------------------------------------
// FEATURE: Soundboard — play audio on PC via ffplay + SDL device routing
// ---------------------------------------------------------------------------
async function playAudioOnDevice(dataUrl, deviceName) {
  if (!dataUrl) return;
  return new Promise((resolve) => {
    let ext = "mp3";
    try {
      const mime = dataUrl.split(";")[0].replace("data:", "");
      ext =
        {
          "audio/mpeg": "mp3",
          "audio/wav": "wav",
          "audio/ogg": "ogg",
          "audio/webm": "webm",
          "audio/mp4": "m4a",
          "audio/aac": "aac",
        }[mime] ?? "mp3";
    } catch {
      /* keep mp3 */
    }

    const tmpFile = path.join(
      os.tmpdir(),
      `streamdeck_sound_${Date.now()}.${ext}`,
    );
    const base64Data = dataUrl.split(",")[1];
    if (!base64Data) return resolve();

    try {
      fs.writeFileSync(tmpFile, Buffer.from(base64Data, "base64"));
    } catch (e) {
      console.error("Sound: failed to write temp file:", e.message);
      return resolve();
    }

    const { spawn } = require("child_process");
    const args = ["-nodisp", "-autoexit", "-loglevel", "quiet", tmpFile];
    const env = { ...process.env };
    if (deviceName?.trim()) {
      env.SDL_AUDIODRIVER = "directsound";
      env.AUDIODEV = deviceName.trim();
    }

    // The release build can bundle ffplay in resources/tools. The PATH fallback
    // keeps local development working, but logs a clear error if neither exists.
    const bundledFfplay = process.resourcesPath
      ? path.join(process.resourcesPath, "tools", "ffplay.exe")
      : path.join(__dirname, "..", "assets", "tools", "ffplay.exe");
    const ffplay = fs.existsSync(bundledFfplay) ? bundledFfplay : "ffplay";

    console.log(`🎵 Playing sound → ${deviceName || "system default"}`);
    const proc = spawn(ffplay, args, {
      env,
      detached: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorOutput = "";
    proc.stderr?.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    proc.on("error", (err) => {
      console.error(
        "Soundboard playback failed:",
        err.code === "ENOENT"
          ? "ffplay.exe is missing. Bundle it in resources/tools/ffplay.exe."
          : err.message,
      );
      resolve();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(
          "Soundboard playback failed:",
          errorOutput.trim() || `ffplay exited with code ${code}`,
        );
      }
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------
function executeAction(type, value) {
  return new Promise((resolve) => {
    if (type === "delay") {
      const duration = Math.max(0, Math.min(60_000, parseInt(value) || 1000));
      setTimeout(resolve, duration);
      return;
    }

    if (type === "audio_switch_device") {
      switchAudioDevice(value, "output")
        .then(resolve)
        .catch(() => resolve());
      return;
    }

    if (type === "mic_switch_device") {
      switchAudioDevice(value, "input")
        .then(resolve)
        .catch(() => resolve());
      return;
    }

    // FEATURE: Microphone controls — always direct, never via Voicemeeter
    if (type === "mic_mute") {
      if (mic) {
        try {
          mic.isMuted() ? mic.unmute() : mic.mute();
        } catch (e) {
          console.error("Mic mute failed:", e.message);
        }
      }
      return resolve();
    }

    if (type === "mic_volume_set") {
      const level = Math.max(0, Math.min(100, parseInt(value) || 50));
      if (mic) {
        try {
          mic.set(level);
        } catch (e) {
          console.error("Mic volume failed:", e.message);
        }
      }
      return resolve();
    }

    if (type === "mic_volume_up" || type === "mic_volume_down") {
      const step = Math.max(1, Math.min(20, parseInt(value) || 5));
      if (mic) {
        try {
          const current = mic.get();
          mic.set(
            type === "mic_volume_up"
              ? Math.min(100, current + step)
              : Math.max(0, current - step),
          );
        } catch (e) {
          console.error("Mic volume failed:", e.message);
        }
      }
      return resolve();
    }

    // FEATURE: Volume controls — Voicemeeter-first, win-audio fallback
    if (type === "volume_set") {
      const level = Math.max(0, Math.min(100, parseInt(value) || 50));
      withVoicemeeter(async (vm) => {
        await vm.setBusParameter(0, BusProperties.Gain, volumeToGain(level));
        if (level > 0) await vm.setBusParameter(0, BusProperties.Mute, 0);
        return true;
      }).then((ok) => {
        if (ok !== null) return resolve();
        // fallback to win-audio
        return speaker ? (speaker.set(level), resolve()) : resolve();
      });
      return;
    }

    if (type === "volume_up") {
      const step = Math.max(1, Math.min(20, parseInt(value) || 5));
      withVoicemeeter(async (vm) => {
        const gain = vm.getBusParameter(0, BusProperties.Gain);
        const current = gainToVolume(gain);
        await vm.setBusParameter(
          0,
          BusProperties.Gain,
          volumeToGain(Math.min(100, current + step)),
        );
        await vm.setBusParameter(0, BusProperties.Mute, 0);
        return true;
      }).then((ok) => {
        if (ok !== null) return resolve();
        return speaker
          ? (speaker.set(Math.min(100, speaker.get() + step)), resolve())
          : resolve();
      });
      return;
    }

    if (type === "volume_down") {
      const step = Math.max(1, Math.min(20, parseInt(value) || 5));
      withVoicemeeter(async (vm) => {
        const gain = vm.getBusParameter(0, BusProperties.Gain);
        const current = gainToVolume(gain);
        const next = Math.max(0, current - step);
        await vm.setBusParameter(0, BusProperties.Gain, volumeToGain(next));
        return true;
      }).then((ok) => {
        if (ok !== null) return resolve();
        return speaker
          ? (speaker.set(Math.max(0, speaker.get() - step)), resolve())
          : resolve();
      });
      return;
    }

    if (type === "volume_mute") {
      withVoicemeeter(async (vm) => {
        const muted = vm.getBusParameter(0, BusProperties.Mute);
        await vm.setBusParameter(0, BusProperties.Mute, muted ? 0 : 1);
        return true;
      }).then((ok) => {
        if (ok !== null) return resolve();
        return speaker
          ? (speaker.isMuted() ? speaker.unmute() : speaker.mute(), resolve())
          : resolve();
      });
      return;
    }

    // All other actions — robotjs with 100ms settle delay
    setTimeout(() => {
      try {
        switch (type) {
          case "type":
            robot.typeString(value);
            break;
          case "keystroke": {
            const parts = value.toLowerCase().split("+");
            const key = parts[parts.length - 1];
            const mods = parts.slice(0, -1).map((m) => {
              if (m === "ctrl") return "control";
              if (m === "cmd") return "command";
              return m;
            });
            robot.keyTap(key, mods.length ? mods : undefined);
            break;
          }
          case "shell": {
            const { exec } = require("child_process");
            exec(value, (err) => {
              if (err) console.error("Shell error:", err.message);
            });
            break;
          }
          case "url": {
            const { exec } = require("child_process");
            const cmd =
              process.platform === "win32"
                ? `start "" "${value}"`
                : process.platform === "darwin"
                  ? `open "${value}"`
                  : `xdg-open "${value}"`;
            exec(cmd);
            break;
          }
          case "launch": {
            const { spawn } = require("child_process");
            const child = spawn(
              "cmd.exe",
              ["/c", "start", "", value.replace(/^"|"$/g, "").trim()],
              {
                detached: true,
                stdio: "ignore",
              },
            );
            child.on("error", (err) =>
              console.error("Launch error:", err.message),
            );
            child.unref();
            break;
          }
          default:
            console.warn("Unknown action type:", type);
        }
      } catch (err) {
        console.error("Action error:", err.message);
      }
      resolve();
    }, 100);
  });
}

async function executeSequence(actions) {
  for (const step of actions) {
    await executeAction(step.action_type, step.action_value);
    if (step.delay_ms && step.delay_ms > 0)
      await new Promise((r) => setTimeout(r, step.delay_ms));
  }
}

module.exports = {
  executeAction,
  executeSequence,
  getVolume,
  getMuted,
  getMicVolume,
  getMicMuted,
  getAudioDevices,
  switchAudioDevice,
  playAudioOnDevice,
};
