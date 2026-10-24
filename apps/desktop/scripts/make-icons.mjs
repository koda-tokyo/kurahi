// Regenerates the app and tray icons from the SVG sources in ../assets with the Tauri CLI
// (`npm run icons`). The app mark is the Kurahi "K" from docs/assets/kolo-mark.svg.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauri = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const icons = path.join(root, "src-tauri", "icons");

execFileSync(tauri, ["icon", path.join(root, "assets", "kurahi-mark.svg"), "-o", icons], { stdio: "inherit" });
// Mobile targets are out of scope for the desktop app.
for (const dir of ["android", "ios"]) {
  fs.rmSync(path.join(icons, dir), { recursive: true, force: true });
}
for (const state of ["green", "amber", "red"]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-tray-"));
  execFileSync(tauri, ["icon", path.join(root, "assets", `tray-${state}.svg`), "-o", tmp, "-p", "64"], { stdio: "inherit" });
  fs.copyFileSync(path.join(tmp, "64x64.png"), path.join(icons, `tray-${state}.png`));
  fs.rmSync(tmp, { recursive: true, force: true });
}
