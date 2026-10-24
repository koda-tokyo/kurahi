import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bumpVersion,
  extractChangelogNotes,
  main as releasePrep,
  parseArgs,
  parseChangelog,
  syncVersions,
  validateChangelogTop,
  versionFiles,
} from "../../scripts/release-prep.mjs";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-release-prep-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CHANGELOG = `# Changelog

Docs: https://docs.example

## 2026.10.16

### Changes

- Prebuilt bundles.

## 2026.10.15

- Older.
`;

describe("bumpVersion", () => {
  it("accepts explicit versions with or without v", () => {
    expect(bumpVersion("2026.10.15", "2026.10.16")).toBe("2026.10.16");
    expect(bumpVersion("2026.10.15", "v2026.10.16-beta.1")).toBe("2026.10.16-beta.1");
    expect(() => bumpVersion("1.0.0", "banana")).toThrow(/not a version/);
    expect(() => bumpVersion("1.0.0", "")).toThrow(/required/);
  });

  it("increments patch, minor and major", () => {
    expect(bumpVersion("2026.10.15", "patch")).toBe("2026.10.16");
    expect(bumpVersion("2026.10.15-beta.1", "patch")).toBe("2026.10.16");
    expect(bumpVersion("2026.10.15", "minor")).toBe("2026.11.0");
    expect(bumpVersion("2026.10.15", "major")).toBe("2027.0.0");
  });

  it("derives calver from the date and refuses a no-op", () => {
    const day = new Date(2026, 9, 16);
    expect(bumpVersion("2026.10.15", "calver", day)).toBe("2026.10.16");
    expect(() => bumpVersion("2026.10.16", "calver", day)).toThrow(/equals the current/);
  });
});

describe("changelog validation", () => {
  it("parses entries in order", () => {
    const entries = parseChangelog(CHANGELOG);
    expect(entries.map((e) => e.version)).toEqual(["2026.10.16", "2026.10.15"]);
    expect(entries[0].body).toContain("Prebuilt bundles");
  });

  it("requires the top entry to equal the release version with content", () => {
    expect(validateChangelogTop(CHANGELOG, "2026.10.16")).toEqual({
      ok: true,
      notes: "### Changes\n\n- Prebuilt bundles.",
    });
    const mismatch = validateChangelogTop(CHANGELOG, "2026.10.17");
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toMatch(/top entry is 2026.10.16, expected 2026.10.17/);
    const empty = validateChangelogTop(
      "# Changelog\n\n## 2026.10.16\n\n## 2026.10.15\n- x\n",
      "2026.10.16",
    );
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/is empty/);
    expect(validateChangelogTop("# Changelog\n", "1.0.0").ok).toBe(false);
  });

  it("extracts notes for any version", () => {
    expect(extractChangelogNotes(CHANGELOG, "2026.10.15")).toBe("- Older.");
    expect(extractChangelogNotes(CHANGELOG, "9.9.9")).toBeNull();
  });
});

describe("parseArgs", () => {
  it("reads the spec and flags", () => {
    expect(parseArgs(["patch", "--dry-run", "--no-tag"])).toEqual({
      spec: "patch",
      dryRun: true,
      commit: true,
      tag: false,
      allowDirty: false,
    });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["patch", "--bogus"])).toThrow(/unknown flag/);
  });
});

function makeRepo(version: string, changelog: string): string {
  const root = tmpDir();
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "kolo", version }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(root, "packages", "client"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "packages", "client", "package.json"),
    `${JSON.stringify({ name: "@kodasoken/kurahi-client", version }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(root, "packages", "legacy-analyzer"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "packages", "legacy-analyzer", "package.json"),
    `${JSON.stringify({ name: "@kodasoken/legacy-analyzer", version, private: true }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(root, "extensions", "telegram"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "extensions", "telegram", "package.json"),
    `${JSON.stringify({ name: "@kolo/telegram", version }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return root;
}

describe("release-prep main", () => {
  it("syncs versions across package files", () => {
    const root = makeRepo("2026.10.15", CHANGELOG);
    expect(versionFiles(root).length).toBe(4);
    const changed = syncVersions(root, "2026.10.16");
    expect(changed.length).toBe(4);
    for (const file of versionFiles(root)) {
      expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe("2026.10.16");
    }
    expect(syncVersions(root, "2026.10.16")).toEqual([]);
  });

  it("bumps, validates the changelog, commits and tags", () => {
    const root = makeRepo("2026.10.15", CHANGELOG);
    const result = releasePrep(["2026.10.16"], root);
    expect(result).toMatchObject({
      version: "2026.10.16",
      tag: "v2026.10.16",
      committed: true,
      tagged: true,
    });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    expect(git("tag", "--list")).toBe("v2026.10.16");
    expect(git("log", "-1", "--format=%s")).toBe("release: v2026.10.16");
    expect(git("status", "--porcelain")).toBe("");
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version).toBe(
      "2026.10.16",
    );
  });

  it("refuses when the changelog top entry does not match", () => {
    const root = makeRepo("2026.10.15", CHANGELOG);
    expect(() => releasePrep(["2026.10.17"], root)).toThrow(
      /top entry is 2026.10.16, expected 2026.10.17/,
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version).toBe(
      "2026.10.15",
    );
  });

  it("refuses a dirty tree and an existing tag", () => {
    const root = makeRepo("2026.10.15", CHANGELOG);
    fs.appendFileSync(path.join(root, "CHANGELOG.md"), "\n- wip\n");
    expect(() => releasePrep(["2026.10.16"], root)).toThrow(/uncommitted changes/);
    execFileSync("git", ["checkout", "--", "CHANGELOG.md"], { cwd: root });
    execFileSync("git", ["tag", "v2026.10.16"], { cwd: root });
    expect(() => releasePrep(["2026.10.16"], root)).toThrow(/already exists/);
  });

  it("dry run changes nothing", () => {
    const root = makeRepo("2026.10.15", CHANGELOG);
    const result = releasePrep(["2026.10.16", "--dry-run"], root);
    expect(result.committed).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version).toBe(
      "2026.10.15",
    );
    expect(execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" }).trim()).toBe("");
  });
});
