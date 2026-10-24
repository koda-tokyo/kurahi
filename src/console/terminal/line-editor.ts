// The console terminal's prompt line editor. While no command runs, keystrokes never reach a
// shell: the broker edits the line itself, echoes it, and hands the whole line to the gate on
// Enter. Supported: printable text, Backspace, Ctrl-C (discard the line), Ctrl-U (erase the
// line). Escape sequences (arrows, function keys), Tab and other control keys are ignored.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const splitGraphemes = (text: string) => Array.from(segmenter.segment(text), (s) => s.segment);

export type EditResult = {
  /** Text to echo to the terminal. */
  echo: string;
  /** The line, when Enter was pressed. */
  submitted: string | null;
  /** Ctrl-C was pressed with no command running. */
  interrupted: boolean;
  /** Data followed Enter in the same input (a multi-line paste): it was discarded. */
  discardedRest: boolean;
  /** Characters were dropped because the line reached the length limit. */
  overLimit: boolean;
};

export class LineEditor {
  line = "";
  private escape: "none" | "start" | "csi" | "ss3" = "none";

  constructor(private readonly maxLength: number) {}

  reset(): void {
    this.line = "";
    this.escape = "none";
  }

  feed(data: string): EditResult {
    const out: EditResult = {
      echo: "",
      submitted: null,
      interrupted: false,
      discardedRest: false,
      overLimit: false,
    };
    const chars = Array.from(data);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const code = ch.codePointAt(0) ?? 0;
      if (this.escape === "start") {
        this.escape = ch === "[" ? "csi" : ch === "O" ? "ss3" : "none";
        continue;
      }
      if (this.escape === "csi") {
        if (code >= 0x40 && code <= 0x7e) {
          this.escape = "none";
        }
        continue;
      }
      if (this.escape === "ss3") {
        this.escape = "none";
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        out.submitted = this.line;
        this.line = "";
        const rest = chars
          .slice(i + 1)
          .join("")
          .replace(/^\n/, "");
        out.discardedRest = rest.trim().length > 0;
        return out;
      }
      if (ch === "\x1b") {
        this.escape = "start";
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        if (this.line.length > 0) {
          const graphemes = splitGraphemes(this.line);
          graphemes.pop();
          this.line = graphemes.join("");
          out.echo += "\b \b";
        }
        continue;
      }
      if (ch === "\x03") {
        out.echo += "^C\r\n";
        this.line = "";
        out.interrupted = true;
        continue;
      }
      if (ch === "\x15") {
        out.echo += "\b \b".repeat(splitGraphemes(this.line).length);
        this.line = "";
        continue;
      }
      if (code < 0x20 || (code >= 0x80 && code < 0xa0)) {
        continue;
      }
      if (this.line.length + ch.length > this.maxLength) {
        out.overLimit = true;
        continue;
      }
      this.line += ch;
      out.echo += ch;
    }
    return out;
  }
}
