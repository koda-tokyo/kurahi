import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideLine, type GateInput } from "./gate.js";
import { checkLinePaths } from "./path-guard.js";
import { checkReadOnlyWrites, readOnlyFolderOf } from "./readonly-guard.js";
import { resolveTerminalSettings } from "./settings.js";

let base: string;
let root: string;
const RO = ["source", "data", "docs"];

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-rofolders-")));
  root = path.join(base, "project");
  for (const d of ["source/cobol", "data", "docs", "output", "plans"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "source", "cobol", "PAY.cbl"), "IDENTIFICATION DIVISION.\n");
  fs.writeFileSync(path.join(root, "output", "notes.md"), "notes\n");
  // Tricks: a link into a read-only folder, a dangling one, and one whose `..` lands at the root.
  fs.symlinkSync(path.join(root, "source"), path.join(root, "output", "src-link"));
  fs.symlinkSync(path.join(root, "source", "new.cbl"), path.join(root, "output", "dangling"));
  fs.symlinkSync(path.join(root, "plans"), path.join(root, "output", "up"));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const check = (line: string, cwd = root, readOnly = RO) =>
  checkReadOnlyWrites(line, { root, cwd, readOnly });

const gate = (line: string, mode: "plan" | "act", extra: Partial<GateInput> = {}) =>
  decideLine({
    line,
    mode,
    root,
    cwd: root,
    previousCwd: null,
    readOnlyFolders: RO,
    settings: resolveTerminalSettings({ console: { terminal: { actApprovals: "policy" } } }),
    policy: () => ({ security: "full", ask: "off", analysisOk: true, allowlistSatisfied: true }),
    guard: { sessionKey: "terminal:test", sandboxed: false },
    ...extra,
  });

describe("read-only folders: refused writes", () => {
  it.each([
    "touch source/x",
    "mkdir source/new",
    "mkdir data",
    "rm source/cobol/PAY.cbl",
    "rm -rf source",
    "rmdir docs",
    "echo hi > source/x",
    "echo hi >> docs/readme.md",
    "cat output/notes.md | tee source/copy.md",
    "cp output/notes.md source/",
    "cp output/notes.md data/notes.md",
    "cp -t source output/notes.md",
    "mv source/cobol/PAY.cbl output/",
    "mv output/notes.md docs/",
    "chmod 777 source/cobol/PAY.cbl",
    "chmod -R u+w source",
    "chown -R me data",
    "sed -i s/A/B/ source/cobol/PAY.cbl",
    "truncate -s 0 source/cobol/PAY.cbl",
    "dd if=/dev/zero of=source/cobol/PAY.cbl count=1",
    "ln -s ../output/notes.md source/link",
    "ln source/cobol/PAY.cbl output/hard",
    "cp -l source/cobol/PAY.cbl output/hard",
    "gzip source/cobol/PAY.cbl",
    "sort -o source/sorted output/notes.md",
    "tar -xf output/a.tar -C source",
    "tar -czf source/out.tgz output",
    "tar xzf output/a.tgz",
    "unzip output/a.zip -d data",
    "find source -name '*.cbl' -delete",
    "find source -name '*.cbl' -exec rm {} ;",
    "find . -name '*.cbl' | xargs rm",
    "ls | xargs rm -rf",
    "rm -rf *",
    "rm -rf ./*",
    "chmod -R 777 .",
    "touch source/*",
    "git checkout -- source/cobol/PAY.cbl",
    "git checkout main",
    "git clean -fdx",
    "javac source/cobol/Pay.java",
    "sh -c 'touch source/x'",
    "bash -lc 'cd source && touch x'",
    "eval touch source/x",
    "env FOO=1 touch source/x",
    "timeout 5 touch source/x",
    "cd source && touch x",
    "cd source; make",
    "cd output && touch ../source/x",
    "touch output/../source/x",
    "touch ~/source/x",
    "touch output/src-link/x",
    "echo hi > output/dangling",
    "touch output/up/../source/x",
    "rsync -a output/ source/",
  ])("%s", (line) => {
    expect(check(line)).toMatchObject({ ok: false });
  });

  it("names the folder", () => {
    expect(check("touch data/x")).toEqual({ ok: false, folder: "data" });
  });

  it("refuses writes when the cwd is inside a read-only folder", () => {
    const cwd = path.join(root, "source", "cobol");
    expect(check("touch x", cwd)).toMatchObject({ ok: false, folder: "source" });
    expect(check("rm PAY.cbl", cwd)).toMatchObject({ ok: false });
    expect(check("cat PAY.cbl", cwd)).toEqual({ ok: true });
  });

  it("matches case-insensitively on macOS and Windows only", () => {
    const folded = process.platform === "darwin" || process.platform === "win32";
    expect(check("touch Source/x").ok).toBe(!folded);
  });
});

