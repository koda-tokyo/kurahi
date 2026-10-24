import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import type { PolicyDocument } from "../policy/schema.js";
import { PolicyEngine } from "../policy/engine.js";
import { resolvePolicyLocations } from "../policy/paths.js";
import { validatePolicyDocument } from "../policy/schema.js";
import {
  isNaturallyDense,
  looksLikeRansomNote,
  shannonEntropy,
  ShieldDetector,
  type ShieldTrigger,
} from "./detect.js";
import { resolveShieldMode, startShield } from "./index.js";
import {
  CANARY_NAME,
  CANARY_TEXT,
  normalizeRoots,
  startShieldWatcher,
  type ShieldWatcher,
} from "./watch.js";

let dir: string;
let watchers: ShieldWatcher[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-shield-")));
});

afterEach(async () => {
  for (const w of watchers) {
    await w.stop();
  }
  watchers = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

const TEXT = "Quarterly overtime report.\nTeam A: 30/45 h\nTeam B: 41/45 h\n".repeat(80);

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

function watch(roots: string[], triggers: ShieldTrigger[], rewrites = 8) {
  const w = startShieldWatcher({
    roots,
    thresholds: { rewrites },
    onTrigger: (t) => triggers.push(t),
  });
  watchers.push(w);
  return w;
}

describe("detector", () => {
  it("entropy separates text from ciphertext", () => {
    expect(shannonEntropy(Buffer.from(TEXT))).toBeLessThan(5);
    expect(shannonEntropy(randomBytes(65536))).toBeGreaterThan(7.9);
    expect(shannonEntropy(new Uint8Array())).toBe(0);
  });

  it("counts rewrites of plain files into noise and triggers at the threshold", () => {
    const d = new ShieldDetector({ rewrites: 3, windowMs: 1000 });
    expect(
      d.observe({ kind: "change", path: "/w/a.md", entropy: 7.9, previousEntropy: 4 }, 0),
    ).toBeNull();
    expect(d.observe({ kind: "change", path: "/w/b.md", entropy: 7.9 }, 10)).toBeNull();
    const t = d.observe({ kind: "change", path: "/w/c.csv", entropy: 7.9 }, 20);
    expect(t?.reason).toBe("encrypt");
    expect(t?.paths).toEqual(["/w/a.md", "/w/b.md", "/w/c.csv"]);
  });

  it("forgets events outside the window and ignores dense formats and new noise", () => {
    const d = new ShieldDetector({ rewrites: 2, windowMs: 1000 });
    expect(d.observe({ kind: "change", path: "/w/a.md", entropy: 7.9 }, 0)).toBeNull();
    expect(d.observe({ kind: "change", path: "/w/b.md", entropy: 7.9 }, 5000)).toBeNull();
    expect(d.observe({ kind: "change", path: "/w/c.zip", entropy: 7.99 }, 5001)).toBeNull();
    expect(
      d.observe({ kind: "change", path: "/w/d.bin", entropy: 7.99, previousEntropy: 7.9 }, 5002),
    ).toBeNull();
    expect(d.observe({ kind: "add", path: "/w/new.bin", entropy: 7.99 }, 5003)).toBeNull();
  });

  it("catches delete-and-replace with an extra extension", () => {
    const d = new ShieldDetector({ rewrites: 2 });
    d.observe({ kind: "unlink", path: "/w/report.docx" }, 0);
    expect(d.observe({ kind: "add", path: "/w/report.docx.locked", entropy: 7.95 }, 1)).toBeNull();
    d.observe({ kind: "unlink", path: "/w/plan.xlsx" }, 2);
    expect(d.observe({ kind: "add", path: "/w/plan.xlsx.locked", entropy: 7.95 }, 3)?.reason).toBe(
      "encrypt",
    );
  });

  it("recognises ransom notes and canaries", () => {
    expect(looksLikeRansomNote("/w/HOW_TO_DECRYPT_FILES.txt")).toBe(true);
    expect(looksLikeRansomNote("/w/restore-my-files.html")).toBe(true);
    expect(looksLikeRansomNote("/w/README.md")).toBe(false);
    expect(looksLikeRansomNote("/w/decrypt.ts")).toBe(false);
    expect(isNaturallyDense("/w/photo.JPG")).toBe(true);
    const d = new ShieldDetector();
    expect(d.observe({ kind: "add", path: "/w/HOW_TO_DECRYPT.txt", entropy: 4 })?.reason).toBe(
      "note",
    );
    expect(
      d.observe({ kind: "canary", path: "/w/_kurahi_canary.txt", what: "deleted" })?.reason,
    ).toBe("canary");
  });
});

describe("watcher on a real folder", () => {
  it("plants decoys, skips nested roots and keeps the decoy out of git", () => {
    fs.mkdirSync(path.join(dir, "ws", ".git", "info"), { recursive: true });
    const roots = normalizeRoots([dir, path.join(dir, "ws"), path.join(dir, "missing")]);
    expect(roots).toEqual([dir]);
    const triggers: ShieldTrigger[] = [];
    const w = watch([path.join(dir, "ws")], triggers);
    expect(w.canaries).toEqual([path.join(dir, "ws", CANARY_NAME)]);
    expect(fs.readFileSync(w.canaries[0], "utf8")).toBe(CANARY_TEXT);
    expect(fs.readFileSync(path.join(dir, "ws", ".git", "info", "exclude"), "utf8")).toContain(
      CANARY_NAME,
    );
  });

  it("triggers when files are encrypted in place", async () => {
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dir, `note-${i}.md`), TEXT);
    }
    const triggers: ShieldTrigger[] = [];
    const w = watch([dir], triggers);
    await w.ready;
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dir, `note-${i}.md`), randomBytes(8192));
    }
    expect(await until(() => triggers.length > 0)).toBe(true);
    expect(triggers[0].reason).toBe("encrypt");
    expect(triggers).toHaveLength(1); // one incident, one trigger (cool-down)
  });

  it("triggers when the decoy is deleted", async () => {
    const triggers: ShieldTrigger[] = [];
    const w = watch([dir], triggers);
    await w.ready;
    fs.rmSync(w.canaries[0]);
    expect(await until(() => triggers.length > 0)).toBe(true);
    expect(triggers[0]).toMatchObject({ reason: "canary", detail: "decoy file deleted" });
  });

  it("stays quiet for a build that writes new binary files and edits text", async () => {
    fs.writeFileSync(path.join(dir, "src.ts"), TEXT);
    const triggers: ShieldTrigger[] = [];
    const w = watch([dir], triggers, 4);
    await w.ready;
    fs.mkdirSync(path.join(dir, "out"));
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(dir, "out", `chunk-${i}.bin`), randomBytes(8192));
      fs.writeFileSync(path.join(dir, "out", `bundle-${i}.zip`), randomBytes(4096));
    }
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), randomBytes(8192));
    fs.writeFileSync(path.join(dir, "src.ts"), TEXT + "// edited\n");
    await new Promise((r) => setTimeout(r, 1500));
    expect(triggers).toEqual([]);
  });
});

