// Guardian SIEM export (Kurahi Guardian, Phase 2): audit entries and Guardian events as syslog to
// the customer's SIEM. The only Guardian path that writes to an external system.
//
// Formats: RFC 5424 (structured data `kurahi@32473`) or ArcSight CEF carried in an RFC 5424 MSG.
// Transports: TCP and TLS with octet-counted framing (RFC 6587 3.4.1 / RFC 5425), UDP one
// message per datagram (RFC 5426). TLS verifies the server certificate always; `ca` adds a PEM
// bundle for a private CA. TCP stays the default for compatibility with plain syslog collectors,
// but TCP and UDP carry the (redacted) audit detail in clear text, so starting either logs a
// warning; use `tls` anywhere the path to the SIEM is not trusted.
//
// Never blocks the gateway: `send` only formats and enqueues. A small bounded queue drains one
// message at a time; when the SIEM is down the oldest messages are dropped and counted, and the
// count is sent as its own event once the SIEM is back. Connect and write are time-bounded.
// Details are redacted like the audit log and clipped; secrets never reach the wire.

import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import type { AuditEntry } from "../audit/audit-log.js";
import type { GuardianSiemConfig } from "../config/types.guardian.js";
import { onAuditAppend } from "../audit/audit-log.js";
import { redactAuditValue } from "../audit/redact.js";

export type SiemSeverity = "info" | "low" | "medium" | "high" | "critical";

export type SiemEvent = {
  ts?: Date | string;
  /** Dotted action, e.g. `guardian.scan.found`, `device.pair.approve`. */
  action: string;
  outcome?: string;
  /** Subsystem that raised the event (`guardian.scan`, `gateway.http`, …). */
  source: string;
  severity?: SiemSeverity;
  identity?: string | null;
  /** Audit chain sequence number, when the event is an audit entry. */
  seq?: number;
  /** Free-form context; redacted and clipped before it is formatted. */
  detail?: unknown;
};

/** RFC 5612 documentation PEN; a customer's SIEM keys on the SD-ID name. */
export const SIEM_SD_ID = "kurahi@32473";
const APP_NAME = "kurahi";
const VENDOR = "KODA SoKEN";
const PRODUCT = "Kurahi";
/** Facility 13: log audit. */
const FACILITY = 13;

const DETAIL_MAX_CHARS = 2000;
const FIELD_MAX_CHARS = 256;
/** Upper bound of one message on the wire; above it the detail is dropped. */
export const SIEM_MAX_MESSAGE_BYTES = 8192;
const QUEUE_MAX = 1000;
const CONNECT_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

const SYSLOG_SEVERITY: Record<SiemSeverity, number> = {
  critical: 2,
  high: 3,
  medium: 4,
  low: 5,
  info: 6,
};
const CEF_SEVERITY: Record<SiemSeverity, number> = {
  critical: 10,
  high: 8,
  medium: 5,
  low: 3,
  info: 1,
};

/** Severity of an audit entry: refusals warn, failures are errors, the rest is informational. */
export function auditSeverity(outcome: string): SiemSeverity {
  if (outcome === "failed" || outcome === "error") {
    return "high";
  }
  return outcome === "denied" ? "medium" : "info";
}

export function auditEntryToEvent(entry: AuditEntry): SiemEvent {
  return {
    ts: entry.ts,
    action: entry.action,
    outcome: entry.outcome,
    source: entry.source,
    severity: auditSeverity(entry.outcome),
    identity: entry.identity,
    seq: entry.seq,
    detail: entry.detail,
  };
}

// ---- formatting ----

/** RFC 5424 header field: printable US-ASCII without spaces, bounded, `-` when empty. */
function headerField(value: string, max: number): string {
  const v = value.replace(/[^\x21-\x7e]/g, "_").slice(0, max);
  return v || "-";
}

