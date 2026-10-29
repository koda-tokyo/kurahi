import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { appendAudit, flushAudit } from "../audit/audit-log.js";
import {
  escapeCefHeader,
  escapeCefValue,
  escapeSdParam,
  formatSiemMessage,
  frameOctetCounted,
  SIEM_MAX_MESSAGE_BYTES,
  SiemSink,
  startSiemExport,
} from "./siem.js";

const FIXED = { hostname: "kurahi-host", pid: 42, version: "2.4.0" };
const TS = "2026-10-30T01:02:03.000Z";

/** Collects octet-counted frames from a stream. */
function frameReader(onMessage: (m: string) => void) {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sp = buf.indexOf(0x20);
      if (sp < 0) {
        return;
      }
      const len = Number(buf.subarray(0, sp).toString("ascii"));
      if (buf.length < sp + 1 + len) {
        return;
      }
      onMessage(buf.subarray(sp + 1, sp + 1 + len).toString("utf8"));
      buf = buf.subarray(sp + 1 + len);
    }
  };
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) {
    await c();
  }
});

/** Close a server and every connection it accepted (a paused socket never sees the client go). */
function track(server: net.Server) {
  const sockets = new Set<net.Socket>();
  server.on("connection", (s: net.Socket) => sockets.add(s));
  server.on("secureConnection", (s: net.Socket) => sockets.add(s));
  closers.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) {
          s.destroy();
        }
        server.close(() => r());
      }),
  );
}

function tcpServer(): Promise<{ port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = net.createServer((s) => {
    s.on(
      "data",
      frameReader((m) => messages.push(m)),
    );
  });
  track(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as net.AddressInfo).port, messages }),
    ),
  );
}

describe("formatting", () => {
  it("formats RFC 5424 with escaped structured data and a BOM before the detail", () => {
    const msg = formatSiemMessage(
      {
        ts: TS,
        action: "guardian.scan.found",
        outcome: 'quarantined "x" \\ ]',
        source: "guardian.scan",
        severity: "high",
        identity: "operator",
        detail: { file: "a.docx" },
      },
      FIXED,
    );
    // facility 13 * 8 + severity 3 = 107
    expect(msg).toBe(
      `<107>1 ${TS} kurahi-host kurahi 42 guardian.scan.found [kurahi@32473 action="guardian.scan.found" outcome="quarantined \\"x\\" \\\\ \\]" source="guardian.scan" severity="high" identity="operator"] ﻿{"file":"a.docx"}`,
    );
  });

  it("keeps header fields printable ASCII and bounded", () => {
    const msg = formatSiemMessage(
      { ts: TS, action: "a béc".repeat(20), source: "s" },
      { ...FIXED, hostname: "host name" },
    );
    const [, , host, app, pid, msgid] = msg.split(" ");
    expect(host).toBe("host_name");
    expect(app).toBe("kurahi");
    expect(pid).toBe("42");
    expect(msgid).toMatch(/^[\x21-\x7e]{1,32}$/);
  });

  it("formats CEF with escaped header and extension values", () => {
    const msg = formatSiemMessage(
      {
        ts: TS,
        action: "shield.trip|x",
        outcome: "stopped",
        source: "shield",
        severity: "critical",
        seq: 7,
        detail: { note: "a=b\nc\\d" },
      },
      { ...FIXED, format: "cef" },
    );
    expect(msg.startsWith(`<106>1 ${TS} kurahi-host kurahi 42 shield.trip|x - CEF:0|`)).toBe(true);
    const cef = msg.slice(msg.indexOf("CEF:0"));
    expect(cef).toContain("|KODA SoKEN|Kurahi|2.4.0|shield.trip\\|x|shield.trip\\|x stopped|10|");
    expect(cef).toContain(`rt=${Date.parse(TS)} act=shield.trip|x outcome=stopped`);
    expect(cef).toContain("cn1Label=auditSeq cn1=7");
    // JSON escapes the newline and backslash; CEF then escapes `=` and `\`.
    expect(cef).toContain('msg={"note":"a\\=b\\\\nc\\\\\\\\d"}');
  });

  it("escapes per spec", () => {
    expect(escapeSdParam('a"b\\c]d')).toBe('a\\"b\\\\c\\]d');
    expect(escapeCefHeader("a|b\\c\nd")).toBe("a\\|b\\\\c d");
    expect(escapeCefValue("a=b\\c\r\nd")).toBe("a\\=b\\\\c\\r\\nd");
  });

  it("redacts secrets in the detail and bounds the message", () => {
    const msg = formatSiemMessage(
      { ts: TS, action: "x", source: "s", detail: { token: "sk-live-abcdef1234567890" } },
      FIXED,
    );
    expect(msg).not.toContain("sk-live-abcdef1234567890");
    const big = formatSiemMessage(
      { ts: TS, action: "x", source: "s", identity: "é".repeat(300), detail: "é".repeat(50_000) },
      FIXED,
    );
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(SIEM_MAX_MESSAGE_BYTES);
  });

  it("frames by octet count", () => {
    expect(frameOctetCounted("é1").toString("utf8")).toBe("3 é1");
  });
});

