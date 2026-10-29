import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BoundedExecResult } from "./bounded-exec.js";
import {
  collectYaraRules,
  createClamavScanner,
  createDefenderScanner,
  createNoneScanner,
  createYaraScanner,
  type FileScanner,
  resolveScanner,
  type ScannerHost,
  scanWithDeadline,
  wslAutomountRoot,
  wslDefenderPath,
} from "./scanner.js";

type Call = { argv: string[]; env: Record<string, string>; timeoutMs: number };

function host(opts: {
  platform?: NodeJS.Platform;
  wsl?: boolean;
  files?: string[];
  bins?: Record<string, string>;
  rules?: string[] | null;
  reply: (argv: string[]) => Partial<BoundedExecResult>;
}): ScannerHost & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    platform: opts.platform ?? "linux",
    wsl: opts.wsl ?? false,
    exists: (f) => (opts.files ?? []).includes(f),
    which: (n) => opts.bins?.[n] ?? null,
    env: { PATH: "/usr/bin", SECRET_TOKEN: "must-not-leak", ProgramFiles: "C:\\Program Files" },
    now: () => 0,
    wslDefenderPath: wslDefenderPath("/wsl-root/"),
    yaraRules: () => (opts.rules === undefined ? ["/rules/a.yar", "/rules/b.yara"] : opts.rules),
    exec: async (argv, o) => {
      calls.push({ argv, env: o.env, timeoutMs: o.timeoutMs });
      return {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        ...opts.reply(argv),
      };
    },
  };
}

const opts = { timeoutMs: 5000 };

describe("clamav adapter", () => {
  it("prefers clamdscan --fdpass, clean on exit 0, with a minimal environment", async () => {
    const h = host({
      bins: { clamdscan: "/usr/bin/clamdscan", clamscan: "/usr/bin/clamscan" },
      reply: () => ({ code: 0 }),
    });
    const s = createClamavScanner(h)!;
    expect(s.name).toBe("clamav");
    expect(await s.scan("/q/f", opts)).toMatchObject({ verdict: "clean", scanner: "clamav" });
    expect(h.calls[0].argv).toEqual([
      "/usr/bin/clamdscan",
      "--fdpass",
      "--no-summary",
      "--infected",
      "/q/f",
    ]);
    expect(h.calls[0].env.SECRET_TOKEN).toBeUndefined();
    expect(h.calls[0].timeoutMs).toBe(5000);
  });

  it("falls back to clamscan --no-summary", async () => {
    const h = host({ bins: { clamscan: "/usr/bin/clamscan" }, reply: () => ({ code: 0 }) });
    await createClamavScanner(h)!.scan("/q/f", opts);
    expect(h.calls[0].argv).toEqual(["/usr/bin/clamscan", "--no-summary", "--infected", "/q/f"]);
  });

  it("infected on exit 1 with the signature", async () => {
    const h = host({
      bins: { clamscan: "/usr/bin/clamscan" },
      reply: () => ({ code: 1, stdout: "/q/f: Win.Test.EICAR_HDB-1 FOUND\n" }),
    });
    expect(await createClamavScanner(h)!.scan("/q/f", opts)).toMatchObject({
      verdict: "infected",
      signature: "Win.Test.EICAR_HDB-1",
    });
  });

  it.each([
    [{ code: 2, stderr: "daemon not running" }, /exit 2/],
    [{ code: null, signal: "SIGSEGV" as NodeJS.Signals }, /SIGSEGV/],
    [{ code: null, timedOut: true }, /timed out/],
  ])("fails closed: %o", async (reply, detail) => {
    const h = host({ bins: { clamscan: "/usr/bin/clamscan" }, reply: () => reply });
    const v = await createClamavScanner(h)!.scan("/q/f", opts);
    expect(v.verdict).toBe("error");
    expect(v.detail).toMatch(detail);
  });

  it("is unavailable when neither binary is installed", () => {
    expect(createClamavScanner(host({ reply: () => ({}) }))).toBeNull();
  });
});

