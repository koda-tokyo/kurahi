# Kurahi Edition UI Architecture

Status: product direction, 2026-10-23

## Decision

Kurahi ships as one trusted platform with four customer Editions:

1. Industrial
2. Business
3. Scholars
4. Core

Each Edition has its own information architecture, home screen, vocabulary, visual density,
default agent team and workflow templates. They share identity, Project boundaries, permissions,
connectors, chat and voice, Artifacts, approvals, audit timelines and the security model.

Scholars has distinct Research and Education layouts under one university Edition. They share
institutional identity, libraries, governance and collaboration while preserving the different
working rhythms of research and teaching.

An Edition is selected when an organization or workspace is provisioned. Authorized administrators
can add another Edition later. Ordinary users should enter the workspace for their role rather than
choose a skin on every launch.

Editions follow the organization that buys and operates Kurahi. Domain lanes are capability packs
inside an Edition. An industrial customer can enable analysis, modernization, controls,
maintenance and cybersecurity packs without buying or operating five products. Packs add agents,
tools, templates and views; they do not create new global navigation or weaken Edition policy.

## Shared product frame

Every Edition retains a small, stable Kurahi frame:

- organization, identity and current Project
- global search and command palette
- agent activity, notifications and exceptions
- text and push-to-talk entry
- Project-scoped files, connectors and permissions
- versioned Artifacts with producer, validator and export hash
- approval and authority requests
- signed timeline and evidence provenance
- connectivity, data freshness and capability status
- Japanese and English at launch

Chat is always available, but it is not always the main canvas. The primary canvas matches the work:
a plant estate, a case queue, a lesson, a notebook or a flexible Project board. Agents work in the
background and surface progress, evidence and exceptions in the domain view.

## Industrial Edition — operations and modernization control room

**Primary user:** plant engineering, operations, maintenance, legacy modernization, OT/IT security

**Home:** estate health and active missions. Show production impact, stale evidence, blocked agent
runs, work orders, maintenance risk, modernization waves and approval exceptions.

**Navigation:**

`Overview | Estate | Modernize | Operate | Timeline | Artifacts`

**Main interaction patterns:**

- plant, Project and operating mode remain visible at all times
- dense asset and system tables with persistent filters
- dependency graphs and batch/production timelines within the active pack
- split workbench for source, evidence, terminal and agent run, with a stable context panel
- preview cards show impact, evidence, validation and rollback before any action
- clear Observe / Plan / Execute / Operate / Controlled mode
- alarm and exception queue ordered by consequence and time
- validation coverage, equivalence results and rollback readiness beside every proposed change

**Visual language:** graphite and deep navy surfaces, compact spacing, monospaced evidence where it
helps, restrained cyan for live state, amber for attention and red only for confirmed danger. Never
depend on color alone. Prefer stable layouts that operators can scan under pressure and controls
large enough for gloved use on an industrial touch screen.

**Default agent team:** estate mapper, dependency analyst, transformation engineer, data and batch
engineer, controls and maintenance engineer, cybersecurity engineer and independent validator.

## Business Edition — case and process desk

**Primary user:** finance, HR, procurement, legal operations, sales operations and administration

**Home:** personal and team work queue. Show cases requiring attention, due dates, agent-completed
work awaiting authority, process exceptions, reconciliations and service-level risk.

**Navigation:**

`Today | Inbox | Cases | Documents | Workflows | Approvals | Connectors | Reports | Artifacts`

**Main interaction patterns:**

- queue-first triage by owner, due date, organization, value and risk
- three-pane workbench: tasks and approvals; original document beside the agent draft; policy and
  evidence checks
- large Approve and Send back actions with consequence and destination visible
- guided case timeline that joins email, files, records, decisions and agent work
- bulk review for low-risk homogeneous items
- explicit separation between prepared, validated, approved and externally committed
- reusable process templates for close, onboarding, procurement and contract review

**Visual language:** warm white and slate, medium density, strong typography and calm blue/teal
status cues. Forms, documents and tables take priority over dashboards. Dates, amounts, owners and
legal entities remain visible while a case is open.

**Default agent team:** intake clerk, document analyst, process operator, reconciliation agent,
policy checker and independent validator.

## Scholars Edition — Education layout

**Primary user:** learner, teacher, course designer and school administrator

The Edition opens in the user's role. A learner sees the next useful action; a teacher sees class
progress and students who need attention. Administrative controls stay outside the learning flow.

**Learner navigation:**

`Today | Courses | Lessons | Assignments | Tutor | Portfolio | Progress`

**Teacher navigation:**

`Classes | Plan | Teach | Student Work | Feedback | Progress | Resources`

**Main interaction patterns:**

- low-density Today page with the next lesson, due work and tutor continuity
- focused lesson canvas with material, activity, notes and voice tutor
- tutor guidance uses questions, hints and explanations without completing assessed work for the
  learner
- assignment states that use familiar teaching language: assigned, submitted, returned and revised
- teacher review with student work, rubric, provenance and suggested feedback side by side
- adaptive explanations and practice while preserving the teacher's learning objectives
- learner portfolio containing selected, versioned work and reflection
- accessible reading modes, keyboard operation, captions and age-appropriate controls

**Visual language:** light, warm and spacious; clear course color accents; generous type and touch
targets; friendly illustration only when it supports orientation. Avoid productivity metrics that
turn learning into an operations dashboard.

**Default agent team:** tutor, lesson planner, practice coach, accessibility assistant, feedback
assistant and safeguarding/policy checker. Teachers retain curriculum and assessment authority.

## Scholars Edition — Research layout

**Primary user:** researcher, analyst, research engineer, principal investigator and lab manager

