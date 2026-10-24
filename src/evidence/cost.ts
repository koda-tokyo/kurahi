// Cost snapshot for a job's evidence (Workflow Evaluator, phase 0). Evidence records tokens; money
// comes from the price table in the KODA tested catalogue (providers/koda-tested.json), and the
// snapshot names the price source and date so a cost can be recomputed later from signed inputs.
import { loadCatalogue } from "../model-bench/catalogue.js";
import { costOf } from "../model-bench/scoring.js";

export type CostLine = {
  provider: string;
  model: string;
  input: number;
  output: number;
  /** Price per million tokens, as listed; null when the catalogue has no price for this model. */
  price: { input: number; output: number; currency: string; asOf: string | null } | null;
  amount: number | null;
};

export type CostSnapshot = {
  lines: CostLine[];
  /** Totals per currency, only over lines that had a price. */
  totals: Record<string, number>;
  /** Lines without a listed price (their tokens are recorded, their cost is unknown). */
  unpriced: number;
  source: "koda-tested";
};

export function costSnapshot(
  usage: Array<{ provider: string; model: string; input: number; output: number }>,
  catalogue: ReturnType<typeof loadCatalogue> = loadCatalogue(),
): CostSnapshot {
  const lines: CostLine[] = [];
  const totals: Record<string, number> = {};
  let unpriced = 0;
  for (const u of usage) {
    const entry = catalogue.models.find(
      (m) => m.provider === u.provider && m.model === u.model && m.price,
    );
    const price = entry?.price
      ? {
          input: entry.price.input,
          output: entry.price.output,
          currency: entry.price.currency,
          asOf: entry.price.asOf ?? null,
        }
      : null;
    const amount = price
      ? costOf({ input: u.input, output: u.output }, entry?.price ?? null)
      : null;
    if (price && amount !== null) {
      totals[price.currency] = (totals[price.currency] ?? 0) + amount;
    } else {
      unpriced += 1;
    }
    lines.push({ ...u, price, amount });
  }
  return { lines, totals, unpriced, source: "koda-tested" };
}
