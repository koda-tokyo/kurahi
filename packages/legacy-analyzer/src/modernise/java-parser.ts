// Java declaration parser (deterministic, no external parser): package, imports, classes,
// interfaces, enums, records and annotation types, nested types, fields, methods and
// constructors with their signatures, annotations with their element values, extends /
// implements. Method bodies are skipped by brace matching and scanned for calls and SQL
// (java-body.ts). What is seen but not modelled is reported as a gap with its line.

import type {
  JavaField,
  JavaFile,
  JavaImport,
  JavaMethod,
  JavaParam,
  JavaType,
  JavaTypeKind,
} from "./types.js";
import { matching, scanBody } from "./java-body.js";
import { P } from "./java-cursor.js";
import { lexJava } from "./java-lexer.js";

function parseType(
  p: P,
  kind: JavaTypeKind,
  m: ReturnType<P["modifiers"]>,
  pkg: string | undefined,
  outer: JavaType | undefined,
  out: JavaType[],
) {
  p.k += kind === "annotation" ? 2 : 1;
  const name = p.cur?.k === "id" ? p.cur.v : "<anonymous>";
  p.k++;
  const prefix = outer ? outer.qualifiedName : pkg;
  const type: JavaType = {
    file: p.file,
    line: m.line,
    name,
    qualifiedName: prefix ? `${prefix}.${name}` : name,
    kind,
    ...(pkg ? { package: pkg } : {}),
    ...(outer ? { outer: outer.qualifiedName } : {}),
    modifiers: m.mods,
    annotations: m.anns,
    extends: [],
    implements: [],
    fields: [],
    methods: [],
    enumConstants: [],
    recordComponents: [],
    endLine: m.line,
    ...(m.doc ? { doc: m.doc } : {}),
  };
  if (p.at("<")) {
    const close = matching(p.t, p.k);
    type.typeParams = p.text(p.k, close + 1);
    p.k = close + 1;
  }
  if (kind === "record" && p.at("(")) {
    const close = matching(p.t, p.k);
    p.k++;
    type.recordComponents = p.params(close);
  }
  for (;;) {
    if (p.at("extends")) {
      p.k++;
      type.extends = p.typeList();
    } else if (p.at("implements")) {
      p.k++;
      type.implements = p.typeList();
    } else if (p.at("permits")) {
      p.k++;
      p.typeList();
    } else {
      break;
    }
  }
  if (kind === "interface" || kind === "annotation") {
    // An interface's `extends` list names interfaces.
    type.implements = [...type.extends];
    type.extends = [];
  }
  out.push(type);
  if (!p.at("{")) {
    p.gap("type declaration", `Declaration of ${name} has no body that could be found.`);
    p.skipStatement();
    return;
  }
  const close = matching(p.t, p.k);
  p.k++;
  if (kind === "enum") {
    parseEnumConstants(p, type, close);
  }
  parseMembers(p, type, close, pkg, out);
  type.endLine = p.t[close]?.line ?? type.line;
  p.k = close + 1;
}

function parseEnumConstants(p: P, type: JavaType, close: number) {
  while (p.k < close && !p.at(";")) {
    p.modifiers();
    if (p.cur?.k === "id") {
      type.enumConstants.push({ file: p.file, line: p.line(), name: p.cur.v });
      p.k++;
    }
    if (p.at("(")) {
      p.k = matching(p.t, p.k) + 1;
    }
    if (p.at("{")) {
      p.gap(
        "enum constant body",
        `Constant ${type.enumConstants.at(-1)?.name} has its own class body; it is not modelled.`,
      );
      p.k = matching(p.t, p.k) + 1;
    }
    if (p.at(",")) {
      p.k++;
    } else if (!p.at(";") && p.k < close) {
      p.gap("enum constants", `Unexpected token "${p.cur?.v}" in the constants of ${type.name}.`);
      break;
    }
  }
  if (p.at(";")) {
    p.k++;
  }
}

