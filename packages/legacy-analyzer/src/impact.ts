// Impact of changing a data item: the items that share its storage (REDEFINES, group and
// subordinate items, by byte range), the items it flows into (MOVE, COMPUTE, arithmetic,
// STRING, WRITE FROM, ...), the same copybook field in other programs, CALL USING parameters,
// and the paragraphs, programs and job steps that touch any of them. Propagation is a bounded
// fixpoint over facts in the index; each affected item carries the fact that brought it in.

import type { DataItem, LegacyIndex, Program } from "./types.js";
import { callEdges, ddBindings, findProgram, jobStepsFor, performEdges } from "./query.js";

type Key = string; // PROGRAM|ITEM

export type ImpactReason = {
  item: string;
  program: string;
  reason:
    | "seed"
    | "shared storage"
    | "data flow"
    | "same copybook field"
    | "CALL USING"
    | "file record";
  from?: string;
  file: string;
  line: number;
  text?: string;
};

const MAX_ITEMS = 2000;

function overlaps(a: DataItem, b: DataItem): boolean {
  if (a.path[0] !== b.path[0] || a.file !== b.file) {
    // Different 01 records only overlap through REDEFINES of the record itself.
    return (a.level === 1 && b.redefines === a.name) || (b.level === 1 && a.redefines === b.name);
  }
  if (
    a.offset === undefined ||
    b.offset === undefined ||
    a.length === undefined ||
    b.length === undefined
  ) {
    return a.path.includes(b.name) || b.path.includes(a.name);
  }
  const aEnd = a.offset + a.length * (a.occurs?.max ?? 1);
  const bEnd = b.offset + b.length * (b.occurs?.max ?? 1);
  return a.offset < bEnd && b.offset < aEnd;
}

