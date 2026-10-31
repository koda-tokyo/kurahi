// Test helpers for the verification engine: a stand-in `cobc` that "compiles" by copying the
// entry source (a shell script) to the executable, so runner tests need no real compiler.
import fs from "node:fs";
import path from "node:path";

export function makeFakeCobc(dir: string): string {
  const file = path.join(dir, "cobc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "fake-cobc 0.1"; exit 0; fi',
      'out=""; last=""',
      'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; last="$1"; shift; done',
      'if grep -q "SYNTAX ERROR" "$last"; then echo "error: syntax" >&2; exit 1; fi',
      'cp "$last" "$out" && chmod +x "$out"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return file;
}

/** A "COBOL program" for the fake compiler: a shell script body in PROG.cbl. */
export function writeProgram(dir: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PROG.cbl"), `#!/bin/sh\n${body}\n`);
}
