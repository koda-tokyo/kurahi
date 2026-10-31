---
summary: "Context guard: personal data in tool results is replaced with placeholders before the model sees it, and put back only where the policy allows"
read_when:
  - Agents read records about people (residents, patients, employees, customers)
  - Personal data must not reach a model provider, or must reach it as little as possible
  - You need to show an auditor what was masked
title: "Context guard"
---

# Context guard

An agent that reads a database row, a file or an API response normally passes everything it read
to the model. When those records describe people, that is the moment personal data leaves your
control. The context guard sits in the same place as the rest of the [policy](/policy): on every
tool call, core or MCP. It replaces personal data in the **result** with placeholders before the
model reads it.

```text
tool returns   [{"name": "山田 花子", "phone": "090-1111-2222", "room": "305"}]
model reads    [{"name": "[[PII:NAME:1]]", "phone": "[[PII:PHONE:1]]", "room": "305"}]
```

The real values stay in a vault in the gateway's memory, one per session. The model can still
reason about the record ("the resident in room 305") and can still act on it: when it calls a tool
named in `restoreTo`, the gateway puts the real values back into that call's arguments. Every other
tool receives the placeholders unchanged, so a web request or a log line cannot carry the data out.

## Turning it on

Add `data.redact` to the signed policy:

```yaml
version: 1
data:
  redact:
    fields: ["@personal"] # mask values of these JSON keys
    restoreTo: [message, "mcp:care/*"] # tools that receive the real values back
```

That is enough for most deployments: the built-in detectors are on by default.

| Key           | Meaning                                                                                                                                                                   | Default         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `detectors`   | Built-in pattern detectors to run                                                                                                                                         | all except `ip` |
| `fields`      | JSON keys whose values are masked (globs, case-insensitive). `@personal` adds common name, address, birth-date, phone and e-mail keys in English, Japanese and Portuguese | none            |
| `patterns`    | Your own detectors: `{ name, regex }`                                                                                                                                     | none            |
| `agents`      | Agents the guard applies to                                                                                                                                               | all             |
| `tools`       | Tools whose results are guarded; `mcp:<server>/<tool>` for MCP tools                                                                                                      | all             |
| `exceptTools` | Tools whose results are never guarded                                                                                                                                     | none            |
| `restoreTo`   | Tools whose arguments get real values back                                                                                                                                | none            |

## Built-in detectors

| Detector       | Finds                                                                    | Validation        |
| -------------- | ------------------------------------------------------------------------ | ----------------- |
| `email`        | e-mail addresses                                                         |                   |
| `phone`        | international numbers, Japanese landlines and mobiles, Brazilian numbers |                   |
| `jp-my-number` | Japanese Individual Numbers (My Number)                                  | check digit       |
| `br-cpf`       | Brazilian CPF                                                            | both check digits |
| `br-cnpj`      | Brazilian CNPJ                                                           | both check digits |
| `credit-card`  | payment card numbers                                                     | Luhn              |
| `jp-postal`    | Japanese postal codes                                                    |                   |
| `ip`           | IPv4 addresses (opt-in)                                                  |                   |

Numbers that fail their check digit are left alone, so order numbers and IDs are not masked by
mistake. Names cannot be found reliably by pattern: mask them through `fields`, which works on any
tool result that is JSON (including MCP results and database rows) and on CSV or TSV text with a
header row, where every value in a matching column is masked. Free text is covered by the
detectors and your `patterns`.

## Placeholders

A placeholder looks like `[[PII:EMAIL:3]]`. The same value always gets the same placeholder within
a session, so the model can tell that two rows belong to the same person without learning who it
is. Field placeholders are named after the key (`[[PII:NAME:1]]`, `[[PII:NOME:1]]`); keys in other
scripts become `FIELD`. Vaults are per session and never shared, and they are not written to disk.

## Evidence

Each guarded call that masked or restored something adds a `redaction` event to the job's
[evidence bundle](/evidence): the tool, the number of values masked per kind and the number
restored. The values themselves are never recorded. Because the guard runs inside the tool wrapper,
the `tool.result` event in the same bundle already holds the masked text, so the bundle shows
exactly what the model was given.

```text
kurahi evidence replay <job>
  ...
  context guard on mcp:care/residents: 4 name, 2 phone masked
  context guard on message: nothing masked, 2 value(s) restored into arguments
```

## Limits

- Images and binary tool output are not inspected.
- What the user types into a chat goes to the model as written; the guard covers what tools return.
- A reply the agent writes keeps placeholders. Reveal real values to people through your own
  system of record, where their access rights already apply.
- Detectors are patterns. Test them against your own data with `kurahi evidence replay` before relying on them for
  regulated data, and add `patterns` for identifiers specific to your organisation.
