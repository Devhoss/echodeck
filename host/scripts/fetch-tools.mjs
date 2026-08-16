/**
 * fetch-tools.mjs — downloads the external binaries the installer bundles.
 *
 * Currently just ffplay, used to play soundboard audio when no Electron
 * renderer is connected (running `npm run dev` without the desktop app).
 * The binary is ~86MB, so it is fetched at build time rather than committed:
 * assets/tools is gitignored, and CI runs this before `npm run dist`.
 *
 * An LGPL build is used deliberately. ffplay is invoked as a separate process,
 * never linked into EchoDeck, but shipping it inside the same installer still
 * means redistributing it — LGPL keeps that straightforward. The licence file
 * is extracted alongside the binary so the release carries it.
 *
 * Usage:  node scripts/fetch-tools.mjs [--force]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(here, "..", "assets", "tools");
const ffplayPath = path.join(toolsDir, "ffplay.exe");

// Pinned rather than "latest" so a release is reproducible. The non-shared
// build is used so ffplay.exe is self-contained and needs no sidecar DLLs.
const RELEASE = "autobuild-2026-08-16-13-00";
const ARCHIVE = "ffmpeg-n8.1.2-44-g7c533d0f86-win64-lgpl-8.1.zip";
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE}/${ARCHIVE}`;

if (process.platform !== "win32") {
  console.log("fetch-tools: not Windows, nothing to do.");
  process.exit(0);
}

if (fs.existsSync(ffplayPath) && !process.argv.includes("--force")) {
  const mb = (fs.statSync(ffplayPath).size / 1024 / 1024).toFixed(1);
  console.log(`fetch-tools: ffplay.exe already present (${mb} MB), skipping.`);
  process.exit(0);
}

fs.mkdirSync(toolsDir, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "echodeck-tools-"));
const zipPath = path.join(tmp, "ffmpeg.zip");

try {
  console.log(`fetch-tools: downloading ${ARCHIVE} …`);
  const res = await fetch(URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${URL}`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  console.log("fetch-tools: extracting ffplay.exe …");
  // Windows 10+ ships bsdtar at System32\tar.exe, which understands drive
  // paths. Calling bare "tar" is not safe: under Git Bash it resolves to GNU
  // tar, which reads "C:\..." as a remote host and fails. Fall back to
  // Expand-Archive if System32 tar is somehow absent.
  const systemTar = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "tar.exe",
  );
  if (fs.existsSync(systemTar)) {
    execFileSync(systemTar, ["-xf", zipPath, "-C", tmp], { stdio: "inherit" });
  } else {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmp}' -Force`,
      ],
      { stdio: "inherit" },
    );
  }

  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "ffplay.exe" || entry.name === "LICENSE.txt")
        found.push(full);
    }
  };
  walk(tmp);

  const src = found.find((f) => f.endsWith("ffplay.exe"));
  if (!src) throw new Error("ffplay.exe not found in the archive");
  fs.copyFileSync(src, ffplayPath);

  const licence = found.find((f) => f.endsWith("LICENSE.txt"));
  if (licence)
    fs.copyFileSync(licence, path.join(toolsDir, "ffplay-LICENSE.txt"));

  const mb = (fs.statSync(ffplayPath).size / 1024 / 1024).toFixed(1);
  console.log(`fetch-tools: ffplay.exe ready (${mb} MB) at ${ffplayPath}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
