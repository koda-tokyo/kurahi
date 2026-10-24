#!/usr/bin/env node
// pack-check: prove the npm package installs and starts on a machine that has never seen this
// repository. Packs the CLI and the @kodasoken/kurahi-client workspace package, installs both tarballs into
// an empty directory with npm (not pnpm: no workspace links, no overrides), then runs the
// installed binary with a fresh KOLO_HOME:
//   kurahi --version      -> exactly the package version on stdout, exit 0
//   kurahi --help         -> exit 0
//   kurahi doctor --json  -> exit 0, parses, reports the fresh home
// Run after `pnpm build`. Use --keep to leave the temp directory for inspection.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packAll } from "./npm-pack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function fail(msg) {
  console.error(`pack-check: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  return { code: res.status ?? -1, out: res.stdout ?? "", err: res.stderr ?? "" };
}

if (!fs.existsSync(path.join(ROOT, "dist", "entry.js"))) {
  fail("dist/entry.js missing; run `pnpm build` first");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-pack-check-"));
const tarballs = path.join(tmp, "tarballs");
const app = path.join(tmp, "app");
const home = path.join(tmp, "home");
fs.mkdirSync(tarballs, { recursive: true });
fs.mkdirSync(app, { recursive: true });
fs.mkdirSync(home, { recursive: true });

const cleanup = () => {
  if (keep) {
    console.log(`pack-check: kept ${tmp}`);
    return;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
};
process.on("exit", cleanup);

const t0 = Date.now();
let clientTarball;
let cliTarball;
try {
  [clientTarball, cliTarball] = packAll(tarballs);
} catch (err) {
  fail(`npm pack failed: ${String(err?.stderr ?? err).slice(-2000)}`);
}
console.log(
  `pack-check: packed ${path.basename(cliTarball)} (${(fs.statSync(cliTarball).size / 1e6).toFixed(1)} MB) and ${path.basename(clientTarball)}`,
);

fs.writeFileSync(
  path.join(app, "package.json"),
  JSON.stringify({ name: "kolo-pack-check", private: true, version: "0.0.0" }, null, 2),
);
const install = run(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--omit=dev",
    clientTarball,
    cliTarball,
  ],
  { cwd: app, env: { CI: "1" } },
);
if (install.code !== 0) {
  fail(`npm install of the tarball failed (exit ${install.code}):\n${install.err.slice(-4000)}`);
}
console.log(`pack-check: installed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const bin = path.join(
  app,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "kolo.cmd" : "kolo",
);
if (!fs.existsSync(bin)) {
  fail(`installed package has no kurahi binary at ${bin}`);
}
const env = {
  KOLO_HOME: home,
  KOLO_CONFIG_PATH: path.join(home, "kolo.json"),
  NO_COLOR: "1",
  CI: "1",
  KOLO_DISABLE_UPDATE_CHECK: "1",
};

const version = run(bin, ["--version"], { cwd: app, env });
if (version.code !== 0) {
  fail(`kolo --version exit ${version.code}:\n${version.err.slice(-2000)}`);
}
const versionLines = version.out.trim().split(/\r?\n/);
if (versionLines.length !== 1 || versionLines[0] !== pkg.version) {
  fail(`kolo --version printed ${JSON.stringify(version.out)}; want exactly "${pkg.version}"`);
}
if (version.err.trim()) {
  fail(`kolo --version wrote to stderr:\n${version.err.slice(-1000)}`);
}

const help = run(bin, ["--help"], { cwd: app, env });
if (help.code !== 0 || !/Usage:/.test(help.out)) {
  fail(`kolo --help exit ${help.code}:\n${(help.out + help.err).slice(-2000)}`);
}

const doctor = run(bin, ["doctor", "--json"], { cwd: app, env });
if (doctor.code !== 0) {
  fail(`kolo doctor --json exit ${doctor.code}:\n${(doctor.out + doctor.err).slice(-3000)}`);
}
let report;
try {
  report = JSON.parse(doctor.out);
} catch {
  fail(`kolo doctor --json is not JSON:\n${doctor.out.slice(0, 1000)}`);
}
if (report.version !== pkg.version || path.resolve(report.koloHome) !== path.resolve(home)) {
  fail(
    `doctor report mismatch: ${JSON.stringify({ version: report.version, koloHome: report.koloHome })}`,
  );
}
if (!Array.isArray(report.checks) || report.checks.some((c) => c.level === "error")) {
  fail(`doctor reports errors on a fresh install: ${JSON.stringify(report.checks)}`);
}

const unknown = run(bin, ["no-such-command"], { cwd: app, env });
if (unknown.code === 0) {
  fail("kolo no-such-command exited 0");
}

console.log(
  `PACK-CHECK PASS version=${pkg.version} install=${((Date.now() - t0) / 1000).toFixed(0)}s --version ok, --help ok, doctor --json ok (${report.checks.length} checks), unknown command exit ${unknown.code}`,
);
