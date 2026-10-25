import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkClassification, loadProfile } from "../../../scripts/enterprise-check.mjs";
import { ENTERPRISE_PROFILE, resolveReleaseProfile } from "../release-profile.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const extensionDirs = fs
  .readdirSync(path.join(REPO_ROOT, "extensions"), { withFileTypes: true })
  // A plugin is a directory with a manifest; leftovers (e.g. only node_modules) are not plugins.
  .filter(
    (e) =>
      e.isDirectory() &&
      fs.existsSync(path.join(REPO_ROOT, "extensions", e.name, "KoLo.plugin.json")),
  )
  .map((e) => e.name)
  .toSorted();

describe("enterprise profile manifest", () => {
  it("classifies every directory in extensions/ and nothing else", () => {
    expect(Object.keys(ENTERPRISE_PROFILE.extensions).toSorted()).toEqual(extensionDirs);
    expect(checkClassification(REPO_ROOT)).toEqual([]);
  });

  it("gives every extension a tier and a reason, keyed by its plugin id", () => {
    for (const id of extensionDirs) {
      const entry = ENTERPRISE_PROFILE.extensions[id];
      expect(["enterprise", "optional", "excluded"]).toContain(entry.tier);
      expect(entry.reason.length).toBeGreaterThan(20);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, "extensions", id, "KoLo.plugin.json"), "utf8"),
      ) as { id: string };
      expect(manifest.id).toBe(id);
    }
  });

  it("keeps the decisions the release depends on", () => {
    const tier = (id: string) => ENTERPRISE_PROFILE.extensions[id]?.tier;
    // GPL-3.0 libsignal: separate plugin since 2.1.0.
    expect(tier("whatsapp")).toBe("optional");
    for (const id of ["telegram", "discord", "signal", "imessage", "line", "nostr", "zalouser"]) {
      expect(tier(id)).toBe("excluded");
    }
    for (const id of ["microsoft-365", "entra", "kintone", "freee", "box", "a2a", "memory-core"]) {
      expect(tier(id)).toBe("enterprise");
    }
  });

  it("the script and the runtime read the same file", () => {
    expect(loadProfile(REPO_ROOT)).toEqual(ENTERPRISE_PROFILE);
  });

  it("a new extension without a classification fails the check", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-profile-"));
    try {
      fs.mkdirSync(path.join(root, "extensions", "office"), { recursive: true });
      fs.writeFileSync(path.join(root, "extensions", "office", "KoLo.plugin.json"), "{}");
      fs.mkdirSync(path.join(root, "extensions", "brand-new-channel"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "extensions", "brand-new-channel", "KoLo.plugin.json"),
        "{}",
      );
      const profile = {
        ...ENTERPRISE_PROFILE,
        extensions: { office: ENTERPRISE_PROFILE.extensions.office },
      };
      expect(checkClassification(root, profile)).toEqual([
        "extensions/brand-new-channel: not classified in src/packaging/profiles/enterprise.json",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("a directory with content but no manifest fails; a node_modules leftover does not", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-profile-"));
    try {
      fs.mkdirSync(path.join(root, "extensions", "office"), { recursive: true });
      fs.writeFileSync(path.join(root, "extensions", "office", "KoLo.plugin.json"), "{}");
      fs.mkdirSync(path.join(root, "extensions", "leftover", "node_modules"), { recursive: true });
      fs.mkdirSync(path.join(root, "extensions", "lost-manifest", "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "extensions", "lost-manifest", "index.ts"), "");
      const profile = {
        ...ENTERPRISE_PROFILE,
        extensions: { office: ENTERPRISE_PROFILE.extensions.office },
      };
      expect(checkClassification(root, profile)).toEqual([
        "extensions/lost-manifest: has content but no KoLo.plugin.json",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveReleaseProfile", () => {
  it("is enterprise when either the environment or the config says so", () => {
    expect(resolveReleaseProfile({}, {})).toBe("standard");
    expect(resolveReleaseProfile({}, { KURAHI_PROFILE: "enterprise" })).toBe("enterprise");
    expect(resolveReleaseProfile({}, { KURAHI_PROFILE: " Enterprise " })).toBe("enterprise");
    expect(resolveReleaseProfile({ profile: "enterprise" }, {})).toBe("enterprise");
    expect(resolveReleaseProfile({ profile: "enterprise" }, { KURAHI_PROFILE: "standard" })).toBe(
      "enterprise",
    );
    expect(resolveReleaseProfile({ profile: "standard" }, { KURAHI_PROFILE: "enterprise" })).toBe(
      "enterprise",
    );
  });
});
