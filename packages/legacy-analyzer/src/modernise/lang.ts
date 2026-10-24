// The language of an accessor node in CRUD rows and impact lists: the attrs.language of FORTRAN
// and PL/I nodes, Java for Java types, JCL for programs without source run by a step (utilities),
// COBOL otherwise.

import type { GraphNode } from "../graph.js";

export function accessorLanguage(n: GraphNode | undefined): string {
  if (n?.attrs?.language) {
    return n.attrs.language;
  }
  return n?.kind === "java-type" ? "Java" : n?.kind === "external-program" ? "JCL" : "COBOL";
}
