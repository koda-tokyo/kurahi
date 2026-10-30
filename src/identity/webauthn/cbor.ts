// A small, strict CBOR decoder (RFC 8949) for WebAuthn: attestation objects, COSE keys and
// authenticator extension maps. Only what CTAP2 canonical CBOR uses is accepted: definite
// lengths, integers that fit a JS number, byte and text strings, arrays, maps (integer or text
// keys, no duplicates), false / true / null / undefined and floats. Tags, indefinite lengths and
// other simple values are refused, and nesting is bounded, so hostile input cannot recurse
// deeply or make the decoder allocate more than the input it was given.

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | Map<number | string, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

const MAX_DEPTH = 16;

type Cursor = { buf: Uint8Array; view: DataView; pos: number };

function need(c: Cursor, n: number): void {
  if (n < 0 || c.pos + n > c.buf.length) {
    throw new CborError("truncated CBOR");
  }
}

/** The argument of an initial byte: a length, a count or an integer value. */
function readArgument(c: Cursor, info: number): number {
  if (info < 24) {
    return info;
  }
  if (info === 24) {
    need(c, 1);
    const v = c.view.getUint8(c.pos);
    c.pos += 1;
    return v;
  }
  if (info === 25) {
    need(c, 2);
    const v = c.view.getUint16(c.pos);
    c.pos += 2;
    return v;
  }
  if (info === 26) {
    need(c, 4);
    const v = c.view.getUint32(c.pos);
    c.pos += 4;
    return v;
  }
  if (info === 27) {
    need(c, 8);
    const v = c.view.getBigUint64(c.pos);
    c.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CborError("CBOR integer out of range");
    }
    return Number(v);
  }
  throw new CborError(info === 31 ? "indefinite-length CBOR is not accepted" : "reserved CBOR");
}

function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) {
    return sign * 2 ** -14 * (frac / 1024);
  }
  if (exp === 31) {
    return frac ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  }
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function readItem(c: Cursor, depth: number): CborValue {
  if (depth > MAX_DEPTH) {
    throw new CborError("CBOR nested too deeply");
  }
  need(c, 1);
  const initial = c.view.getUint8(c.pos);
  c.pos += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;
  switch (major) {
    case 0:
      return readArgument(c, info);
    case 1:
      return -1 - readArgument(c, info);
    case 2: {
      const len = readArgument(c, info);
      need(c, len);
      const out = c.buf.slice(c.pos, c.pos + len);
      c.pos += len;
      return out;
    }
    case 3: {
      const len = readArgument(c, info);
      need(c, len);
      let text: string;
      try {
        text = utf8.decode(c.buf.subarray(c.pos, c.pos + len));
      } catch {
        throw new CborError("invalid UTF-8 in CBOR text");
      }
      c.pos += len;
      return text;
    }
    case 4: {
      const count = readArgument(c, info);
      // Every item takes at least one byte: a count beyond the input is a lie.
      need(c, count);
      const out: CborValue[] = [];
      for (let i = 0; i < count; i += 1) {
        out.push(readItem(c, depth + 1));
      }
      return out;
    }
    case 5: {
      const count = readArgument(c, info);
      need(c, count * 2);
      const out = new Map<number | string, CborValue>();
      for (let i = 0; i < count; i += 1) {
        const key = readItem(c, depth + 1);
        if (typeof key !== "number" && typeof key !== "string") {
          throw new CborError("CBOR map keys must be integers or text");
        }
        if (out.has(key)) {
          throw new CborError("duplicate CBOR map key");
        }
        out.set(key, readItem(c, depth + 1));
      }
      return out;
    }
    case 6:
      throw new CborError("CBOR tags are not accepted");
    default: {
      if (info === 20) {
        return false;
      }
      if (info === 21) {
        return true;
      }
      if (info === 22) {
        return null;
      }
      if (info === 23) {
        return undefined;
      }
      if (info === 25) {
        need(c, 2);
        const v = halfFloat(c.view.getUint16(c.pos));
        c.pos += 2;
        return v;
      }
      if (info === 26) {
        need(c, 4);
        const v = c.view.getFloat32(c.pos);
        c.pos += 4;
        return v;
      }
      if (info === 27) {
        need(c, 8);
        const v = c.view.getFloat64(c.pos);
        c.pos += 8;
        return v;
      }
      throw new CborError("unsupported CBOR simple value");
    }
  }
}

/** Decode one item starting at `offset`; returns it and the offset just after it. */
export function decodeCborPrefix(input: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const c: Cursor = {
    buf: input,
    view: new DataView(input.buffer, input.byteOffset, input.byteLength),
    pos: offset,
  };
  const value = readItem(c, 0);
  return { value, end: c.pos };
}

/** Decode exactly one item; trailing bytes are an error. */
export function decodeCbor(input: Uint8Array): CborValue {
  const { value, end } = decodeCborPrefix(input, 0);
  if (end !== input.length) {
    throw new CborError("trailing bytes after CBOR item");
  }
  return value;
}

export function isCborMap(v: CborValue): v is Map<number | string, CborValue> {
  return v instanceof Map;
}

export function isCborBytes(v: CborValue): v is Uint8Array {
  return v instanceof Uint8Array;
}

// ── encoder (tests and fixtures only need maps, integers, strings and bytes) ────────────────

function head(major: number, n: number): number[] {
  if (n < 24) {
    return [(major << 5) | n];
  }
  if (n < 0x100) {
    return [(major << 5) | 24, n];
  }
  if (n < 0x10000) {
    return [(major << 5) | 25, n >> 8, n & 0xff];
  }
  if (n < 0x100000000) {
    return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  throw new CborError("value too large to encode");
}

/** Minimal CBOR encoder (integers, text, bytes, arrays, maps, booleans, null). */
export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const walk = (v: CborValue) => {
    if (typeof v === "number") {
      if (!Number.isInteger(v)) {
        throw new CborError("only integers are encoded");
      }
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    } else if (typeof v === "string") {
      const b = Buffer.from(v, "utf8");
      out.push(...head(3, b.length), ...b);
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, v.length), ...v);
    } else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      v.forEach(walk);
    } else if (v instanceof Map) {
      out.push(...head(5, v.size));
      for (const [k, item] of v) {
        walk(k);
        walk(item);
      }
    } else if (v === false) {
      out.push(0xf4);
    } else if (v === true) {
      out.push(0xf5);
    } else if (v === null) {
      out.push(0xf6);
    } else {
      out.push(0xf7);
    }
  };
  walk(value);
  return Uint8Array.from(out);
}
