// Strict XML parser for SAML messages (namespace-aware, no external entities, no DTD).
//
// The SAML trust path parses with this small parser instead of a general-purpose XML library:
// the grammar it accepts is the subset identity providers actually send, and everything outside
// it is refused rather than interpreted. Refused outright: DOCTYPE / DTD (no entity expansion,
// no XXE), processing instructions other than the XML declaration, comments (closes the
// comment-truncation class of NameID attacks), CDATA sections, entity references other than the
// five predefined ones and numeric character references, undeclared prefixes, duplicate
// attributes (by qualified and by expanded name), more than one root, and documents beyond the
// size, depth and node limits.
//
// Normalisation follows XML 1.0: line ends become LF (CR LF and lone CR), literal whitespace in
// attribute values becomes a space (all attributes are CDATA without a DTD); character
// references keep the character they name. That is the input the canonicaliser (c14n.ts) needs.

export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

export type XmlAttr = {
  qname: string;
  prefix: string | null;
  local: string;
  ns: string | null;
  value: string;
};

export type XmlText = { type: "text"; value: string };

export type XmlElement = {
  type: "element";
  qname: string;
  prefix: string | null;
  local: string;
  ns: string | null;
  attrs: XmlAttr[];
  /** Namespace declarations made on this element: prefix ("" = default) → URI ("" = undeclare). */
  nsDecls: Map<string, string>;
  /** Every namespace in scope here (inherited + own), prefix ("" = default) → URI. */
  inScope: Map<string, string>;
  children: XmlNode[];
  parent: XmlElement | null;
};

export type XmlNode = XmlElement | XmlText;

export class XmlError extends Error {
  constructor(message: string) {
    super(`XML refused: ${message}`);
    this.name = "XmlError";
  }
}

export type XmlLimits = { maxBytes: number; maxDepth: number; maxNodes: number; maxAttrs: number };
const DEFAULT_LIMITS: XmlLimits = {
  maxBytes: 512 * 1024,
  maxDepth: 48,
  maxNodes: 20_000,
  maxAttrs: 64,
};

const NAME_START = /[A-Za-z_À-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]/;
const NAME_CHAR = /[A-Za-z0-9_.\-·À-ÖØ-öø-ͽͿ-῿‌-‍‿-⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]/;
// XML 1.0 Char: tab, LF, CR and everything from U+0020 except surrogates and U+FFFE / U+FFFF.
// eslint-disable-next-line no-control-regex
const BAD_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

function isValidCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

class Parser {
  private pos = 0;
  private nodes = 0;

  constructor(
    private readonly src: string,
    private readonly limits: XmlLimits,
  ) {}

  private fail(msg: string): never {
    throw new XmlError(`${msg} at offset ${this.pos}`);
  }

