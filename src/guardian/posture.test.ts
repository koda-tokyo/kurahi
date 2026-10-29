import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterAll, describe, expect, it } from "vitest";
import type { BoundedExecResult } from "../security/bounded-exec.js";
import { getDefaultRedactPatterns } from "../logging/redact.js";
import {
  checkBackupFreshness,
  checkCredentials,
  checkIntegrity,
  checkPorts,
  checkRestores,
  checkSecrets,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  type PortsHost,
  restoreTest,
  SECRET_DETECTOR_NAMES,
} from "./posture.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-guardian-posture-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;
const fresh = (name: string) => {
  const d = path.join(root, `${name}${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const HOUR = 3_600_000;

describe("backup freshness", () => {
  it("OK when the newest file is younger than maxAgeHours (default 26 h)", () => {
    const dir = fresh("bk");
    fs.mkdirSync(path.join(dir, "daily"));
    fs.writeFileSync(path.join(dir, "daily", "db.dump"), "x");
    const t = fs.statSync(path.join(dir, "daily", "db.dump")).mtimeMs;
    expect(checkBackupFreshness([{ path: dir }], t + 25 * HOUR).findings).toEqual([]);
    const late = checkBackupFreshness([{ path: dir }], t + 27 * HOUR);
    expect(late.findings[0]).toMatchObject({ check: "backup", subject: dir });
    expect(late.findings[0].detail).toMatch(/27\.0 h old \(maximum 26 h\)/);
    expect(checkBackupFreshness([{ path: dir, maxAgeHours: 48 }], t + 27 * HOUR).findings).toEqual(
      [],
    );
  });

  it("fails closed: missing path, empty folder, nothing configured", () => {
    const empty = fresh("bk-empty");
    const r = checkBackupFreshness([{ path: path.join(empty, "nope") }, { path: empty }]);
    expect(r.findings.map((f) => f.detail)).toEqual([
      expect.stringMatching(/unreadable \(ENOENT\)/),
      "no backup files",
    ]);
    expect(checkBackupFreshness([]).findings).toHaveLength(1);
  });
});

describe("restore test", () => {
  it("restores a file from a backup folder and compares SHA-256; temp is removed", async () => {
    const dir = fresh("rs");
    fs.writeFileSync(path.join(dir, "a.txt"), "payroll");
    const tmpRoot = fresh("rs-tmp");
    const r = await restoreTest(dir, { tmpRoot });
    expect(r).toMatchObject({ status: "ok", member: "a.txt", bytes: 7 });
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("extracts one member of a .tar.gz and of a .zip", async () => {
    const src = fresh("rs-src");
    fs.mkdirSync(path.join(src, "d"));
    fs.writeFileSync(path.join(src, "d", "ledger.csv"), "a,b\n1,2\n");
    const tgz = path.join(fresh("rs-arch"), "backup.tar.gz");
    await tar.c({ gzip: true, file: tgz, cwd: src }, ["d"]);
    expect(await restoreTest(tgz)).toMatchObject({ status: "ok", member: "d/ledger.csv" });

    const zip = new JSZip();
    zip.file("x/report.txt", "hello");
    const zipPath = path.join(path.dirname(tgz), "backup.zip");
    fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    expect(await restoreTest(zipPath)).toMatchObject({ status: "ok", member: "x/report.txt" });
  });

  it("refuses a zip member over the limit before inflating it, and removes its temp folder", async () => {
    const zip = new JSZip();
    zip.file("bomb.bin", Buffer.alloc(64 * 1024));
    const d = fresh("rs-bomb");
    const zipPath = path.join(d, "bomb.zip");
    fs.writeFileSync(
      zipPath,
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
    const tmpRoot = fresh("rs-bomb-tmp");
    const r = await restoreTest(zipPath, { tmpRoot, maxFileBytes: 1024 });
    expect(r).toEqual({
      status: "failed",
      detail: "zip member declares 65536 bytes, over the restore limit (1024)",
    });
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
    const fits = await restoreTest(zipPath, { tmpRoot, maxFileBytes: 64 * 1024 });
    expect(fits).toMatchObject({ status: "ok", bytes: 65536 });
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("a member that inflates beyond its declared size is cut off", async () => {
    const zip = new JSZip();
    zip.file("liar.bin", Buffer.alloc(4096, 7));
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    // Rewrite the central directory's uncompressed size (offset 24 of the 0x02014b50 record).
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(100, cd + 24);
    const d = fresh("rs-liar");
    fs.writeFileSync(path.join(d, "liar.zip"), buf);
    const r = await restoreTest(path.join(d, "liar.zip"));
    expect(r.status).toBe("failed");
  });

  it("reports unsupported formats, corrupt archives and missing backups", async () => {
    const d = fresh("rs-bad");
    const bak = path.join(d, "db.bak");
    fs.writeFileSync(bak, "x");
    expect(await restoreTest(bak)).toEqual({
      status: "unsupported",
      detail: "restore test unsupported for this format",
    });
    const broken = path.join(d, "broken.tar.gz");
    fs.writeFileSync(broken, "not a tarball at all");
    expect((await restoreTest(broken)).status).toBe("failed");
    expect((await restoreTest(path.join(d, "gone.zip"))).status).toBe("failed");
  });

  it("only backups with restoreTest are tested; none is a finding", async () => {
    const dir = fresh("rs-cfg");
    fs.writeFileSync(path.join(dir, "f"), "1");
    expect((await checkRestores([{ path: dir }])).findings).toHaveLength(1);
    const r = await checkRestores([{ path: dir, restoreTest: true }]);
    expect(r).toEqual({ facts: { tested: 1, restored: 1 }, findings: [] });
  });
});

describe("secrets in files", () => {
  it("names one detector per shared redaction pattern", () => {
    expect(SECRET_DETECTOR_NAMES).toHaveLength(getDefaultRedactPatterns().length);
  });

  it("reports path:line and the detector, never the value", () => {
    const dir = fresh("sec");
    const token = `ghp_${"a1B2".repeat(8)}`;
    fs.writeFileSync(
      path.join(dir, "notes.txt"),
      ["hello", `github = ${token}`, "DB_PASSWORD=${DB_PASSWORD}", "primary_key: id"].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "x.js"), `const k = "${token}";`);
    const r = checkSecrets([dir]);
    expect(r.findings).toEqual([
      { check: "secrets", subject: `${path.join(dir, "id_rsa")}:1`, detail: expect.any(String) },
      {
        check: "secrets",
        subject: `${path.join(dir, "notes.txt")}:2`,
        detail: "possible secret (github-token)",
      },
    ]);
    expect(r.findings[0].detail).toBe("possible secret (private-key)");
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.facts).toMatchObject({ secrets: 2, skippedBinary: 1 });
  });

  it("bounded: a file-count limit is a finding (the rest is unknown), large files are skipped", () => {
    const dir = fresh("sec-lim");
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), "nothing here");
    }
    fs.writeFileSync(path.join(dir, "big.log"), "x".repeat(5000));
    const r = checkSecrets([dir], { maxFiles: 3, maxFileBytes: 1000 });
    expect(r.facts.truncated).toBe(true);
    expect(r.findings.at(-1)?.detail).toMatch(/scan limit reached/);
    expect(checkSecrets([path.join(dir, "missing")]).findings[0].detail).toMatch(/unreadable/);
    expect(checkSecrets([]).findings).toHaveLength(1);
  });
});

describe("listening ports", () => {
  const procTcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid",
    "   0: 0100007F:4A26 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000",
    "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0",
    "   2: 0100007F:4A26 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000",
  ].join("\n");
  const procTcp6 = [
    "  sl  local_address                         remote_address                        st",
    "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A",
    "   1: 00000000000000000000000001000000:0277 00000000000000000000000000000000:0000 0A",
  ].join("\n");

  it("parses /proc/net/tcp and tcp6 LISTEN rows", () => {
    expect(parseProcNetTcp(procTcp, false)).toEqual([
      { address: "127.0.0.1", port: 18982 },
      { address: "0.0.0.0", port: 22 },
    ]);
    expect(parseProcNetTcp(procTcp6, true)).toEqual([
      { address: "::", port: 8080 },
      { address: "::1", port: 631 },
    ]);
  });

  it("parses lsof and netstat output", () => {
    expect(
      parseLsof(
        "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n" +
          "node 1 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:18790 (LISTEN)\n" +
          "sshd 2 r 3u IPv6 0x2 0t0 TCP *:22 (LISTEN)\n" +
          "cupsd 3 r 4u IPv6 0x3 0t0 TCP [::1]:631 (LISTEN)\n",
      ),
    ).toEqual([
      { address: "127.0.0.1", port: 18790 },
      { address: "0.0.0.0", port: 22 },
      { address: "::1", port: 631 },
    ]);
    expect(
      parseNetstat(
        "Active Connections\r\n\r\n  Proto  Local Address  Foreign Address  State  PID\r\n" +
          "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    900\r\n" +
          "  TCP    [::]:445       [::]:0       LISTENING    4\r\n" +
          "  TCP    10.0.0.5:50000 1.2.3.4:443  ESTABLISHED  77\r\n",
      ),
    ).toEqual([
      { address: "0.0.0.0", port: 135 },
      { address: "::", port: 445 },
    ]);
  });

  const linuxHost = (files: Record<string, string>): PortsHost => ({
    platform: "linux",
    env: {},
    exec: async () => {
      throw new Error("no exec on linux");
    },
    readFile: (f) => {
      if (!(f in files)) {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }
      return files[f];
    },
  });

  it("non-loopback listeners outside allowedPorts are findings", async () => {
    const host = linuxHost({ "/proc/net/tcp": procTcp, "/proc/net/tcp6": procTcp6 });
    const r = await checkPorts([22], { host });
    expect(r.findings).toEqual([
      { check: "ports", subject: ":::8080", detail: "port 8080 is not allowed" },
    ]);
    expect(r.facts).toMatchObject({ available: true, loopbackOnly: 2 });
    const strict = await checkPorts([22, 8080], { host, includeLoopback: true });
    expect(strict.findings.map((f) => f.subject)).toEqual(["127.0.0.1:18982", "::1:631"]);
    const unset = await checkPorts(undefined, { host });
    expect(unset.findings[0].subject).toBe("guardian.posture.allowedPorts");
  });

  it("fails closed when the table or the tool cannot be read; unsupported platforms say so", async () => {
    expect((await checkPorts([22], { host: linuxHost({}) })).findings[0].detail).toMatch(
      /unreadable/,
    );
    const reply = (r: Partial<BoundedExecResult>): PortsHost => ({
      platform: "darwin",
      env: { PATH: "/usr/bin", SECRET: "x" },
      readFile: () => "",
      exec: async (_argv, o) => {
        expect(o.env.SECRET).toBeUndefined();
        return {
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          ...r,
        };
      },
    });
    expect(
      (await checkPorts([22], { host: reply({ timedOut: true, code: null }) })).findings[0].detail,
    ).toMatch(/timed out/);
    expect((await checkPorts([22], { host: reply({ code: 1, stdout: "" }) })).findings).toEqual([]);
    const aix: PortsHost = { ...reply({}), platform: "aix" };
    expect((await checkPorts([22], { host: aix })).findings[0].detail).toMatch(/unsupported/);
  });
});

describe("Kurahi integrity", () => {
  it("an unconfigured registry is a finding, not a pass", () => {
    const home = fresh("int");
    const loc = {
      home,
      dir: path.join(home, "integrity"),
      registryPath: path.join(home, "integrity", "registry.json"),
      keyPath: path.join(home, "secrets", "integrity.key"),
    };
    const r = checkIntegrity(loc);
    expect(r.facts.state).toBe("unconfigured");
    expect(r.findings).toHaveLength(1);
    fs.mkdirSync(path.dirname(loc.keyPath), { recursive: true });
    fs.writeFileSync(loc.keyPath, "k");
    const deleted = checkIntegrity(loc);
    expect(deleted.facts.state).toBe("failed");
    expect(deleted.findings[0].detail).toMatch(/registry/);
  });
});

describe("expiring credentials", () => {
  const now = Date.UTC(2026, 9, 30);
  const DAY = 86_400_000;

  it("static tokens and non-refreshable OAuth within the window; never values", () => {
    const file = path.join(fresh("cred"), "auth-profiles.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        profiles: {
          "gh:default": {
            type: "token",
            provider: "gh",
            token: "SECRETVALUE1",
            expires: now + 3 * DAY,
          },
          "old:default": {
            type: "token",
            provider: "old",
            token: "SECRETVALUE2",
            expires: now - DAY,
          },
          "far:default": { type: "token", provider: "far", token: "x", expires: now + 90 * DAY },
          "llm:default": { type: "api_key", provider: "llm", key: "SECRETVALUE3" },
          "o:refresh": { type: "oauth", provider: "o", access: "a", refresh: "r", expires: now },
          "o:norefresh": { type: "oauth", provider: "o", access: "a", expires: now + DAY },
        },
      }),
    );
    const r = checkCredentials(file, 14, now);
    expect(r.findings.map((f) => f.subject)).toEqual(["gh:default", "o:norefresh", "old:default"]);
    expect(r.findings[2].detail).toMatch(/expired 1\.0 day/);
    expect(r.facts).toMatchObject({
      credentialStore: "present",
      profiles: 6,
      withExpiry: 4,
      refreshable: 1,
      noExpiryData: 1,
    });
    expect(JSON.stringify(r)).not.toMatch(/SECRETVALUE/);
  });

  it("no store is nothing to expire; an unreadable store is a finding", () => {
    const d = fresh("cred2");
    const none = checkCredentials(path.join(d, "none.json"));
    expect(none.findings).toEqual([]);
    expect(none.facts.credentialStore).toBe("none");
    fs.writeFileSync(path.join(d, "bad.json"), "{not json");
    expect(checkCredentials(path.join(d, "bad.json")).findings[0].detail).toMatch(/unreadable/);
  });
});
