// Structured startup phase timings for the gateway. `startGatewayServer` marks the end of each
// phase; the summary goes to the log once the gateway is serving, as one line plus a meta object
// (`startupPhases`) so `kurahi logs --json` and the health snapshot can read it back.
//
// `bootMs` is the time the process spent before `startGatewayServer` was entered (Node start,
// module loading, CLI parsing). It is measured from the process start, not from this module.

export type StartupPhase = { name: string; ms: number };

export type StartupPhaseSummary = {
  /** Process uptime when startGatewayServer was entered (module load + CLI). */
  bootMs: number;
  /** Time from entering startGatewayServer to the last mark. */
  serverMs: number;
  /** Process uptime at the last mark. */
  totalMs: number;
  phases: StartupPhase[];
};

export type StartupPhaseTimer = {
  /** Ends the current phase, naming it, and starts the next one. */
  mark: (name: string) => void;
  summary: () => StartupPhaseSummary;
  format: () => string;
};

let lastSummary: StartupPhaseSummary | null = null;

/** The most recent gateway startup summary in this process (null until a gateway started). */
export function getLastStartupPhases(): StartupPhaseSummary | null {
  return lastSummary;
}

export function createStartupPhaseTimer(
  now: () => number = () => performance.now(),
  uptimeMs: () => number = () => process.uptime() * 1000,
): StartupPhaseTimer {
  const bootMs = uptimeMs();
  const start = now();
  let last = start;
  const phases: StartupPhase[] = [];
  const summary = (): StartupPhaseSummary => {
    const s: StartupPhaseSummary = {
      bootMs: Math.round(bootMs),
      serverMs: Math.round(last - start),
      totalMs: Math.round(bootMs + (last - start)),
      phases: phases.map((p) => ({ name: p.name, ms: p.ms })),
    };
    lastSummary = s;
    return s;
  };
  return {
    mark(name) {
      const t = now();
      phases.push({ name, ms: Math.round(t - last) });
      last = t;
    },
    summary,
    format() {
      const s = summary();
      const parts = s.phases.map((p) => `${p.name}=${p.ms}ms`).join(" ");
      return `startup: ${s.totalMs}ms (boot ${s.bootMs}ms + server ${s.serverMs}ms) ${parts}`;
    },
  };
}
