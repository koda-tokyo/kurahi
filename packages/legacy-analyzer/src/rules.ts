// Rule candidates: deterministic extraction of the places where business rules usually live.
// Nothing here interprets meaning. Each candidate is the exact source text at file:line plus the
// literal values in it and, for named items, the declared VALUE they start with. An agent or a
// person decides what (if anything) the candidate means.

import type { DataItem, LegacyIndex, Program, Statement } from "./types.js";
import { FIGURATIVE } from "./data.js";
import { findProgram } from "./query.js";

export type ConstantRef = {
  name: string;
  value: string;
  file: string;
  line: number;
  text: string;
  pic?: string;
};

export type RuleCandidate = {
  id: string;
  kind:
    | "condition"
    | "arithmetic"
    | "rounding"
    | "condition-name"
    | "constant"
    | "literal-assignment";
  program: string;
  paragraph?: string;
  file: string;
  line: number;
  endLine: number;
  /** The exact program text of the lines (code area). */
  source: string;
  /** IF/WHEN/UNTIL condition, or the arithmetic statement, as parsed. */
  expression?: string;
  /** Literals written in the statement itself (numeric and alphanumeric, figurative constants). */
  literals: string[];
  /** Named data items in the statement that are declared with a VALUE literal. */
  namedConstants: ConstantRef[];
  /** Condition names (88) in the statement, with the values they test. */
  conditionNames: Array<{
    name: string;
    parent?: string;
    values: string[];
    file: string;
    line: number;
  }>;
  /** Enclosing IF/WHEN conditions, outermost first. */
  guards: string[];
  rounded?: boolean;
  targets?: string[];
};

function isNumericLiteral(v: string): boolean {
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v);
}

function isZeroish(v: string): boolean {
  return /^[+-]?0*(\.0*)?$/.test(v) || FIGURATIVE.has(v.toUpperCase());
}

function constantsOf(names: string[], items: Map<string, DataItem>): ConstantRef[] {
  const out: ConstantRef[] = [];
  for (const n of names) {
    const d = items.get(n);
    // Zero and figurative initial values (counters, switches) are not reported as constants.
    if (d && d.level !== 88 && d.value && d.value.length > 0 && !d.value.every(isZeroish)) {
      out.push({
        name: d.name,
        value: d.value.join(" "),
        file: d.file,
        line: d.line,
        text: d.text,
        pic: d.pic,
      });
    }
  }
  return out;
}

function conditionNamesOf(
  names: string[],
  items: Map<string, DataItem>,
): RuleCandidate["conditionNames"] {
  return names
    .map((n) => items.get(n))
    .filter((d): d is DataItem => d !== undefined && d.level === 88)
    .map((d) => ({
      name: d.name,
      parent: d.parent,
      values: d.conditionValues ?? [],
      file: d.file,
      line: d.line,
    }));
}

export function rulesForProgram(prog: Program): RuleCandidate[] {
  const items = new Map<string, DataItem>();
  for (const d of prog.dataItems) {
    if (!items.has(d.name)) {
      items.set(d.name, d);
    }
  }
  const out: RuleCandidate[] = [];
  let n = 0;
  const push = (c: Omit<RuleCandidate, "id">) => {
    n++;
    out.push({ id: `${prog.name}-R${String(n).padStart(3, "0")}`, ...c });
  };
  const fromStatement = (para: string, st: Statement, kind: RuleCandidate["kind"]) => {
    const names = [...new Set([...st.uses, ...st.sets])];
    push({
      kind,
      program: prog.name,
      paragraph: para,
      file: st.file,
      line: st.line,
      endLine: st.endLine,
      source: st.text,
      expression: kind === "condition" && st.verb === "WHEN" ? st.condition : st.code,
      literals: st.literals,
      namedConstants: constantsOf(names, items),
      conditionNames: conditionNamesOf(names, items),
      guards: st.guards,
      rounded: st.rounded,
      targets: kind === "condition" ? undefined : st.sets,
    });
  };

  for (const para of prog.paragraphs) {
    for (const st of para.statements) {
      if (st.condition && (st.verb === "IF" || st.verb === "WHEN" || st.verb === "PERFORM")) {
        if (st.verb === "WHEN" && /^WHEN OTHER$/.test(st.code)) {
          continue;
        }
        fromStatement(para.name, st, "condition");
      }
      if (
        st.verb === "COMPUTE" ||
        st.verb === "ADD" ||
        st.verb === "SUBTRACT" ||
        st.verb === "MULTIPLY" ||
        st.verb === "DIVIDE"
      ) {
        fromStatement(para.name, st, st.rounded ? "rounding" : "arithmetic");
      }
      if (st.verb === "MOVE") {
        const m = /^MOVE\s+(\S+)\s+TO\b/i.exec(st.code);
        if (m && isNumericLiteral(m[1]) && !isZeroish(m[1])) {
          fromStatement(para.name, st, "literal-assignment");
        }
      }
    }
  }

  for (const d of prog.dataItems) {
    if (d.level === 88) {
      push({
        kind: "condition-name",
        program: prog.name,
        file: d.file,
        line: d.line,
        endLine: d.endLine ?? d.line,
        source: d.text,
        expression: `${d.name} = ${(d.conditionValues ?? []).join(" OR ")} (of ${d.parent ?? "?"})`,
        literals: d.conditionValues ?? [],
        namedConstants: [],
        conditionNames: [
          {
            name: d.name,
            parent: d.parent,
            values: d.conditionValues ?? [],
            file: d.file,
            line: d.line,
          },
        ],
        guards: [],
      });
      continue;
    }
    // Numeric items declared with a non-zero numeric VALUE in working or local storage.
    const v = d.value?.length === 1 ? d.value[0] : undefined;
    if (
      v &&
      isNumericLiteral(v) &&
      !isZeroish(v) &&
      d.numeric &&
      (d.section === "WORKING-STORAGE" || d.section === "LOCAL-STORAGE") &&
      d.name !== "FILLER"
    ) {
      push({
        kind: "constant",
        program: prog.name,
        file: d.file,
        line: d.line,
        endLine: d.endLine ?? d.line,
        source: d.text,
        expression: `${d.name} VALUE ${v}`,
        literals: [v],
        namedConstants: [
          { name: d.name, value: v, file: d.file, line: d.line, text: d.text, pic: d.pic },
        ],
        conditionNames: [],
        guards: [],
      });
    }
  }
  return out;
}

export function rules(index: LegacyIndex, program?: string): RuleCandidate[] {
  if (program) {
    const p = findProgram(index, program);
    if (!p) {
      throw new Error(`No program named ${program} in the index.`);
    }
    return rulesForProgram(p);
  }
  return index.programs.flatMap(rulesForProgram);
}
