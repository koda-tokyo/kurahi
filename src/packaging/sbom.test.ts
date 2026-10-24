import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyLicence, parseCargoLock } from "../../scripts/sbom.mjs";

describe("sbom licence classification", () => {
  it("treats permissive licences as ok", () => {
    expect(classifyLicence("MIT")).toBe("ok");
    expect(classifyLicence("Apache-2.0 OR MIT")).toBe("ok");
    expect(classifyLicence("(MIT OR Apache-2.0) AND Unicode-3.0")).toBe("ok");
  });

  it("uses the most permissive alternative of an OR expression", () => {
    expect(classifyLicence("MIT OR GPL-3.0")).toBe("ok");
    expect(classifyLicence("MPL-2.0 OR GPL-2.0")).toBe("weak-copyleft");
  });

  it("flags weak and strong copyleft", () => {
    expect(classifyLicence("MPL-2.0")).toBe("weak-copyleft");
    expect(classifyLicence("LGPL-3.0-or-later")).toBe("weak-copyleft");
    expect(classifyLicence("Apache-2.0 AND LGPL-3.0-or-later")).toBe("weak-copyleft");
    expect(classifyLicence("GPL-3.0")).toBe("copyleft");
    expect(classifyLicence("AGPL-3.0-only")).toBe("copyleft");
  });

  it("flags missing or custom licences as unknown", () => {
    expect(classifyLicence("UNKNOWN")).toBe("unknown");
    expect(classifyLicence("")).toBe("unknown");
    expect(classifyLicence("SEE LICENSE IN LICENSE.md")).toBe("unknown");
  });
});

describe("sbom Cargo.lock reader", () => {
  it("reads packages, sources, checksums and both dependency list forms", () => {
    const pkgs = parseCargoLock(
      [
        "version = 4",
        "",
        "[[package]]",
        'name = "app"',
        'version = "0.1.0"',
        "dependencies = [",
        ' "serde",',
        ' "windows-sys 0.52.0",',
        "]",
        "",
        "[[package]]",
        'name = "serde"',
        'version = "1.0.0"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "abc"',
        "",
        "[metadata]",
        'x = "y"',
      ].join("\n"),
    );
    expect(pkgs).toHaveLength(2);
    expect(pkgs[0]).toMatchObject({ name: "app", version: "0.1.0" });
    expect(pkgs[0].dependencies).toEqual(["serde", "windows-sys 0.52.0"]);
    expect(pkgs[0].source).toBeUndefined();
    expect(pkgs[1]).toMatchObject({ name: "serde", checksum: "abc" });
  });
});

describe("sbom script", () => {
  it("writes CycloneDX documents for the runtime and the desktop app", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-sbom-"));
    try {
      const script = path.resolve(__dirname, "..", "..", "scripts", "sbom.mjs");
      const res = spawnSync(process.execPath, [script, "--out", out], { encoding: "utf8" });
      expect(res.status, res.stderr).toBe(0);
      for (const file of ["kurahi-runtime.cdx.json", "kurahi-desktop.cdx.json"]) {
        const doc = JSON.parse(fs.readFileSync(path.join(out, file), "utf8"));
        expect(doc.bomFormat).toBe("CycloneDX");
        expect(doc.specVersion).toBe("1.5");
        expect(doc.components.length).toBeGreaterThan(0);
        for (const c of doc.components) {
          expect(c.licenses?.length).toBeGreaterThan(0);
        }
        expect(doc.dependencies[0].ref).toBe(doc.metadata.component["bom-ref"]);
      }
      expect(fs.existsSync(path.join(out, "licence-flags.md"))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
