---
summary: "Import results exported from vendor modernisation tools into a Kurahi Project: supported formats with their verification status, the bundle manifest, the checks every import passes, and what imported data means (unverified until reviewed)"
read_when:
  - Bringing results from another modernisation tool into a Kurahi Project
  - Checking which vendor export formats Kurahi reads, and how far each is verified
  - Explaining what an imported dependency or rule means
title: "Vendor results import"
---

# Vendor results import

日本語: [ベンダー分析結果の取り込み](/ja/industrial/vendor-import)

A modernisation project often already has results from another tool: an assessment graph, generated
requirements, AI-generated program documentation. Kurahi can import those results into a Project so
they sit next to its own analysis. Imports are offline: you export the results from the vendor tool
yourself and give Kurahi the exported files. Kurahi never connects to the vendor.

Status as of 1 November 2026: in development, not yet in a release.

## What is supported

Each format has one of two verification states:

- **Verified from documentation**: the importer follows the vendor's public documentation of that
  output, and its test fixtures follow the documented structure. Where the documentation leaves a
  detail open, the importer keeps the vendor's value as it is and does not interpret it.
- **Unverified schema**: the vendor documents that the export exists but publishes no field-level
  schema. Kurahi reads it only through a field mapping file that you supply with the bundle (see
  [Mapped import](#mapped-import)). Kurahi does not ship a guessed schema for these exports.

| Provider (`--provider`) | Format (`format`)       | What it is                                                                       | Verification                                   | Documentation                                                                                                      |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `google-mat`            | `neo4j-jsonl`           | Mainframe Assessment Tool, Neo4j graph export (JSON Lines)                       | Verified from documentation (record envelope)  | [Export assessment results](https://docs.cloud.google.com/mainframe-assessment-tool/docs/export-results)           |
| `google-mat`            | `json-report`           | Mainframe Assessment Tool, JSON report (one file per program)                    | Unverified schema (mapped import)              | [Export assessment results](https://docs.cloud.google.com/mainframe-assessment-tool/docs/export-results)           |
| `aws-transform`         | `requirements-md`       | AWS Transform for mainframe, `requirements.md` per business function             | Verified from documentation (document parts)   | [Mainframe workflow](https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe-workflow.html) |
| `aws-transform`         | `analysis-json`         | AWS Transform for mainframe, business logic JSON, dependencies JSON, assets list | Unverified schema (mapped import)              | [Mainframe workflow](https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe-workflow.html) |
| `ibm-z`                 | `understand-docgen-md`  | watsonx Code Assistant for Z, Z Understand documentation generation (Markdown)   | Verified from documentation (layout, sections) | [Generating documentation](https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/Docgen_create.html)           |
| `ibm-z`                 | `business-rules-export` | watsonx Code Assistant for Z, Z Understand business rule export (.json or .csv)  | Unverified schema (mapped import)              | [Identifying business rules](https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/rules_intro.html)           |

What "verified from documentation" covers, format by format:

- **`neo4j-jsonl`**: the documented line envelope. A node is `{"type":"node","id":…,"labels":[…],"properties":{…}}`
  and a relationship is `{"type":"relationship","start":{"id":…},"end":{"id":…},"label":…,"properties":{…}}`,
  as in the import queries on the export page. Label values and property names are not documented:
  they are stored verbatim. A node's display name is its `properties.name` when that is a string,
  otherwise its `id`, and the record says which. A relationship whose label is literally one of
  Kurahi's edge names (`CALLS`, `READS`, `WRITES`, `QUERIES`, …) is marked with it; any other label
  (for example `EXECUTES`) is kept as the vendor wrote it. A relationship to a node that is not in the
  file is reported, not imported (the documented import would not create it either).
- **`requirements-md`**: the documented parts of each `requirements.md`: a title naming the
  business function, global preconditions, and numbered workflow sections each with a user story
  and requirements in EARS format with a unique identifier. The Markdown syntax is not documented,
  so headings of any level are read, a workflow section is a heading that starts with a number, and a
  requirement is a line with an identifier (a token containing a digit, such as `REQ-1.1`) and the
  word "shall". Its EARS pattern (event-driven, state-driven, unwanted behaviour, optional feature,
  ubiquitous) comes from the EARS keywords. A requirement without an identifier, or a repeated
  identifier, is imported and reported.
- **`understand-docgen-md`**: the documented `Documentation` folder: `application_document.md`, one
  `programs/<program_name>.md` per program, and `logs/` (ignored). Sections are recognised only by
  their documented names (Purpose, Inputs, Outputs, Business Rules, Business Variables, Processing
  Logic, Paragraphs, Dependencies, Constraints, Error Handling, Examples; and Overview, Processing
  Flow, Components for the application). Each item under Business Rules becomes a rule candidate. A
  Dependencies item becomes a `DEPENDS_ON` edge only when it starts with a single name (for example
  `TAXCALC - computes the tax`); prose entries are reported, not turned into edges. HTML output is
  not read.

Not supported: the Mainframe Assessment Tool HTML report, AWS Transform `traceability.yaml`, PDF
documentation and SMF analysis outputs (unless mapped as tables), and anything not in the table.

### Direct vendor execution is not available

Kurahi does not call vendor services. The provider registry lists these modes as disabled, with the
reason, and refuses them before any network call:

| Provider id            | Mode       | Status   | Reason                                                                                                                  |
| ---------------------- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ibm-z-remote`         | REMOTE_MCP | Disabled | Remote access for a third-party client, endpoints, auth, limits and licence terms not verified in an authorised sandbox |
| `ibm-watsonx-ai`       | REMOTE_API | Disabled | Not configured; a separately entitled model endpoint, not Code Assistant for Z                                          |
| `aws-transform-remote` | REMOTE_API | Disabled | Planned, not active                                                                                                     |
| `google-mat-remote`    | REMOTE_MCP | Disabled | Planned, not active (the vendor's MCP server is documented as Preview)                                                  |

`kurahi industrial providers` prints the registry.

## What imported data means

Imported data is the vendor tool's claim, not a fact Kurahi checked. Every imported item, edge, rule
and finding carries:

- provenance `IMPORTED_VENDOR_ARTEFACT`
- confidence `UNVERIFIED`, until a person reviews it
- the bundle file it came from, its SHA-256 and the line or record number

The modernisation tools keep it apart from the analyser's facts. `modernise_inventory` with
`kind: imported` lists imported items (and, with a name, their rules). `modernise_impact` adds an
`imported` block next to the analysed result, with the vendor's upstream and downstream edges and
rules for the target. The agent is told to cite these as the vendor's claims.

## How to import

1. Export the results from the vendor tool and keep the files unchanged.
2. Put them in a folder with a manifest named `kurahi-import.json` at its root (see below). You can
   zip the folder.
3. Import, from the agent (in a Project chat, 計画 Plan or 実行 Act mode; the bundle must be inside
   the Project folder):

   ```text
   modernise_import  path: imports/assessment.zip  provider: google-mat
   ```

   or from the command line:

   ```bash
   kurahi industrial import --project <project-id> --provider google-mat --bundle ./assessment.zip
   kurahi industrial imports --project <project-id>
   ```

   Exit codes: 0 imported (or already imported), 1 refused, 2 usage.

### The manifest

```json
{
  "schema": "kurahi.vendor-import/1",
  "provider": "google-mat",
  "format": "neo4j-jsonl",
  "origin": {
    "product": "Mainframe Assessment Tool",
    "productVersion": null,
    "exportedAt": "2026-10-30T09:00:00Z",
    "exportedBy": "alice",
    "authorisedBy": "ops-lead",
    "sourceSystem": "payroll"
  },
  "files": [
    {
      "path": "graph/assessment.jsonl",
      "sha256": "<64 hex characters>",
      "bytes": 1234,
      "role": "data"
    }
  ]
}
```

`files` lists every file of the bundle with its size and SHA-256. `role` is `data` (default),
`mapping` (the field mapping file of a mapped import) or `ignored` (kept, not read, for example a log).
`authorisedBy` records who allowed the export to be given to Kurahi; it is recorded, not verified.

## What every import passes

The import is refused, with a stable code, a reason and a remedy, when any check fails:

| Check                                                                                                                                                                                                            | Code on failure             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| The provider and format are in the registry and allow offline import                                                                                                                                             | `CAPABILITY_UNAVAILABLE`    |
| Archive safety: no absolute or `..` paths, no symbolic links, no encrypted entries, no ZIP64, at most 5,000 files, 200 MB archive, 512 MB extracted, 128 MB per file, no compression ratio above 100 (zip bombs) | `ARTEFACT_INTEGRITY_FAILED` |
| Every file listed in the manifest with the right size and SHA-256; nothing unlisted                                                                                                                              | `ARTEFACT_INTEGRITY_FAILED` |
| Malware scan of the files, with the attachment scanner and its settings (`security.attachments`); no scanner while `requireScan` is on is a refusal                                                              | `POLICY_DENIED`             |
| The files have the format's structure, as UTF-8 text                                                                                                                                                             | `SCHEMA_REJECTED`           |

An unknown structure is refused as unsupported; Kurahi never guesses a schema. Each import and each
refusal is written to the audit log and sealed as a signed evidence bundle (`kurahi evidence verify`
checks it). The files are stored by content hash in the Project's state directory, not in the
Project folder. Importing the same bundle again (zip or folder) returns the existing import:
the import id is derived from the provider, format and file hashes.

## Mapped import

For an export without a published schema, add a field mapping file to the bundle (role `mapping` in
the manifest). It names, for each data file, which column or field holds each value:

```json
{
  "schema": "kurahi.vendor-import-mapping/1",
  "tables": [
    {
      "file": "business-rules.csv",
      "format": "csv",
      "produces": "rules",
      "fields": { "title": "Rule Name", "text": "Description", "subject": "Program" }
    },
    {
      "file": "dependencies.json",
      "format": "json",
      "records": "dependencies",
      "produces": "edges",
      "fields": { "from": "source", "to": "target", "relation": "type" }
    }
  ]
}
```

- `format`: `csv` (optional `delimiter`: `,` `;` `|` or tab), `json` (with `records`, a dotted path to
  the list) or `jsonl`.
- `produces` and its fields: `items` (name; kind, id), `edges` (from, to; relation), `rules` (text;
  vendorId, subject, title, ruleType), `findings` (title; detail, severity, subject). A value
  starting with `=` is a constant (`"relation": "=CALLS"`).
- `file` may use `*` within one folder and `**/` for any folders.

The import is refused when a named column is missing, a required value is empty, a data file is not
mapped (map it or mark it `ignored`), or a table matches no file. The column names in the example are
illustrative: use the ones in your export.
