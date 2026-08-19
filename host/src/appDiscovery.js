/**
 * FEATURE: Launch App — discovering installed Windows applications.
 *
 * Windows already keeps a register of everything launchable: the Applications
 * shell folder, `shell:AppsFolder` (FOLDERID_AppsFolder). It is the same list
 * the Start menu's "All apps" is built from, and it unifies three kinds of
 * entry that would otherwise have to be gathered separately — Start menu
 * shortcuts, App Paths registrations, and packaged MSIX apps.
 *
 * That is why this does not walk Program Files looking for .exe files: that
 * approach finds uninstallers, crash handlers and bundled tools, misses every
 * Store app, and has no idea what anything is called.
 *
 * Each entry carries an identifier which is *not* uniformly an AUMID. On a real
 * machine the shapes are roughly:
 *
 *   packaged   Microsoft.WindowsCalculator_8wekyb3d8bbwe!App
 *   file path  C:\Python314\python.exe
 *   progID     ai.elementlabs.lmstudio
 *
 * All three launch the same way, so the identifier is stored verbatim rather
 * than parsed into a union — see launchApplication below.
 */
const { execFile } = require("child_process");

// A unit separator: legal in neither a file path nor an application name, so
// splitting on it cannot be fooled by a name containing a tab or a pipe.
const SEP = "\u001f";

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
# Without this, stdout is written in the console's OEM codepage and every
# non-ASCII application name arrives as question marks.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace('shell:AppsFolder')
foreach ($item in $folder.Items()) {
  $name = $item.Name
  $id = $item.Path
  if ($name -and $id) { Write-Output ($name + '${SEP}' + $id) }
}
`;

// Enumeration costs 2-3 seconds, which is far too slow to run when a picker
// opens. It is cached instead and refreshed on request: installing an app is
// rare, and the list is only a few hundred entries.
let cache = null;
let cachedAt = 0;
let inFlight = null;

function runDiscovery() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);

    // -EncodedCommand takes UTF-16LE base64, which sidesteps quoting entirely.
    // The script contains quotes and backslashes, and passing it as a plain
    // argument means one of them eventually lands wrong.
    const encoded = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");

    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          console.warn("⚠️  Could not enumerate applications:", err.message);
          return resolve([]);
        }

        const seen = new Set();
        const apps = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const cut = line.indexOf(SEP);
          if (cut < 1) continue;
          const name = line.slice(0, cut).trim();
          const id = line.slice(cut + 1).trim();
          if (!name || !id || seen.has(id)) continue;
          seen.add(id);

          apps.push({
            id,
            name,
            // Packaged apps are the ones that cannot be launched by path, so
            // the distinction is worth surfacing even though launching does
            // not branch on it.
            packaged: id.includes("!"),
            path: /^[a-zA-Z]:\\/.test(id) ? id : null,
          });
        }

        apps.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
        resolve(apps);
      },
    );
  });
}

async function listApplications({ refresh = false } = {}) {
  if (!refresh && cache) return cache;
  // Concurrent callers share one enumeration rather than each paying 3 seconds.
  if (!inFlight) {
    inFlight = runDiscovery().then((apps) => {
      // A real Windows machine never has zero launchable applications, so an
      // empty result means the enumeration failed rather than that the list
      // is genuinely empty. Leaving `cache` unset lets the next call retry
      // instead of an early failure (e.g. antivirus scanning the freshly
      // spawned powershell.exe on a cold app launch) permanently poisoning
      // the picker until someone notices and hits Rescan.
      if (apps.length) {
        cache = apps;
        cachedAt = Date.now();
      }
      inFlight = null;
      return apps;
    });
  }
  return inFlight;
}

function applicationCacheAge() {
  return cache ? Date.now() - cachedAt : null;
}

/**
 * Warms the cache in the background so the first picker open is instant.
 * Deliberately not awaited by the caller: a slow enumeration must never delay
 * the host coming up.
 *
 * Retries on failure: the very first PowerShell spawn of a session is the one
 * most likely to lose a race with antivirus scanning the freshly-launched
 * powershell.exe, which previously left the picker silently empty until
 * someone thought to hit Rescan. A cold Electron launch can afford a couple
 * of seconds of patience here since nothing is blocked on it.
 */
function primeApplicationCache(attempt = 1) {
  listApplications()
    .then((apps) => {
      if (!apps.length && attempt < 3) {
        setTimeout(() => primeApplicationCache(attempt + 1), 2000);
      }
    })
    .catch(() => {});
}



// ---------------------------------------------------------------------------
// FEATURE: Launch App — application icons
//
// IShellItemImageFactory is the only thing that resolves an icon for all three
// identifier shapes, because it asks the shell exactly what Explorer asks. It
// is reachable by P/Invoke, so this needs no second native addon.
//
// Extraction measures ~120ms per icon, so all 238 would cost close to half a
// minute: far too slow to do eagerly, and pointless when a picker shows thirty
// rows. Icons are fetched for what is on screen, in one batch, and cached — so
// scrolling and searching get cheaper as they go.
// ---------------------------------------------------------------------------

const ICON_SIZE = 64;
const iconCache = new Map();

const ICON_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Drawing;using System.Drawing.Imaging;using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
[StructLayout(LayoutKind.Sequential)] public struct BITMAP {
  public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes;
  public ushort bmPlanes; public ushort bmBitsPixel; public IntPtr bmBits; }
[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItemImageFactory { void GetImage(SIZE size, int flags, out IntPtr phbm); }
public static class ShellIcon {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string p, IntPtr b,
    [MarshalAs(UnmanagedType.LPStruct)] Guid r, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory v);
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int c, out BITMAP pv);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  public static string ToBase64Png(string name, int size) {
    IShellItemImageFactory f;
    SHCreateItemFromParsingName(name, IntPtr.Zero, new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), out f);
    IntPtr hb; SIZE s; s.cx=size; s.cy=size;
    f.GetImage(s, 0x4, out hb);
    Marshal.ReleaseComObject(f);
    try {
      BITMAP i; GetObject(hb, Marshal.SizeOf(typeof(BITMAP)), out i);
      // GetImage returns a 32bpp premultiplied DIB. Bitmap.FromHbitmap would
      // discard the alpha and leave every icon on a black square, so the bits
      // are wrapped directly.
      using (var src = new Bitmap(i.bmWidth, i.bmHeight, i.bmWidthBytes, PixelFormat.Format32bppPArgb, i.bmBits))
      using (var copy = new Bitmap(src))
      using (var ms = new System.IO.MemoryStream()) { copy.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); }
    } finally { DeleteObject(hb); }
  }
}
'@ -ReferencedAssemblies System.Drawing

# Identifiers arrive on stdin, one per line: they contain backslashes, braces and
# exclamation marks, so embedding them in the script would need escaping that is
# easy to get wrong and impossible to get safe.
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id = $line.Trim()
  if (-not $id) { continue }
  try {
    # The separator is built from its character code rather than written as a
    # backslash. This script is a JavaScript template literal, where \$ is an
    # escape for a literal dollar — so a written backslash is swallowed and
    # PowerShell receives "shell:AppsFolder$id", which resolves to nothing.
    $b64 = [ShellIcon]::ToBase64Png('shell:AppsFolder' + [char]92 + $id, ${ICON_SIZE})
    Write-Output ($id + '${SEP}' + $b64)
  } catch {
    Write-Output ($id + '${SEP}')
  }
}
`;

