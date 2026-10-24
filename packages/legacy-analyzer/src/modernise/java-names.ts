// Shared vocabulary of the Java engine: result types, naming helpers (method ids, Spring Boot's
// default physical naming), the Spring Data CRUD vocabulary, and the type index that resolves a
// type name as written to a type in the sources (nested types, single-type imports, the same
// package, wildcard imports) and lists a type's known supertypes.

import type { CrudOp } from "../crud.js";
import type { Loc } from "../types.js";
import type {
  JavaAnnotation,
  JavaCall,
  JavaFile,
  JavaMethod,
  JavaModel,
  JavaType,
} from "./types.js";

export type ResolvedCall = Loc & { from: string; to: string[]; name: string; resolution: string };
export type UnresolvedCall = Loc & {
  from: string;
  name: string;
  qualifier?: string;
  form: JavaCall["form"];
  reason: string;
};

export type JavaTableUse = Loc & {
  type: string;
  /** Method signature, when the fact is inside a method. */
  method?: string;
  table: string;
  /** Access operations; empty for a mapping (entity or repository to table). */
  ops: CrudOp[];
  kind: "entity" | "repository" | "access";
  via: string;
  /** SQL facts: the statement's first keyword. */
  sqlOp?: string;
  text?: string;
  partial?: boolean;
  declaredAt?: Loc;
};

export type JavaSupertype = Loc & {
  type: string;
  kind: "EXTENDS" | "IMPLEMENTS";
  name: string;
  resolved?: string;
};

export type JavaColumnMap = Loc & {
  type: string;
  field: string;
  table: string;
  column: string;
  implicit: boolean;
};

export type JavaAnalysis = {
  model: JavaModel;
  calls: ResolvedCall[];
  unresolved: UnresolvedCall[];
  tableUses: JavaTableUse[];
  columns: JavaColumnMap[];
  supertypes: JavaSupertype[];
  stereotypes: Record<string, string[]>;
};

export const methodId = (type: string, m: JavaMethod) => `${type}#${m.signature}`;
export const simple = (n: string) =>
  n
    .replace(/<.*$/s, "")
    .replace(/\[\]|\.\.\./g, "")
    .trim();
export const last = (n: string) => simple(n).split(".").pop() ?? n;
export const ann = (t: { annotations: JavaAnnotation[] }, ...names: string[]) =>
  t.annotations.find((a) => names.includes(a.name.split(".").pop() ?? a.name));

/** Spring Boot's default physical naming: camelCase -> CAMEL_CASE. */
export function springName(n: string): string {
  return n.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

export const STEREOTYPES = [
  "Entity",
  "Table",
  "Repository",
  "Service",
  "Component",
  "Controller",
  "RestController",
  "Configuration",
  "Embeddable",
  "MappedSuperclass",
  "Transactional",
];
export const REPO_BASES = new Set([
  "Repository",
  "CrudRepository",
  "JpaRepository",
  "PagingAndSortingRepository",
  "ListCrudRepository",
  "ListPagingAndSortingRepository",
  "ReactiveCrudRepository",
]);

export const INHERITED: Record<string, CrudOp[]> = {
  save: ["C", "U"],
  saveAll: ["C", "U"],
  saveAndFlush: ["C", "U"],
  saveAllAndFlush: ["C", "U"],
  findById: ["R"],
  findAll: ["R"],
  findAllById: ["R"],
  getById: ["R"],
  getReferenceById: ["R"],
  getOne: ["R"],
  existsById: ["R"],
  count: ["R"],
  delete: ["D"],
  deleteById: ["D"],
  deleteAll: ["D"],
  deleteAllById: ["D"],
  deleteInBatch: ["D"],
  deleteAllInBatch: ["D"],
};

export function opsOfSql(op: string): CrudOp[] {
  switch (op) {
    case "SELECT":
    case "WITH":
      return ["R"];
    case "INSERT":
      return ["C"];
    case "UPDATE":
      return ["U"];
    case "DELETE":
    case "TRUNCATE":
      return ["D"];
    case "MERGE":
      return ["C", "U"];
    default:
      return ["?"];
  }
}

export function derivedOps(name: string): CrudOp[] | undefined {
  if (/^(find|read|get|query|search|stream|count|exists)[A-Za-z0-9]*?By/.test(name)) {
    return ["R"];
  }
  if (/^(delete|remove)[A-Za-z0-9]*?By/.test(name)) {
    return ["D"];
  }
  return undefined;
}

export function typeIndex(files: JavaFile[]) {
  const types = files
    .flatMap((f) => f.types)
    .toSorted((a, b) =>
      a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0,
    );
  const byQn = new Map(types.map((t) => [t.qualifiedName, t]));
  const fileOf = new Map(files.flatMap((f) => f.types.map((t) => [t.qualifiedName, f] as const)));

  const resolveType = (nameIn: string, from: JavaType): JavaType | undefined => {
    const name = simple(nameIn);
    if (!name || /^[a-z]+$/.test(name)) {
      return byQn.get(name);
    }
    if (byQn.has(name)) {
      return byQn.get(name);
    }
    const [head, ...rest] = name.split(".");
    const tail = rest.length ? `.${rest.join(".")}` : "";
    // Nested in this type or an enclosing type.
    for (let t: JavaType | undefined = from; t; t = t.outer ? byQn.get(t.outer) : undefined) {
      const hit = byQn.get(`${t.qualifiedName}.${head}${tail}`);
      if (hit) {
        return hit;
      }
    }
    const f = fileOf.get(from.qualifiedName);
    for (const imp of f?.imports.filter((i) => !i.static && !i.wildcard) ?? []) {
      if (imp.name.split(".").pop() === head) {
        return byQn.get(`${imp.name}${tail}`);
      }
    }
    const samePkg = byQn.get(from.package ? `${from.package}.${name}` : name);
    if (samePkg) {
      return samePkg;
    }
    for (const imp of f?.imports.filter((i) => !i.static && i.wildcard) ?? []) {
      const hit = byQn.get(`${imp.name}.${name}`);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  };

  const supers = (t: JavaType): JavaType[] => {
    const out: JavaType[] = [];
    const seen = new Set<string>([t.qualifiedName]);
    const queue = [t];
    while (queue.length > 0) {
      const cur = queue.shift() as JavaType;
      for (const s of [...cur.extends, ...cur.implements]) {
        const st = resolveType(s, cur);
        if (st && !seen.has(st.qualifiedName)) {
          seen.add(st.qualifiedName);
          out.push(st);
          queue.push(st);
        }
      }
    }
    return out;
  };

  const arityOk = (m: JavaMethod, n: number) =>
    n < 0 ||
    m.params.length === n ||
    (m.params.at(-1)?.type.endsWith("...") === true && n >= m.params.length - 1);
  const methodsIn = (ts: JavaType[], name: string, n: number) =>
    ts.flatMap((t) =>
      t.methods
        .filter((m) => m.name === name && m.kind === "method" && arityOk(m, n))
        .map((m) => methodId(t.qualifiedName, m)),
    );

  return { types, byQn, fileOf, resolveType, supers, arityOk, methodsIn };
}