/** RFC 5424 6.3.3: `"`, `\` and `]` are escaped with a backslash inside PARAM-VALUE. */
export function escapeSdParam(value: string): string {
  return value.replace(/["\\\]]/g, (c) => `\\${c}`);
}

/** CEF header fields: `\` and `|` are escaped; line breaks are not allowed and become spaces. */
export function escapeCefHeader(value: string): string {
  return value.replace(/[\\|]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ");
}

/** CEF extension values: `\`, `=` and line breaks are escaped (`\n`, `\r`). */
export function escapeCefValue(value: string): string {
  return value
    .replace(/[\\=]/g, (c) => `\\${c}`)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function clipChars(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function detailText(detail: unknown): string {
  if (detail === undefined || detail === null) {
    return "";
  }
  let text: string;
  try {
    text = JSON.stringify(redactAuditValue(detail)) ?? "";
  } catch {
    text = '"[unserialisable]"';
  }
  return clipChars(text, DETAIL_MAX_CHARS);
}

function isoOf(ts: Date | string | undefined): string {
  const d = ts instanceof Date ? ts : ts ? new Date(ts) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export type FormatOptions = {
  format?: "rfc5424" | "cef";
  hostname?: string;
  pid?: number;
  version?: string;
};

function formatOnce(event: SiemEvent, opts: FormatOptions, withDetail: boolean): string {
  const sev = event.severity ?? "info";
  const pri = FACILITY * 8 + SYSLOG_SEVERITY[sev];
  const ts = isoOf(event.ts);
  const host = headerField(opts.hostname ?? os.hostname(), 255);
  const procid = headerField(String(opts.pid ?? process.pid), 128);
  const action = clipChars(event.action, FIELD_MAX_CHARS);
  const msgid = headerField(action, 32);
  const outcome = clipChars(event.outcome ?? "", FIELD_MAX_CHARS);
  const source = clipChars(event.source, FIELD_MAX_CHARS);
  const identity = clipChars(event.identity ?? "", FIELD_MAX_CHARS);
  const detail = withDetail ? detailText(event.detail) : "";
  const head = `<${pri}>1 ${ts} ${host} ${APP_NAME} ${procid} ${msgid}`;

  if (opts.format === "cef") {
    const ext: Array<[string, string]> = [
      ["rt", String(new Date(ts).getTime())],
      ["act", action],
      ["outcome", outcome],
      ["cs1Label", "source"],
      ["cs1", source],
    ];
    if (identity) {
      ext.push(["suser", identity]);
    }
    if (event.seq !== undefined) {
      ext.push(["cn1Label", "auditSeq"], ["cn1", String(event.seq)]);
    }
    if (detail) {
      ext.push(["msg", detail]);
    }
    const cef = [
      "CEF:0",
      escapeCefHeader(VENDOR),
      escapeCefHeader(PRODUCT),
      escapeCefHeader(opts.version ?? "-"),
      escapeCefHeader(action),
      escapeCefHeader(`${action} ${outcome}`.trim()),
      String(CEF_SEVERITY[sev]),
      ext.map(([k, v]) => `${k}=${escapeCefValue(v)}`).join(" "),
    ].join("|");
    return `${head} - ${cef}`;
  }

  const params: Array<[string, string]> = [
    ["action", action],
    ["outcome", outcome],
    ["source", source],
    ["severity", sev],
  ];
  if (identity) {
    params.push(["identity", identity]);
  }
  if (event.seq !== undefined) {
    params.push(["seq", String(event.seq)]);
  }
  const sd = `[${SIEM_SD_ID} ${params.map(([k, v]) => `${k}="${escapeSdParam(v)}"`).join(" ")}]`;
  // MSG: UTF-8 with the BOM RFC 5424 6.4 asks for; the redacted detail.
  return detail ? `${head} ${sd} ﻿${detail}` : `${head} ${sd}`;
}

/** One syslog message (without framing). Bounded by {@link SIEM_MAX_MESSAGE_BYTES}. */
export function formatSiemMessage(event: SiemEvent, opts: FormatOptions = {}): string {
  const full = formatOnce(event, opts, true);
  if (Buffer.byteLength(full, "utf8") <= SIEM_MAX_MESSAGE_BYTES) {
    return full;
  }
  return formatOnce(event, opts, false);
}

/** RFC 6587 octet counting: `<byte length> <message>`. */
export function frameOctetCounted(message: string): Buffer {
  const body = Buffer.from(message, "utf8");
  return Buffer.concat([Buffer.from(`${body.length} `, "ascii"), body]);
}

// ---- transport ----

export type SiemLog = { info: (m: string) => void; warn: (m: string) => void };

export type SiemSinkOptions = {
  cfg: GuardianSiemConfig;
  log?: SiemLog;
  queueMax?: number;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  hostname?: string;
  version?: string;
};

export type SiemStats = {
  queued: number;
  sent: number;
  dropped: number;
  connected: boolean;
  lastError: string | null;
};

type Conn = {
  write: (msg: string) => Promise<void>;
  close: () => void;
};

const noopLog: SiemLog = { info: () => {}, warn: () => {} };

function errText(err: unknown): string {
  return clipChars(err instanceof Error ? err.message : String(err), 200);
}

export class SiemSink {
  private readonly queue: string[] = [];
  private readonly log: SiemLog;
  private readonly queueMax: number;
  private conn: Conn | null = null;
  private draining = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  /** Drops not yet reported to the SIEM. */
  private unreported = 0;
  private readonly stats_: SiemStats = {
    queued: 0,
    sent: 0,
    dropped: 0,
    connected: false,
    lastError: null,
  };

  constructor(private readonly opts: SiemSinkOptions) {
    this.log = opts.log ?? noopLog;
    this.queueMax = Math.max(1, opts.queueMax ?? QUEUE_MAX);
    this.backoffMs = opts.backoffMinMs ?? BACKOFF_MIN_MS;
  }

  stats(): SiemStats {
    return { ...this.stats_, queued: this.queue.length };
  }

  /** Format and enqueue; never throws, never waits. */
  send(event: SiemEvent): void {
    if (this.stopped) {
      return;
    }
    let msg: string;
    try {
      msg = this.format(event);
    } catch (err) {
      this.log.warn(`siem: event not formatted (${errText(err)})`);
      return;
    }
    this.queue.push(msg);
    while (this.queue.length > this.queueMax) {
      this.queue.shift();
      this.stats_.dropped += 1;
      this.unreported += 1;
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.conn?.close();
    this.conn = null;
    this.stats_.connected = false;
  }

  private format(event: SiemEvent): string {
    return formatSiemMessage(event, {
      format: this.opts.cfg.format,
      hostname: this.opts.hostname,
      version: this.opts.version,
    });
  }

  private kick(): void {
    if (this.draining || this.timer || this.stopped) {
      return;
    }
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queue.length > 0) {
      try {
        if (!this.conn) {
          const conn = await this.connect();
          // stop() may have run while connecting: nothing would ever close this connection.
          if (this.stopped) {
            conn.close();
            return;
          }
          this.conn = conn;
          this.stats_.connected = true;
          this.log.info(`siem: connected to ${this.opts.cfg.host}:${this.opts.cfg.port}`);
        }
        if (this.unreported > 0) {
          const count = this.unreported;
          await this.conn.write(
            this.format({
              action: "guardian.siem.dropped",
              outcome: "failed",
              source: "guardian.siem",
              severity: "medium",
              detail: { dropped: count },
            }),
          );
          this.unreported -= count;
        }
        const msg = this.queue[0];
        await this.conn.write(msg);
        // The head may have been dropped while the write was in flight.
        if (this.queue[0] === msg) {
          this.queue.shift();
        }
        this.stats_.sent += 1;
        this.backoffMs = this.opts.backoffMinMs ?? BACKOFF_MIN_MS;
      } catch (err) {
        this.conn?.close();
        this.conn = null;
        if (this.stats_.connected || this.stats_.lastError === null) {
          this.log.warn(`siem: ${this.opts.cfg.host}:${this.opts.cfg.port} ${errText(err)}`);
        }
        this.stats_.connected = false;
        this.stats_.lastError = errText(err);
        this.scheduleRetry();
        return;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer) {
      return;
    }
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.backoffMaxMs ?? BACKOFF_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, wait);
    this.timer.unref?.();
  }

  private connect(): Promise<Conn> {
    const { cfg } = this.opts;
    const protocol = cfg.protocol ?? "tcp";
    return protocol === "udp" ? this.connectUdp() : this.connectStream(protocol === "tls");
  }

  private connectUdp(): Promise<Conn> {
    const { host, port } = this.opts.cfg;
    const type = net.isIPv6(host) ? "udp6" : "udp4";
    const sock = dgram.createSocket(type);
    sock.unref();
    sock.on("error", () => {
      // Surfaced through the send callback; a stray error must not crash the gateway.
    });
    return Promise.resolve({
      write: (msg) =>
        new Promise<void>((resolve, reject) => {
          sock.send(Buffer.from(msg, "utf8"), port, host, (err) => (err ? reject(err) : resolve()));
        }),
      close: () => {
        try {
          sock.close();
        } catch {
          // already closed
        }
      },
    });
  }

  private connectStream(secure: boolean): Promise<Conn> {
    const { host, port, ca } = this.opts.cfg;
    const connectTimeout = this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const writeTimeout = this.opts.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
    return new Promise<Conn>((resolve, reject) => {
      let socket: net.Socket;
      if (secure) {
        let caPem: Buffer | undefined;
        if (ca) {
          try {
            caPem = fs.readFileSync(ca);
          } catch (err) {
            reject(new Error(`CA bundle unreadable (${(err as NodeJS.ErrnoException).code})`));
            return;
          }
        }
        socket = tls.connect({
          host,
          port,
          ca: caPem,
          rejectUnauthorized: true,
          servername: net.isIP(host) ? undefined : host,
          minVersion: "TLSv1.2",
        });
      } else {
        socket = net.connect({ host, port });
      }
      socket.unref();
      let dead: Error | null = null;
      const timer = setTimeout(() => {
        socket.destroy(new Error("connect timeout"));
      }, connectTimeout);
      timer.unref?.();
      const onError = (err: Error) => {
        dead = err;
        clearTimeout(timer);
        reject(err);
      };
      socket.once("error", onError);
      socket.on("close", () => {
        dead ??= new Error("connection closed");
      });
      // The SIEM never talks back; anything it sends is discarded.
      socket.on("data", () => {});
      socket.once(secure ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.on("error", (err) => {
          dead = err;
        });
        resolve({
          write: (msg) =>
            new Promise<void>((res, rej) => {
              if (dead || socket.destroyed) {
                rej(dead ?? new Error("connection closed"));
                return;
              }
              const t = setTimeout(() => {
                socket.destroy(new Error("write timeout"));
                rej(new Error("write timeout"));
              }, writeTimeout);
              t.unref?.();
              socket.write(frameOctetCounted(msg), (err) => {
                clearTimeout(t);
                if (err || dead) {
                  rej(err ?? dead ?? new Error("connection closed"));
                } else {
                  res();
                }
              });
            }),
          close: () => socket.destroy(),
        });
      });
    });
  }
}

// ---- gateway wiring ----

let active: SiemSink | null = null;

/** Send a Guardian event to the configured SIEM, if any. Never throws, never waits. */
export function emitGuardianEvent(event: SiemEvent): void {
  active?.send(event);
}

/**
 * Gateway startup: export every audit entry this process appends, and Guardian events, to
 * `guardian.siem`. Returns the stop handle.
 */
export function startSiemExport(params: {
  cfg: GuardianSiemConfig;
  log?: SiemLog;
  version?: string;
}): { stop: () => Promise<void>; sink: SiemSink } {
  const sink = new SiemSink({ cfg: params.cfg, log: params.log, version: params.version });
  const unsubscribe = onAuditAppend((entry) => sink.send(auditEntryToEvent(entry)));
  active = sink;
  const protocol = params.cfg.protocol ?? "tcp";
  params.log?.info(
    `siem: exporting audit and Guardian events to ${params.cfg.host}:${params.cfg.port} (${protocol}, ${params.cfg.format ?? "rfc5424"})`,
  );
  if (protocol !== "tls") {
    params.log?.warn(
      `siem: protocol ${protocol} sends audit details unencrypted; set guardian.siem.protocol to "tls" unless the network path to the SIEM is trusted`,
    );
  }
  return {
    sink,
    stop: async () => {
      unsubscribe();
      if (active === sink) {
        active = null;
      }
      await sink.stop();
    },
  };
}
