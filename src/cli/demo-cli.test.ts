import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { DemoInviteStore } from "../packaging/demo-invites.js";
import {
  DEMO_EXIT,
  demoInviteLink,
  registerDemoCli,
  runDemoInviteCreate,
  runDemoInviteList,
  runDemoInviteRevoke,
} from "./demo-cli.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-demo-cli-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
function harness() {
  const filePath = path.join(root, `invites-${++seq}.json`);
  const out: string[] = [];
  const err: string[] = [];
  const runtime: RuntimeEnv = {
    log: (...args) => void out.push(args.join(" ")),
    error: (...args) => void err.push(args.join(" ")),
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
  // A fresh store per call, like separate CLI runs against one file.
  const store = () => new DemoInviteStore({ filePath, audit: (e) => ({ ts: "", ...e }) });
  return { deps: { runtime, store, env: { KURAHI_DEMO: "1" } }, out, err, filePath, store };
}

function codeFrom(out: string[]): string {
  const line = out.find((l) => l.trim().startsWith("Code"));
  return line?.trim().split(/\s+/)[1] ?? "";
}

describe("kurahi demo invite", () => {
  it("prints the code once, keeps only its hash, and the code signs in", () => {
    const h = harness();
    const code = runDemoInviteCreate(
      { project: "pdemobiz001", label: "Tanaka, Example Corp", days: "3" },
      h.deps,
    );
    expect(code).toBe(DEMO_EXIT.ok);
    const invite = codeFrom(h.out);
    expect(invite.startsWith("kdi_")).toBe(true);
    expect(fs.readFileSync(h.filePath, "utf8")).not.toContain(invite);
    expect(h.store().resolve(invite).ok).toBe(true);
    expect(h.out.join("\n")).not.toContain("KURAHI_DEMO=1");
  });

  it("puts the code in the link fragment, never the query", () => {
    const h = harness();
    runDemoInviteCreate(
      { project: "pdemobiz001", label: "T", url: "https://demo.example.com/app?x=1" },
      h.deps,
    );
    const link =
      h.out
        .find((l) => l.includes("Link"))
        ?.trim()
        .split(/\s+/)[1] ?? "";
    expect(link).toBe(`https://demo.example.com/app?x=1#invite=${codeFrom(h.out)}`);
    expect(demoInviteLink("javascript:alert(1)", "kdi_x")).toBeNull();
    expect(demoInviteLink("not a url", "kdi_x")).toBeNull();
  });

  it("refuses bad usage before touching the store", () => {
    const h = harness();
    expect(runDemoInviteCreate({ project: "pdemobiz001", label: "T", days: "30" }, h.deps)).toBe(
      DEMO_EXIT.usage,
    );
    expect(runDemoInviteCreate({ project: "pdemobiz001", label: "T", days: "1.5" }, h.deps)).toBe(
      DEMO_EXIT.usage,
    );
    expect(
      runDemoInviteCreate({ project: "pdemobiz001", label: "T", url: "ftp://x" }, h.deps),
    ).toBe(DEMO_EXIT.usage);
    expect(runDemoInviteCreate({ project: "../etc", label: "T" }, h.deps)).toBe(DEMO_EXIT.usage);
    expect(runDemoInviteCreate({ project: "pdemobiz001" }, h.deps)).toBe(DEMO_EXIT.usage);
    expect(fs.existsSync(h.filePath)).toBe(false);
  });

  it("refuses a second live invite, lists without codes, and revoke bites the next sign-in", () => {
    const h = harness();
    runDemoInviteCreate({ project: "pdemobiz001", label: "Tanaka" }, h.deps);
    const invite = codeFrom(h.out);
    expect(runDemoInviteCreate({ project: "pdemobiz001", label: "Sato" }, h.deps)).toBe(
      DEMO_EXIT.refused,
    );

    h.out.length = 0;
    expect(runDemoInviteList({ json: true }, h.deps)).toBe(DEMO_EXIT.ok);
    const listed = h.out.join("\n");
    expect(listed).not.toContain("codeHash");
    expect(listed).not.toContain(invite);
    const [row] = JSON.parse(listed) as Array<{ id: string; status: string }>;
    expect(row.status).toBe("active");

    expect(runDemoInviteRevoke(row.id, h.deps)).toBe(DEMO_EXIT.ok);
    expect(h.store().resolve(invite)).toEqual({ ok: false, reason: "revoked" });
    expect(runDemoInviteRevoke(row.id, h.deps)).toBe(DEMO_EXIT.ok);
    expect(runDemoInviteRevoke("dinv_nope", h.deps)).toBe(DEMO_EXIT.usage);
  });

  it("warns outside the demo profile and wires the commands", async () => {
    const h = harness();
    runDemoInviteCreate({ project: "pdemobiz001", label: "T" }, { ...h.deps, env: {} });
    expect(h.out.join("\n")).toContain("KURAHI_DEMO=1");

    const program = new Command().exitOverride();
    registerDemoCli(program, h.deps);
    h.out.length = 0;
    await program.parseAsync(["demo", "invite", "list"], { from: "user" });
    expect(h.out.join("\n")).toContain("pdemobiz001");
    await expect(
      program.parseAsync(["demo", "invite", "revoke", "dinv_nope"], { from: "user" }),
    ).rejects.toThrow("exit 2");
  });
});