describe("defender adapter", () => {
  const WSL_EXE = wslDefenderPath("/wsl-root/");
  const WIN_EXE = "C:\\Program Files\\Windows Defender\\MpCmdRun.exe";

  it("on Windows: MpCmdRun -Scan -ScanType 3 -File <path> -DisableRemediation, clean on 0", async () => {
    const h = host({
      platform: "win32",
      files: [WIN_EXE],
      reply: () => ({ code: 0, stdout: "Scanning C:\\q\\f found no threats.\r\n" }),
    });
    const s = createDefenderScanner(h)!;
    expect(await s.scan("C:\\q\\f", opts)).toMatchObject({ verdict: "clean", scanner: "defender" });
    expect(h.calls[0].argv).toEqual([
      WIN_EXE,
      "-Scan",
      "-ScanType",
      "3",
      "-File",
      "C:\\q\\f",
      "-DisableRemediation",
    ]);
  });

  it("from WSL: translates the path with wslpath -w, infected on exit 2", async () => {
    const h = host({
      wsl: true,
      files: [WSL_EXE],
      reply: (argv) =>
        argv[0] === "wslpath"
          ? { code: 0, stdout: "\\\\wsl.localhost\\Distro\\q\\f\n" }
          : {
              code: 2,
              stdout:
                "found 1 threats.\r\nThreat                  : Virus:DOS/EICAR_Test_File\r\nResources : 1 total\r\n",
            },
    });
    const v = await createDefenderScanner(h)!.scan("/q/f", opts);
    expect(v).toMatchObject({ verdict: "infected", signature: "Virus:DOS/EICAR_Test_File" });
    expect(h.calls[0].argv).toEqual(["wslpath", "-w", "/q/f"]);
    expect(h.calls[1].argv[0]).toBe(WSL_EXE);
    expect(h.calls[1].argv).toContain("\\\\wsl.localhost\\Distro\\q\\f");
  });

  it.each([
    ["exit 0 without the verdict line", { code: 0, stdout: "" }],
    ["an unknown exit code", { code: 2147942402, stdout: "CmdTool: Failed" }],
    ["a timeout", { code: null, timedOut: true }],
  ])("fails closed on %s", async (_what, reply) => {
    const h = host({ platform: "win32", files: [WIN_EXE], reply: () => reply });
    expect((await createDefenderScanner(h)!.scan("C:\\q\\f", opts)).verdict).toBe("error");
  });

  it("fails closed when wslpath fails", async () => {
    const h = host({ wsl: true, files: [WSL_EXE], reply: () => ({ code: 1 }) });
    expect(await createDefenderScanner(h)!.scan("/q/f", opts)).toMatchObject({
      verdict: "error",
      detail: "wslpath failed",
    });
    expect(h.calls).toHaveLength(1);
  });

  it("is unavailable off Windows and outside WSL", () => {
    expect(createDefenderScanner(host({ files: [WSL_EXE], reply: () => ({}) }))).toBeNull();
    expect(createDefenderScanner(host({ wsl: true, reply: () => ({}) }))).toBeNull();
  });
});

describe("yara adapter", () => {
  const bins = { yara: "/usr/bin/yara" };

  it("runs every rule file against the file, clean when nothing matches", async () => {
    const h = host({ bins, reply: () => ({ code: 0, stdout: "" }) });
    const s = createYaraScanner(h, "/rules")!;
    expect(s.name).toBe("yara");
    expect(await s.scan("/q/f", opts)).toMatchObject({ verdict: "clean", scanner: "yara" });
    expect(h.calls[0].argv).toEqual([
      "/usr/bin/yara",
      "--no-warnings",
      "-a",
      "4",
      "/rules/a.yar",
      "/rules/b.yara",
      "/q/f",
    ]);
    expect(h.calls[0].env.SECRET_TOKEN).toBeUndefined();
  });

  it("infected with the matching rule names", async () => {
    const h = host({
      bins,
      reply: () => ({ code: 0, stdout: "Ransom_Note /q/f\nEicar_Test /q/f\nRansom_Note /q/f\n" }),
    });
    expect(await createYaraScanner(h, "/rules")!.scan("/q/f", opts)).toMatchObject({
      verdict: "infected",
      signature: "Eicar_Test,Ransom_Note",
    });
  });

  it.each([
    ["a compile error", { code: 1, stderr: "error: syntax error" }, /exit 1/],
    ["a crash", { code: null, signal: "SIGSEGV" as NodeJS.Signals }, /SIGSEGV/],
    ["a timeout", { code: null, timedOut: true }, /timed out/],
    ["unreadable output", { code: 0, stdout: "warning: something odd\n" }, /unreadable/],
    ["truncated empty output", { code: 0, stdout: "", truncated: true }, /truncated/],
  ])("fails closed on %s", async (_what, reply, detail) => {
    const h = host({ bins, reply: () => reply });
    const v = await createYaraScanner(h, "/rules")!.scan("/q/f", opts);
    expect(v.verdict).toBe("error");
    expect(v.detail).toMatch(detail);
  });

  it("fails closed without rule files, and never runs yara", async () => {
    for (const rules of [[], null]) {
      const h = host({ bins, rules, reply: () => ({ code: 0 }) });
      expect((await createYaraScanner(h, "/rules")!.scan("/q/f", opts)).verdict).toBe("error");
      expect(h.calls).toHaveLength(0);
    }
  });

  it("is unavailable when yara is not installed", () => {
    expect(createYaraScanner(host({ reply: () => ({}) }), "/rules")).toBeNull();
  });
});

