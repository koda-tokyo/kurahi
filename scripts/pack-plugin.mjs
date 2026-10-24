#!/usr/bin/env node
// Pack one bundled extension as a separately installable plugin archive.
//
//   node scripts/pack-plugin.mjs <extension> [--out <dir>] [--name <npm name>]
//
// For extensions that are kept out of the default package (see `files` in package.json and
// OMIT_EXTENSIONS in scripts/bundle.mjs), e.g. whatsapp, whose libsignal dependency is GPL-3.0.
// The archive holds the extension sources and its manifest with the workspace-only
// devDependencies removed; `kurahi plugins install <archive>` copies it into
// <KOLO_HOME>/extensions/<id>/ and runs `npm install --omit=dev` there for its dependencies.
// Output: <out>/kurahi-<extension>-<version>.tgz and a .sha256 next to it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const name = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!name) {
  console.error("usage: pack-plugin.mjs <extension> [--out <dir>] [--name <npm name>]");
  process.exit(2);
}
const src = path.join(ROOT, "extensions", name);
if (!fs.existsSync(path.join(src, "package.json"))) {
  console.error(`pack-plugin: no extension ${name}`);
  process.exit(2);
}
const out = path.resolve(opt("--out") ?? path.join(ROOT, "release"));
const rootVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
if (pkg.version !== rootVersion) {
  console.error(`pack-plugin: ${name} is ${pkg.version}, the release is ${rootVersion}`);
  process.exit(1);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), `kurahi-plugin-${name}-`));
const dst = path.join(stage, "package");
const skip = (rel) =>
  rel.split(path.sep).includes("node_modules") ||
  /\.test\.ts$/.test(rel) ||
  rel.split(path.sep).includes("test-fixtures");
fs.cpSync(src, dst, {
  recursive: true,
  filter: (file) => !skip(path.relative(src, file)),
});
delete pkg.devDependencies;
// npm package names are lowercase; the unscoped part stays the plugin id.
pkg.name = opt("--name") ?? `@kodasoken/${name}`;
pkg.files = undefined;
fs.writeFileSync(path.join(dst, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
for (const f of ["LICENSE", "NOTICE"]) {
  if (fs.existsSync(path.join(ROOT, f)) && !fs.existsSync(path.join(dst, f))) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dst, f));
  }
}

fs.mkdirSync(out, { recursive: true });
const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", stage], {
  cwd: dst,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const file = JSON.parse(packed)[0].filename;
const target = path.join(out, `kurahi-${name}-${pkg.version}.tgz`);
fs.copyFileSync(path.join(stage, file), target);
fs.rmSync(stage, { recursive: true, force: true });
const sum = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
fs.writeFileSync(`${target}.sha256`, `${sum}  ${path.basename(target)}\n`);
console.log(
  `pack-plugin: ${path.relative(ROOT, target)} (${fs.statSync(target).size} bytes) ${sum}`,
);
