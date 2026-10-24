import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearArtifactDigestCache,
  digestArtifact,
  listArtifactFiles,
} from "./supply-chain-hash.js";

let root: string;

function write(dir: string, rel: string, body: string) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-sc-hash-"));
  clearArtifactDigestCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("supply-chain digest", () => {
  it("is deterministic: same content in a different order and location digests the same", () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    write(a, "SKILL.md", "# demo\n");
    write(a, "scripts/run.sh", "echo hi\n");
    write(a, "z.txt", "z");
    write(b, "z.txt", "z");
    write(b, "scripts/run.sh", "echo hi\n");
    write(b, "SKILL.md", "# demo\n");
    const da = digestArtifact(a);
    expect(da).toEqual(digestArtifact(b));
    expect(da.files).toBe(3);
    expect(digestArtifact(a, { cache: false }).sha256).toBe(da.sha256);
    expect(listArtifactFiles(a).map((f) => f.rel)).toEqual(["SKILL.md", "scripts/run.sh", "z.txt"]);
  });

  it("ignores node_modules and .git at any depth", () => {
    const a = path.join(root, "a");
    write(a, "SKILL.md", "# demo\n");
    const before = digestArtifact(a).sha256;
    write(a, "node_modules/x/index.js", "evil()");
    write(a, "sub/node_modules/y.js", "evil()");
    write(a, ".git/HEAD", "ref");
    expect(digestArtifact(a).sha256).toBe(before);
  });

  it("detects an edit, an added file and a rename", () => {
    const a = path.join(root, "a");
    write(a, "SKILL.md", "# demo\n");
    write(a, "run.sh", "echo hi\n");
    const pinned = digestArtifact(a).sha256;

    write(a, "run.sh", "echo HI\n");
    const edited = digestArtifact(a).sha256;
    expect(edited).not.toBe(pinned);

    write(a, "run.sh", "echo hi\n");
    expect(digestArtifact(a).sha256).toBe(pinned);

    write(a, "extra.sh", "x");
    expect(digestArtifact(a).sha256).not.toBe(pinned);
    fs.rmSync(path.join(a, "extra.sh"));

    fs.renameSync(path.join(a, "run.sh"), path.join(a, "run2.sh"));
    expect(digestArtifact(a).sha256).not.toBe(pinned);
  });

  it("an edit that restores the mtime is still seen (cache keys on ctime too)", () => {
    const a = path.join(root, "a");
    write(a, "SKILL.md", "# demo\n");
    const file = path.join(a, "SKILL.md");
    const pinned = digestArtifact(a).sha256;
    const st = fs.statSync(file);
    fs.writeFileSync(file, "# DEMO\n");
    fs.utimesSync(file, st.atime, st.mtime);
    expect(digestArtifact(a).sha256).not.toBe(pinned);
  });

  it("digests a single-file plugin as that one file", () => {
    write(root, "plugin.ts", "export default {}\n");
    const d = digestArtifact(path.join(root, "plugin.ts"));
    expect(d.files).toBe(1);
    write(root, "plugin.ts", "export default { evil: true }\n");
    expect(digestArtifact(path.join(root, "plugin.ts")).sha256).not.toBe(d.sha256);
  });
});
