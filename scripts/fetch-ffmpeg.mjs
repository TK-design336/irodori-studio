/**
 * Download Windows ffmpeg essentials (ffmpeg.exe + ffprobe.exe) into vendor/ffmpeg/.
 * Skips if binaries already exist. Non-Windows platforms skip (no PATH fallback).
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destDir = path.join(root, "vendor", "ffmpeg");
const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffprobeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
const ffmpegDest = path.join(destDir, ffmpegName);
const ffprobeDest = path.join(destDir, ffprobeName);

if (process.platform !== "win32") {
  if (!existsSync(ffmpegDest)) {
    console.warn(
      "[fetch-ffmpeg] Windows essentials only. Place ffmpeg/ffprobe in vendor/ffmpeg/ for this OS.",
    );
  }
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

if (existsSync(ffmpegDest) && existsSync(ffprobeDest)) {
  console.log("[fetch-ffmpeg] already present:", destDir);
  process.exit(0);
}

const url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const zipPath = path.join(destDir, "ffmpeg-release-essentials.zip");
const extractDir = path.join(destDir, "_extract");

console.log("[fetch-ffmpeg] downloading", url);
const res = await fetch(url, {
  redirect: "follow",
  headers: { "User-Agent": "irodori-studio-fetch-ffmpeg" },
});
if (!res.ok || !res.body) {
  console.error("[fetch-ffmpeg] download failed:", res.status, res.statusText);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));

rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });

const ps = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
  ],
  { stdio: "inherit" },
);
if (ps.status !== 0) {
  console.error("[fetch-ffmpeg] unzip failed");
  process.exit(1);
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

const ff = findFile(extractDir, "ffmpeg.exe");
const fp = findFile(extractDir, "ffprobe.exe");
if (!ff || !fp) {
  console.error("[fetch-ffmpeg] ffmpeg.exe / ffprobe.exe not found in archive");
  process.exit(1);
}

copyFileSync(ff, ffmpegDest);
copyFileSync(fp, ffprobeDest);

const lic =
  findFile(extractDir, "LICENSE") || findFile(extractDir, "LICENSE.txt");
if (lic) {
  copyFileSync(lic, path.join(destDir, "FFMPEG_BUILD_LICENSE.txt"));
}

rmSync(extractDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
writeFileSync(path.join(destDir, ".fetched"), new Date().toISOString());
console.log("[fetch-ffmpeg] installed", ffmpegDest, "and", ffprobeDest);