**Home:** active studies and experiment state. Show recent notebooks, running compute, dataset
versions, failed or drifting experiments, review requests, literature updates and publication
milestones.

**Navigation:**

`Studies | Notebooks | Data | Experiments | Literature | Compute | Provenance | Publications`

**Main interaction patterns:**

- three-pane default: sources and data; notebook and analysis; claim support and reproducibility
- resizable workspace for code, visualization, terminal and agent chat
- study tree that links question, protocol, data, run, result, interpretation and publication
- immutable dataset references and environment snapshots attached to every result
- experiment comparison across parameters, code, data, metrics and cost
- literature table with claims, citations, notes and contradictory evidence
- review mode for methodology, statistics, reproducibility and disclosure
- publication builder whose figures and claims resolve back to exact evidence
- referenced export to LaTeX and Word, with unsupported claims blocked or clearly marked

**Visual language:** neutral canvas with cobalt/violet accents, medium-high information density and
excellent chart contrast. Tabs, split panes and keyboard commands support long exploratory sessions.

**Default agent team:** literature analyst, data steward, experiment operator, statistical reviewer,
reproducibility agent and publication assistant.

## Core Edition — adaptable Project command center

**Primary user:** teams whose domain does not justify a specialized Edition yet

**Home:** chat first, with Projects, recent conversations, active agent missions, assigned tasks and
pending approvals close at hand. Onboarding asks what the team wants to accomplish and assembles a
starting workspace. Core is the way into Kurahi before a customer chooses a specialized Edition.

**Navigation:**

`Home | Projects | Chat | Tasks | Files | Agents | Artifacts | Activity`

**Main interaction patterns:**

- modular home cards that users can arrange
- chat and voice as prominent entry points
- simple Project board and file workspace
- progressive disclosure of terminal, connectors and automation controls
- saved agent missions that can later become an Edition template

**Visual language:** balanced navy and neutral surfaces, medium density and minimal domain imagery.
It should feel complete without pretending to understand a domain it has not been configured for.

**Default agent team:** coordinator, researcher, document worker, workflow operator and independent
validator, limited to tools and evidence actually connected.

## Edition implementation contract

Edition behavior is represented by separate readonly `EditionManifest` and `WorkspaceManifest`
contracts. Four licensed editions (`industrial`, `business`, `scholars`, `core`) map to five UI
workspaces (`industrial`, `backoffice`, `research`, `education`, `generic`). Base mappings are
Industrial to Industrial, Business to Backoffice, Scholars to Research and Education, and Core to
Generic. Scholars therefore shares one licence while selecting distinct Research and Education
layouts. Edition behavior remains configuration over shared, composable capabilities.

```ts
interface WorkspaceManifest {
  id: "industrial" | "backoffice" | "research" | "education" | "generic";
  labelKey: string;
  navigation: readonly { id: string; route: string; labelKey: string; capability?: string }[];
  terminology: Readonly<Record<string, string>>;
  density: "comfortable" | "standard" | "compact";
  theme: { palette: string; typography: string; dataVisualization: string };
  homeWidgets: readonly string[];
  defaultAgentRoles: readonly string[];
  projectTemplates: readonly string[];
  requiredCapabilities: readonly string[];
  optionalCapabilities: readonly string[];
}

interface EditionManifest {
  id: "industrial" | "business" | "scholars" | "core";
  label: string;
  licence: { sku: string; edition: EditionManifest["id"] };
  defaultWorkspace: WorkspaceManifest["id"];
  allowedBaseWorkspaces: readonly WorkspaceManifest["id"][];
  availablePacks: readonly string[];
}

interface WorkspacePackManifest {
  id: string;
  availableTo: readonly EditionManifest["id"][];
  addsWorkspaces: readonly WorkspaceManifest["id"][];
}
```

`getEditionManifest`, `getWorkspaceManifest`, `resolveWorkspaceId` and `workspacesForEdition` are
pure lookups/resolution helpers. Each default workspace must be in its Edition's allowed base
workspaces; resolution may select only a base workspace or one added by an available, enabled pack.
The Research pack declares Research as its added workspace for Industrial and Business without
mutating either Edition's base manifest. Manifests describe presentation and capability needs only;
they contain no fields for permissions, Project isolation, security policy, approval policy, audit
retention or evidence/provenance policy, and cannot weaken those shared controls. Routes and
permissions resolve from capabilities, not from visual hiding. A missing, disabled or unverified
connector remains visible with its honest status when it is relevant to the workflow.

Specialized components remain reusable. For example, the Industrial dependency graph can appear in
Scholars Research for lineage, the Research notebook can appear in Industrial analysis, and the
Business document review panel can appear in Scholars Education assessment. The Edition decides
which components lead and what words they use.

## Responsive and accessibility baseline

Desktop is the full authoring and operations environment. Tablet supports review, teaching and
floor use. Phone supports voice, notifications, evidence capture and approvals; it should not shrink
a control room or notebook into an unsafe miniature.

All Editions require keyboard navigation, visible focus, screen-reader names, scalable text,
reduced-motion support, captions/transcripts for voice, non-color status indicators and Japanese
text layouts tested at realistic lengths.

## Delivery order

1. Extract the common frame and define the Edition manifest contract.
2. Finish Industrial as the first complete reference Edition.
3. Build Business around queue, case, document and approval components.
4. Build Scholars with Research first, then Education, sharing institutional services while keeping
   their layouts distinct.
5. Assemble Core from the proven shared parts and keep its entry experience chat-first and minimal.

An Edition is ready when representative users can complete its three most important workflows
without entering generic chat or learning platform terminology, and every agent action remains
traceable through the common evidence model.
