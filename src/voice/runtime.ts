// Gateway glue for the voice manager: one manager per process, reading `voice.*` from the live
// config on every call, auditing through the audit log, and sending events to one connection
// through the sink the gateway installs at startup (server-runtime-state.ts).
import { auditSafe } from "../audit/audit-log.js";
import { loadConfig } from "../config/config.js";
import { resolveVoiceConfig } from "./config.js";
import { VoiceManager, type VoiceEventSink } from "./manager.js";

let sink: VoiceEventSink | null = null;
let manager: VoiceManager | null = null;

/** Installed by the gateway: sends one event frame to one connection id. */
export function setVoiceEventSink(next: VoiceEventSink | null): void {
  sink = next;
}

export function getVoiceManager(): VoiceManager {
  manager ??= new VoiceManager({
    config: () => resolveVoiceConfig(loadConfig().voice),
    sink: () => sink,
    audit: (input) => void auditSafe(input),
  });
  return manager;
}

/** Socket close: drop the connection's sessions (no-op when voice never ran). */
export function closeVoiceConnection(connId: string): void {
  if (manager) {
    void manager.closeConnection(connId);
  }
}

/** Gateway close: end every voice session and speech (temp audio removed). */
export async function stopVoice(): Promise<void> {
  if (manager) {
    await manager.shutdown();
  }
}

/** Tests: swap in a manager built with fakes, or reset to the lazy default. */
export function setVoiceManagerForTests(next: VoiceManager | null): void {
  manager = next;
}
