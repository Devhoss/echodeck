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
      cache = apps;
      cachedAt = Date.now();
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
 */
function primeApplicationCache() {
  listApplications().catch(() => {});
}

module.exports = {
  listApplications,
  applicationCacheAge,
  primeApplicationCache,
};
