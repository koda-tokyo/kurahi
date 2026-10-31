// AWS Transform for mainframe, generated requirements (VERIFIED_FROM_DOCS, document structure):
// https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe-workflow.html
// ("Generate requirements"): one requirements.md per selected business function, organised as
//   - Title: names the business function and the workflow it represents
//   - Global preconditions: conditions that hold across the workflow (parameter placeholders)
//   - Numbered workflow sections, each with a user story and a list of requirements in EARS
//     (Easy Approach to Requirements Syntax) format, each with a unique identifier.
// The page does not fix the Markdown syntax (heading levels, identifier pattern), so:
//   - the title is the first heading; "Global preconditions" is matched by name; a workflow
//     section is a heading that starts with a number
//   - a requirement is a line with an identifier (a token containing a digit, e.g. REQ-1.1,
//     FR-001, R1) and the EARS keyword "shall"; its EARS pattern is classified by the standard
//     EARS keywords (While, When, If…then, Where; otherwise ubiquitous)
//   - a "shall" line without an identifier is imported and reported (the docs say every
//     requirement has one); a duplicate identifier is reported
// A file without a title, a numbered section and at least one requirement is not this format
// (SCHEMA_REJECTED).

import type { ImportedRule } from "../model.js";
import type { ParseInput, ParseResult } from "./types.js";
import { ProviderError } from "../../providers.js";
import { decodeUtf8, sha256Hex } from "../manifest.js";
import { base, emptyArtefacts } from "../model.js";
import { cleanInline, listItems, type MdSection, sectionsOf } from "./markdown.js";

const ID_LINE =
  /^\s*(?:[-*+]|\d+[.)])?\s*(?:\*\*|__)?\[?([A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*)\]?(?:\*\*|__)?\s*[:.)–—-]?\s+(.*)$/;

export function earsPattern(text: string): string {
  const t = text.trim().toLowerCase();
  if (/^while\b/.test(t)) {
    return "EARS_STATE_DRIVEN";
  }
  if (/^when\b/.test(t)) {
    return "EARS_EVENT_DRIVEN";
  }
  if (/^if\b.*\bthen\b/.test(t)) {
    return "EARS_UNWANTED_BEHAVIOUR";
  }
  if (/^where\b/.test(t)) {
    return "EARS_OPTIONAL_FEATURE";
  }
  return "EARS_UBIQUITOUS";
}

function splitId(line: string): { id: string | null; text: string } {
  const m = ID_LINE.exec(line);
  if (m && /\d/.test(m[1]) && /\bshall\b/i.test(m[2])) {
    return { id: m[1], text: cleanInline(m[2]) };
  }
  return { id: null, text: cleanInline(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")) };
}

export function parseEarsRequirementsMd(input: ParseInput): ParseResult {
  const out = emptyArtefacts();
  const shape = new Set<string>();
  if (input.data.length === 0) {
    throw new ProviderError(
      "SCHEMA_REJECTED",
      "the bundle has no requirements.md file",
      "Add the requirements.md files from the S3 output location.",
    );
  }
  for (const f of input.data) {
    if (!/(^|\/)requirements\.md$/i.test(f.path)) {
      throw new ProviderError(
        "SCHEMA_REJECTED",
        `${f.path.slice(0, 120)} is not a requirements.md file`,
        "List other outputs with role ignored, or import them with a mapped format.",
      );
    }
    const { sections } = sectionsOf(decodeUtf8(f.bytes, f.path));
    const title = sections[0];
    // A numbered workflow section owns the deeper headings under it ("User story", "Requirements").
    const numbered: { heading: string; line: number; body: MdSection["body"] }[] = [];
    let open: { heading: string; line: number; level: number; body: MdSection["body"] } | null =
      null;
    for (const s of sections.slice(1)) {
      if (/^\d+(?:\.\d+)*[.)]?\s+\S/.test(s.heading) && (!open || s.level <= open.level)) {
        open = { heading: s.heading, line: s.line, level: s.level, body: [...s.body] };
        numbered.push(open);
      } else if (open && s.level > open.level) {
        open.body.push({ text: s.heading, line: s.line }, ...s.body);
      } else {
        open = null;
      }
    }
    const pre = sections.find((s) => /global preconditions?/i.test(s.heading));
    const src = (line: number) => ({ file: f.path, sha256: f.sha256, line });
    const rules: ImportedRule[] = [];
    const ids = new Set<string>();
    let withoutId = 0;
    if (title) {
      const fnName = title.heading.slice(0, 200);
      out.items.push({
        ...base(`bf-${sha256Hex(f.path).slice(0, 16)}`, src(title.line)),
        name: fnName,
        nameFrom: "title heading",
        kind: "business-function",
        properties: { workflowSections: numbered.length },
      });
      if (pre) {
        for (const li of listItems(pre.body)) {
          rules.push({
            ...base(`r-${sha256Hex(`${f.path}:${li.line}`).slice(0, 16)}`, src(li.line)),
            vendorId: null,
            title: "Global precondition",
            text: cleanInline(li.text).slice(0, 4000),
            subject: fnName,
            ruleType: "PRECONDITION",
          });
        }
      }
      for (const s of numbered) {
        let story: string | null = null;
        for (const b of s.body) {
          if (!b.text.trim()) {
            continue;
          }
          if (!story && /\bas an?\b.*\bi want\b/i.test(b.text)) {
            story = cleanInline(b.text.replace(/^.*?user story\s*[:-]?\s*/i, "")).slice(0, 2000);
            continue;
          }
          if (!/\bshall\b/i.test(b.text)) {
            continue;
          }
          const { id, text } = splitId(b.text);
          if (id === null) {
            withoutId++;
          } else if (ids.has(id)) {
            out.findings.push({
              ...base(`f-${sha256Hex(`${f.path}:${b.line}:dup`).slice(0, 16)}`, src(b.line)),
              title: "Duplicate requirement identifier",
              detail: id,
              severity: "warning",
              subject: fnName,
            });
          } else {
            ids.add(id);
          }
          rules.push({
            ...base(`r-${sha256Hex(`${f.path}:${b.line}`).slice(0, 16)}`, src(b.line)),
            vendorId: id,
            title: `${s.heading.slice(0, 160)}${story ? ` | ${story}` : ""}`,
            text: text.slice(0, 4000),
            subject: fnName,
            ruleType: earsPattern(text),
          });
        }
      }
    }
    const requirements = rules.filter((r) => r.ruleType.startsWith("EARS_"));
    if (!title || numbered.length === 0 || requirements.length === 0) {
      throw new ProviderError(
        "SCHEMA_REJECTED",
        `${f.path.slice(0, 120)} does not have the documented parts (a title, numbered workflow sections, EARS requirements)`,
        "Import the requirements.md files exactly as generated.",
      );
    }
    if (withoutId > 0) {
      out.findings.push({
        ...base(`f-${sha256Hex(`${f.path}:noid`).slice(0, 16)}`, src(title.line)),
        title: "Requirements without an identifier",
        detail: `${withoutId} requirement line(s) had no identifier; imported without one`,
        severity: "warning",
        subject: title.heading.slice(0, 200),
      });
    }
    out.rules.push(...rules);
    shape.add(
      `requirements.md:title,${pre ? "global-preconditions," : ""}numbered-sections,ears-requirements`,
    );
  }
  const detail = [...shape].toSorted();
  return { artefacts: out, fingerprint: sha256Hex(detail.join("\n")), fingerprintDetail: detail };
}
