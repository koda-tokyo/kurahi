// Exclusive XML Canonicalization 1.0 without comments (http://www.w3.org/2001/10/xml-exc-c14n#)
// of an element subtree, as XML-DSig uses it for SAML signatures.
//
// Rules implemented (W3C exc-c14n §3 over C14N 1.0 §2): namespace declarations are emitted on an
// element only for prefixes it visibly uses (its own prefix or the default namespace when it has
// none, and the prefixes of its attributes) or that the InclusiveNamespaces PrefixList names,
// and only when the nearest output ancestor did not already emit the same binding; `xmlns=""` is
// emitted when the element uses the default namespace, has none, and an output ancestor emitted
// one. Declarations sort by prefix (default first), attributes by namespace URI then local name.
// Text escapes & < > and CR; attribute values escape & < " TAB LF CR. Empty elements are written
// as start and end tag. `xml:*` attributes are not inherited (exclusive canonicalisation).
// `omit` excludes one element (the enveloped signature) and everything under it.
import type { XmlElement } from "./xml.js";

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalizeExclusive(
  apex: XmlElement,
  opts: { inclusivePrefixes?: string[]; omit?: XmlElement | null } = {},
): string {
  const inclusive = new Set((opts.inclusivePrefixes ?? []).map((p) => (p === "#default" ? "" : p)));
  const out: string[] = [];

  // `rendered` maps prefix → URI as emitted by the output ancestors (default "" → "" at the top).
  const visit = (el: XmlElement, rendered: Map<string, string>) => {
    const used = new Set<string>();
    used.add(el.prefix ?? "");
    for (const a of el.attrs) {
      if (a.prefix && a.prefix !== "xml") {
        used.add(a.prefix);
      }
    }
    for (const p of inclusive) {
      if (el.inScope.has(p)) {
        used.add(p);
      }
    }
    const decls: Array<[string, string]> = [];
    const next = new Map(rendered);
    for (const prefix of used) {
      if (prefix === "xml") {
        continue;
      }
      const uri = el.inScope.get(prefix) ?? "";
      if (prefix === "" && uri === "" && (rendered.get("") ?? "") === "") {
        continue;
      }
      if (rendered.get(prefix) === uri) {
        continue;
      }
      if (prefix !== "" && uri === "") {
        continue;
      }
      decls.push([prefix, uri]);
      next.set(prefix, uri);
    }
    decls.sort((a, b) => compareCodeUnits(a[0], b[0]));
    const attrs = el.attrs
      .map((a) => ({ a, ns: a.ns ?? "" }))
      .toSorted((x, y) => compareCodeUnits(x.ns, y.ns) || compareCodeUnits(x.a.local, y.a.local));
    let tag = `<${el.qname}`;
    for (const [prefix, uri] of decls) {
      tag += prefix ? ` xmlns:${prefix}="${escapeAttr(uri)}"` : ` xmlns="${escapeAttr(uri)}"`;
    }
    for (const { a } of attrs) {
      tag += ` ${a.qname}="${escapeAttr(a.value)}"`;
    }
    out.push(`${tag}>`);
    for (const c of el.children) {
      if (c.type === "text") {
        out.push(escapeText(c.value));
      } else if (c !== opts.omit) {
        visit(c, next);
      }
    }
    out.push(`</${el.qname}>`);
  };
  visit(apex, new Map([["", ""]]));
  return out.join("");
}
