// End to end, no model: a project made from the industry/legacy template gets the legacy
// analyser for that project only, the agent tool layer exposes it in every mode, and the facts
// come back with file:line. Runs against a temporary copy of the demo pack
// (~/kurahi-demo-packs/industry-legacy-cobol, or KURAHI_LEGACY_DEMO_PACK), without _answer-keys.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import type { ProjectMode } from "./types.js";
import { createKoLoCodingTools } from "../agents/pi-tools.js";
import { flushAudit } from "../audit/audit-log.js";
import { projectsHandlers } from "../gateway/server-methods/projects.js";
import { LEGACY_ANALYZER_TOOLS, projectSessionKey } from "./scope.js";
import { setProjectMode } from "./store.js";

const PACK =
  process.env.KURAHI_LEGACY_DEMO_PACK ??
  // The test setup isolates HOME; the demo pack lives in the real home directory.
  path.join(os.userInfo().homedir, "kurahi-demo-packs", "industry-legacy-cobol");
const hasPack = fs.existsSync(path.join(PACK, "source", "cobol", "PAYCALC.cbl"));

// Global config: the analyser is NOT enabled for the gateway. The allowlist only keeps the
// gateway registry from loading unrelated bundled plugins in this test.
const config: KoLoConfig = { plugins: { allow: ["legacy-analyzer"] } };

type Text = { content: Array<{ type: string; text?: string }> };
const textOf = (r: Text) => r.content.find((c) => c.type === "text")?.text ?? "";

