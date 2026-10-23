---
summary: "Kurahi Editions: Industrial, Business, Scholars and Core on one shared shell, capability packs, the planned Research pack, and what is available today versus planned"
read_when:
  - Choosing which Kurahi Edition fits an organisation
  - Explaining what the Editions share and where they differ
  - Checking which Edition features exist today and which are planned
title: "Editions"
---

# Editions

日本語: [エディション](/ja/editions)

Kurahi is one runtime with four Editions. Each Edition is a different working environment for a
different kind of organisation: its own home screen, navigation, vocabulary and default agent
team. Underneath, every Edition is the same Kurahi, with the same security model.

| Edition        | For                                                                                | Main canvas                       |
| -------------- | ---------------------------------------------------------------------------------- | --------------------------------- |
| **Industrial** | Plant engineering, operations, maintenance, legacy modernisation, OT/IT security   | Estate health and active missions |
| **Business**   | Back-office teams: cases, documents, workflows, approvals                          | Case and process desk             |
| **Scholars**   | Universities and research institutes, with separate Research and Education layouts | Studies and notebooks; courses    |
| **Core**       | Teams whose domain does not need a specialised Edition yet                         | Chat-first Project command centre |

## What every Edition shares

The Editions are configurations over one shell. These parts are the same in all of them and an
Edition cannot weaken them:

- identity, Projects and their folder boundaries, permissions and connectors;
- chat and push-to-talk entry;
- versioned Artifacts with their producer and export hash;
- approvals and authority requests;
- the signed timeline and evidence provenance;
- the security model: policy, sandbox, exec approvals, audit log, supply-chain lock, memory
  provenance and signed agent messages (see [Security overview](/security/SECURITY_OVERVIEW)).

An Edition's manifest describes presentation and capability needs only. It has no fields for
permissions, Project isolation, security, approval or audit policy. Routes and permissions come
from capabilities, not from hiding things on screen; a connector that is missing, disabled or
unverified stays visible with its real status.

Japanese and English are the launch languages for every Edition.

## Capability packs

Inside an Edition, domain lanes are capability packs. A pack adds agents, tools, templates and
views; it does not add new global navigation and cannot change Edition policy. Each pack shows
its readiness honestly: active, configured but not verified, disabled, or planned.

The Industrial Edition has five packs today:

| Pack          | Readiness                | What it covers                                                                |
| ------------- | ------------------------ | ----------------------------------------------------------------------------- |
| Analysis      | Active                   | Deterministic legacy analysis (COBOL/JCL, Java, SQL DDL) with path:line facts |
| Modernisation | Configured, not verified | Target design, transformation plan, equivalence evidence                      |
| Maintenance   | Configured, not verified | Work orders, manuals and condition data, once those connections are verified  |
| Controls      | Disabled                 | Offline PLC review; stays off until an approved offline export is connected   |
| Cybersecurity | Planned                  | Authorised-scope inventory and finding review; no scanner connection claimed  |

### Research pack (planned)

The Research pack is planned as an add-on that brings the Scholars Research workspace (studies,
notebooks, data, experiments, literature, provenance) into the Industrial and Business Editions,
for example for an R&D department. It is not available yet.

## Available today and planned

As of 23 October 2026. Everything below is in the development line after release 2.0.3 and is not
in a published release yet.

| Item                                        | Status                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Edition and workspace manifests (all four)  | Built: the shared shell selects an Edition's navigation, vocabulary and layout                        |
| Industrial Edition workbench                | Built: the first reference Edition, with the five packs above                                         |
| Legacy analyser and design documents        | Built: see [Industrial modernisation](/industrial-modernisation)                                      |
| Work Console terminal and push-to-talk      | Gateway side built; the desktop console screens are in development, see [Work Console](/work-console) |
| Business Edition                            | Planned: navigation is defined; the case, document and queue screens are not built                    |
| Scholars Edition (Research, then Education) | Planned: navigation is defined; the Research and Education screens are not built                      |
| Core Edition                                | Planned: assembled last from the shared parts already proven in the other Editions                    |
| Research pack                               | Planned                                                                                               |
| Edition licences                            | Planned: licence identifiers are defined; terms and pricing are not published                         |

The order of delivery is Industrial, then Business, then Scholars (Research first, then
Education), then Core. An Edition is considered ready when representative users can complete its
three most important workflows without going through generic chat, and every agent action can be
traced through the common evidence model.

## Scholars: free for non-commercial academic use

Scholars is planned as a global Edition, free for non-commercial research and teaching at
universities and research institutes in any country. Commercial use needs a commercial licence.
Applications will open soon. See [Kurahi Scholars](/scholars).
