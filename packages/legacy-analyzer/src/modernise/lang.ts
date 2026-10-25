// The language of an accessor node in CRUD rows and impact lists: the attrs.language of FORTRAN
// and PL/I nodes, Java for Java types, SQL for stored routines, JCL for programs without source run
// by a step (utilities), COBOL otherwise.

import type { GraphNode } from "../graph.js";

export function accessorLanguage(n: GraphNode | undefined): string {
  if (n?.attrs?.language) {
    return n.attrs.language;
  }
  switch (n?.kind) {
    case "java-type":
      return "Java";
    case "routine":
      return "SQL";
    case "external-program":
      return "JCL";
    default:
      return "COBOL";
  }
}
