import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPackage, checkPackageDir } from "../../scripts/enterprise-check.mjs";
import { extensionsToDrop } from "../../scripts/npm-pack.mjs";
import { bundleArchiveName, parseBundleTarget } from "./bundle-manifest.js";
import { ENTERPRISE_PROFILE } from "./release-profile.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
// Built at runtime so this file itself never contains the identifier it tests.
const BODY_FILE = ["hormones", "json"].join(".");

let root: string;

function write(rel: string, text: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function dep(lib: string, name: string, license: string) {
  write(
    `${lib}/node_modules/${name}/package.json`,
    JSON.stringify({ name, version: "1.0.0", license }),
  );
}

/** A minimal enterprise bundle: manifest, one dist file, one enterprise extension, MIT deps. */
function cleanBundle() {
  const b = "kolo-2.2.0-linux-x64";
  write(
    `${b}/bundle-manifest.json`,
    JSON.stringify({ profile: "enterprise", extensions: { included: ["office"], omitted: {} } }),
  );
  write(`${b}/lib/package.json`, JSON.stringify({ name: "kurahi", version: "2.2.0" }));
  write(`${b}/lib/dist/index.js`, "export const ok = 1;\n");
  write(`${b}/lib/extensions/office/index.ts`, "export default {};\n");
  dep(`${b}/lib`, "left-pad", "MIT");
  dep(`${b}/lib`, "@scope/dual", "(MIT OR GPL-3.0)");
  return b;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-enterprise-check-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("enterprise-check on a package", () => {
  it("passes a clean enterprise bundle", () => {
    cleanBundle();
    const r = checkPackageDir(root, { repoRoot: REPO_ROOT });
    expect(r.kind).toBe("bundle");
    expect(r.findings).toEqual([]);
    expect(r.extensions).toEqual(["office"]);
    expect(r.licences.copyleft).toBe(0);
  });

  it("catches an excluded extension, an optional one and an unclassified one", () => {
    const b = cleanBundle();
    write(`${b}/lib/extensions/telegram/index.ts`, "export default {};\n");
    write(`${b}/lib/extensions/whatsapp/index.ts`, "export default {};\n");
    write(`${b}/lib/extensions/mystery/index.ts`, "export default {};\n");
    const r = checkPackageDir(root, { repoRoot: REPO_ROOT });
    expect(r.findings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^extension telegram: excluded tier must not ship/),
        expect.stringMatching(/^extension whatsapp: optional tier must not ship/),
        "extension mystery: not classified for the enterprise profile",
      ]),
    );
  });

  it("catches a GPL dependency, nested or in an extension; LGPL and unknown are warnings", () => {
    const b = cleanBundle();
    dep(`${b}/lib/node_modules/left-pad`, "libsignal", "GPL-3.0");
    dep(`${b}/lib/extensions/office`, "agpl-thing", "AGPL-3.0-only");
    dep(`${b}/lib`, "libvips-ish", "LGPL-3.0-or-later");
    write(`${b}/lib/node_modules/nolicence/package.json`, JSON.stringify({ name: "nolicence" }));
    const r = checkPackageDir(root, { repoRoot: REPO_ROOT });
    expect(r.findings).toEqual([
      "libsignal@1.0.0: licence GPL-3.0 (copyleft)",
      "agpl-thing@1.0.0: licence AGPL-3.0-only (copyleft)",
    ]);
    expect(r.warnings.join("\n")).toMatch(/libvips-ish@1\.0\.0: licence LGPL/);
    expect(r.warnings.join("\n")).toMatch(/nolicence@: licence UNKNOWN \(unknown\)/);
    const strict = checkPackageDir(root, { repoRoot: REPO_ROOT, strict: true });
    expect(strict.findings).toContain("nolicence@: licence UNKNOWN (unknown)");
  });

  it("a GPL dependency listed as an exception is accepted with its reason", () => {
    const b = cleanBundle();
    dep(`${b}/lib`, "gpl-tool", "GPL-2.0");
    const profile = {
      ...ENTERPRISE_PROFILE,
      licensePolicy: { ...ENTERPRISE_PROFILE.licensePolicy, exceptions: { "gpl-tool": "test" } },
    };
    const r = checkPackageDir(root, { repoRoot: REPO_ROOT, profile });
    expect(r.findings).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(
      /gpl-tool@1\.0\.0: GPL-2\.0 \(copyleft, accepted: test\)/,
    );
  });

  it("catches a family-internal identifier in dist and in an extension", () => {
    const b = cleanBundle();
    write(`${b}/lib/dist/state.js`, `const f = "${BODY_FILE}";\n`);
    write(`${b}/lib/extensions/office/src/x.ts`, `read("${BODY_FILE}");\n`);
    const r = checkPackageDir(root, { repoRoot: REPO_ROOT });
    expect(r.findings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^dist\/state\.js:1: body-state-file:/),
        expect.stringMatching(/^extensions\/office\/src\/x\.ts:1: body-state-file:/),
      ]),
    );
  });

  it("catches an extension import of a core module the package does not ship", () => {
    const b = cleanBundle();
    write(
      `${b}/lib/extensions/office/index.ts`,
      [
        'import { render } from "../../src/office/docx.js";',
        'import type { Spec } from "../../src/office/types.js";',
        'import { local } from "./src/local.js";',
        'const lazy = () => import("../../src/office/common.js");',
        "",
      ].join("\n"),
    );
    write(`${b}/lib/extensions/office/src/local.ts`, "export const local = 1;\n");
    const r = checkPackageDir(root, { repoRoot: REPO_ROOT });
    expect(r.findings).toEqual([
      "extensions/office/index.ts: imports ../../src/office/docx.js, which the package does not contain",
    ]);
    expect(r.warnings.join("\n")).toMatch(
      /imports \.\.\/\.\.\/src\/office\/common\.js.*\(dynamic\)/,
    );
    // The bundle's src shims make both resolve.
    write(`${b}/lib/src/office/docx.js`, 'export * from "../../dist/office/docx.js";\n');
    write(`${b}/lib/src/office/common.js`, 'export * from "../../dist/office/common.js";\n');
    expect(checkPackageDir(root, { repoRoot: REPO_ROOT }).findings).toEqual([]);
  });

  it("refuses a bundle whose manifest is not the enterprise profile", () => {
    const b = cleanBundle();
    write(`${b}/bundle-manifest.json`, JSON.stringify({ extensions: { included: [] } }));
    const r = checkPackageDir(root, { repoRoot: REPO_ROOT });
    expect(r.findings).toEqual(['bundle-manifest.json: profile is null, expected "enterprise"']);
  });

  it("reads an npm tarball (package/) and an archive", async () => {
    write("package/package.json", JSON.stringify({ name: "kurahi", version: "2.2.0" }));
    write("package/extensions/discord/index.ts", "export default {};\n");
    const tar = await import("tar");
    const archive = path.join(os.tmpdir(), `kurahi-enterprise-check-${process.pid}.tgz`);
    try {
      await Promise.resolve(tar.c({ gzip: true, file: archive, cwd: root }, ["package"]));
      const r = await checkPackage(archive, { repoRoot: REPO_ROOT });
      expect(r.kind).toBe("npm");
      expect(r.findings).toEqual([expect.stringMatching(/^extension discord: excluded tier/)]);
    } finally {
      fs.rmSync(archive, { force: true });
    }
  });
});

describe("enterprise packaging helpers", () => {
  it("names the enterprise archive after the target", () => {
    const t = parseBundleTarget("linux-x64");
    expect(bundleArchiveName("2.2.0", t)).toBe("kolo-2.2.0-linux-x64.tar.gz");
    expect(bundleArchiveName("2.2.0", t, "enterprise")).toBe(
      "kolo-2.2.0-linux-x64-enterprise.tar.gz",
    );
    expect(bundleArchiveName("2.2.0", parseBundleTarget("win32-x64"), "enterprise")).toBe(
      "kolo-2.2.0-win32-x64-enterprise.zip",
    );
  });

  it("drops every non-enterprise extension from the npm tarball", () => {
    expect(
      extensionsToDrop(["office", "telegram", "whatsapp", "unknown-x"], ENTERPRISE_PROFILE),
    ).toEqual(["telegram", "whatsapp", "unknown-x"]);
  });
});