describe("YARA rule collection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-yara-rules-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("collects *.yar and *.yara recursively, sorted, and nothing else", () => {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "b.yara"), "");
    fs.writeFileSync(path.join(dir, "sub", "a.YAR"), "");
    fs.writeFileSync(path.join(dir, "notes.txt"), "");
    expect(collectYaraRules(dir)).toEqual(
      [path.join(dir, "b.yara"), path.join(dir, "sub", "a.YAR")].toSorted(),
    );
    expect(collectYaraRules(path.join(dir, "missing"))).toBeNull();
  });
});

describe("WSL Defender path", () => {
  it("follows the automount root of wsl.conf", () => {
    expect(wslAutomountRoot("")).toBe("/mnt/");
    expect(wslAutomountRoot('[automount]\nroot = "/win/"\n')).toBe("/win/");
    expect(wslAutomountRoot("[network]\nroot = /x/\n")).toBe("/mnt/");
    expect(wslDefenderPath("/win/")).toBe("/win/c/Program Files/Windows Defender/MpCmdRun.exe");
  });
});

describe("scanner selection", () => {
  it("none: every file is unscanned", async () => {
    expect(await createNoneScanner().scan("/q/f", opts)).toMatchObject({ verdict: "unscanned" });
  });

  it("auto: ClamAV, then Defender, then none", () => {
    const wsl = wslDefenderPath("/wsl-root/");
    const both = host({ wsl: true, files: [wsl], bins: { clamscan: "/c" }, reply: () => ({}) });
    expect(resolveScanner("auto", both).name).toBe("clamav");
    expect(resolveScanner("auto", host({ wsl: true, files: [wsl], reply: () => ({}) })).name).toBe(
      "defender",
    );
    expect(resolveScanner("auto", host({ reply: () => ({}) })).name).toBe("none");
  });

  it("yara only when named, and only with a rules folder", async () => {
    const h = host({ bins: { clamscan: "/c", yara: "/usr/bin/yara" }, reply: () => ({}) });
    expect(resolveScanner("auto", h).name).toBe("clamav");
    expect(resolveScanner("yara", h, { yaraRules: "/rules" }).name).toBe("yara");
    const noRules = resolveScanner("yara", h);
    expect(noRules.name).toBe("yara");
    expect(await noRules.scan("/q/f", opts)).toMatchObject({
      verdict: "error",
      detail: "yara is configured without a rules folder",
    });
    const missing = resolveScanner("yara", host({ reply: () => ({}) }), { yaraRules: "/rules" });
    expect((await missing.scan("/q/f", opts)).verdict).toBe("error");
  });

  it("an explicit scanner that is not installed fails every scan (never a silent none)", async () => {
    const s = resolveScanner("clamav", host({ reply: () => ({}) }));
    expect(s.name).toBe("clamav");
    expect((await s.scan("/q/f", opts)).verdict).toBe("error");
    const d = resolveScanner("defender", host({ reply: () => ({}) }));
    expect((await d.scan("/q/f", opts)).verdict).toBe("error");
  });

  it("the deadline turns a hanging or throwing adapter into an error", async () => {
    const hang: FileScanner = { name: "clamav", scan: () => new Promise(() => {}) };
    const t0 = Date.now();
    expect((await scanWithDeadline(hang, "/q/f", 50)).verdict).toBe("error");
    expect(Date.now() - t0).toBeLessThan(5000);
    const boom: FileScanner = {
      name: "defender",
      scan: async () => {
        throw new Error("spawn EACCES");
      },
    };
    expect(await scanWithDeadline(boom, "/q/f", 50)).toMatchObject({
      verdict: "error",
      scanner: "defender",
    });
  });
});
