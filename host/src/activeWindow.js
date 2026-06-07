// Uses active-win (native bindings, no PowerShell spawning) for the
// hot path (polled every 2s). listOpenWindows still uses PowerShell
// but is only called on-demand from the UI, so it's fine.

const path = require("path");
let _activeWin = null;

async function getActiveWin() {
  if (!_activeWin) {
    const mod = await import("active-win");
    _activeWin = mod.default;
  }
  return _activeWin;
}

async function getActiveWindow() {
  if (process.platform !== "win32") return null;
  try {
    const fn = await getActiveWin();
    const win = await fn();
    if (!win) return null;

    const executablePath = win.owner?.path ?? "";
    // Normalize process name to match PowerShell picker format: "name.exe"
    const rawName = win.owner?.name ?? "";
    const exeName = executablePath
      ? path.basename(executablePath) // e.g. "msedge.exe"
      : rawName.toLowerCase().endsWith(".exe")
        ? rawName
        : rawName + ".exe"; // fallback: append .exe if missing

    return {
      process: exeName,
      pid: win.owner?.processId ?? 0,
      windowTitle: win.title ?? "",
      executablePath,
      browserUrl: null,
    };
  } catch {
    return null;
  }
}

// listOpenWindows is on-demand only (user clicks "Select app") so
// PowerShell here is acceptable — it runs once, not on a timer.
const { execFile } = require("child_process");

function listOpenWindows() {
  if (process.platform !== "win32") return Promise.resolve([]);

  const script = `
Add-Type @"
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public class Win32List {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$items = New-Object System.Collections.Generic.List[object]
[Win32List]::EnumWindows({
  param([IntPtr]$hwnd, [IntPtr]$lparam)
  if (-not [Win32List]::IsWindowVisible($hwnd)) { return $true }
  $tb = New-Object System.Text.StringBuilder 1024
  [void][Win32List]::GetWindowText($hwnd, $tb, $tb.Capacity)
  $title = $tb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $pidValue = 0
  [void][Win32List]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
  try {
    $proc = Get-Process -Id $pidValue -ErrorAction Stop
    $items.Add([PSCustomObject]@{
      process = "$($proc.ProcessName).exe"
      pid = $pidValue
      windowTitle = $title
      executablePath = $proc.Path
      browserUrl = $null
    }) | Out-Null
  } catch {}
  return $true
}, [IntPtr]::Zero) | Out-Null
$items | Sort-Object process,windowTitle -Unique | ConvertTo-Json -Compress`.trim();

  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout?.trim()) return resolve([]);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

module.exports = { getActiveWindow, listOpenWindows };
