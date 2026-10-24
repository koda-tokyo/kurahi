import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { addOwner } from "../policy/attestation.js";
import { resolvePolicyLocations } from "../policy/paths.js";
import { copyExample, tempHome } from "../test-helpers/eval.js";
import {
  lintSpec,
  loadSpec,
  signSpec,
  SpecError,
  verifyFixtureDigests,
  verifySpecSignature,
} from "./spec.js";

let t: ReturnType<typeof tempHome>;
let dir: string;
beforeEach(() => {
  t = tempHome();
  dir = copyExample(t.home);
});
afterEach(() => t.cleanup());

function editSpec(mutate: (doc: Record<string, unknown>) => void) {
  const file = path.join(dir, "spec.yaml");
  const doc = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  mutate(doc);
  fs.writeFileSync(file, YAML.stringify(doc));
}
const checks = (doc: Record<string, unknown>) => doc.checks as Array<Record<string, unknown>>;
const errors = () =>
  lintSpec(loadSpec(dir))
    .filter((f) => f.level === "error")
    .map((f) => f.message);

describe("spec format", () => {
  it("loads, lints clean and matches its fixtures", () => {
    const loaded = loadSpec(dir);
    expect(loaded.spec.workflow).toBe("csv-inspection.exceptions");
    expect(lintSpec(loaded)).toEqual([]);
    expect(verifyFixtureDigests(loaded)).toEqual([]);
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unknown fields and bad check types with path-level issues", () => {
    editSpec((d) => {
      d.surprise = true;
      checks(d)[0].type = "vibes";
    });
    try {
      loadSpec(dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SpecError);
      expect((err as SpecError).issues.join("\n")).toMatch(/checks\.0\.type/);
    }
  });

  it("detects a changed golden dataset", () => {
    fs.appendFileSync(path.join(dir, "fixtures", "line3-2026-10-14", "input.csv"), "tampered\n");
    const issues = verifyFixtureDigests(loadSpec(dir));
    expect(issues).toEqual([
      expect.objectContaining({ fixture: "line3-2026-10-14", file: "input.csv" }),
    ]);
  });
});

describe("lint: a model judge is never a gate", () => {
  it("rejects judge: model as a gate", () => {
    editSpec((d) =>
      checks(d).push({
        id: "tone",
        type: "rubric",
        judge: "model",
        severity: "gate",
        output: "report",
        model: "m",
        rubric: "r.md",
      }),
    );
    expect(errors()).toContain("a judge: model check can never be a gate");
  });

  it("rejects judge: model above info", () => {
    editSpec((d) =>
      checks(d).push({
        id: "tone",
        type: "rubric",
        judge: "model",
        severity: "major",
        weight: 1,
        output: "report",
        model: "m",
        rubric: "r.md",
      }),
    );
    expect(errors()).toContain("a judge: model check must have severity info, not major");
  });

  it("rejects judge: model on a deterministic check type", () => {
    editSpec((d) => {
      checks(d)[0].judge = "model";
    });
    expect(errors().join("\n")).toMatch(/judge: model is only allowed on rubric checks/);
  });

  it("rejects an output checked only by a model judge", () => {
    editSpec((d) => {
      (d.outputs as unknown[]).push({ name: "notes", from: "finalText" });
      checks(d).push({
        id: "tone",
        type: "rubric",
        judge: "model",
        severity: "info",
        output: "notes",
        model: "m",
        rubric: "r.md",
      });
    });
    expect(errors()).toContain("output notes is checked only by a model judge");
  });

  it("accepts an info-level model judge next to deterministic checks", () => {
    editSpec((d) =>
      checks(d).push({
        id: "tone",
        type: "rubric",
        judge: "model",
        severity: "info",
        output: "report",
        model: "m",
        rubric: "r.md",
      }),
    );
    expect(errors()).toEqual([]);
  });
});

describe("lint: structure", () => {
  it("gates are never weighted, quality checks need weights, ids are unique, params are present", () => {
    editSpec((d) => {
      checks(d)[0].weight = 5;
      delete checks(d)[3].weight;
      checks(d).push({ ...checks(d)[1], actions: ["no-such-action"] });
      checks(d).push({
        id: "rec",
        type: "setMatch",
        severity: "major",
        weight: 1,
        output: "report",
        field: "x",
      });
    });
    const e = errors();
    expect(e).toContain("gates are pass/fail and never weighted");
    expect(e).toContain("quality checks need a weight");
    expect(e).toContain("duplicate check id");
    expect(e).toContain("unknown consequential action no-such-action");
    expect(e).toEqual(
      expect.arrayContaining([
        "setMatch needs expectedFrom",
        "setMatch needs metric",
        "setMatch needs threshold",
      ]),
    );
  });

  it("warns when no security gate is defined", () => {
    editSpec((d) => {
      d.checks = checks(d).filter((c) => c.severity !== "gate");
    });
    const f = lintSpec(loadSpec(dir));
    expect(f).toContainEqual(
      expect.objectContaining({
        level: "warning",
        message: "no mandatory security gate is defined",
      }),
    );
  });
});

describe("spec signatures", () => {
  it("round-trips: sign then verify as signed by a pinned owner", () => {
    signSpec(dir, t.env);
    expect(verifySpecSignature(loadSpec(dir), t.env).state).toBe("signed");
  });

  it("detects a spec edited after signing", () => {
    signSpec(dir, t.env);
    editSpec((d) => {
      (d.scoring as Record<string, unknown>).passThreshold = 10;
    });
    const r = verifySpecSignature(loadSpec(dir), t.env);
    expect(r.state).toBe("invalid");
    expect(r.reason).toMatch(/changed since it was signed/);
  });

  it("reports unsigned and untrusted signers", () => {
    expect(verifySpecSignature(loadSpec(dir), t.env).state).toBe("unsigned");
    signSpec(dir, t.env);
    // Replace the pinned owners with an unrelated key.
    const loc = resolvePolicyLocations(t.env);
    fs.rmSync(loc.ownersPath);
    const other = loadOrCreateDeviceIdentity(path.join(t.home, "other.json"));
    const raw = other.publicKeyPem
      .split("\n")
      .filter((l) => l && !l.startsWith("-----"))
      .join("");
    const der = Buffer.from(raw, "base64");
    addOwner(loc.ownersPath, { publicKey: der.subarray(der.length - 32).toString("base64url") });
    expect(verifySpecSignature(loadSpec(dir), t.env).state).toBe("untrusted");
  });
});
