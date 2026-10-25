// Token cursor of the Java declaration parser: lookahead, source text of a token range, error
// recovery, qualified names, types (generics, arrays, varargs), annotations with their element
// values, modifiers, type keywords (record and @interface included), type lists and parameters.

import type { JTok } from "./java-lexer.js";
import type { EngineGap, JavaAnnotation, JavaParam, JavaTypeKind } from "./types.js";
import { matching } from "./java-body.js";

const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "native",
  "synchronized",
  "transient",
  "volatile",
  "strictfp",
  "default",
  "sealed",
]);

export class P {
  k = 0;
  gaps: EngineGap[] = [];
  constructor(
    readonly file: string,
    readonly t: JTok[],
  ) {}
  get cur(): JTok | undefined {
    return this.t[this.k];
  }
  at(v: string, off = 0): boolean {
    const x = this.t[this.k + off];
    return Boolean(x && (x.k === "op" || x.k === "id") && x.v === v);
  }
  line(): number {
    return this.cur?.line ?? this.t[this.t.length - 1]?.line ?? 1;
  }
  gap(construct: string, detail: string, line = this.line()) {
    this.gaps.push({ file: this.file, line, construct, detail });
  }
  /** Source text of tokens [a, b): identifiers spaced, punctuation tight. */
  text(a: number, b: number): string {
    let s = "";
    for (let i = a; i < b; i++) {
      const x = this.t[i];
      const v = x.k === "str" ? `"${x.v}"` : x.k === "chr" ? `'${x.v}'` : x.v;
      const prev = this.t[i - 1];
      const glue =
        i === a ||
        /^[.,()<>[\]@]$/.test(v) ||
        v === "..." ||
        (prev && /^[.(<[@]$/.test(prev.v) && prev.k === "op");
      s += glue ? v : ` ${v}`;
      if (v === "," && i + 1 < b) {
        s += " ";
      }
    }
    return s.replace(/ {2,}/g, " ");
  }
  /** Skip to the end of a statement or a balanced block (error recovery). */
  skipStatement() {
    while (this.cur && !this.at(";") && !this.at("}")) {
      if (this.at("{") || this.at("(")) {
        this.k = matching(this.t, this.k) + 1;
        if (this.t[this.k - 1]?.v === "}") {
          return;
        }
        continue;
      }
      this.k++;
    }
    if (this.at(";")) {
      this.k++;
    }
  }
  qualifiedName(): string {
    const parts: string[] = [];
    while (this.cur?.k === "id") {
      parts.push(this.cur.v);
      this.k++;
      if (this.at(".") && this.t[this.k + 1]?.k === "id") {
        this.k++;
        continue;
      }
      break;
    }
    return parts.join(".");
  }
  /** A type: qualified name, type arguments, array dims, varargs. */
  type(): string {
    const a = this.k;
    while (this.at("@")) {
      this.annotation();
    }
    const startType = this.k;
    this.qualifiedName();
    if (this.at("<")) {
      this.k = matching(this.t, this.k) + 1;
      // Nested.Inner after type arguments: Outer<T>.Inner
      while (this.at(".") && this.t[this.k + 1]?.k === "id") {
        this.k++;
        this.qualifiedName();
        if (this.at("<")) {
          this.k = matching(this.t, this.k) + 1;
        }
      }
    }
    while (this.at("[") && this.at("]", 1)) {
      this.k += 2;
    }
    if (this.at("...")) {
      this.k++;
    }
    return this.text(startType > a ? startType : a, this.k);
  }
  annotation(): JavaAnnotation {
    const line = this.line();
    this.k++; // @
    const name = this.qualifiedName();
    const args: Record<string, string> = {};
    if (this.at("(")) {
      const close = matching(this.t, this.k);
      // Split the element-value pairs at top-level commas.
      let depth = 0;
      let segStart = this.k + 1;
      const segs: Array<[number, number]> = [];
      for (let i = this.k + 1; i < close; i++) {
        const v = this.t[i].k === "op" ? this.t[i].v : "";
        if (v === "(" || v === "{" || v === "[") {
          depth++;
        } else if (v === ")" || v === "}" || v === "]") {
          depth--;
        } else if (v === "," && depth === 0) {
          segs.push([segStart, i]);
          segStart = i + 1;
        }
      }
      if (close > this.k + 1) {
        segs.push([segStart, close]);
      }
      for (const [s, e] of segs) {
        const named = this.t[s]?.k === "id" && this.t[s + 1]?.v === "=" && this.t[s + 2]?.v !== "=";
        const key = named ? this.t[s].v : "value";
        const from = named ? s + 2 : s;
        const strs = this.t.slice(from, e).filter((x) => x.k === "str");
        const onlyStrings =
          strs.length > 0 && this.t.slice(from, e).every((x) => x.k === "str" || x.v === "+");
        args[key] = onlyStrings ? strs.map((x) => x.v).join("") : this.text(from, e);
      }
      // Annotations inside the values keep their own names, values and lines, and the element
      // they are the value of when it is named (`joinColumns = @JoinColumn(..)`).
      const keyAt = (i: number) => {
        const seg = segs.find(([s, e]) => i >= s && i < e);
        const s = seg?.[0] ?? -1;
        return this.t[s]?.k === "id" && this.t[s + 1]?.v === "=" ? this.t[s].v : undefined;
      };
      const nested: JavaAnnotation[] = [];
      for (this.k++; this.k < close; ) {
        if (this.at("@") && this.t[this.k + 1]?.k === "id") {
          const element = keyAt(this.k);
          const a = this.annotation();
          nested.push(element ? { ...a, element } : a);
        } else {
          this.k++;
        }
      }
      this.k = close + 1;
      if (nested.length > 0) {
        return { file: this.file, line, name, args, nested };
      }
    }
    return { file: this.file, line, name, args };
  }
  modifiers(): { mods: string[]; anns: JavaAnnotation[]; doc?: string; line: number } {
    const mods: string[] = [];
    const anns: JavaAnnotation[] = [];
    const doc = this.cur?.doc;
    const line = this.line();
    for (;;) {
      if (this.at("@") && !this.at("interface", 1)) {
        anns.push(this.annotation());
      } else if (
        this.cur?.k === "id" &&
        MODIFIERS.has(this.cur.v) &&
        !(this.cur.v === "default" && this.at(":", 1))
      ) {
        mods.push(this.cur.v);
        this.k++;
      } else if (this.at("non") && this.at("-", 1) && this.at("sealed", 2)) {
        mods.push("non-sealed");
        this.k += 3;
      } else {
        break;
      }
    }
    return { mods, anns, doc, line };
  }
  typeKeyword(): JavaTypeKind | undefined {
    if (this.at("class")) {
      return "class";
    }
    if (this.at("interface")) {
      return "interface";
    }
    if (this.at("enum") && this.t[this.k + 1]?.k === "id") {
      return "enum";
    }
    if (this.at("@") && this.at("interface", 1)) {
      return "annotation";
    }
    if (
      this.at("record") &&
      this.t[this.k + 1]?.k === "id" &&
      (this.at("(", 2) || this.at("<", 2))
    ) {
      return "record";
    }
    return undefined;
  }
  typeList(): string[] {
    const out = [this.type()];
    while (this.at(",")) {
      this.k++;
      out.push(this.type());
    }
    return out;
  }
  params(close: number): JavaParam[] {
    const out: JavaParam[] = [];
    while (this.k < close) {
      this.modifiers(); // final, annotations
      const type = this.type();
      if (this.at("this")) {
        this.k++; // receiver parameter
        out.push({ type, name: "this" });
      } else if (this.cur?.k === "id") {
        out.push({ type, name: this.cur.v });
        this.k++;
      }
      while (this.at("[") && this.at("]", 1)) {
        this.k += 2;
      }
      if (this.at(",")) {
        this.k++;
      } else if (this.k < close) {
        this.gap("parameter list", "A parameter list could not be read fully.");
        break;
      }
    }
    this.k = close + 1;
    return out;
  }
}
