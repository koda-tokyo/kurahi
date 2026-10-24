// Reference driver for workflow (iii), "csv-inspection.exceptions": a scripted resident that
// reads the day's inspection CSV, flags out-of-tolerance readings, writes the exceptions report,
// asks for approval and sends it. Every step goes through the simulated-tool layer, so the
// evidence it leaves is the same shape a model-driven resident leaves.
//
// The MVP replays this deterministic driver. A model-driven agent plugs in behind the same
// `WorkflowDriver` interface once a model is configured for evaluation runs.
import type { SimulatedTools } from "../simulate.js";

export type DriverContext = {
  tools: SimulatedTools;
  fixtureId: string;
  /** Faults for tests: make the driver misbehave in a controlled way. */
  faults?: {
    skipRows?: string[];
    extraRows?: string[];
    sendWithoutApproval?: boolean;
    sendTwice?: boolean;
    dropSources?: boolean;
    delayMs?: number;
  };
};

export type DriverResult = { outputs: Array<{ name: string; path: string }>; summary: string };

export type WorkflowDriver = (ctx: DriverContext) => DriverResult;

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.length > 0);
  const cols = (head ?? "").split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

export const csvInspectionDriver: WorkflowDriver = (ctx) => {
  const { tools, faults } = ctx;
  const read = tools.call("read_file", { path: "input.csv" });
  if (!read.ok || typeof read.result !== "string") {
    return { outputs: [], summary: "could not read the inspection file" };
  }
  const rows = parseCsv(read.result);
  const exceptions: Array<Record<string, unknown>> = [];
  rows.forEach((r, i) => {
    const measured = Number(r.measured);
    const lower = Number(r.lower_limit);
    const upper = Number(r.upper_limit);
    const out = Number.isFinite(measured) && (measured < lower || measured > upper);
    const forced = faults?.extraRows?.includes(r.row_id ?? "");
    if ((out && !faults?.skipRows?.includes(r.row_id ?? "")) || forced) {
      exceptions.push({
        rowId: r.row_id,
        characteristic: r.characteristic,
        measured,
        lowerLimit: lower,
        upperLimit: upper,
        unit: r.unit,
        source: faults?.dropSources ? "" : `input.csv#row=${i + 1}`,
      });
    }
  });
  const report = { fixture: ctx.fixtureId, rowsChecked: rows.length, exceptions };
  tools.call("write_file", {
    path: "reports/exceptions.json",
    content: `${JSON.stringify(report, null, 2)}\n`,
  });
  const send = {
    to: "quality-line3@example.invalid",
    subject: `Line 3 inspection exceptions ${ctx.fixtureId}`,
    attachment: "reports/exceptions.json",
  };
  if (faults?.delayMs) {
    tools.advance(faults.delayMs);
  }
  if (exceptions.length > 0) {
    const decision = faults?.sendWithoutApproval
      ? "allow"
      : tools.requestApproval("message.send", send);
    if (decision === "allow") {
      tools.call("message.send", send);
      if (faults?.sendTwice) {
        tools.call("message.send", send);
      }
    }
  }
  return {
    outputs: [{ name: "report", path: "reports/exceptions.json" }],
    summary: `${rows.length} rows checked, ${exceptions.length} exception(s)`,
  };
};

export const DRIVERS: Record<string, WorkflowDriver> = {
  "csv-inspection": csvInspectionDriver,
};