  private startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /[ \t\n]/.test(this.src[this.pos])) {
      this.pos += 1;
    }
  }

  private readName(): string {
    const start = this.pos;
    if (this.pos >= this.src.length || !NAME_START.test(this.src[this.pos])) {
      this.fail("expected a name");
    }
    this.pos += 1;
    while (
      this.pos < this.src.length &&
      (NAME_CHAR.test(this.src[this.pos]) || this.src[this.pos] === ":")
    ) {
      this.pos += 1;
    }
    const name = this.src.slice(start, this.pos);
    const parts = name.split(":");
    if (parts.length > 2 || parts.some((p) => !p || !NAME_START.test(p[0]))) {
      this.fail(`invalid qualified name ${JSON.stringify(name)}`);
    }
    return name;
  }

  /** Decode entity and character references in `raw`; `attr` applies attribute normalisation. */
  private decode(raw: string, attr: boolean): string {
    let out = "";
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === "&") {
        const end = raw.indexOf(";", i);
        if (end < 0 || end - i > 12) {
          this.fail("unterminated reference");
        }
        const ref = raw.slice(i + 1, end);
        const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
        if (ref in named) {
          out += named[ref];
        } else if (/^#[0-9]{1,7}$/.test(ref) || /^#x[0-9A-Fa-f]{1,6}$/.test(ref)) {
          const cp =
            ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
          if (!isValidCodePoint(cp)) {
            this.fail("character reference to a forbidden character");
          }
          out += String.fromCodePoint(cp);
        } else {
          this.fail(`entity reference &${ref}; is not allowed`);
        }
        i = end;
      } else if (attr && (ch === "\t" || ch === "\n")) {
        out += " ";
      } else if (attr && ch === "<") {
        this.fail("'<' in an attribute value");
      } else {
        out += ch;
      }
    }
    return out;
  }

  parseDocument(): XmlElement {
    if (this.startsWith("﻿")) {
      this.pos += 1;
    }
    if (this.startsWith("<?xml")) {
      const end = this.src.indexOf("?>", this.pos);
      if (end < 0) {
        this.fail("unterminated XML declaration");
      }
      const decl = this.src.slice(this.pos, end + 2);
      if (
        !/^<\?xml\s+version\s*=\s*["']1\.0["'](\s+encoding\s*=\s*["']utf-8["'])?(\s+standalone\s*=\s*["'](yes|no)["'])?\s*\?>$/i.test(
          decl,
        )
      ) {
        this.fail("unsupported XML declaration");
      }
      this.pos = end + 2;
    }
    this.skipMisc();
    if (!this.startsWith("<")) {
      this.fail("expected the root element");
    }
    const root = this.parseElement(null, 0);
    this.skipMisc();
    if (this.pos !== this.src.length) {
      this.fail("content after the root element");
    }
    return root;
  }

  private skipMisc(): void {
    this.skipWs();
    if (this.startsWith("<!--")) {
      this.fail("comments are not accepted");
    }
    if (this.startsWith("<!") || this.startsWith("<?")) {
      this.fail("DOCTYPE and processing instructions are not accepted");
    }
  }

  private parseElement(parent: XmlElement | null, depth: number): XmlElement {
    if (depth >= this.limits.maxDepth) {
      this.fail("document is nested too deeply");
    }
    if (++this.nodes > this.limits.maxNodes) {
      this.fail("document has too many nodes");
    }
    this.pos += 1; // "<"
    const qname = this.readName();
    const rawAttrs: Array<{ qname: string; value: string }> = [];
    for (;;) {
      const before = this.pos;
      this.skipWs();
      if (this.startsWith("/>") || this.startsWith(">")) {
        break;
      }
      if (this.pos === before) {
        this.fail("expected whitespace before an attribute");
      }
      const name = this.readName();
      this.skipWs();
      if (this.src[this.pos] !== "=") {
        this.fail("expected '='");
      }
      this.pos += 1;
      this.skipWs();
      const quote = this.src[this.pos];
      if (quote !== '"' && quote !== "'") {
        this.fail("expected a quoted attribute value");
      }
      const end = this.src.indexOf(quote, this.pos + 1);
      if (end < 0) {
        this.fail("unterminated attribute value");
      }
      const value = this.decode(this.src.slice(this.pos + 1, end), true);
      this.pos = end + 1;
      if (rawAttrs.some((a) => a.qname === name)) {
        this.fail(`duplicate attribute ${name}`);
      }
      rawAttrs.push({ qname: name, value });
      if (rawAttrs.length > this.limits.maxAttrs) {
        this.fail("too many attributes");
      }
    }
    const inScope = new Map(parent?.inScope ?? [["xml", XML_NS]]);
    const nsDecls = new Map<string, string>();
    for (const a of rawAttrs) {
      if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) {
        const prefix = a.qname === "xmlns" ? "" : a.qname.slice(6);
        if (
          prefix === "xmlns" ||
          (prefix === "xml" && a.value !== XML_NS) ||
          (prefix !== "xml" && a.value === XML_NS)
        ) {
          this.fail("reserved namespace prefix or URI");
        }
        if (prefix && !a.value) {
          this.fail("a prefixed namespace cannot be undeclared in XML 1.0");
        }
        nsDecls.set(prefix, a.value);
        inScope.set(prefix, a.value);
      }
    }
    const resolve = (name: string, isAttr: boolean) => {
      const i = name.indexOf(":");
      const prefix = i < 0 ? null : name.slice(0, i);
      const local = i < 0 ? name : name.slice(i + 1);
      if (prefix === null) {
        const def = isAttr ? "" : (inScope.get("") ?? "");
        return { prefix, local, ns: def || null };
      }
      const ns = inScope.get(prefix);
      if (!ns) {
        this.fail(`undeclared namespace prefix ${prefix}`);
      }
      return { prefix, local, ns };
    };
    const el: XmlElement = {
      type: "element",
      qname,
      ...resolve(qname, false),
      attrs: [],
      nsDecls,
      inScope,
      children: [],
      parent,
    };
    const expanded = new Set<string>();
    for (const a of rawAttrs) {
      if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) {
        continue;
      }
      const r = resolve(a.qname, true);
      const key = `${r.ns ?? ""}|${r.local}`;
      if (expanded.has(key)) {
        this.fail(`duplicate attribute ${a.qname}`);
      }
      expanded.add(key);
      el.attrs.push({ qname: a.qname, ...r, value: a.value });
    }
    if (this.startsWith("/>")) {
      this.pos += 2;
      return el;
    }
    this.pos += 1; // ">"
    for (;;) {
      const lt = this.src.indexOf("<", this.pos);
      if (lt < 0) {
        this.fail(`unterminated element ${qname}`);
      }
      if (lt > this.pos) {
        const raw = this.src.slice(this.pos, lt);
        if (raw.includes("]]>")) {
          this.fail("']]>' in text");
        }
        if (++this.nodes > this.limits.maxNodes) {
          this.fail("document has too many nodes");
        }
        el.children.push({ type: "text", value: this.decode(raw, false) });
      }
      this.pos = lt;
      if (this.startsWith("</")) {
        this.pos += 2;
        const closing = this.readName();
        if (closing !== qname) {
          this.fail(`mismatched end tag ${closing} for ${qname}`);
        }
        this.skipWs();
        if (this.src[this.pos] !== ">") {
          this.fail("expected '>'");
        }
        this.pos += 1;
        return el;
      }
      if (this.startsWith("<!--")) {
        this.fail("comments are not accepted");
      }
      if (this.startsWith("<!") || this.startsWith("<?")) {
        this.fail("CDATA, DOCTYPE and processing instructions are not accepted");
      }
      el.children.push(this.parseElement(el, depth + 1));
    }
  }
}