export function impact(index: LegacyIndex, itemIn: string, programIn?: string) {
  const name = itemIn.trim().toUpperCase();
  const affected = new Map<Key, ImpactReason>();
  const queue: Key[] = [];
  // Items reached through shared storage (an enclosing group, a REDEFINES) are not expanded to
  // their own storage again, nor are their copybook twins: a group would pull in every sibling.
  const noStorage = new Set<Key>();
  const add = (r: ImpactReason, inheritFrom?: Key) => {
    const k = `${r.program}|${r.item}`;
    if (affected.has(k) || affected.size >= MAX_ITEMS) {
      return;
    }
    affected.set(k, r);
    if (r.reason === "shared storage" || (inheritFrom && noStorage.has(inheritFrom))) {
      noStorage.add(k);
    }
    queue.push(k);
  };
  const programs = index.programs.filter(
    (p) => !programIn || p.name === programIn.trim().toUpperCase(),
  );
  for (const p of programs) {
    for (const d of p.dataItems.filter((x) => x.name === name)) {
      add({
        item: d.name,
        program: p.name,
        reason: "seed",
        file: d.file,
        line: d.line,
        text: d.text,
      });
    }
  }
  const progByName = new Map(index.programs.map((p) => [p.name, p]));
  const calls = callEdges(index);
  const bindings = ddBindings(index);

  while (queue.length > 0) {
    const key = queue.shift() as Key;
    const [pname, iname] = key.split("|");
    const prog = progByName.get(pname) as Program;
    const defs = prog.dataItems.filter((d) => d.name === iname);
    // Shared storage within the program (88-levels are reported through their parent).
    const viaStorage = noStorage.has(key);
    for (const def of viaStorage ? [] : defs) {
      for (const other of prog.dataItems) {
        if (
          other.name !== iname &&
          other.level !== 88 &&
          other.name !== "FILLER" &&
          overlaps(def, other)
        ) {
          add({
            item: other.name,
            program: pname,
            reason: "shared storage",
            from: iname,
            file: other.file,
            line: other.line,
            text: other.text,
          });
        }
      }
    }
    for (const def of defs) {
      // The same field of the same copybook in other programs.
      if (def.copybook) {
        for (const p2 of index.programs) {
          if (p2.name === pname) {
            continue;
          }
          const twin = p2.dataItems.find((d) => d.name === iname && d.file === def.file);
          if (twin) {
            add(
              {
                item: iname,
                program: p2.name,
                reason: "same copybook field",
                from: `${pname}.${iname}`,
                file: twin.file,
                line: twin.line,
                text: twin.text,
              },
              key,
            );
          }
        }
      }
    }
    // Data flow: a statement that uses the item and sets something else.
    for (const para of prog.paragraphs) {
      for (const st of para.statements) {
        if (!st.uses.includes(iname)) {
          continue;
        }
        for (const s of st.sets) {
          if (s !== iname) {
            add({
              item: s,
              program: pname,
              reason: "data flow",
              from: iname,
              file: st.file,
              line: st.line,
              text: st.text,
            });
          }
        }
      }
    }
    // CALL USING: caller argument position <-> callee LINKAGE parameter, both directions.
    for (const c of calls) {
      if (c.dynamic || !c.resolved) {
        continue;
      }
      const callee = findProgram(index, c.target);
      if (!callee) {
        continue;
      }
      if (c.program === pname) {
        c.using.forEach((arg, n) => {
          const param = callee.usingParams[n];
          if (arg === iname && param) {
            add({
              item: param,
              program: callee.name,
              reason: "CALL USING",
              from: `${pname}.${iname}`,
              file: c.file,
              line: c.line,
              text: c.text,
            });
          }
        });
      }
      if (c.target === pname) {
        const n = prog.usingParams.indexOf(iname);
        const arg = n >= 0 ? c.using[n] : undefined;
        if (arg) {
          add({
            item: arg,
            program: c.program,
            reason: "CALL USING",
            from: `${pname}.${iname}`,
            file: c.file,
            line: c.line,
            text: c.text,
          });
        }
      }
    }
    // File records: a record written to a data set that another step reads.
    for (const def of defs) {
      const rec = def.path[0];
      const fd = prog.files.find((f) => f.records.includes(rec));
      if (!fd) {
        continue;
      }
      const outs = bindings.filter(
        (b) => b.program === pname && b.fileName === fd.name && b.dd.dsn,
      );
      for (const o of outs) {
        for (const reader of bindings.filter(
          (b) => b.dd.dsn === o.dd.dsn && b.program !== pname && b.fileName,
        )) {
          const rp = progByName.get(reader.program);
          const rfd = rp?.files.find((f) => f.name === reader.fileName);
          if (!rp || !rfd) {
            continue;
          }
          const twin = rp.dataItems.find(
            (d) => d.name === iname && rfd.records.includes(d.path[0]),
          );
          const target = twin ?? rp.dataItems.find((d) => rfd.records.includes(d.name));
          if (target) {
            add({
              item: target.name,
              program: rp.name,
              reason: "file record",
              from: `${pname}.${iname} via ${o.dd.dsn}`,
              file: reader.dd.file,
              line: reader.dd.line,
            });
          }
        }
      }
    }
  }

  // Paragraphs that set or use an affected item (including through its condition names).
  const touched: Array<{
    program: string;
    paragraph: string;
    items: string[];
    access: string[];
    file: string;
    line: number;
  }> = [];
  const byProg = new Map<string, Set<string>>();
  for (const r of affected.values()) {
    const s = byProg.get(r.program) ?? new Set<string>();
    s.add(r.item);
    byProg.set(r.program, s);
  }
  for (const [pname, items] of byProg) {
    const prog = progByName.get(pname) as Program;
    const conds = new Map(
      prog.dataItems
        .filter((d) => d.level === 88 && d.parent && items.has(d.parent))
        .map((d) => [d.name, d.parent as string]),
    );
    for (const para of prog.paragraphs) {
      const hit = new Set<string>();
      const access = new Set<string>();
      for (const st of para.statements) {
        for (const s of st.sets) {
          if (items.has(s)) {
            hit.add(s);
            access.add("set");
          }
        }
        for (const u of st.uses) {
          if (items.has(u) || conds.has(u)) {
            hit.add(conds.get(u) ?? u);
            access.add("use");
          }
        }
      }
      if (hit.size > 0) {
        touched.push({
          program: pname,
          paragraph: para.name,
          items: [...hit],
          access: [...access],
          file: para.file,
          line: para.line,
        });
      }
    }
  }
  // Paragraphs from which a touched paragraph is reached through PERFORM (transitively).
  const edges = performEdges(index);
  const reached = new Set(touched.map((t) => `${t.program}.${t.paragraph}`));
  const frontier = [...reached];
  const performers: Array<{
    program: string;
    paragraph: string;
    performs: string;
    file: string;
    line: number;
  }> = [];
  while (frontier.length > 0) {
    const cur = frontier.shift() as string;
    const [pn, para] = cur.split(".");
    for (const e of edges.filter((x) => x.program === pn && x.to === para)) {
      const k = `${e.program}.${e.from}`;
      if (!reached.has(k)) {
        reached.add(k);
        frontier.push(k);
        performers.push({
          program: e.program,
          paragraph: e.from,
          performs: para,
          file: e.file,
          line: e.line,
        });
      }
    }
  }
  const progs = [
    ...new Set([...touched.map((t) => t.program), ...[...affected.values()].map((r) => r.program)]),
  ];
  return {
    item: name,
    found: affected.size > 0,
    truncated: affected.size >= MAX_ITEMS,
    affectedItems: [...affected.values()],
    paragraphs: touched,
    reachedFrom: performers,
    programs: progs,
    jobSteps: progs.flatMap((p) => jobStepsFor(index, p)),
  };
}