describe("transport", () => {
  it("sends octet-counted frames over TCP", async () => {
    const srv = await tcpServer();
    const sink = new SiemSink({ cfg: { host: "127.0.0.1", port: srv.port }, hostname: "h" });
    closers.push(() => sink.stop());
    sink.send({ ts: TS, action: "a.one", source: "t" });
    sink.send({ ts: TS, action: "a.two", source: "t", detail: "multi\nline" });
    await waitFor(() => srv.messages.length === 2);
    expect(srv.messages[0]).toContain(" a.one ");
    expect(srv.messages[1]).toContain("multi\\nline");
    expect(sink.stats()).toMatchObject({ sent: 2, dropped: 0, queued: 0, connected: true });
  });

  it("sends one datagram per message over UDP", async () => {
    const got: string[] = [];
    const sock = dgram.createSocket("udp4");
    sock.on("message", (m) => got.push(m.toString("utf8")));
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise<void>((r) => sock.close(() => r())));
    const sink = new SiemSink({
      cfg: { host: "127.0.0.1", port: sock.address().port, protocol: "udp", format: "cef" },
    });
    closers.push(() => sink.stop());
    sink.send({ ts: TS, action: "u.one", source: "t" });
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatch(/^<110>1 .* - CEF:0\|/);
  });

  it("drops the oldest when the SIEM is down, counts, and reports the drops once back", async () => {
    // Reserve a port, then close it so connects are refused.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const sink = new SiemSink({
      cfg: { host: "127.0.0.1", port },
      queueMax: 3,
      backoffMinMs: 20,
      backoffMaxMs: 40,
    });
    closers.push(() => sink.stop());
    const started = Date.now();
    for (let i = 0; i < 5; i++) {
      sink.send({ ts: TS, action: `e.${i}`, source: "t" });
    }
    // send never waits on the network
    expect(Date.now() - started).toBeLessThan(50);
    await waitFor(() => sink.stats().lastError !== null);
    expect(sink.stats()).toMatchObject({ queued: 3, dropped: 2, connected: false });

    const messages: string[] = [];
    const server = net.createServer((s) =>
      s.on(
        "data",
        frameReader((m) => messages.push(m)),
      ),
    );
    track(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    await waitFor(() => messages.length === 4);
    expect(messages[0]).toContain("guardian.siem.dropped");
    expect(messages[0]).toContain('{"dropped":2}');
    expect(messages.slice(1).map((m) => m.split(" ")[5])).toEqual(["e.2", "e.3", "e.4"]);
  });

  it("times out a connect that never completes", async () => {
    // A TLS client to a TCP server that never answers the handshake.
    const server = net.createServer(() => {});
    track(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const sink = new SiemSink({
      cfg: { host: "127.0.0.1", port: (server.address() as net.AddressInfo).port, protocol: "tls" },
      connectTimeoutMs: 50,
      backoffMinMs: 10_000,
    });
    closers.push(() => sink.stop());
    sink.send({ action: "x", source: "t" });
    await waitFor(() => sink.stats().lastError !== null);
    expect(sink.stats().lastError).toContain("connect timeout");
  });
});

let opensslOk = false;
let certDir = "";
beforeAll(() => {
  try {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), "siem-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-days",
        "1",
        "-keyout",
        path.join(certDir, "key.pem"),
        "-out",
        path.join(certDir, "cert.pem"),
      ],
      { stdio: "ignore", timeout: 15_000 },
    );
    opensslOk = true;
  } catch {
    opensslOk = false;
  }
});
afterAll(() => {
  if (certDir) {
    fs.rmSync(certDir, { recursive: true, force: true });
  }
});