describe.skipIf(!hasPack)("legacy template → legacy analyser (no model)", () => {
  const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
  let root: string;
  let folder: string;
  let projectId: string;
  let paycalcLines: string[];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-legacy-e2e-"));
    const home = path.join(root, "state");
    fs.mkdirSync(home);
    process.env.KOLO_HOME = home;
    process.env.KOLO_STATE_DIR = home;
    folder = path.join(root, "client", "payroll");
    fs.cpSync(PACK, folder, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("_answer-keys"),
    });
    // A hidden answer key deeper in the tree: the analyser and the guard must never reach it.
    const keys = path.join(folder, "source", "cobol", "_answer-keys");
    fs.mkdirSync(keys);
    fs.writeFileSync(
      path.join(keys, "ANSWER.cbl"),
      [
        "       IDENTIFICATION DIVISION.",
        "       PROGRAM-ID. ANSWER.",
        "       DATA DIVISION.",
        "       WORKING-STORAGE SECTION.",
        "       01  WS-ANSWER-KEY-RATE  PIC 9V99 VALUE 9.99.",
        "       PROCEDURE DIVISION.",
        "           STOP RUN.",
        "",
      ].join("\n"),
    );
    paycalcLines = fs
      .readFileSync(path.join(folder, "source", "cobol", "PAYCALC.cbl"), "utf8")
      .split(/\r?\n/);

    let created: { id: string; plugins?: string[]; templateId: string | null } | undefined;
    let failure: unknown;
    void projectsHandlers["projects.create"]({
      params: { name: "Payroll", folder, templateId: "industry-legacy-modernisation" },
      respond: (ok: boolean, payload: unknown, err: unknown) => {
        if (ok) {
          created = (payload as { project: typeof created }).project;
        } else {
          failure = err;
        }
      },
      client: null,
    } as never);
    expect(failure).toBeUndefined();
    expect(created?.templateId).toBe("industry-legacy-modernisation");
    expect(created?.plugins).toEqual(["legacy-analyzer"]);
    projectId = created!.id;
  });

  afterAll(async () => {
    await flushAudit();
    process.env.KOLO_HOME = saved.home;
    process.env.KOLO_STATE_DIR = saved.state;
    if (saved.home === undefined) {
      delete process.env.KOLO_HOME;
    }
    if (saved.state === undefined) {
      delete process.env.KOLO_STATE_DIR;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function toolsFor(sessionKey: string) {
    return createKoLoCodingTools({
      sessionKey,
      workspaceDir: path.join(root, "agent-workspace"),
      config,
    });
  }

  /** Line number (1-based) of the declaration of `name` in PAYCALC.cbl. */
  const declLine = (name: string) =>
    paycalcLines.findIndex((l) => new RegExp(`\\b05\\s+${name}\\b`).test(l)) + 1;

  it("is not enabled for the gateway: an ordinary session has no analyser tools", () => {
    const names = toolsFor("agent:main:main").map((t) => t.name);
    for (const name of LEGACY_ANALYZER_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  it.each(["read", "plan", "act"] as ProjectMode[])(
    "the project session has the analyser tools in %s mode",
    (mode) => {
      setProjectMode(projectId, mode);
      const names = toolsFor(projectSessionKey("main", projectId, "c1")).map((t) => t.name);
      for (const name of LEGACY_ANALYZER_TOOLS) {
        expect(names).toContain(name);
      }
    },
  );

  it("read mode still refuses writes (the analyser does not widen the scope)", async () => {
    setProjectMode(projectId, "read");
    const write = toolsFor(projectSessionKey("main", projectId, "c0")).find(
      (t) => t.name === "write",
    )!;
    await expect(
      write.execute("w1", { path: path.join(folder, "output", "x.md"), content: "x" }),
    ).rejects.toThrow(/read mode|not allowed|denied/i);
  });

  it("index, then rules: the PAYCALC overtime constants come back with file:line", async () => {
    setProjectMode(projectId, "read");
    const tools = toolsFor(projectSessionKey("main", projectId, "c2"));
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    const indexed = JSON.parse(textOf(await tool("legacy_index").execute("i1", { path: folder })));
    expect(indexed.programs ?? indexed.counts).toBeTruthy();
    expect(JSON.stringify(indexed)).not.toContain("_answer-keys");

    const res = await tool("legacy_rules").execute("r1", { path: folder, program: "PAYCALC" });
    const text = textOf(res);
    expect(text).not.toMatch(/_answer-keys|WS-ANSWER-KEY-RATE|9\.99/);
    const out = JSON.parse(text) as {
      candidates: Array<{
        kind: string;
        file: string;
        line: number;
        source: string;
        namedConstants: Array<{ name: string; value: string; file: string; line: number }>;
      }>;
    };
    const constants = new Map<string, string>();
    for (const c of out.candidates) {
      for (const k of c.namedConstants) {
        constants.set(k.name, `${k.value} @ ${k.file}:${k.line}`);
      }
      if (c.kind === "constant") {
        const m = /\b05\s+([A-Z0-9-]+)\b.*VALUE\s+([0-9]+(?:\.[0-9]+)?)/.exec(c.source);
        if (m) {
          constants.set(m[1], `${m[2]} @ ${c.file}:${c.line}`);
        }
      }
    }
    const file = "source/cobol/PAYCALC.cbl";
    const expectConst = (name: string, value: string) => {
      const got = constants.get(name);
      expect(got, name).toBeDefined();
      const [v, where] = got!.split(" @ ");
      expect(Number(v)).toBe(Number(value));
      expect(where).toBe(`${file}:${declLine(name)}`);
      expect(declLine(name)).toBeGreaterThan(0);
    };
    expectConst("WS-OT1-RATE", "1.25");
    expectConst("WS-OT2-RATE", "1.50");
    expectConst("WS-OT-TIER-HOURS", "60");

    // The overtime arithmetic is a candidate too, at its own file:line.
    const ot2 = out.candidates.find(
      (c) => c.kind === "arithmetic" && /WS-OT2-RATE/.test(c.source) && c.file === file,
    );
    expect(ot2).toBeDefined();
    expect(paycalcLines[ot2!.line - 1]).toContain("WS-OT2-RATE");

    // The dated SME deferral (1.25 before the deferral ended) is a separate, guarded fact.
    const deferral = out.candidates.find(
      (c) => c.kind === "literal-assignment" && /MOVE 1\.25 TO WS-OT2-RATE/.test(c.source),
    ) as { line: number; guards?: string[] } | undefined;
    expect(deferral).toBeDefined();
    expect(paycalcLines[deferral!.line - 1]).toMatch(/MOVE\s+1\.25\s+TO\s+WS-OT2-RATE/);
    expect(deferral!.guards?.join(" ")).toMatch(/WS-PERIOD/);
  });

  it("read mode: the design document and the wave plan cite the demo pack's source lines", async () => {
    setProjectMode(projectId, "read");
    const tools = toolsFor(projectSessionKey("main", projectId, "c4"));
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const doc = textOf(
      await tool("legacy_design_doc").execute("d1", {
        path: folder,
        lang: "ja",
        program: "PAYCALC",
      }),
    );
    expect(doc).toContain("プログラム仕様書");
    expect(doc).toContain(`source/cobol/PAYCALC.cbl:${declLine("WS-OT2-RATE")}`);
    expect(doc).not.toContain("_answer-keys/");
    const plan = textOf(await tool("legacy_wave_plan").execute("w1", { path: folder, lang: "en" }));
    expect(plan).toMatch(/Proposal for human review/);
    expect(plan).toMatch(/wave 1: [^;]*PAYRND/);
  });

  it("never reaches _answer-keys and never leaves the project folder", async () => {
    setProjectMode(projectId, "act");
    const tools = toolsFor(projectSessionKey("main", projectId, "c3"));
    const index = tools.find((t) => t.name === "legacy_index")!;
    await expect(
      index.execute("x1", { path: path.join(folder, "source", "cobol", "_answer-keys") }),
    ).rejects.toThrow();
    const outside = fs.mkdtempSync(path.join(root, "outside-"));
    fs.copyFileSync(
      path.join(folder, "source", "cobol", "PAYCALC.cbl"),
      path.join(outside, "PAYCALC.cbl"),
    );
    await expect(index.execute("x2", { path: outside })).rejects.toThrow();
    // The analyser's cache folder (index, latest design document and wave plan) is its only
    // write, inside the project's output/.
    const cache = path.join(folder, "output", ".legacy-index");
    expect(fs.existsSync(cache)).toBe(true);
    expect(
      fs
        .readdirSync(cache)
        .every((n) => /^(index-.*\.json|design-doc-.*\.md|wave-plan-.*\.md)$/.test(n)),
    ).toBe(true);
  });
});
