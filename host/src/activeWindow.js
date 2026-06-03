const { execFile } = require("child_process");

function getActiveWindow() {
  if (process.platform !== "win32") {
    return Promise.resolve(null);
  }

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$hwnd = [Win32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }
$titleBuilder = New-Object System.Text.StringBuilder 1024
[void][Win32]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)
$pidValue = 0
[void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
try {
  $proc = Get-Process -Id $pidValue -ErrorAction Stop
  [PSCustomObject]@{
    process = "$($proc.ProcessName).exe"
    pid = $pidValue
    windowTitle = $titleBuilder.ToString()
    executablePath = $proc.Path
    browserUrl = $null
  } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{
    process = ""
    pid = $pidValue
    windowTitle = $titleBuilder.ToString()
    executablePath = ""
    browserUrl = $null
  } | ConvertTo-Json -Compress
}`.trim();

  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 2500 },
      (err, stdout) => {
        if (err || !stdout?.trim()) return resolve(null);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function listOpenWindows() {
  if (process.platform !== "win32") {
    return Promise.resolve([]);
  }

  const script = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Win32List {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$items = New-Object System.Collections.Generic.List[object]
[Win32List]::EnumWindows({
  param([IntPtr]$hwnd, [IntPtr]$lparam)
  if (-not [Win32List]::IsWindowVisible($hwnd)) { return $true }
  $titleBuilder = New-Object System.Text.StringBuilder 1024
  [void][Win32List]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)
  $title = $titleBuilder.ToString()
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
$items |
  Sort-Object process, windowTitle -Unique |
  ConvertTo-Json -Compress
`.trim();

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
