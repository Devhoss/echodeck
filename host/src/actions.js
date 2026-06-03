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

// FEATURE: Volume controls — loudness (Windows Core Audio fallback)
let loudness;
try {
  loudness = require("loudness");
} catch {
  console.warn(
    "⚠️  loudness not installed — volume actions won't work. Run: npm install loudness",
  );
}

// FEATURE: Volume controls — Voicemeeter API (primary when Voicemeeter is running)
// voicemeeter-connector talks directly to Voicemeeter's COM API
// If Voicemeeter is not installed/running, all calls gracefully fall back to loudness
let voicemeeter;
let Voicemeeter;
let BusProperties;
let lastVoicemeeterError = "";
let voicemeeterInitPromise = null;
let voicemeeterDisabled = !hasVoicemeeterRemoteRegistry();
if (voicemeeterDisabled) {
  console.warn("⚠️  VoiceMeeter not installed — using Windows volume fallback.");
} else {
  try {
    voicemeeter = require("voicemeeter-connector");
    ({ Voicemeeter, BusProperties } = voicemeeter);
  } catch {
    voicemeeterDisabled = true;
    console.warn(
      "⚠️  voicemeeter-connector not installed — will use loudness for volume. Run: npm install voicemeeter-connector",
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
// Exported volume functions — Voicemeeter-first, loudness fallback
// ---------------------------------------------------------------------------

async function getVolume() {
  // Try Voicemeeter first
  const vol = await withVoicemeeter(async (vm) => {
    // Bus[0] is the A1 master bus
    const gain = vm.getBusParameter(0, BusProperties.Gain);
    const muted = vm.getBusParameter(0, BusProperties.Mute);
    if (muted) return 0;
    return gainToVolume(gain);
  });
  if (vol !== null) return vol;

  // Fallback: loudness (Windows Core Audio)
  if (!loudness) return null;
  try {
    return await loudness.getVolume();
  } catch {
    return null;
  }
}

async function getMuted() {
  // Try Voicemeeter first
  const muted = await withVoicemeeter(async (vm) => {
    return !!vm.getBusParameter(0, BusProperties.Mute);
  });
  if (muted !== null) return muted;

  // Fallback: loudness
  if (!loudness) return null;
  try {
    return await loudness.getMuted();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function getNircmdPath() {
  const candidates = [
    path.join(__dirname, "nircmd.exe"),
    path.join(path.dirname(process.execPath), "nircmd.exe"),
    path.join(path.dirname(process.execPath), "resources", "nircmd.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return `"${c}"`;
  }
  return "nircmd";
}

function psImportBlock() {
  return `
$_paths = @(
  (Join-Path $env:USERPROFILE "Documents\\WindowsPowerShell\\Modules\\AudioDeviceCmdlets"),
  (Join-Path $env:USERPROFILE "Documents\\PowerShell\\Modules\\AudioDeviceCmdlets"),
  (Join-Path $env:ProgramFiles "WindowsPowerShell\\Modules\\AudioDeviceCmdlets"),
  (Join-Path $env:ProgramFiles "PowerShell\\Modules\\AudioDeviceCmdlets")
)
$_loaded = $false
foreach ($_p in $_paths) {
  if (Test-Path $_p) {
    try { Import-Module $_p -ErrorAction Stop; $_loaded = $true; break } catch {}
  }
}
if (-not $_loaded) {
  try { Import-Module AudioDeviceCmdlets -ErrorAction Stop; $_loaded = $true } catch {}
}
if (-not $_loaded) { Write-Output "ERROR:AudioDeviceCmdlets not found"; exit 1 }`.trim();
}

function writeTempScript(name, content) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

let audioSwitchHelper = null;
let audioSwitchHelperReady = null;
let audioSwitchBuffer = "";
let audioSwitchSeq = 0;
const audioSwitchPending = new Map();
let audioSwitchQueue = Promise.resolve();

function resetAudioSwitchHelper(err) {
  if (audioSwitchHelper) {
    audioSwitchHelper.removeAllListeners();
    audioSwitchHelper.stdout?.removeAllListeners();
    audioSwitchHelper.stderr?.removeAllListeners();
    try {
      audioSwitchHelper.kill();
    } catch {
      /* ignore */
    }
  }
  audioSwitchHelper = null;
  audioSwitchHelperReady = null;
  audioSwitchBuffer = "";

  for (const pending of audioSwitchPending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({
      ok: false,
      message: err?.message ?? "audio switch helper stopped",
    });
  }
  audioSwitchPending.clear();
}

function handleAudioSwitchLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed === "READY") return;

  const [id, status, ...rest] = trimmed.split("|");
  const pending = audioSwitchPending.get(id);
  if (!pending) return;

  audioSwitchPending.delete(id);
  clearTimeout(pending.timer);
  pending.resolve({
    ok: status === "OK",
    message: rest.join("|"),
  });
}

async function getAudioSwitchHelper() {
  if (audioSwitchHelperReady) {
    await audioSwitchHelperReady;
    return audioSwitchHelper;
  }
  if (audioSwitchHelper && !audioSwitchHelper.killed) return audioSwitchHelper;

  audioSwitchHelperReady = new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const script = `
${psImportBlock()}
Get-AudioDevice -List | Where-Object { $_.Type -eq "Playback" } | Out-Null
[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $sep = $line.IndexOf("|")
    if ($sep -lt 1) { continue }
    $id = $line.Substring(0, $sep)
    $payload = $line.Substring($sep + 1)
    $bytes = [Convert]::FromBase64String($payload)
    $deviceName = [Text.Encoding]::UTF8.GetString($bytes)
    $devs = Get-AudioDevice -List | Where-Object { $_.Type -eq "Playback" }
    $dev = $devs | Where-Object { $_.Name -eq $deviceName } | Select-Object -First 1
    if ($null -eq $dev) {
      $dev = $devs | Where-Object { $_.Name -like "*$deviceName*" } | Select-Object -First 1
    }
    if ($null -eq $dev) {
      [Console]::Out.WriteLine("$id|FAIL|device not found: $deviceName")
      [Console]::Out.Flush()
      continue
    }
    Set-AudioDevice -Index $dev.Index | Out-Null
    Start-Sleep -Milliseconds 80
    $current = Get-AudioDevice -Playback
    if ($current.Name -like "*$($dev.Name)*" -or $dev.Name -like "*$($current.Name)*") {
      [Console]::Out.WriteLine("$id|OK|$($current.Name)")
      [Console]::Out.Flush()
    } else {
      [Console]::Out.WriteLine("$id|FAIL|default is still $($current.Name)")
      [Console]::Out.Flush()
    }
  } catch {
    [Console]::Out.WriteLine("$id|FAIL|$($_.Exception.Message)")
    [Console]::Out.Flush()
  }
}`.trim();

    let scriptPath;
    try {
      scriptPath = writeTempScript(
        "streamdeck_audio_switch_helper.ps1",
        script,
      );
    } catch (e) {
      audioSwitchHelperReady = null;
      reject(e);
      return;
    }

    audioSwitchHelper = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const startupTimer = setTimeout(() => {
      const err = new Error("audio switch helper startup timed out");
      resetAudioSwitchHelper(err);
      reject(err);
    }, 20000);

    audioSwitchHelper.stdout.on("data", (chunk) => {
      audioSwitchBuffer += chunk.toString();
      const lines = audioSwitchBuffer.split(/\r?\n/);
      audioSwitchBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "READY") {
          clearTimeout(startupTimer);
          resolve();
        } else {
          handleAudioSwitchLine(line);
        }
      }
    });

    audioSwitchHelper.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) console.warn("Audio switch helper:", message);
    });

    audioSwitchHelper.on("error", (e) => {
      clearTimeout(startupTimer);
      resetAudioSwitchHelper(e);
      reject(e);
    });

    audioSwitchHelper.on("exit", () => {
      clearTimeout(startupTimer);
      resetAudioSwitchHelper();
    });
  });

  await audioSwitchHelperReady;
  return audioSwitchHelper;
}

