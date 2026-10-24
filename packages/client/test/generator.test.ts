// SPDX-License-Identifier: MIT
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATED_DIR,
  SPEC_PATH,
  collectOperations,
  diffClientFiles,
  pascal,
  renderClientFiles,
  schemaToTs,
} from "../../../scripts/client-gen.mjs";

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));

describe("client-gen", () => {
  it("is deterministic", () => {
    const a = renderClientFiles(structuredClone(spec));
    const b = renderClientFiles(structuredClone(spec));
    expect(Object.keys(a)).toEqual(["types.ts", "operations.ts", "client.ts", "websocket.ts"]);
    expect(a).toEqual(b);
  });

  it("committed client matches the committed spec (drift check)", () => {
    expect(diffClientFiles(renderClientFiles(spec))).toEqual([]);
  });

  it("detects drift, missing and stray files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-client-gen-"));
    try {
      const files = renderClientFiles(spec);
      for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body);
      }
      expect(diffClientFiles(files, dir)).toEqual([]);
      fs.appendFileSync(path.join(dir, "client.ts"), "// edited\n");
      fs.rmSync(path.join(dir, "types.ts"));
      fs.writeFileSync(path.join(dir, "extra.ts"), "");
      const problems = diffClientFiles(files, dir).join("\n");
      expect(problems).toMatch(/client\.ts: differs at line/);
      expect(problems).toMatch(/types\.ts: missing/);
      expect(problems).toMatch(/extra\.ts: not produced/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits one client method per operationId", () => {
    const ops = collectOperations(spec);
    const client = renderClientFiles(spec)["client.ts"];
    expect(ops.length).toBeGreaterThanOrEqual(20);
    for (const { op } of ops) {
      expect(client).toContain(`  ${op.operationId}(`);
    }
    expect(fs.readdirSync(GENERATED_DIR).toSorted()).toEqual([
      "client.ts",
      "operations.ts",
      "types.ts",
      "websocket.ts",
    ]);
  });

  it("lists every WebSocket method and event of the spec", () => {
    const ws = renderClientFiles(spec)["websocket.ts"];
    for (const m of spec["x-kolo-websocket"].methods) {
      expect(ws).toContain(JSON.stringify(m.name));
    }
    for (const e of spec["x-kolo-websocket"].events) {
      expect(ws).toContain(JSON.stringify(e.name));
    }
  });

  it("maps the JSON Schema subset", () => {
    expect(pascal("agent.identity.get")).toBe("AgentIdentityGet");
    expect(pascal("getHealth")).toBe("GetHealth");
    expect(schemaToTs({ type: "string" })).toBe("string");
    expect(schemaToTs({ type: "integer" })).toBe("number");
    expect(schemaToTs({ const: "x" })).toBe('"x"');
    expect(schemaToTs({ enum: ["a", 1] })).toBe('"a" | 1');
    expect(schemaToTs({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null");
    expect(schemaToTs({ type: ["string", "null"] })).toBe("string | null");
    expect(
      schemaToTs({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
    ).toBe("(string | number)[]");
    expect(schemaToTs({ $ref: "#/components/schemas/HelloOk" })).toBe("HelloOk");
    expect(schemaToTs({})).toBe("unknown");
    expect(schemaToTs({ type: "object" })).toBe("Record<string, unknown>");
    expect(schemaToTs({ type: "object", additionalProperties: { type: "number" } })).toBe(
      "Record<string, number>",
    );
    expect(
      schemaToTs({ type: "object", patternProperties: { "^(.*)$": { type: "boolean" } } }),
    ).toBe("Record<string, boolean>");
    expect(
      schemaToTs({
        type: "object",
        required: ["a"],
        properties: { a: { type: "string", description: "the a" }, "b-c": { type: "boolean" } },
        additionalProperties: true,
      }),
    ).toBe('{\n  /** the a */\n  a: string;\n  "b-c"?: boolean;\n  [key: string]: unknown;\n}');
    expect(() => schemaToTs({ $ref: "#/definitions/X" })).toThrow(/unsupported \$ref/);
  });

  it("parenthesises a union of object literals inside arrays and intersections", () => {
    const a = { type: "object", properties: { t: { const: "a" } }, required: ["t"] };
    const b = { type: "object", properties: { t: { const: "b" } }, required: ["t"] };
    const arr = schemaToTs({ type: "array", items: { oneOf: [a, b] } });
    expect(arr.startsWith("({")).toBe(true);
    expect(arr.endsWith("})[]")).toBe(true);
    expect(schemaToTs({ type: "array", items: a })).toMatch(/^\{[\s\S]*\}\[\]$/);
    expect(schemaToTs({ type: "array", items: { enum: ["x | y", "z"] } })).toBe(
      '("x | y" | "z")[]',
    );
    expect(schemaToTs({ type: "array", items: { const: "x | y" } })).toBe('"x | y"[]');
    expect(schemaToTs({ allOf: [{ oneOf: [a, b] }, { $ref: "#/components/schemas/x" }] })).toMatch(
      /^\(\{[\s\S]*\}\) & X$/,
    );
  });

  it("rejects duplicate or missing operationIds", () => {
    const dup = {
      paths: {
        "/a": { get: { operationId: "same", responses: {} } },
        "/b": { get: { operationId: "same", responses: {} } },
      },
    };
    expect(() => collectOperations(dup)).toThrow(/duplicate operationId/);
    expect(() => collectOperations({ paths: { "/a": { get: { responses: {} } } } })).toThrow(
      /no usable operationId/,
    );
  });
});
