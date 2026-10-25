// PLC inventory of the modernisation tools: the POU list with the I/O map, or one POU in full
// with its variables, calls, writes, the instances of it and the I/O it declares, each at
// path:line. A direct address (`%IX0.0`) as the name gives the variables located there.

import type { Polyglot } from "./project.js";

export function plcInventory(poly: Polyglot, name?: string) {
  const p = poly.plc;
  if (!name) {
    return {
      pous: p.pous.map((x) => ({
        name: x.name,
        kind: x.kind,
        ...(x.returns ? { returns: x.returns } : {}),
        ...(x.extends ? { extends: x.extends } : {}),
        vars: x.vars.length,
        calls: x.calls.length,
        writes: x.writes.length,
        file: x.file,
        line: x.line,
      })),
      types: p.types.map((t) => ({ name: t.name, kind: t.kind, file: t.file, line: t.line })),
      io: p.io,
      sharedAddresses: p.sharedAddresses,
      exportsNotRead: poly.plcExports,
    };
  }
  const q = name.trim().toUpperCase();
  if (q.startsWith("%")) {
    const io = p.io.filter((x) => x.address === q);
    if (io.length === 0) {
      throw new Error(`No variable at ${name} in the PLC sources.`);
    }
    return { address: q, io };
  }
  const x = p.pous.find((y) => y.name.toUpperCase() === q);
  if (!x) {
    throw new Error(`No PLC POU named ${name}.`);
  }
  return {
    pou: x,
    io: p.io.filter((i) => i.pou === x.name),
    instances: p.instances.filter((i) => i.pou === x.name),
    instancesOf: p.instances.filter((i) => i.type.toUpperCase() === q),
    callers: p.pous
      .filter((y) => y.calls.some((c) => c.kind === "function" && c.name.toUpperCase() === q))
      .map((y) => ({ name: y.name, file: y.file, line: y.line })),
  };
}
