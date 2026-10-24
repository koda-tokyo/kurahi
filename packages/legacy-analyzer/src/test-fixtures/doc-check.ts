import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fact lines (list items and table body rows, outside code blocks) that carry no `path:line`
 * citation. Table header rows (followed by the `| --- |` separator) are not fact lines.
 */
export function uncitedFactLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  const bad: string[] = [];
  let inCode = false;
  lines.forEach((l, i) => {
    if (l.startsWith("```")) {
      inCode = !inCode;
      return;
    }
    if (inCode) {
      return;
    }
    const isList = /^\s*- /.test(l);
    const isRow =
      l.startsWith("| ") && !l.startsWith("| ---") && !(lines[i + 1] ?? "").startsWith("| ---");
    if ((isList || isRow) && !/`[^`\s]+:\d+`/.test(l)) {
      bad.push(l);
    }
  });
  return bad;
}

/** The same files under `<tmp>/<name>/`, so two copies have the same folder name. */
export function namedTree(name: string, files: Record<string, string>): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-doc-"));
  const root = path.join(base, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${content}\n`);
  }
  return root;
}

/** The demo pack (~/kurahi-demo-packs/industry-legacy-cobol or KURAHI_LEGACY_DEMO_PACK), if present. */
export function demoPack(): string | null {
  const dir =
    process.env.KURAHI_LEGACY_DEMO_PACK ??
    path.join(os.userInfo().homedir, "kurahi-demo-packs", "industry-legacy-cobol");
  return fs.existsSync(path.join(dir, "source", "cobol", "PAYCALC.cbl")) ? dir : null;
}