describe("read-only folders: allowed lines", () => {
  it.each([
    "cat source/cobol/PAY.cbl",
    "grep -rn MOVE source",
    "ls -la source data docs",
    "wc -l source/cobol/*.cbl",
    "find source -name '*.cbl'",
    "find source -name '*.cbl' -exec grep -l MOVE {} +",
    "cp source/cobol/PAY.cbl output/PAY.cbl",
    "cp -r source output/",
    "cat source/cobol/PAY.cbl > output/copy.cbl",
    "diff source/cobol/PAY.cbl output/notes.md",
    "touch output/x plans/y",
    "rm -rf output/build",
    "tar -czf output/source.tgz source",
    "zip output/source.zip source/cobol/PAY.cbl",
    "find source -name '*.cbl' | xargs grep MOVE",
    "grep -l x output/*.md | xargs rm",
    "ln -s ../source/cobol/PAY.cbl output/link",
    "git status",
    "git add output",
    "git commit -m wip",
    "mkdir -p output/sources",
    "sed s/A/B/ source/cobol/PAY.cbl > output/PAY.cbl",
    "python3 tools/analyse.py source",
  ])("%s", (line) => {
    expect(check(line)).toEqual({ ok: true });
  });

  it("allows everything when the project has no read-only folders (unlocked)", () => {
    expect(check("touch source/x", root, [])).toEqual({ ok: true });
    expect(check("rm -rf data", root, ["source"])).toEqual({ ok: true });
  });
});

describe("gate: read-only-path is refused in every mode, never approvable", () => {
  for (const mode of ["plan", "act"] as const) {
    it(`${mode} mode`, () => {
      const d = gate("touch source/x", mode);
      expect(d).toMatchObject({
        action: "refuse",
        refusal: { code: "read-only-path", params: { folder: "source" } },
      });
      expect(d.risks[0]).toEqual({ code: "read-only-path", params: { folder: "source" } });
      expect(gate("cat source/cobol/PAY.cbl", mode).action).toBe("run");
      // Writable folders keep the mode rule: plan asks; act "policy" with full security runs.
      expect(gate("touch output/x", mode).action).toBe(mode === "plan" ? "approve" : "run");
    });
  }

  it("unlocks when the folder leaves the project's read-only list", () => {
    expect(gate("touch source/x", "plan", { readOnlyFolders: ["data", "docs"] }).action).toBe(
      "approve",
    );
  });
});

describe("path guard: `..` after a symlink", () => {
  it("follows the link before applying `..`", () => {
    fs.symlinkSync(base, path.join(root, "output", "outside"));
    try {
      // Lexically output/outside/../x is output/x; the kernel opens <base>/x, outside the root.
      expect(checkLinePaths("cat output/outside/../secret", { root, cwd: root })).toEqual({
        ok: false,
        code: "path-escape",
      });
    } finally {
      fs.rmSync(path.join(root, "output", "outside"));
    }
  });
});

describe("readOnlyFolderOf (diff paths)", () => {
  it("maps project-relative paths to their read-only folder", () => {
    expect(readOnlyFolderOf("source/cobol/PAY.cbl", RO)).toBe("source");
    expect(readOnlyFolderOf("docs", RO)).toBe("docs");
    expect(readOnlyFolderOf("sourcey/x", RO)).toBeNull();
    expect(readOnlyFolderOf("output/x", RO)).toBeNull();
    expect(readOnlyFolderOf("anything", ["."])).toBe(".");
  });
});
