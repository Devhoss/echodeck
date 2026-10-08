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

// The primary is pinned so a release is reproducible. BtbN prunes old daily
// builds, though, so a pin has a finite lifetime — the day it 404s, the whole
// installer build dies with it. The `latest` release keeps a stable asset name
// for exactly this reason, so it is the fallback rather than the primary: the
// pin still wins while it lives, and a rotten one degrades to "whatever ffmpeg
// master is current" instead of failing the build.
// The non-shared build is used so ffplay.exe is self-contained and needs no
// sidecar DLLs.
const PINNED_RELEASE = "autobuild-2026-08-16-13-00";
const PINNED_ARCHIVE = "ffmpeg-n8.1.2-44-g7c533d0f86-win64-lgpl-8.1.zip";
const LATEST_RELEASE = "latest";
const LATEST_ARCHIVE = "ffmpeg-master-latest-win64-lgpl.zip";
const SOURCES = [
  {
    archive: PINNED_ARCHIVE,
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${PINNED_RELEASE}/${PINNED_ARCHIVE}`,
  },
  {
    archive: LATEST_ARCHIVE,
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${LATEST_RELEASE}/${LATEST_ARCHIVE}`,
  },
];

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
  // Tried in order, so a pruned pin costs one wasted request rather than the
  // build. `redirect: "follow"` is required: these URLs bounce through
  // objects.githubusercontent.com.
  let source = null;
  let download = null;
  for (const candidate of SOURCES) {
    try {
      const res = await fetch(candidate.url, { redirect: "follow" });
      if (res.ok) {
        source = candidate;
        download = res;
        break;
      }
      console.warn(
        `fetch-tools: ${candidate.archive} unavailable (HTTP ${res.status})`,
      );
    } catch (e) {
      console.warn(`fetch-tools: ${candidate.archive} failed — ${e.message}`);
    }
  }
  if (!source)
    throw new Error(
      `no ffmpeg source reachable (tried ${SOURCES.map((s) => s.archive).join(", ")})`,
    );

  console.log(`fetch-tools: downloading ${source.archive} …`);
  fs.writeFileSync(zipPath, Buffer.from(await download.arrayBuffer()));

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
