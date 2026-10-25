---
summary: "Business connectors: Microsoft 365, Gmail, Entra ID and the Japanese SaaS connectors (kintone, freee, Money Forward, SmartHR, LINE WORKS, Box); all off by default, read-only by default, every write approved by a person"
read_when:
  - You want to know which business systems Kurahi can connect to
  - You need the common rules every business connector follows
title: "Business connectors"
---

# Business connectors

日本語: [業務コネクター](/ja/connectors)

Every business connector is a bundled plugin that is **off by default**, **read-only by default**,
and makes each write a separate administrator opt-in that waits for a person's approval. Tokens
live in the Kurahi secret store; audit rows hold ids and counts only; provider text reaches the
model only inside the untrusted-content boundary; the desktop catalogue shows **Active** only
after a successful live probe. Each has `kurahi <cli> login`, `status`, `probe` and `logout`.

| Connector                                              | CLI            | Reads                                                       | Opt-in writes (each approved)           | Status     |
| ------------------------------------------------------ | -------------- | ----------------------------------------------------------- | --------------------------------------- | ---------- |
| [Microsoft 365](/connectors/microsoft-365)             | `m365`         | Mail, calendar, OneDrive and SharePoint files               | Send, drafts, events, app-folder upload | Unverified |
| [Gmail](/connectors/gmail)                             | `gmail`        | Mail                                                        | Send                                    | Unverified |
| [Microsoft Entra ID](/connectors/entra)                | `entra`        | Sign-in, users and groups                                   | None                                    | Unverified |
| [kintone](/connectors/kintone)                         | `kintone`      | Records of listed apps, allow-listed field codes            | Record comment, record creation         | Unverified |
| [freee 会計](/connectors/freee)                        | `freee`        | Companies, deals, partners, account items, receipt metadata | None (the API has no draft deal)        | Unverified |
| [マネーフォワード クラウド](/connectors/money-forward) | `moneyforward` | クラウド請求書: billings, quotes, partners                  | None                                    | Unverified |
| [SmartHR](/connectors/smarthr)                         | `smarthr`      | Employees (work fields only), departments                   | None                                    | Unverified |
| [LINE WORKS](/connectors/line-works)                   | `lineworks`    | Channel information and members (no message history API)    | Bot text message                        | Unverified |
| [Box](/connectors/box)                                 | `box`          | Search, metadata, scanned fetch into the Project            | Upload to one folder                    | Unverified |

For research, the [Scholar sources](/connectors/scholar-sources) plugin (Kurahi Scholars) reads
arXiv, OpenAlex, Crossref and PubMed through their free public APIs, with no sign-in and no key.

"Unverified" means built and tested against recorded provider responses, not yet proven on a
live tenant; a connector becomes **Active** in the catalogue only after its own probe succeeds.