/** Parse a complete document. The input is the decoded UTF-8 text of the message. */
export function parseXml(input: string, limits: Partial<XmlLimits> = {}): XmlElement {
  const l = { ...DEFAULT_LIMITS, ...limits };
  if (input.length > l.maxBytes) {
    throw new XmlError("document is too large");
  }
  // Line-end normalisation (XML 1.0 §2.11) before anything else; then the character check.
  const text = input.replace(/\r\n?/g, "\n");
  if (BAD_CHAR.test(text)) {
    throw new XmlError("document contains a forbidden character");
  }
  return new Parser(text, l).parseDocument();
}

/** Decode bytes as UTF-8, refusing invalid sequences instead of substituting U+FFFD. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new XmlError("message is not valid UTF-8");
  }
}

// ── tree helpers ───────────────────────────────────────────────────────────────────────

export function childElements(el: XmlElement, ns?: string, local?: string): XmlElement[] {
  return el.children.filter(
    (c): c is XmlElement =>
      c.type === "element" &&
      (ns === undefined || c.ns === ns) &&
      (local === undefined || c.local === local),
  );
}

/** The single child with this name, null when absent; refuses duplicates. */
export function onlyChild(el: XmlElement, ns: string, local: string): XmlElement | null {
  const found = childElements(el, ns, local);
  if (found.length > 1) {
    throw new XmlError(`more than one ${local} in ${el.local}`);
  }
  return found[0] ?? null;
}

export function descendants(el: XmlElement, ns: string, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.type === "element") {
        if (c.ns === ns && c.local === local) {
          out.push(c);
        }
        walk(c);
      }
    }
  };
  if (el.ns === ns && el.local === local) {
    out.push(el);
  }
  walk(el);
  return out;
}

/** An unqualified attribute's value (SAML attributes such as ID, Version are unqualified). */
export function attr(el: XmlElement, local: string): string | null {
  return el.attrs.find((a) => a.ns === null && a.local === local)?.value ?? null;
}

/** All text content of an element that may hold only text (child elements are refused). */
export function textOf(el: XmlElement): string {
  let out = "";
  for (const c of el.children) {
    if (c.type === "element") {
      throw new XmlError(`${el.local} must hold text only`);
    }
    out += c.value;
  }
  return out;
}