function extractIcons(ids) {
  return new Promise((resolve) => {
    if (process.platform !== "win32" || ids.length === 0) return resolve({});

    const encoded = Buffer.from(ICON_SCRIPT, "utf16le").toString("base64");
    const child = execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 60_000 },
      (err, stdout) => {
        if (err) {
          console.warn("⚠️  Could not extract application icons:", err.message);
          return resolve({});
        }
        const out = {};
        for (const line of String(stdout).split(/\r?\n/)) {
          const cut = line.indexOf(SEP);
          if (cut < 1) continue;
          const id = line.slice(0, cut).trim();
          const b64 = line.slice(cut + 1).trim();
          // An empty payload means the shell had no icon for it. Cached as null
          // so a second request does not pay the extraction cost again.
          out[id] = b64 ? `data:image/png;base64,${b64}` : null;
        }
        resolve(out);
      },
    );

    child.stdin.end(ids.join("\n") + "\n");
  });
}

async function getApplicationIcons(ids) {
  const wanted = [...new Set(ids)].filter((id) => typeof id === "string" && id);
  const missing = wanted.filter((id) => !iconCache.has(id));

  if (missing.length) {
    const fresh = await extractIcons(missing);
    for (const id of missing) iconCache.set(id, fresh[id] ?? null);
  }

  const result = {};
  for (const id of wanted) {
    const icon = iconCache.get(id);
    if (icon) result[id] = icon;
  }
  return result;
}

module.exports = {
  listApplications,
  applicationCacheAge,
  primeApplicationCache,
  getApplicationIcons,
};
