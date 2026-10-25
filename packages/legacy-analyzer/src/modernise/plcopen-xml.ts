// PLC engine, PLCopen XML (IEC 61131-10 / TC6 0201) exports. Reads the POUs of the project
// (program, function block, function) with their interface variables, located addresses and
// initial values, the data types, and the configuration / resource globals. Structured Text bodies
// are handed to the Structured Text reader, so calls and writes follow exactly the same rules;
// every fact keeps the line of the XML element it came from. FBD and LD networks give their block
// calls and the variables their outputs and coils write. IL and SFC bodies, actions, transitions
// and vendor addData are reported as gaps, never guessed.
//
// The XML reader is deliberately small: elements, attributes, text, CDATA, comments and processing
// instructions. Only the five predefined entities and character references are expanded; a DOCTYPE
// is skipped and its entity declarations are never applied.

import type { Loc } from "../types.js";
import type { PlcFile, PlcPou, PlcType } from "./plc-st-types.js";
import type { EngineGap } from "./types.js";
import { parsePlcFile } from "./plc-st.js";

type XNode = {
  /** Local name (namespace prefix dropped). */
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Text and CDATA directly inside, each with the line it starts on. */
  text: Array<{ value: string; line: number }>;
  line: number;
  endLine: number;
};

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });

const local = (q: string) => q.slice(q.indexOf(":") + 1);

/** Parses XML into an element tree; throws with the line on malformed input. */
export function parseXml(text: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [], text: [], line: 1, endLine: 1 };
  const stack: XNode[] = [root];
  let i = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let k = i; k < to; k++) {
      if (text.charCodeAt(k) === 10) {
        line++;
      }
    }
    i = to;
  };
  const fail = (msg: string): never => {
    throw new Error(`${msg} at line ${line}`);
  };
  const top = () => stack[stack.length - 1];
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0 || lt > i) {
      const end = lt < 0 ? text.length : lt;
      const raw = text.slice(i, end);
      if (raw.trim() !== "") {
        top().text.push({ value: decode(raw), line });
      }
      advance(end);
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) {
        fail("Comment never closed");
      }
      advance(end + 3);
    } else if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end < 0) {
        fail("CDATA never closed");
      }
      top().text.push({ value: text.slice(i + 9, end), line });
      advance(end + 3);
    } else if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) {
        fail("Processing instruction never closed");
      }
      advance(end + 2);
    } else if (text.startsWith("<!", i)) {
      // DOCTYPE (with an optional internal subset): skipped, never applied.
      const bracket = text.indexOf("[", i);
      const gt = text.indexOf(">", i);
      const end = bracket >= 0 && bracket < gt ? text.indexOf("]>", bracket) + 1 : gt;
      if (end <= 0) {
        fail("Declaration never closed");
      }
      advance(end + 1);
    } else if (text[i + 1] === "/") {
      const m = /^<\/([^\s>]+)\s*>/.exec(text.slice(i, i + 512));
      if (!m) {
        fail("Malformed end tag");
      }
      const node = stack.pop();
      if (!node || node === root || node.name !== local(m![1])) {
        fail(`Unexpected </${m![1]}>`);
      }
      node!.endLine = line;
      advance(i + m![0].length);
    } else {
      const m = /^<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(
        text.slice(i, i + 65536),
      );
      if (!m) {
        fail("Malformed start tag");
      }
      const attrs: Record<string, string> = {};
      for (const a of m![2].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[local(a[1])] = decode(a[2] ?? a[3] ?? "");
      }
      const node: XNode = {
        name: local(m![1]),
        attrs,
        children: [],
        text: [],
        line,
        endLine: line,
      };
      top().children.push(node);
      advance(i + m![0].length);
      node.endLine = line;
      if (!m![3]) {
        stack.push(node);
      }
    }
  }
  if (stack.length > 1) {
    fail(`<${top().name}> never closed`);
  }
  return root;
}

const kids = (n: XNode | undefined, name: string) =>
  n ? n.children.filter((c) => c.name === name) : [];
