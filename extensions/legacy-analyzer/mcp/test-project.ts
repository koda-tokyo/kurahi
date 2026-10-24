// Test fixtures for the kurahi-legacy MCP server: the ORDCALC/ORDTAX/ORDRPT demo project the
// legacy-analyzer tests use, plus a linked in-memory client.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  A,
  B,
  C,
  program,
  tmpTree,
} from "../../../packages/legacy-analyzer/src/test-fixtures/helpers.js";
import { buildMcpServer, openLegacyMcp, type LegacyMcpOptions } from "./server.js";

const COPY = [
  C(" ORDREC - ORDER RECORD"),
  C(" ORD-QTY   QUANTITY ORDERED"),
  A("01  ORD-REC."),
  B("05 ORD-ID PIC X(6)."),
  B("05 ORD-QTY PIC 9(4)."),
  B("05 ORD-PRICE PIC 9(5)V99 COMP-3."),
  B("05 ORD-DATE PIC X(8)."),
  B("05 ORD-DATE-N REDEFINES ORD-DATE PIC 9(8)."),
  B("05 ORD-ITEMS OCCURS 5 TIMES."),
  B("   10 ORD-SKU PIC X(4)."),
].join("\n");

const WRITER = program("ORDCALC", {
  env: [A("INPUT-OUTPUT SECTION."), A("FILE-CONTROL."), B("SELECT ORD-OUT ASSIGN TO ORDOUT.")],
  data: [
    A("FILE SECTION."),
    A("FD  ORD-OUT."),
    B("COPY ORDREC."),
    A("WORKING-STORAGE SECTION."),
    A("01  WS-DISC-QTY PIC 9(4) VALUE 0100."),
    A("01  WS-AMOUNT PIC 9(9)V99."),
    A("01  WS-NET PIC 9(9)V99."),
  ],
  proc: [
    A("0000-MAIN."),
    B("OPEN OUTPUT ORD-OUT"),
    B("MOVE 12 TO ORD-QTY"),
    B("PERFORM 1000-PRICE"),
    B("WRITE ORD-REC"),
    B("CLOSE ORD-OUT"),
    B("STOP RUN."),
    A("1000-PRICE."),
    B("IF ORD-QTY > WS-DISC-QTY"),
    B("    COMPUTE WS-AMOUNT ROUNDED = ORD-QTY * ORD-PRICE * 0.95"),
    B("END-IF"),
    B("MOVE WS-AMOUNT TO WS-NET"),
    B("CALL 'ORDTAX' USING WS-NET."),
  ],
});

const TAX = program("ORDTAX", {
  data: [A("LINKAGE SECTION."), A("01  LK-NET PIC 9(9)V99.")],
  using: "LK-NET",
  proc: [A("0000-MAIN."), B("COMPUTE LK-NET = LK-NET * 1.10"), B("GOBACK.")],
});

const READER = program("ORDRPT", {
  env: [A("INPUT-OUTPUT SECTION."), A("FILE-CONTROL."), B("SELECT ORD-IN ASSIGN TO ORDIN.")],
  data: [
    A("FILE SECTION."),
    A("FD  ORD-IN."),
    B("COPY ORDREC."),
    A("WORKING-STORAGE SECTION."),
    A("01  WS-Q PIC 9(4)."),
  ],
  proc: [
    A("0000-MAIN."),
    B("OPEN INPUT ORD-IN"),
    B("READ ORD-IN"),
    B("MOVE ORD-QTY TO WS-Q"),
    B("CLOSE ORD-IN"),
    B("STOP RUN."),
  ],
});

const JOB = [
  "//ORDJOB   JOB (A),'ORDERS'",
  "//S1       EXEC PGM=ORDCALC",
  "//ORDOUT   DD DSN=PROD.ORDERS,DISP=(NEW,CATLG)",
  "//S2       EXEC PGM=ORDRPT",
  "//ORDIN    DD DSN=PROD.ORDERS,DISP=SHR",
].join("\n");

/** A copybook with `n` fields, for the size-cap and pagination tests. */
export function wideCopybook(n: number): string {
  const lines = [A("01  WIDE-REC.")];
  for (let i = 0; i < n; i++) {
    lines.push(B(`05 WIDE-FIELD-${String(i).padStart(4, "0")} PIC X(10) VALUE 'ABCDEFGHIJ'.`));
  }
  return lines.join("\n");
}

/** The demo project (with an `output/` folder and a hidden answer-key folder). */
export function demoProject(extra: Record<string, string> = {}): string {
  return tmpTree({
    "source/cobol/ORDCALC.cbl": WRITER,
    "source/cobol/ORDTAX.cbl": TAX,
    "source/cobol/ORDRPT.cbl": READER,
    "source/copybook/ORDREC.cpy": COPY,
    "source/jcl/ORDJOB.jcl": JOB,
    "output/.keep": "",
    "_answer-keys/SECRET.cbl": program("SECRET", { proc: [A("0000-MAIN."), B("STOP RUN.")] }),
    ...extra,
  });
}

export type Connected = {
  client: Client;
  ctx: ReturnType<typeof openLegacyMcp>;
  call(name: string, args?: Record<string, unknown>): Promise<CallOutcome>;
  close(): Promise<void>;
};

export type CallOutcome = {
  isError: boolean;
  text: string;
  structured: {
    tool: string;
    scope: string;
    summary: string;
    page: { offset: number; limit: number; total: number; nextOffset: number | null };
    reduced?: { reason: string };
    // oxlint-disable-next-line typescript/no-explicit-any -- test access to varied result shapes
    result: any;
  };
  bytes: number;
};

export async function connect(opts: LegacyMcpOptions): Promise<Connected> {
  const ctx = openLegacyMcp(opts);
  const server = buildMcpServer(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "legacy-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    ctx,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        structuredContent?: CallOutcome["structured"];
      };
      const json = r.content[1]?.text ?? "";
      return {
        isError: Boolean(r.isError),
        text: r.content[0]?.text ?? "",
        structured: r.structuredContent as CallOutcome["structured"],
        bytes: Buffer.byteLength(json, "utf8"),
      };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
