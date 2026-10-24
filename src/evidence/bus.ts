// Evidence signals (KoLo 2.0, M12): a tiny in-process bus so the permission guard and the snapshot
// wrapper can report decisions without depending on the recorder. Signals are keyed by session
// key; a recorder subscribes for the lifetime of its job. No listener: nothing happens.

export type EvidenceSignal =
  | {
      kind: "permission";
      sessionKey: string;
      tool: string;
      decision: "allow" | "deny";
      toolClass?: string;
      target?: string;
      rule?: string;
      reason?: string;
      auditSeq?: number;
    }
  | {
      kind: "redaction";
      sessionKey: string;
      tool: string;
      /** Masked values per kind (EMAIL, PHONE, NAME …); never the values themselves. */
      counts: Record<string, number>;
      /** Placeholders replaced by real values in this call's arguments. */
      restored: number;
    }
  | {
      /** A human decision on a policy `ask` (Workflow Evaluator: approvals as evidence). */
      kind: "approval";
      sessionKey: string;
      tool: string;
      decision: "allow" | "deny";
      ruleId?: string;
      approvalId?: string;
      /** Who decided, as reported by the approval path (device/user id); null when unknown. */
      approver?: string | null;
      argsDigest?: string;
    }
  | {
      kind: "snapshot";
      sessionKey: string;
      snapshotId: string;
      tool: string;
      files: Array<{
        path: string;
        existed: boolean;
        hash?: string;
        size: number;
        skipped?: string;
      }>;
    };

type Listener = (signal: EvidenceSignal) => void;

const listeners = new Map<string, Set<Listener>>();

function normalizeKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

export function subscribeEvidenceSignals(sessionKey: string, listener: Listener): () => void {
  const key = normalizeKey(sessionKey);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(key);
    }
  };
}

export function emitEvidenceSignal(signal: EvidenceSignal): void {
  const set = listeners.get(normalizeKey(signal.sessionKey));
  if (!set) {
    return;
  }
  for (const listener of set) {
    try {
      listener(signal);
    } catch {
      // Evidence must never break the tool call that produced the signal.
    }
  }
}

export function hasEvidenceListeners(sessionKey: string): boolean {
  return (listeners.get(normalizeKey(sessionKey))?.size ?? 0) > 0;
}