describe("TLS", () => {
  async function tlsServer() {
    const messages: string[] = [];
    const server = tls.createServer(
      {
        key: fs.readFileSync(path.join(certDir, "key.pem")),
        cert: fs.readFileSync(path.join(certDir, "cert.pem")),
      },
      (s) =>
        s.on(
          "data",
          frameReader((m) => messages.push(m)),
        ),
    );
    track(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { port: (server.address() as net.AddressInfo).port, messages };
  }

  it("delivers over TLS when the CA bundle trusts the server", async (ctx) => {
    if (!opensslOk) {
      ctx.skip();
    }
    const srv = await tlsServer();
    const sink = new SiemSink({
      cfg: {
        host: "127.0.0.1",
        port: srv.port,
        protocol: "tls",
        ca: path.join(certDir, "cert.pem"),
      },
    });
    closers.push(() => sink.stop());
    sink.send({ ts: TS, action: "t.one", source: "t" });
    await waitFor(() => srv.messages.length === 1);
    expect(srv.messages[0]).toContain(" t.one ");
  });

  it("refuses a server certificate it cannot verify", async (ctx) => {
    if (!opensslOk) {
      ctx.skip();
    }
    const srv = await tlsServer();
    const sink = new SiemSink({
      cfg: { host: "127.0.0.1", port: srv.port, protocol: "tls" },
      backoffMinMs: 10_000,
    });
    closers.push(() => sink.stop());
    sink.send({ action: "t.two", source: "t" });
    await waitFor(() => sink.stats().lastError !== null);
    expect(srv.messages).toEqual([]);
    expect(sink.stats().sent).toBe(0);
  });

  it("refuses an unreadable CA bundle", async () => {
    const sink = new SiemSink({
      cfg: { host: "127.0.0.1", port: 1, protocol: "tls", ca: "/nonexistent/ca.pem" },
      backoffMinMs: 10_000,
    });
    closers.push(() => sink.stop());
    sink.send({ action: "x", source: "t" });
    await waitFor(() => sink.stats().lastError !== null);
    expect(sink.stats().lastError).toContain("CA bundle unreadable");
  });
});

describe("lifecycle", () => {
  it("closes a connection that completes after stop()", async () => {
    let closed = 0;
    let accepted = 0;
    const server = net.createServer((s) => {
      accepted += 1;
      s.on("close", () => {
        closed += 1;
      });
      s.resume();
    });
    track(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const sink = new SiemSink({
      cfg: { host: "127.0.0.1", port: (server.address() as net.AddressInfo).port },
    });
    sink.send({ action: "x", source: "t" });
    // The connect is in flight; stop before it resolves.
    await sink.stop();
    await waitFor(() => accepted === 1 && closed === 1);
    expect(sink.stats()).toMatchObject({ sent: 0, connected: false });
  });

  it("warns at start when the transport is not TLS", async () => {
    const warned: string[] = [];
    const log = { info: () => {}, warn: (m: string) => warned.push(m) };
    const tcp = startSiemExport({ cfg: { host: "127.0.0.1", port: 9 }, log });
    await tcp.stop();
    const udp = startSiemExport({ cfg: { host: "127.0.0.1", port: 9, protocol: "udp" }, log });
    await udp.stop();
    const tlsExp = startSiemExport({ cfg: { host: "127.0.0.1", port: 9, protocol: "tls" }, log });
    await tlsExp.stop();
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("protocol tcp sends audit details unencrypted");
    expect(warned[1]).toContain("protocol udp");
  });
});

describe("audit export", () => {
  it("exports appended audit entries while started, and stops cleanly", async () => {
    const srv = await tcpServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siem-audit-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const exp = startSiemExport({ cfg: { host: "127.0.0.1", port: srv.port } });
    await appendAudit({ action: "device.pair.approve", outcome: "ok", source: "test" }, { dir });
    await appendAudit({ action: "tool.exec", outcome: "denied", source: "test" }, { dir });
    await waitFor(() => srv.messages.length === 2);
    expect(srv.messages[0]).toContain('action="device.pair.approve"');
    expect(srv.messages[0]).toContain('seq="1"');
    // denied → warning (13 * 8 + 4)
    expect(srv.messages[1].startsWith("<108>1 ")).toBe(true);
    await exp.stop();
    await appendAudit({ action: "after.stop", outcome: "ok", source: "test" }, { dir });
    await flushAudit();
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.messages).toHaveLength(2);
  });
});