function parseMembers(
  p: P,
  type: JavaType,
  close: number,
  pkg: string | undefined,
  out: JavaType[],
) {
  while (p.k < close) {
    if (p.at(";")) {
      p.k++;
      continue;
    }
    const before = p.k;
    if (p.at("{") || (p.at("static") && p.at("{", 1))) {
      const line = p.line();
      if (p.at("static")) {
        p.k++;
      }
      const end = matching(p.t, p.k);
      p.gap(
        "initializer block",
        `Initializer block of ${type.name}: calls and SQL inside it are not attributed to a method.`,
        line,
      );
      p.k = end + 1;
      continue;
    }
    const m = p.modifiers();
    const kind = p.typeKeyword();
    if (kind) {
      parseType(p, kind, m, pkg, type, out);
      continue;
    }
    let typeParams: string | undefined;
    if (p.at("<")) {
      const e = matching(p.t, p.k);
      typeParams = p.text(p.k, e + 1);
      p.k = e + 1;
    }
    const line = p.line();
    const isCtor = p.cur?.k === "id" && p.cur.v === type.name && p.at("(", 1);
    // Compact canonical record constructor: `Name {`
    if (type.kind === "record" && p.cur?.v === type.name && p.at("{", 1)) {
      p.k++;
      const end = matching(p.t, p.k);
      addMethod(p, type, {
        line,
        m,
        name: type.name,
        kind: "constructor",
        params: type.recordComponents,
        bodyOpen: p.k,
        bodyClose: end,
      });
      p.k = end + 1;
      continue;
    }
    const returnType = isCtor ? undefined : p.type();
    if (p.cur?.k !== "id") {
      p.gap(
        "member",
        `Member of ${type.name} could not be read (at "${p.cur?.v ?? "end"}").`,
        line,
      );
      p.k = Math.max(p.k, before + 1);
      p.skipStatement();
      continue;
    }
    const name = p.cur.v;
    p.k++;
    if (p.at("(")) {
      const pclose = matching(p.t, p.k);
      p.k++;
      const params = p.params(pclose);
      while (p.at("[") && p.at("]", 1)) {
        p.k += 2;
      }
      let throws: string[] = [];
      if (p.at("throws")) {
        p.k++;
        throws = p.typeList();
      }
      if (p.at("default")) {
        p.k++; // annotation element default value
        while (p.k < close && !p.at(";")) {
          p.k = p.at("{") || p.at("(") ? matching(p.t, p.k) + 1 : p.k + 1;
        }
      }
      let bodyOpen = -1;
      let bodyClose = -1;
      if (p.at("{")) {
        bodyOpen = p.k;
        bodyClose = matching(p.t, p.k);
        p.k = bodyClose + 1;
      } else if (p.at(";")) {
        p.k++;
      } else {
        p.gap(
          "method",
          `Method ${name} of ${type.name}: no body or ';' after the signature.`,
          line,
        );
        p.skipStatement();
      }
      addMethod(p, type, {
        line,
        m,
        name,
        kind: isCtor ? "constructor" : "method",
        params,
        returnType,
        throws,
        typeParams,
        bodyOpen,
        bodyClose,
      });
      continue;
    }
    // Field declarators: name [= init] {, name [= init]} ;
    let fname = name;
    for (;;) {
      while (p.at("[") && p.at("]", 1)) {
        p.k += 2;
      }
      const field: JavaField = {
        file: p.file,
        line: p.line(),
        name: fname,
        type: returnType ?? "",
        modifiers: m.mods,
        annotations: m.anns,
      };
      if (p.at("=")) {
        p.k++;
        const s = p.k;
        while (p.k < close && !p.at(",") && !p.at(";")) {
          p.k = p.at("{") || p.at("(") || p.at("[") ? matching(p.t, p.k) + 1 : p.k + 1;
        }
        const init = p.t.slice(s, p.k);
        if (init.length > 0 && init.every((x) => x.k === "str" || x.v === "+")) {
          field.stringValue = init
            .filter((x) => x.k === "str")
            .map((x) => x.v)
            .join("");
        }
      }
      type.fields.push(field);
      if (p.at(",") && p.t[p.k + 1]?.k === "id") {
        p.k++;
        fname = p.cur?.v ?? "";
        p.k++;
        continue;
      }
      break;
    }
    if (p.at(";")) {
      p.k++;
    } else {
      p.gap(
        "field",
        `Field ${name} of ${type.name}: declaration not terminated as expected.`,
        line,
      );
      p.skipStatement();
    }
  }
}

function addMethod(
  p: P,
  type: JavaType,
  d: {
    line: number;
    m: ReturnType<P["modifiers"]>;
    name: string;
    kind: "method" | "constructor";
    params: JavaParam[];
    returnType?: string;
    throws?: string[];
    typeParams?: string;
    bodyOpen: number;
    bodyClose: number;
  },
) {
  const body = d.bodyOpen >= 0 ? scanBody(p.file, p.t, d.bodyOpen + 1, d.bodyClose) : undefined;
  p.gaps.push(...(body?.gaps ?? []));
  const method: JavaMethod = {
    file: p.file,
    line: d.line,
    name: d.name,
    kind: d.kind,
    ...(d.returnType
      ? { returnType: d.typeParams ? `${d.typeParams} ${d.returnType}` : d.returnType }
      : {}),
    params: d.params,
    modifiers: d.m.mods,
    annotations: d.m.anns,
    throws: d.throws ?? [],
    signature: `${d.name}(${d.params.map((x) => x.type).join(", ")})`,
    endLine: d.bodyClose >= 0 ? p.t[d.bodyClose].line : d.line,
    abstract: d.bodyOpen < 0,
    calls: body?.calls ?? [],
    sql: body?.sql ?? [],
    refs: body?.refs ?? [],
    ...(d.m.doc ? { doc: d.m.doc } : {}),
  };
  type.methods.push(method);
}

export function parseJavaFile(path: string, text: string): JavaFile {
  const { tokens, unterminated } = lexJava(text);
  const p = new P(path, tokens);
  for (const l of unterminated) {
    p.gap(
      "literal or comment",
      "Unterminated string, text block or comment; the rest of the file may be misread.",
      l,
    );
  }
  let pkg: string | undefined;
  const imports: JavaImport[] = [];
  const types: JavaType[] = [];
  while (p.cur) {
    if (p.at(";")) {
      p.k++;
      continue;
    }
    const start = p.k;
    const m = p.modifiers();
    if (p.at("package")) {
      p.k++;
      pkg = p.qualifiedName();
      p.skipStatement();
      continue;
    }
    if (p.at("import")) {
      const line = p.line();
      p.k++;
      const isStatic = p.at("static");
      if (isStatic) {
        p.k++;
      }
      const name = p.qualifiedName();
      const wildcard = p.at(".") && p.at("*", 1);
      imports.push({ file: path, line, name, static: isStatic, wildcard });
      p.skipStatement();
      continue;
    }
    if (p.at("module") || p.at("open")) {
      p.gap("module declaration", "module-info is not modelled.");
      p.k = tokens.length;
      break;
    }
    const kind = p.typeKeyword();
    if (kind) {
      parseType(p, kind, m, pkg, undefined, types);
      continue;
    }
    p.gap("top-level", `Unrecognised top-level construct at "${p.cur?.v}".`);
    p.k = Math.max(p.k, start + 1);
    p.skipStatement();
  }
  return { path, ...(pkg ? { package: pkg } : {}), imports, types, gaps: p.gaps };
}
