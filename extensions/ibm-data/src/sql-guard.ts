// Read-only SQL guard for the watsonx.data query tool. It is a second line of defence, not the
// boundary: the engine user the administrator configures must itself be read-only and limited to
// the allowed catalogs. The guard refuses anything that is not a single SELECT / WITH ... SELECT /
// SHOW / DESCRIBE statement, any statement-level keyword that writes or changes the session, and
// any table reference outside the catalog and schema allowlist.

export type CatalogAllowlist = Array<{ name: string; schemas: string[] }>;

export class SqlRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlRefused";
  }
}

const LEADING = new Set(["select", "with", "show", "describe"]);
const FORBIDDEN = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "create",
  "drop",
  "alter",
  "truncate",
  "grant",
  "revoke",
  "deny",
  "call",
  "execute",
  "prepare",
  "deallocate",
  "set",
  "reset",
  "use",
  "start",
  "commit",
  "rollback",
  "analyze",
  "refresh",
  "comment",
  "explain",
  "vacuum",
  "optimize",
  "register",
  "unregister",
]);

type Token = { kind: "word" | "quoted" | "punct"; text: string };

/** Tokenise, dropping comments and string literals; quoted identifiers keep their text. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") {
        i += 1;
      }
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) {
        throw new SqlRefused("unterminated comment");
      }
      i = end + 2;
    } else if (c === "'") {
      // String literal; '' escapes a quote.
      i += 1;
      for (;;) {
        if (i >= n) {
          throw new SqlRefused("unterminated string literal");
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      out.push({ kind: "punct", text: "''" });
    } else if (c === '"' || c === "`") {
      const end = sql.indexOf(c, i + 1);
      if (end < 0) {
        throw new SqlRefused("unterminated quoted identifier");
      }
      out.push({ kind: "quoted", text: sql.slice(i + 1, end).toLowerCase() });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) {
        j += 1;
      }
      out.push({ kind: "word", text: sql.slice(i, j).toLowerCase() });
      i = j;
    } else {
      out.push({ kind: "punct", text: c });
      i += 1;
    }
  }
  return out;
}

const ident = (t: Token | undefined) => t && (t.kind === "word" || t.kind === "quoted");

/** Dotted name starting at index i: parts and the index after it. */
function readName(tokens: Token[], i: number): { parts: string[]; next: number } | null {
  if (!ident(tokens[i])) {
    return null;
  }
  const parts = [tokens[i].text];
  let j = i + 1;
  while (tokens[j]?.text === "." && ident(tokens[j + 1])) {
    parts.push(tokens[j + 1].text);
    j += 2;
  }
  return { parts, next: j };
}

/**
 * Check a statement. `session` is the catalog and schema the query runs in (from the
 * allowlist). Returns the statement without a trailing semicolon.
 */
export function assertReadOnlySql(
  sql: string,
  allow: CatalogAllowlist,
  session: { catalog: string; schema: string },
): string {
  const text = sql.trim().replace(/;\s*$/, "");
  if (!text) {
    throw new SqlRefused("the query is empty");
  }
  const tokens = tokenize(text);
  if (tokens.some((t) => t.text === ";")) {
    throw new SqlRefused("only one statement is allowed");
  }
  const first = tokens[0];
  if (first?.kind !== "word" || !LEADING.has(first.text)) {
    throw new SqlRefused("only SELECT, WITH, SHOW and DESCRIBE statements are allowed");
  }
  for (const t of tokens) {
    if (t.kind === "word" && FORBIDDEN.has(t.text)) {
      throw new SqlRefused(`"${t.text.toUpperCase()}" is not allowed in a read-only query`);
    }
  }
  const catalogs = new Map(
    allow.map((c) => [c.name.toLowerCase(), new Set(c.schemas.map((s) => s.toLowerCase()))]),
  );
  const allowed = (catalog: string, schema: string) => catalogs.get(catalog)?.has(schema) === true;
  const cteNames = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (ident(tokens[i]) && tokens[i + 1].text === "as" && tokens[i + 2]?.text === "(") {
      cteNames.add(tokens[i].text);
    }
  }
  // Table references follow FROM, JOIN, and commas in a FROM list; SHOW ... FROM/IN and
  // DESCRIBE name objects too.
  const checkRef = (parts: string[]) => {
    if (parts.length === 1) {
      if (cteNames.has(parts[0]) || allowed(session.catalog, session.schema)) {
        return;
      }
    } else if (parts.length === 2) {
      if (allowed(session.catalog, parts[0])) {
        return;
      }
    } else if (parts.length === 3 && allowed(parts[0], parts[1])) {
      return;
    }
    throw new SqlRefused(`"${parts.join(".")}" is outside the allowed catalogs and schemas`);
  };
  if (first.text === "describe") {
    const name = readName(
      tokens,
      tokens[1]?.text === "input" || tokens[1]?.text === "output" ? 2 : 1,
    );
    if (!name) {
      throw new SqlRefused("DESCRIBE needs a table name");
    }
    checkRef(name.parts);
    return text;
  }
  if (first.text === "show") {
    const what = tokens[1]?.text;
    if (what === "catalogs") {
      throw new SqlRefused("SHOW CATALOGS is not allowed; the allowed catalogs are configured");
    }
    for (let i = 2; i < tokens.length; i += 1) {
      if (tokens[i].text === "from" || tokens[i].text === "in") {
        const name = readName(tokens, i + 1);
        if (!name) {
          continue;
        }
        if (what === "schemas") {
          if (!catalogs.has(name.parts[0])) {
            throw new SqlRefused(`catalog "${name.parts[0]}" is not allowed`);
          }
        } else if (name.parts.length === 1) {
          // SHOW TABLES FROM <schema>
          if (!allowed(session.catalog, name.parts[0])) {
            throw new SqlRefused(`schema "${name.parts[0]}" is not allowed`);
          }
        } else {
          checkRef(name.parts.length === 2 ? [...name.parts, "x"] : name.parts);
        }
      }
    }
    return text;
  }
  let inFrom = false;
  let depth = 0;
  const fromDepth: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.text === "(") {
      depth += 1;
      continue;
    }
    if (t.text === ")") {
      depth -= 1;
      if (fromDepth.length && fromDepth[fromDepth.length - 1] > depth) {
        fromDepth.pop();
      }
      continue;
    }
    if (t.kind === "word" && (t.text === "from" || t.text === "join")) {
      inFrom = true;
      fromDepth.push(depth);
      const name = readName(tokens, i + 1);
      if (name && tokens[i + 1]?.text !== "(") {
        if (name.parts[0] === "table") {
          // Table functions can pass SQL through to a connector's own database.
          throw new SqlRefused("table functions are not allowed");
        }
        if (name.parts[0] === "unnest") {
          continue;
        }
        checkRef(name.parts);
        i = name.next - 1;
      }
      continue;
    }
    if (
      inFrom &&
      t.text === "," &&
      fromDepth.length > 0 &&
      fromDepth[fromDepth.length - 1] === depth
    ) {
      const name = readName(tokens, i + 1);
      if (name && tokens[i + 1]?.text !== "(") {
        checkRef(name.parts);
        i = name.next - 1;
      }
      continue;
    }
    if (
      t.kind === "word" &&
      [
        "where",
        "group",
        "order",
        "having",
        "limit",
        "union",
        "intersect",
        "except",
        "on",
        "select",
      ].includes(t.text)
    ) {
      if (fromDepth.length && fromDepth[fromDepth.length - 1] === depth) {
        fromDepth.pop();
        inFrom = fromDepth.length > 0;
      }
    }
  }
  return text;
}
