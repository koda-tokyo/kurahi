// IBM watsonx Code Assistant for Z, Z Understand "Documentation Generation" output
// (VERIFIED_FROM_DOCS, layout and section names):
// https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/Docgen_create.html
//
// Documented results: a `Documentation` folder holding `application_document.md` at its root,
// `<program_name>.md` files in `programs/`, and a log file in `logs/`. Markdown is the default
// output (HTML is optional). Documented default sections:
//   program      Purpose, Inputs, Outputs, Business Rules, Business Variables, Processing Logic,
//                Paragraphs, Dependencies, Constraints, Error Handling, Examples
//   application  Overview, Processing Flow, Components, Business Rules, Business Variables,
//                Inputs, Outputs, Error Handling, Constraints
// Heading levels and the inner formatting of each section are not documented, so:
//   - a section is recognised only by its documented name (any heading level, case-insensitive);
//     other headings are kept as notes, never mapped
//   - Business Rules: each list item (or paragraph, when written as prose) is a rule candidate
//   - Dependencies: a list item becomes a DEPENDS_ON edge only when it starts with a single
//     name token (e.g. `CUSTMAST - customer master file`); other items are reported, not guessed
//   - the program name is the file name, as documented (<program_name>.md)
// A file with none of the documented sections is not this format (SCHEMA_REJECTED). Files in
// logs/ are ignored. The application document is optional.

import type { ParseInput, ParseResult } from "./types.js";
import { ProviderError } from "../../providers.js";
import { decodeUtf8, sha256Hex } from "../manifest.js";
import { base, emptyArtefacts } from "../model.js";
import { cleanInline, listItems, type MdSection, paragraphs, sectionsOf } from "./markdown.js";

export const PROGRAM_SECTIONS = [
  "purpose",
  "inputs",
  "outputs",
  "business rules",
  "business variables",
  "processing logic",
  "paragraphs",
  "dependencies",
  "constraints",
  "error handling",
  "examples",
] as const;

export const APPLICATION_SECTIONS = [
  "overview",
  "processing flow",
  "components",
  "business rules",
  "business variables",
  "inputs",
  "outputs",
  "error handling",
  "constraints",
] as const;

type Kind = "application" | "program" | "log";

/** Where a file sits in the documented Documentation folder, or null when it does not fit. */
export function docgenRole(p: string): { kind: Kind; program: string | null } | null {
  const segs = p.split("/");
  const at = segs.lastIndexOf("Documentation");
  const rest = at >= 0 ? segs.slice(at + 1) : segs;
  if (rest.length === 1 && rest[0] === "application_document.md") {
    return { kind: "application", program: null };
  }
  if (rest.length === 2 && rest[0] === "programs" && /^[^/]+\.md$/i.test(rest[1])) {
    return { kind: "program", program: rest[1].replace(/\.md$/i, "") };
  }
  if (rest.length >= 2 && rest[0] === "logs") {
    return { kind: "log", program: null };
  }
  return null;
}

const DEP_NAME =
  /^\s*(?:`|\*\*)?([A-Za-z$#@][A-Za-z0-9$#@._-]{0,63})(?:`|\*\*)?\s*(?::|\s[-–—]\s|\(|$)/;

function sectionEntries(s: MdSection) {
  const items = listItems(s.body);
  return items.length > 0 ? items : paragraphs(s.body);
}

export function parseDocgenMd(input: ParseInput): ParseResult {
  const out = emptyArtefacts();
  const shape = new Set<string>();
  let documents = 0;
  for (const f of input.data) {
    const role = docgenRole(f.path);
    if (!role) {
      throw new ProviderError(
        "SCHEMA_REJECTED",
        `${f.path.slice(0, 120)} is not in the documented Documentation layout`,
        "Import the Documentation folder as generated (application_document.md, programs/, logs/).",
      );
    }
    if (role.kind === "log") {
      out.notes.push(`${f.path} is a generation log (ignored)`);
      continue;
    }
    const known: readonly string[] =
      role.kind === "program" ? PROGRAM_SECTIONS : APPLICATION_SECTIONS;
    const { sections } = sectionsOf(decodeUtf8(f.bytes, f.path));
    const matched = sections.filter((s) => known.includes(s.heading.toLowerCase()));
    if (matched.length === 0) {
      throw new ProviderError(
        "SCHEMA_REJECTED",
        `${f.path.slice(0, 120)} has none of the documented ${role.kind} sections`,
        "Import the generated Markdown unchanged; HTML output is not read.",
      );
    }
    for (const s of sections) {
      if (!known.includes(s.heading.toLowerCase()) && s !== sections[0]) {
        out.notes.push(
          `${f.path}:${s.line} heading "${s.heading.slice(0, 60)}" is not a documented section (kept as text only)`,
        );
      }
    }
    documents++;
    const src = (line: number) => ({ file: f.path, sha256: f.sha256, line });
    const subject = role.kind === "program" ? (role.program ?? "") : "application";
    const itemId = `p-${sha256Hex(`${role.kind}:${subject}`).slice(0, 16)}`;
    const purpose = matched.find(
      (s) => s.heading.toLowerCase() === (role.kind === "program" ? "purpose" : "overview"),
    );
    out.items.push({
      ...base(itemId, src(matched[0].line)),
      name: subject,
      nameFrom: role.kind === "program" ? "file name" : "application_document.md",
      kind: role.kind,
      properties: {
        sections: matched.map((s) => s.heading).join(", "),
        summary: purpose ? (paragraphs(purpose.body)[0]?.text.slice(0, 1000) ?? null) : null,
      },
    });
    for (const s of matched) {
      const name = s.heading.toLowerCase();
      shape.add(`${role.kind}:${name}`);
      if (name === "business rules") {
        for (const e of sectionEntries(s)) {
          out.rules.push({
            ...base(`r-${sha256Hex(`${f.path}:${e.line}`).slice(0, 16)}`, src(e.line)),
            vendorId: null,
            title: null,
            text: cleanInline(e.text).slice(0, 4000),
            subject,
            ruleType: "BUSINESS_RULE",
          });
        }
      }
      if (name === "dependencies" && role.kind === "program") {
        for (const e of listItems(s.body)) {
          const m = DEP_NAME.exec(e.text);
          if (!m) {
            out.notes.push(
              `${f.path}:${e.line} dependency entry is not a single name (not mapped to an edge)`,
            );
            continue;
          }
          const target = m[1];
          out.edges.push({
            ...base(`e-${sha256Hex(`${f.path}:${e.line}`).slice(0, 16)}`, src(e.line)),
            from: itemId,
            to: `name:${target}`,
            fromName: subject,
            toName: target,
            relation: "DEPENDS_ON",
            relationNormalised: null,
            properties: { text: cleanInline(e.text).slice(0, 500) },
          });
        }
      }
    }
  }
  if (documents === 0) {
    throw new ProviderError(
      "SCHEMA_REJECTED",
      "the bundle has no application_document.md or programs/*.md",
      "Import the Documentation folder produced by documentation generation.",
    );
  }
  const detail = [...shape].toSorted();
  return { artefacts: out, fingerprint: sha256Hex(detail.join("\n")), fingerprintDetail: detail };
}
