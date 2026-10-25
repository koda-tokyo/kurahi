// MyBatis mapper XML: the namespace (the mapper interface) and its <select>, <insert>, <update>
// and <delete> statements with path:line. The SQL of a statement is read with every dynamic
// branch (<if>, <choose>, <foreach>, ...) included, so its tables are the union of all branches.
// <include refid> is expanded from <sql> fragments of the same file; a fragment from another file,
// or a ${...} substitution (often a table or column name), makes the statement partial.

import type { Loc } from "../types.js";

export type MyBatisStatement = Loc & {
  id: string;
  kind: "select" | "insert" | "update" | "delete";
  /** SQL text, tags removed, #{...} and ${...} replaced by `?`, whitespace collapsed. */
  text: string;
  partial?: boolean;
};

export type MyBatisMapper = {
  file: string;
  namespace: string;
  line: number;
  statements: MyBatisStatement[];
};

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
const attr = (attrs: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1]?.trim();
// Comments become blanks of the same lines, so offsets keep their line numbers.
const blank = (s: string) => s.replace(/[^\n]/g, " ");
const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export function parseMyBatisMapper(path: string, raw: string): MyBatisMapper | null {
  const text = raw.replace(/<!--[\s\S]*?-->/g, blank);
  const mapper = /<mapper\b([^>]*)>/.exec(text);
  const namespace = mapper ? attr(mapper[1], "namespace") : undefined;
  if (!mapper || !namespace) {
    return null;
  }
  const fragments = new Map<string, string>();
  for (const m of text.matchAll(/<sql\b([^>]*)>([\s\S]*?)<\/sql>/g)) {
    const id = attr(m[1], "id");
    if (id) {
      fragments.set(id, m[2]);
    }
  }
  const statements: MyBatisStatement[] = [];
  for (const m of text.matchAll(/<(select|insert|update|delete)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const id = attr(m[2], "id");
    if (!id) {
      continue;
    }
    let partial = false;
    const expand = (body: string, depth: number): string =>
      body.replace(/<include\b([^>]*?)(?:\/>|>[\s\S]*?<\/include>)/g, (_, attrs: string) => {
        const frag = fragments.get(attr(attrs, "refid") ?? "");
        if (frag === undefined || depth > 5) {
          partial = true;
          return " ";
        }
        return expand(frag, depth + 1);
      });
    // CDATA keeps its `<` and `>` as entities, so stripping tags cannot eat a comparison.
    let sql = expand(m[3], 0).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
    if (/\$\{/.test(sql)) {
      partial = true;
    }
    sql = unescape(sql.replace(/[#$]\{[^}]*\}/g, "?").replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    statements.push({
      file: path,
      line: lineAt(text, m.index),
      id,
      kind: m[1] as MyBatisStatement["kind"],
      text: sql,
      ...(partial ? { partial: true } : {}),
    });
  }
  return { file: path, namespace, line: lineAt(text, mapper.index), statements };
}
