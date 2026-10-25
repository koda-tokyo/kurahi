---
summary: "kurahi-legacy: the legacy analyser as an MCP server for VS Code, Eclipse-based IDEs and any MCP client, one project per server, read-only, every fact with path:line"
read_when:
  - Using the legacy analyser from an editor or IDE
  - Configuring an MCP client for a COBOL / JCL project
  - Reviewing what the legacy MCP server can read and write
title: "Legacy analyser in your editor (MCP)"
---

# Legacy analyser in your editor (MCP)

日本語: [エディタでレガシー解析（MCP）](/ja/tools/legacy-mcp)

`kurahi legacy mcp` serves the [legacy analyser](/tools/legacy-analyzer) to the tools engineers
already use: VS Code, Eclipse-based mainframe IDEs, or any client that speaks the Model Context
Protocol (MCP). It is a separate, product server: it reads one project folder and nothing else,
needs no gateway and no Kurahi configuration, and shares nothing with a running Kurahi service.

```bash
kurahi legacy mcp --root /path/to/project              # stdio (the client starts it)
kurahi legacy mcp --root /path/to/project --http 7465  # loopback HTTP, http://127.0.0.1:7465/mcp
```

| Option                   | Meaning                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <dir>`           | The project folder. Required. Every tool is confined to it.                                                                                                   |
| `--http <port>`          | Serve streamable HTTP on `127.0.0.1:<port>` instead of stdio.                                                                                                 |
| `--max-bytes <n>`        | Cap on one response, in bytes (default 65536, from 4096).                                                                                                     |
| `--allow-host <host...>` | With `--http`: also accept these `Host` names, for a TLS reverse proxy in front ([remote toolkit](/integrations/ibm-watsonx-orchestrate#remote-mcp-toolkit)). |

## Tools

All tools are read-only (`readOnlyHint`) and take three common arguments: `path` (a sub-folder or
file of the project, relative to the root; default the root), `offset` and `limit` (pagination).

| Tool                  | What it returns                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy_index_status` | Whether a fresh index exists for the scope, with counts. Never parses.                                                                                        |
| `legacy_index_build`  | Parses COBOL, copybooks and JCL and builds the fact index; programs, copybooks, jobs, diagnostics.                                                            |
| `legacy_query`        | Structure: callers, callees, call and perform graphs, file access, data items and references, job steps, data sets, unresolved references.                    |
| `legacy_rules`        | Rule candidates: conditions, arithmetic with constants, rounding, 88-level values, constants.                                                                 |
| `legacy_dictionary`   | Copybook data dictionary: level, PIC, usage, length, offset, positions, OCCURS, REDEFINES, values.                                                            |
| `legacy_impact`       | What a change to a data item reaches, with the fact that links each entry.                                                                                    |
| `legacy_design_doc`   | Design document (設計書) from the code in Japanese or English, one section per entry; every fact cites path:line.                                             |
| `legacy_wave_plan`    | Proposed migration waves for human review, ordered by dependencies and risk.                                                                                  |
| `modernise_plan`      | Detected languages, inventory of the COBOL/JCL, Java, SQL DDL, FORTRAN and PL/I engines, shared tables, coverage, planned assistants (which analyse nothing). |
| `modernise_crud`      | CRUD of SQL tables across COBOL, PL/I, Java and JCL utilities, and of files (COBOL, FORTRAN, PL/I), with the evidence of each operation.                      |
| `modernise_impact`    | What a change to a table, column, file, FORTRAN COMMON block, Java class or program reaches across languages.                                                 |
| `modernise_inventory` | Java types, SQL tables, FORTRAN units and COMMON blocks, or PL/I procedures: the list, or one entry in full.                                                  |

Other tools build the index on first use; `legacy_index_build` forces a rebuild. The index is
rebuilt automatically when any file under the scope changes.

## Responses

Each result has a short text summary (first content block), the full JSON (second content block)
and the same JSON as `structuredContent`:

```json
{
  "tool": "legacy_query",
  "scope": ".",
  "summary": "Query callers: calledBy 1, performedBy 0, jobSteps 0. Entries 1-1 of 1 (last page).",
  "page": {
    "offset": 0,
    "limit": 100,
    "total": 1,
    "lists": { "calledBy": 1, "performedBy": 0, "jobSteps": 0 },
    "nextOffset": null
  },
  "result": {
    "name": "ORDTAX",
    "kind": "program",
    "calledBy": [
      {
        "program": "ORDCALC",
        "paragraph": "1000-PRICE",
        "file": "source/cobol/ORDCALC.cbl",
        "line": 28,
        "text": "CALL 'ORDTAX' USING WS-NET.",
        "at": "source/cobol/ORDCALC.cbl:28"
      }
    ],
    "performedBy": [],
    "jobSteps": []
  }
}
```