describe("gateway wiring", () => {
  it("resolves the mode with the env override first", () => {
    expect(resolveShieldMode({}, undefined)).toBe("stop");
    expect(resolveShieldMode({}, "alert")).toBe("alert");
    expect(resolveShieldMode({ KOLO_SHIELD: "off" }, "stop")).toBe("off");
  });

  it("validates the policy section", () => {
    expect(validatePolicyDocument({ version: 1, shield: { mode: "alert", rewrites: 20 } }).ok).toBe(
      true,
    );
    expect(validatePolicyDocument({ version: 1, shield: { mode: "panic" } }).ok).toBe(false);
  });

  it("stops every agent through the policy kill switch", async () => {
    const env = { KOLO_HOME: dir, KOLO_STATE_DIR: dir, KOLO_SHIELD: "stop" };
    const engine = new PolicyEngine({
      loc: resolvePolicyLocations(env),
      mode: "enforce",
      persist: false,
      audit: false,
    });
    engine.useDocument({ version: 1, shield: { rewrites: 3 } } as PolicyDocument);
    const logs: string[] = [];
    const w = startShield({
      cfg: {} as KoLoConfig,
      engine,
      env,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    expect(w).not.toBeNull();
    watchers.push(w!);
    await w!.ready;
    // macOS FSEvents can start delivering a moment after the watcher reports ready, and may drop
    // the very first event; touch the note again each second (still a real file event each time).
    const note = path.join(dir, "HOW_TO_DECRYPT_FILES.txt");
    fs.writeFileSync(note, "pay us");
    let touches = 0;
    const retouch = setInterval(() => {
      if (touches++ < 14) {
        fs.writeFileSync(note, `pay us ${touches}`);
      }
    }, 1000);
    try {
      expect(await until(() => engine.status().kill.fleet !== null, 15_000)).toBe(true);
    } finally {
      clearInterval(retouch);
    }
    expect(engine.status().kill.fleet).toMatchObject({ by: "shield" });
    expect(engine.status().kill.fleet?.reason).toContain("shield: note");
    expect(logs.join("\n")).toContain("stopping every agent");
  });
});
