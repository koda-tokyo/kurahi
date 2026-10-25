import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractTextIsolated } from "./isolated-extract.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-extract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("isolated text extraction", () => {
  it("extracts a docx in a child process (the real extractor)", async () => {
    const z = new JSZip();
    z.file(
      "word/document.xml",
      '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>請求書 42</w:t></w:r></w:p></w:body></w:document>',
    );
    const file = path.join(dir, "a.docx");
    fs.writeFileSync(file, await z.generateAsync({ type: "nodebuffer" }));
    const r = await extractTextIsolated("docx", file, { timeoutMs: 60_000 });
    expect(r).toMatchObject({ ok: true, text: "請求書 42" });
  }, 90_000);

  it("kills the child on timeout and reports it", async () => {
    const script = path.join(dir, "hang.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'fs.writeFileSync("pid", String(process.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const work = fs.mkdtempSync(path.join(dir, "w-"));
    const file = path.join(work, "x.txt");
    fs.writeFileSync(file, "x");
    const t0 = Date.now();
    const r = await extractTextIsolated("txt", file, { childScript: script, timeoutMs: 1500 });
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(10_000);
    const pid = Number(fs.readFileSync(path.join(work, "pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  }, 20_000);

  it("a crash or a heap overrun is a failure, never text", async () => {
    const crash = path.join(dir, "crash.mjs");
    fs.writeFileSync(crash, "process.exit(3);");
    const file = path.join(dir, "y.txt");
    fs.writeFileSync(file, "y");
    expect(await extractTextIsolated("txt", file, { childScript: crash })).toMatchObject({
      ok: false,
      code: "crashed",
    });
    const hog = path.join(dir, "hog.mjs");
    fs.writeFileSync(hog, "const a = []; for (;;) a.push(new Array(1e5).fill(Math.random()));");
    expect(
      await extractTextIsolated("txt", file, {
        childScript: hog,
        maxOldSpaceMb: 32,
        timeoutMs: 30_000,
      }),
    ).toMatchObject({ ok: false });
  }, 40_000);

  it("the child gets no environment from the gateway", async () => {
    process.env.KURAHI_TEST_SECRET = "s3cret";
    const probe = path.join(dir, "env.mjs");
    fs.writeFileSync(
      probe,
      'process.stdout.write(JSON.stringify({ ok: true, text: Object.keys(process.env).join(",") }) + "\\n");',
    );
    const file = path.join(dir, "z.txt");
    fs.writeFileSync(file, "z");
    const r = await extractTextIsolated("txt", file, { childScript: probe });
    delete process.env.KURAHI_TEST_SECRET;
    expect(r.ok).toBe(true);
    expect(r.ok && r.text).not.toMatch(/KURAHI_TEST_SECRET/);
  });
});
