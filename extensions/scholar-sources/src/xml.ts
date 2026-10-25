// A minimal reader for the two XML feeds we consume (arXiv Atom, PubMed efetch). Not a general
// XML parser: elements are found by name (non-greedy, no nesting of the same name), attributes by
// a bounded pattern, entities decoded. Inputs are size-capped before they get here, and nothing
// is evaluated (no DTDs, no external entities).
import { decodeEntities } from "./record.js";

export type XmlElement = { attrs: string; inner: string };

const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function elements(xml: string, name: string, max = 500): XmlElement[] {
  const n = escapeName(name);
  const re = new RegExp(`<${n}(\\s[^>]{0,2000}?)?(?:/>|>([\\s\\S]*?)</${n}>)`, "g");
  const out: XmlElement[] = [];
  for (const m of xml.matchAll(re)) {
    out.push({ attrs: m[1] ?? "", inner: m[2] ?? "" });
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

export function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\s${escapeName(name)}\\s*=\\s*(?:"([^"]{0,2000})"|'([^']{0,2000})')`).exec(
    ` ${attrs}`,
  );
  const v = m ? (m[1] ?? m[2] ?? "") : null;
  return v === null ? null : decodeEntities(v);
}

/** Text of an element's content: child tags removed, CDATA kept, entities decoded. */
export function textOf(inner: string): string {
  return decodeEntities(
    inner
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/</g, "&lt;"))
      .replace(/<[^>]{0,2000}>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function firstText(xml: string, name: string): string {
  const el = elements(xml, name, 1)[0];
  return el ? textOf(el.inner) : "";
}
