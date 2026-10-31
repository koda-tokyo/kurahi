# Vendor import fixtures

Synthetic payroll sample data (no customer or vendor-produced content). Each folder is a complete
import bundle: the data files plus `kurahi-import.json` with their SHA-256 hashes. Regenerate a
manifest after editing a data file, or the import is refused as tampered.

The structure of each fixture follows the vendor's public documentation, as checked on
2026-11-01. Where the documentation does not fix a detail, the fixture's value is illustrative and
the parser does not depend on it.

| Folder                        | Provider / format                   | Verification                                  | Documentation followed                                                                       |
| ----------------------------- | ----------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `google-mat-neo4j/`           | `google-mat` / `neo4j-jsonl`        | VERIFIED_FROM_DOCS (record envelope)          | https://docs.cloud.google.com/mainframe-assessment-tool/docs/export-results                  |
| `aws-transform-requirements/` | `aws-transform` / `requirements-md` | VERIFIED_FROM_DOCS (document parts)           | https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe-workflow.html |
| `ibm-z-docgen/`               | `ibm-z` / `understand-docgen-md`    | VERIFIED_FROM_DOCS (layout and section names) | https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/Docgen_create.html                 |
| `ibm-z-rules-mapped/`         | `ibm-z` / `business-rules-export`   | UNVERIFIED_SCHEMA (generic mapped)            | https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/rules_intro.html                   |
| `aws-transform-deps-mapped/`  | `aws-transform` / `analysis-json`   | UNVERIFIED_SCHEMA (generic mapped)            | https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe-workflow.html |

What comes from the documentation, and what is illustrative:

- **google-mat-neo4j**: the envelope of each line (`type` `node` with `id`, `labels`,
  `properties`; `type` `relationship` with `start.id`, `end.id`, `label`, `properties`) is taken
  from the APOC import queries on the export page. The label values (`Program`, `JclJob`,
  `Dataset`, `Database`, `BmsMap`), relationship labels and property names are illustrative: the
  page names the node kinds only in prose ("programs, JCL jobs, datasets, databases, and BMS
  maps") and documents no property names. The last relationship points at a node that is not in
  the file on purpose (the documented `MATCH` would not create it either).
- **aws-transform-requirements**: the parts (title, global preconditions, numbered workflow
  sections with a user story and EARS requirements with unique identifiers) are documented. The
  Markdown syntax (heading levels, `REQ-1.1` identifiers, bold "User story") is illustrative.
- **ibm-z-docgen**: the folder layout (`Documentation/application_document.md`,
  `Documentation/programs/<program_name>.md`, `Documentation/logs/`) and the section names are
  documented. Heading levels and list formatting are illustrative. The third dependency line is
  prose on purpose: it must be reported, not turned into an edge.
- **ibm-z-rules-mapped** and **aws-transform-deps-mapped**: the vendors document that these
  exports exist (business rule Export as .json or .csv; a dependencies JSON file, assets list and
  business logic JSON in S3) but publish no field-level schema. The column and key names here are
  invented for the test, and the bundle's `kurahi-mapping.json` states them explicitly. They show
  the generic mapped import, not the vendor's real schema.