- **Every fact carries `at: "path:line"`**, relative to the project root, next to the analyser's
  own `file` and `line`. Cite it; open it in the editor.
- **Pagination.** Every top-level list of a result is windowed by `offset` and `limit` (default
  100, max 1000). `page.total` is the longest list, `page.nextOffset` the next window (`null` on
  the last page).
- **Size cap.** When a page would exceed `--max-bytes`, the page shrinks first (`reduced.reason`
  says so and `nextOffset` follows the smaller page), then long text (for example a DOT graph) is
  clipped at 2,000 characters. When even one entry does not fit, the call fails with a request to
  narrow it (a `path`, a `program`, a smaller `limit`).

## Client configuration

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "kurahi-legacy": {
      "type": "stdio",
      "command": "kurahi",
      "args": ["legacy", "mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

Over loopback HTTP (start `kurahi legacy mcp --root … --http 7465` yourself first):

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "kurahi-legacy-token",
      "description": "kurahi-legacy token",
      "password": true
    }
  ],
  "servers": {
    "kurahi-legacy": {
      "type": "http",
      "url": "http://127.0.0.1:7465/mcp",
      "headers": { "Authorization": "Bearer ${input:kurahi-legacy-token}" }
    }
  }
}
```

### Any MCP client (Eclipse-based IDEs included)

Most clients accept the common `mcpServers` form; give the project folder as an absolute path:

```json
{
  "mcpServers": {
    "kurahi-legacy": {
      "command": "kurahi",
      "args": ["legacy", "mcp", "--root", "/path/to/project"]
    }
  }
}
```

A client that only connects to a URL uses the HTTP form: URL `http://127.0.0.1:<port>/mcp`,
header `Authorization: Bearer <token>`. If `kurahi` is not on the client's `PATH`, give the full
path of the executable as `command`.

## Security

- **One root, confined.** The root is resolved to its real path at start. Each `path` argument is
  resolved against it and refused when it leaves it: `../`, an absolute path elsewhere, or a
  symbolic link whose target is outside (checked on the real path). Folders the analyser never
  reads (`_answer-keys`, `.git`, `node_modules`, the `.kurahi` folder) are refused too. The indexer
  does not follow symbolic links inside the tree.
- **Read-only.** The tools parse source text. They never run code, scripts or JCL from the
  repository, never call out to the network, and never write to the sources.
- **The only writes** are in the project's Kurahi folder: `.kurahi/legacy-mcp/cache/` (the index)
  and `.kurahi/legacy-mcp/audit.jsonl`. The server creates these folders itself (mode 0700) and
  refuses to start when `.kurahi` or a folder below it is a symbolic link; files are opened without
  following links. Add `.kurahi/` to `.gitignore`.
- **Audit.** One JSON line per call: time, tool, SHA-256 of the arguments (the arguments
  themselves are not stored), `ok`, result size in bytes, duration, and `error`
  (`path-refused`, `error`, `overflow`) on failure.
- **HTTP is loopback only** (`127.0.0.1`), requires a bearer token
  (`KURAHI_LEGACY_MCP_TOKEN`, at least 16 characters, or one generated and printed to stderr at
  start), checks `Host` and `Origin` against the loopback address (DNS rebinding), accepts `POST`
  only and requests up to 1 MiB by `Content-Length`. It has no TLS; do not forward the port.

## Limits

- **Facts, not meaning.** The analyser reports structure and exact source text. Business meaning
  is never inferred; the reader interprets and cites.
- **Analyser coverage.** Dialect support, the 5,000-file and 4 MiB-per-file limits and the parsing
  diagnostics are those of the [legacy analyser](/tools/legacy-analyzer); a partial index says so
  in its diagnostics.
- **Freshness is conservative.** Each call walks the scope and compares size and modification time
  of every file (not only sources); any change rebuilds the index. On very large trees, scope
  calls with `path`. Indexing is synchronous: other calls wait while it runs.
- **The audit log is append-only by the server, not tamper-evident.** Anyone who can write the
  project folder can edit it. It is not the gateway's hash-chained audit log, and it is not
  rotated.
- **The cache is trusted when its fingerprint matches the tree.** Someone with write access to the
  project could plant a forged cache file; `legacy_index_build` rebuilds from the sources, and
  deleting `.kurahi/legacy-mcp/cache/` is always safe.
- **Pagination is one level deep.** It windows the top-level lists of a result; nested lists come
  whole and fall under the size cap.
- **HTTP is stateless.** No server-initiated messages, no sessions; each request is independent.
- Client compatibility is checked with the protocol's reference client (stdio, in-memory and
  HTTP).
