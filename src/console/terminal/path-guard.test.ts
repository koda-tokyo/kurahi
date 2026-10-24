import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLinePaths, pathHelpers } from "./path-guard.js";
import { parseShellLine } from "./shell-words.js";

let base: string;
let root: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-pathguard-")));
  root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, "_answer-keys"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "a\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "b\n");
  fs.writeFileSync(path.join(base, "secret.txt"), "outside\n");
  fs.symlinkSync(path.join(base, "secret.txt"), path.join(root, "link"));
  fs.symlinkSync(base, path.join(root, "updir"));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const check = (line: string, cwd = root) => checkLinePaths(line, { root, cwd });

describe("checkLinePaths", () => {
  it("allows paths inside the project", () => {
    for (const line of [
      "ls src",
      "cat src/a.ts ./src/b.ts",
      "grep -rn foo . 2>/dev/null",
      "cat ~/src/a.ts",
      "wc -l src/*.ts",
      "git -C src status",
      "/usr/bin/env ls",
      "ls --color=auto src",
    ]) {
      expect(check(line), line).toEqual({ ok: true, cwdAfter: null });
    }
  });

  it("refuses .., absolute paths and symlinks that leave the project", () => {
    for (const line of [
      "cat ../secret.txt",
      "cat /etc/passwd",
      "ls /",
      "cat link",
      "ls updir/",
      "cp src/a.ts ../stolen.ts",
      "echo hi > ../x",
      "tar -cf /tmp/out.tar src",
      "rm -rf ../*",
      "cat --file=/etc/hosts",
      "sh -c 'cat /etc/passwd'",
      "ls _answer-keys",
      "cat lin*",
      "ls up*/",
    ]) {
      expect(check(line), line).toEqual({ ok: false, code: "path-escape" });
    }
  });

  it("tracks cd through the line, including cd that may or may not happen", () => {
    expect(check("cd ..")).toEqual({ ok: false, code: "path-escape" });
    expect(check("cd src && cd .. && cd ..", path.join(root, "src"))).toEqual({
      ok: false,
      code: "path-escape",
    });
    expect(check("cd src && cat ../../secret.txt")).toEqual({ ok: false, code: "path-escape" });
    // Conservative: the cd may fail, so `..` is also checked from the root.
    expect(check("cd src/deep && ls ..")).toEqual({ ok: false, code: "path-escape" });
    expect(check("cd src/deep && ls . ../a.ts")).toEqual({ ok: false, code: "path-escape" });
    expect(check("cd src/deep && ls")).toEqual({ ok: true, cwdAfter: null });
    expect(check("cd src")).toEqual({ ok: true, cwdAfter: path.join(root, "src") });
    expect(check("cd", path.join(root, "src"))).toEqual({ ok: true, cwdAfter: root });
  });

  it("refuses paths it cannot verify", () => {
    expect(check("cat $HOME/../x")).toEqual({ ok: false, code: "unverifiable-path" });
    expect(check("cat ~root/.ssh/id_rsa")).toEqual({ ok: false, code: "unverifiable-path" });
    expect(check("F=/etc/passwd cat x")).toEqual({ ok: false, code: "path-escape" });
    expect(check("echo $HOME")).toEqual({ ok: true, cwdAfter: null });
    expect(check("cat .*/secret.txt")).toEqual({ ok: false, code: "unverifiable-path" });
    expect(check("cat {..,.}/secret.txt")).toEqual({ ok: false, code: "unverifiable-path" });
    expect(check("find . -name x -exec cat {} +")).toEqual({ ok: true, cwdAfter: null });
  });

  it("counts glob and recursive targets for the risk preview", () => {
    const helpers = pathHelpers(root, root);
    const p = parseShellLine("rm src/*.ts");
    if (!p.ok) {
      throw new Error("parse");
    }
    expect(helpers.countTargets(p.commands[0].words.slice(1), false)).toBe(2);
    const r = parseShellLine("rm -r src");
    if (!r.ok) {
      throw new Error("parse");
    }
    expect(helpers.countTargets(r.commands[0].words.slice(2), true)).toBe(4);
  });
});
