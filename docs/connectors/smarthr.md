---
summary: "SmartHR business connector: read employees (work-related fields only, from a strict allow-list enforced in code) and departments; never My Number, bank, insurance, pay or other personal fields; read-only"
read_when:
  - You are connecting Kurahi to SmartHR
  - You need the access token setup and the exact fields read
  - You must confirm which personal data is never read
title: "SmartHR"
---

# SmartHR connector

日本語: [SmartHR コネクター](/ja/connectors/smarthr)

| Property      | Value                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| Plugin id     | `smarthr` (bundled, **off by default**)                                                  |
| Access        | **Read-only, always.** No write tool exists                                              |
| Sign-in       | An access token a SmartHR administrator issues (hidden prompt at `kurahi smarthr login`) |
| Token storage | Kurahi secret store (`connector.smarthr.token`)                                          |
| Status        | Available                                                                                |

## The field allow-list

Every employee request sends `fields=` with the allow-list, and every response is projected onto
it again, so a field outside it is neither requested nor returned even if the API sent it. The
allow-list is fixed in code (`CREW_FIELD_CEILING`); `crewFields` can only narrow it:

`id`, `emp_code`, `last_name`, `first_name`, `last_name_yomi`, `first_name_yomi`,
`business_last_name`, `business_first_name`, `business_last_name_yomi`,
`business_first_name_yomi`, `emp_status`, `employment_type`, `department`, `departments`,
`position`, `positions`, `entered_at`, and `email` (off unless listed in `crewFields`).

Nested objects are reduced to id, name, full name and code.

**Never read, whatever the configuration:** My Number (not in the public API at all); bank
accounts; employment, social, health insurance and basic pension numbers and their images;
insurance premiums; salary, standard monthly income, spouse income, commuting allowances; tax
category; birth date; gender; phone numbers; addresses (current, resident card, emergency
contact); residence card, nationality and residence status; identity documents; handicap,
widow and working-student information; résumés; previous workplaces; contract terms; resignation
reason; dependants (a separate endpoint the connector never calls); custom fields. A second,
independent pattern check (`SENSITIVE_FIELD`) refuses any such name even if it were added to the
allow-list, and the test suite runs all 144 properties of the published Crew schema through both.

## What it reads

| Tool                       | API                   | Returns                                                                                                                                   |
| -------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `smarthr_crews_list`       | `GET /v1/crews`       | allow-listed fields; filters: status, department id, employee code, name/department/position search (`q`); at most 100 per page, 50 pages |
| `smarthr_crew_get`         | `GET /v1/crews/{id}`  | one employee, allow-listed fields                                                                                                         |
| `smarthr_departments_list` | `GET /v1/departments` | id, name, full name, code, parent id                                                                                                      |

## Set up

1. In SmartHR, an administrator issues an access token (共通設定 > API アクセストークン). Where your
   plan offers it, restrict the token to **read** (参照) on employees and departments and to the
   employee fields above.
2. Configure:

```bash
kurahi plugins enable smarthr
kurahi config set plugins.entries.smarthr.config '{ "tenant": "example" }' --json
kurahi smarthr status
kurahi smarthr login        # hidden prompt; or: printf '%s' "$TOKEN" | kurahi smarthr login --stdin
kurahi smarthr probe
```

| Key             | Default            | Meaning                                               |
| --------------- | ------------------ | ----------------------------------------------------- |
| `tenant`        | none               | `example` for `https://example.smarthr.jp`            |
| `sandbox`       | `false`            | Use `https://<tenant>.daruma.space` (SmartHR sandbox) |
| `crewFields`    | allow-list − email | Narrow the allow-list; other names are refused        |
| `ratePerSecond` | 5                  | Client-side request limit                             |

## Data handling

- **Untrusted content.** Names, departments and positions reach the model only inside the
  untrusted-content boundary.
- **Audit.** One row per call (`connector.smarthr.<operation>`): crew and department ids, counts,
  duration, error code. Never names or other field values.
- **Limits.** SmartHR allows 10 requests per second and 5,000 per hour per token (and 50,000 per
  minute per tenant); the connector stays at 5 per second and backs off on 429.
- **Endpoints.** Only `https://<tenant>.smarthr.jp/api` (or `daruma.space` for the sandbox).

## Status and revocation

The gateway probes `GET /v1/crews?fields=id&per_page=1`. `kurahi smarthr logout` deletes the
stored token; an administrator deletes the token in SmartHR to revoke it.

## References

Official SmartHR documentation: base URL, Bearer auth, paging and rate limits
([about_api](https://developer.smarthr.jp/api/about_api)), sandbox domain
([about_sandbox](https://developer.smarthr.jp/api/about_sandbox)), `fields`, `q`, endpoints and
the 144 Crew properties ([Swagger document](https://app.smarthr.jp/api/v1/swagger_doc)).

Setup notes: grant the access token read permission for the employee fields and resources the
connector reads (SmartHR sets token permissions per field and per resource). Department listing
uses the general page size limit of 100.