const kid = (n: XNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const textOf = (n: XNode | undefined): string =>
  n ? [...n.text.map((t) => t.value), ...n.children.map(textOf)].join("") : "";

const SECTION: Record<string, string> = {
  inputVars: "VAR_INPUT",
  outputVars: "VAR_OUTPUT",
  inOutVars: "VAR_IN_OUT",
  localVars: "VAR",
  tempVars: "VAR_TEMP",
  externalVars: "VAR_EXTERNAL",
  globalVars: "VAR_GLOBAL",
};

const POU_KIND: Record<string, PlcPou["kind"]> = {
  program: "PROGRAM",
  functionBlock: "FUNCTION_BLOCK",
  function: "FUNCTION",
};

const BODY_LANGS = new Set(["ST", "IL", "LD", "FBD", "SFC"]);

/** A plain or qualified variable name: `Motor`, `Line.Drive`. */
const QNAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

/** A PLCopen type element (`<type>`, `<baseType>`, `<returnType>`) as Structured Text. */
function typeText(n: XNode | undefined): string {
  const t = n?.children[0];
  if (!t) {
    return "";
  }
  switch (t.name) {
    case "derived":
      return t.attrs.name ?? "";
    case "string":
    case "wstring":
      return `${t.name.toUpperCase()}${t.attrs.length ? `(${t.attrs.length})` : ""}`;
    case "array": {
      const dims = kids(t, "dimension").map((d) => `${d.attrs.lower}..${d.attrs.upper}`);
      return `ARRAY [${dims.join(", ")}] OF ${typeText(kid(t, "baseType"))}`;
    }
    case "pointer":
      return `POINTER TO ${typeText(kid(t, "baseType"))}`;
    case "subrangeSigned":
    case "subrangeUnsigned": {
      const r = kid(t, "range");
      return `${typeText(kid(t, "baseType"))} (${r?.attrs.lower}..${r?.attrs.upper})`;
    }
    case "enum":
      return `(${kids(kid(t, "values"), "value")
        .map((v) => v.attrs.name)
        .join(", ")})`;
    case "struct":
      return "STRUCT";
    default:
      return t.name.toUpperCase();
  }
}

/** A simple initial value as Structured Text; array and struct values are not rendered. */
const initText = (n: XNode | undefined) => {
  const v = kid(n, "simpleValue")?.attrs.value;
  return v === undefined ? undefined : v.replace(/\s+/g, " ");
};

/**
 * Reads one PLCopen XML export. Returns undefined when the text is not a PLCopen TC6 project, so
 * the caller can count it as an export the engine does not read.
 */
export function parsePlcOpenXml(path: string, text: string): PlcFile | undefined {
  if (!/plcopen\.org\/xml\/tc6/i.test(text.slice(0, 4096))) {
    return undefined;
  }
  const at = (line: number): Loc => ({ file: path, line });
  const empty = (gaps: EngineGap[]): PlcFile => ({ path, pous: [], types: [], globals: [], gaps });
  let root: XNode;
  try {
    root = parseXml(text);
  } catch (e) {
    const m = /line (\d+)$/.exec((e as Error).message);
    return empty([
      {
        ...at(m ? Number(m[1]) : 1),
        construct: "xml",
        detail: `${(e as Error).message}; the file is not read.`,
      },
    ]);
  }
  const project = kid(root, "project");
  if (!project) {
    return empty([{ ...at(1), construct: "xml", detail: "No <project> element." }]);
  }
  const gaps: EngineGap[] = [];

  // Structured Text is synthesised from the XML and read by the ST reader; `lines[k]` is the XML
  // line that synthetic line k+1 came from, so every fact is re-pointed at the XML.
  const st: string[] = [];
  const lines: number[] = [];
  const emit = (s: string, xmlLine: number) => {
    st.push(s);
    lines.push(xmlLine);
  };
  const emitVars = (iface: XNode | undefined) => {
    for (const sec of iface?.children ?? []) {
      const keyword = SECTION[sec.name];
      if (!keyword) {
        if (sec.name !== "returnType" && sec.name !== "documentation" && sec.name !== "addData") {
          gaps.push({
            ...at(sec.line),
            construct: sec.name,
            detail: `${sec.name} is not analysed yet.`,
          });
        }
        continue;
      }
      const quals = [
        sec.attrs.constant === "true" ? "CONSTANT" : "",
        sec.attrs.retain === "true" ? "RETAIN" : "",
        sec.attrs.nonretain === "true" ? "NON_RETAIN" : "",
        sec.attrs.persistent === "true" ? "PERSISTENT" : "",
      ].filter(Boolean);
      emit([keyword, ...quals].join(" "), sec.line);
      for (const v of kids(sec, "variable")) {
        const type = typeText(kid(v, "type"));
        if (!v.attrs.name || !type) {
          gaps.push({
            ...at(v.line),
            construct: "variable",
            detail: "Variable without a name or type.",
          });
          continue;
        }
        const addr = v.attrs.address ? ` AT ${v.attrs.address}` : "";
        const init = initText(kid(v, "initialValue"));
        emit(`${v.attrs.name}${addr} : ${type}${init !== undefined ? ` := ${init}` : ""};`, v.line);
      }
      emit("END_VAR", sec.endLine);
    }
  };

  // FBD and LD networks become one synthetic statement per element, in XML order: a block with an
  // instance is an instance call, a block without one a function call, an output variable or a coil
  // a write. Wiring, contacts and input variables are reads and are not modelled; an expression that
  // is not a plain (qualified) name, jumps and labels are gaps.
  const emitNetwork = (lang: XNode, pou: string) => {
    const walk = (n: XNode) => {
      for (const c of n.children) {
        if (c.name === "block") {
          const callee = c.attrs.instanceName || c.attrs.typeName;
          if (callee && QNAME.test(callee)) {
            emit(`${callee}();`, c.line);
          } else {
            gaps.push({
              ...at(c.line),
              construct: "block",
              detail: `Block ${c.attrs.typeName ?? "(no type)"} in ${pou} is not read.`,
            });
          }
        } else if (c.name === "outVariable" || c.name === "inOutVariable" || c.name === "coil") {
          const target = textOf(kid(c, c.name === "coil" ? "variable" : "expression")).trim();
          if (QNAME.test(target)) {
            emit(`${target} := 0;`, c.line);
          } else {
            gaps.push({
              ...at(c.line),
              construct: c.name,
              detail: `${c.name} target ${target ? `"${target}"` : "(none)"} in ${pou} is not a variable name; not read.`,
            });
          }
        } else if (c.name === "jump" || c.name === "label") {
          gaps.push({
            ...at(c.line),
            construct: c.name,
            detail: `${c.name} in ${pou} is not analysed yet.`,
          });
        } else if (c.name !== "addData" && c.name !== "documentation") {
          walk(c);
        }
      }
    };
    walk(lang);
  };

  const types: PlcType[] = [];
  const projectTypes = kid(project, "types");
  for (const d of kids(kid(projectTypes, "dataTypes"), "dataType")) {
    const base = kid(d, "baseType")?.children[0]?.name;
    types.push({
      ...at(d.line),
      name: d.attrs.name ?? "",
      kind: base === "struct" ? "struct" : base === "enum" ? "enum" : "alias",
      endLine: d.endLine,
    });
  }

  for (const cfg of kids(kid(project, "instances"), "configurations").flatMap((c) =>
    kids(c, "configuration"),
  )) {
    emitVars({ ...cfg, children: kids(cfg, "globalVars") });
    for (const res of kids(cfg, "resource")) {
      emitVars({ ...res, children: kids(res, "globalVars") });
    }
  }

  const docs = new Map<string, string>();
  const pouNodes = kids(kid(projectTypes, "pous"), "pou");
  for (const p of pouNodes) {
    const kind = POU_KIND[p.attrs.pouType ?? ""];
    if (!kind || !p.attrs.name) {
      gaps.push({
        ...at(p.line),
        construct: "pou",
        detail: `pouType ${p.attrs.pouType ?? "(none)"} is not read.`,
      });
      continue;
    }
    const iface = kid(p, "interface");
    const returns = typeText(kid(iface, "returnType"));
    emit(`${kind} ${p.attrs.name}${kind === "FUNCTION" && returns ? ` : ${returns}` : ""}`, p.line);
    emitVars(iface);
    const body = kid(p, "body");
    const lang = body?.children.find((c) => BODY_LANGS.has(c.name));
    if (lang?.name === "ST") {
      const parts: Array<{ value: string; line: number }> = [];
      const collect = (n: XNode) => {
        parts.push(...n.text);
        n.children.forEach(collect);
      };
      collect(lang);
      parts.sort((a, b) => a.line - b.line);
      for (const part of parts) {
        part.value.split(/\r?\n/).forEach((s, k) => emit(s, part.line + k));
      }
    } else if (lang?.name === "FBD" || lang?.name === "LD") {
      emitNetwork(lang, p.attrs.name);
    } else if (lang) {
      gaps.push({
        ...at(lang.line),
        construct: lang.name,
        detail: `${lang.name} body of ${p.attrs.name} is not analysed yet.`,
      });
    }
    for (const extra of ["actions", "transitions"]) {
      const n = kid(p, extra);
      if (n && n.children.length > 0) {
        gaps.push({
          ...at(n.line),
          construct: extra,
          detail: `${extra} of ${p.attrs.name} are not analysed yet.`,
        });
      }
    }
    emit(`END_${kind}`, p.endLine);
    const doc = textOf(kid(p, "documentation")).trim();
    if (doc) {
      docs.set(p.attrs.name.toUpperCase(), doc);
    }
  }

  const parsed = parsePlcFile(path, st.join("\n"));
  const map = <T extends Loc>(x: T): T => ({ ...x, line: lines[x.line - 1] ?? x.line });
  const pous = parsed.pous.map((p) => {
    const doc = docs.get(p.name.toUpperCase());
    const { doc: _synthetic, ...rest } = p;
    return {
      ...map(rest),
      endLine: lines[p.endLine - 1] ?? p.endLine,
      ...(doc ? { doc } : {}),
      vars: p.vars.map(map),
      calls: p.calls.map(map),
      writes: p.writes.map(map),
    };
  });
  return {
    path,
    pous,
    types,
    globals: parsed.globals.map(map),
    gaps: [...gaps, ...parsed.gaps.map(map)].toSorted((a, b) => a.line - b.line),
  };
}