async function switchAudioDeviceFast(deviceName) {
  const helper = await getAudioSwitchHelper();
  const id = String(++audioSwitchSeq);
  const encoded = Buffer.from(deviceName, "utf8").toString("base64");

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      audioSwitchPending.delete(id);
      resetAudioSwitchHelper(
        new Error("audio switch helper request timed out"),
      );
      resolve({ ok: false, message: "request timed out" });
    }, 15000);

    audioSwitchPending.set(id, { resolve, timer });
    helper.stdin.write(`${id}|${encoded}\n`);
  });
}

if (process.platform === "win32") {
  const audioSwitchWarmup = setTimeout(() => {
    getAudioSwitchHelper().catch((e) => {
      console.warn("⚠️  Audio switch helper unavailable:", e.message);
    });
  }, 500);
  audioSwitchWarmup.unref?.();
}

// ---------------------------------------------------------------------------
// FEATURE: Audio output switching — list Windows playback devices
// ---------------------------------------------------------------------------
async function getAudioDevices() {
  return new Promise((resolve) => {
    const { exec } = require("child_process");
    const script = `
${psImportBlock()}
try {
  $devs = Get-AudioDevice -List | Where-Object { $_.Type -eq 'Playback' }
  $devs | ForEach-Object { "$($_.Index)|$($_.Name)|$($_.Default)" }
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
}`.trim();

    let scriptPath;
    try {
      scriptPath = writeTempScript("streamdeck_devices.ps1", script);
    } catch (e) {
      console.warn("⚠️  Could not write PS1:", e.message);
      return resolve([]);
    }

    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      (err, stdout) => {
        const out = stdout?.trim() ?? "";
        if (err || out.startsWith("ERROR")) {
          console.warn(
            "⚠️  Could not enumerate audio devices:",
            err?.message ?? out,
          );
          return resolve([]);
        }
        const devices = out
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [index, name, isDefault] = line.split("|");
            return {
              id: index?.trim(),
              name: name?.trim() ?? "Unknown",
              isDefault: isDefault?.trim() === "True",
            };
          })
          .filter((d) => d.name);
        resolve(devices);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// FEATURE: Audio output switching — switch default Windows playback device
// ---------------------------------------------------------------------------
async function switchAudioDevice(deviceName) {
  if (!deviceName) return;

  audioSwitchQueue = audioSwitchQueue
    .catch(() => {
      /* keep the queue alive after a failed switch */
    })
    .then(() => switchAudioDeviceQueued(deviceName));

  return audioSwitchQueue;
}

async function switchAudioDeviceQueued(deviceName) {
  try {
    const result = await switchAudioDeviceFast(deviceName);
    if (result.ok) {
      console.log(`🔊 Switched audio output to: ${result.message} (helper)`);
      return;
    }
    console.warn("⚠️  Fast audio switch failed:", result.message);
  } catch (e) {
    console.warn("⚠️  Fast audio switch unavailable:", e.message);
  }

  await switchAudioDeviceWithPowerShell(deviceName);
}

function switchAudioDeviceWithPowerShell(deviceName) {
  return new Promise((resolve) => {
    const { exec } = require("child_process");
    const safe = deviceName.replace(/'/g, "").replace(/"/g, "");
    const script = `
${psImportBlock()}
try {
  $devs = Get-AudioDevice -List | Where-Object { $_.Type -eq 'Playback' }
  $dev = $devs | Where-Object { $_.Name -eq '${safe}' } | Select-Object -First 1
  if ($null -eq $dev) {
    $dev = $devs | Where-Object { $_.Name -like '*${safe}*' } | Select-Object -First 1
  }
  if ($null -eq $dev) { Write-Output "FAIL:device not found: ${safe}"; exit 1 }
  Set-AudioDevice -Index $dev.Index | Out-Null
  Start-Sleep -Milliseconds 150
  $current = Get-AudioDevice -Playback
  if ($current.Name -like "*$($dev.Name)*" -or $dev.Name -like "*$($current.Name)*") {
    Write-Output "OK:$($current.Name)"
  } else {
    Write-Output "FAIL:default is still $($current.Name)"
    exit 1
  }
} catch {
  Write-Output "FAIL:$($_.Exception.Message)"
}`.trim();

    let scriptPath;
    try {
      scriptPath = writeTempScript("streamdeck_switch.ps1", script);
    } catch {
      return resolve();
    }

    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      (err, stdout) => {
        const out = stdout?.trim() ?? "";
        if (!err && out.startsWith("OK:")) {
          console.log(`🔊 Switched audio output to: ${out.slice(3)} (PS)`);
          return resolve();
        }
        console.error("⚠️  Audio switch failed.", out || err?.message);
        resolve();
      },
    );
  });
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

    console.log(`🎵 Playing sound → ${deviceName || "system default"}`);
    const proc = spawn("ffplay", args, {
      env,
      detached: false,
      stdio: "ignore",
    });
    proc.on("error", (err) => {
      console.error("ffplay error:", err.message);
      resolve();
    });
    proc.on("close", () => {
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
    if (type === "audio_switch_device") {
      switchAudioDevice(value)
        .then(resolve)
        .catch(() => resolve());
      return;
    }

    // FEATURE: Volume controls — Voicemeeter-first, loudness fallback
    if (type === "volume_set") {
      const level = Math.max(0, Math.min(100, parseInt(value) || 50));
      withVoicemeeter(async (vm) => {
        await vm.setBusParameter(0, BusProperties.Gain, volumeToGain(level));
        if (level > 0) await vm.setBusParameter(0, BusProperties.Mute, 0);
        return true;
      }).then((ok) => {
        if (ok !== null) return resolve();
        // fallback to loudness
        return (
          loudness
            ?.setVolume(level)
            .then(resolve)
            .catch(() => resolve()) ?? resolve()
        );
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
        return (
          loudness
            ?.getVolume()
            .then((v) => loudness.setVolume(Math.min(100, v + step)))
            .then(resolve)
            .catch(() => resolve()) ?? resolve()
        );
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
        return (
          loudness
            ?.getVolume()
            .then((v) => loudness.setVolume(Math.max(0, v - step)))
            .then(resolve)
            .catch(() => resolve()) ?? resolve()
        );
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
        return (
          loudness
            ?.getMuted()
            .then((m) => loudness.setMuted(!m))
            .then(resolve)
            .catch(() => resolve()) ?? resolve()
        );
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
    if (step.delay_ms && step.delay_ms > 0)
      await new Promise((r) => setTimeout(r, step.delay_ms));
    await executeAction(step.action_type, step.action_value);
  }
}

module.exports = {
  executeAction,
  executeSequence,
  getVolume,
  getMuted,
  getAudioDevices,
  switchAudioDevice,
  playAudioOnDevice,
};
