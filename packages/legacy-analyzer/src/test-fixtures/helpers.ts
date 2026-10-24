import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A fixed-format line in Area A (column 8). */
export const A = (text: string, seq = "      ") => `${seq} ${text}`;
/** A fixed-format line in Area B (column 12). */
export const B = (text: string, seq = "      ") => `${seq}     ${text}`;
/** A comment line (indicator `*` in column 7). */
export const C = (text: string) => `      *${text}`;
/** A continuation line (indicator `-` in column 7), text from column 12. */
export const K = (text: string) => `      -    ${text}`;

export function program(
  name: string,
  body: { env?: string[]; data?: string[]; proc: string[]; using?: string },
): string {
  return [
    A("IDENTIFICATION DIVISION."),
    A(`PROGRAM-ID. ${name}.`),
    A("ENVIRONMENT DIVISION."),
    ...(body.env ?? []),
    A("DATA DIVISION."),
    ...(body.data ?? []),
    A(`PROCEDURE DIVISION${body.using ? ` USING ${body.using}` : ""}.`),
    ...body.proc,
  ].join("\n");
}

export function tmpTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-analyzer-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${content}\n`);
  }
  return root;
}
