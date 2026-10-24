export const WORKSPACE_IDS = [
  "industrial",
  "backoffice",
  "research",
  "education",
  "generic",
] as const;

export type WorkspaceId = (typeof WORKSPACE_IDS)[number];
export const EDITION_IDS = ["industrial", "business", "scholars", "core"] as const;

export type EditionId = (typeof EDITION_IDS)[number];
export type WorkspaceDensity = "comfortable" | "standard" | "compact";
export type CapabilityPackId =
  | "analysis"
  | "modernisation"
  | "controls"
  | "maintenance"
  | "cybersecurity";
export type CapabilityPackReadiness = "active" | "unverified" | "disabled" | "planned";

export interface ManifestNavigationItem {
  readonly id: string;
  readonly route: string;
  readonly labelKey: string;
  readonly capability?: string;
}

export interface WorkspaceManifest {
  readonly id: WorkspaceId;
  readonly labelKey: string;
  readonly navigation: readonly ManifestNavigationItem[];
  readonly terminology: Readonly<Record<string, string>>;
  readonly density: WorkspaceDensity;
  readonly theme: {
    readonly palette: string;
    readonly typography: string;
    readonly dataVisualization: string;
  };
  readonly homeWidgets: readonly string[];
  readonly defaultAgentRoles: readonly string[];
  readonly projectTemplates: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly optionalCapabilities: readonly string[];
}

export interface EditionLicence {
  readonly sku: string;
  readonly edition: EditionId;
}

export interface EditionManifest<
  Workspaces extends readonly WorkspaceId[] = readonly WorkspaceId[],
> {
  readonly id: EditionId;
  readonly label: string;
  readonly licence: EditionLicence;
  readonly defaultWorkspace: Workspaces[number];
  readonly allowedBaseWorkspaces: Workspaces;
  readonly availablePacks: readonly CapabilityPackId[];
}

export interface CapabilityPackManifest {
  readonly id: CapabilityPackId;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly promptKey: string;
  readonly availableTo: readonly EditionId[];
  readonly readiness: CapabilityPackReadiness;
  readonly agentRoles: readonly string[];
  readonly capabilities: readonly string[];
  readonly addsWorkspaces: readonly WorkspaceId[];
}

type ForbiddenManifestKey =
  | "security"
  | "permissions"
  | "projectIsolation"
  | "approvalPolicy"
  | "auditPolicy"
  | "auditRetention"
  | "evidencePolicy"
  | "provenancePolicy";

type RejectForbiddenKeys<T> = Extract<keyof T, ForbiddenManifestKey> extends never ? T : never;

function defineWorkspace<const T extends WorkspaceManifest>(
  manifest: T & RejectForbiddenKeys<T>,
): Readonly<T> {
  return manifest;
}

function defineEdition<
  const Workspaces extends readonly WorkspaceId[],
  const T extends EditionManifest<Workspaces>,
>(
  manifest: T &
    RejectForbiddenKeys<T> &
    (T["defaultWorkspace"] extends Workspaces[number] ? unknown : never),
): Readonly<T> {
  return manifest;
}

function definePack<const T extends CapabilityPackManifest>(
  manifest: T & RejectForbiddenKeys<T>,
): Readonly<T> {
  return manifest;
}

const WORKSPACE_MANIFESTS = {
  industrial: defineWorkspace({
    id: "industrial",
    labelKey: "workspace.industrial",
    navigation: [
      { id: "overview", route: "/overview", labelKey: "nav.overview" },
      { id: "estate", route: "/estate", labelKey: "nav.estate" },
      { id: "modernize", route: "/modernize", labelKey: "nav.modernize" },
      { id: "operate", route: "/operate", labelKey: "nav.operate" },
      { id: "timeline", route: "/timeline", labelKey: "nav.timeline" },
      { id: "artifacts", route: "/artifacts", labelKey: "nav.artifacts" },
    ],
    terminology: { project: "mission", task: "work order" },
    density: "compact",
    theme: {
      palette: "industrial-graphite",
      typography: "operational",
      dataVisualization: "high-contrast",
    },
    homeWidgets: ["estate-health", "active-missions", "exceptions", "rollback-readiness"],
    defaultAgentRoles: [
      "estate-mapper",
      "dependency-analyst",
      "transformation-engineer",
      "controls-maintenance-engineer",
      "cybersecurity-engineer",
      "independent-validator",
    ],
    projectTemplates: ["industry-legacy-modernisation"],
    requiredCapabilities: ["projects", "approvals", "audit", "evidence"],
    optionalCapabilities: ["connectors", "terminal", "simulation"],
  } as const),
  backoffice: defineWorkspace({
    id: "backoffice",
    labelKey: "workspace.backoffice",
    navigation: [
      { id: "today", route: "/today", labelKey: "nav.today" },
      { id: "inbox", route: "/inbox", labelKey: "nav.inbox" },
      { id: "cases", route: "/cases", labelKey: "nav.cases" },
      { id: "documents", route: "/documents", labelKey: "nav.documents" },
      { id: "workflows", route: "/workflows", labelKey: "nav.workflows" },
      { id: "approvals", route: "/approvals", labelKey: "nav.approvals" },
      { id: "artifacts", route: "/artifacts", labelKey: "nav.artifacts" },
    ],
    terminology: { project: "case", task: "action" },
    density: "standard",
    theme: {
      palette: "business-neutral",
      typography: "document-first",
      dataVisualization: "status-focused",
    },
    homeWidgets: ["work-queue", "due-soon", "approval-exceptions", "service-risk"],
    defaultAgentRoles: [
      "intake-clerk",
      "document-analyst",
      "process-operator",
      "policy-checker",
      "independent-validator",
    ],
    projectTemplates: [
      "business-procurement",
      "business-hr-leave-overtime",
      "business-finance-expense-invoice",
      "business-general-affairs",
    ],
    requiredCapabilities: ["projects", "approvals", "audit", "evidence"],
    optionalCapabilities: ["connectors", "bulk-review", "workflows"],
  } as const),
  research: defineWorkspace({
    id: "research",
    labelKey: "workspace.research",
    navigation: [
      { id: "studies", route: "/studies", labelKey: "nav.studies" },
      { id: "notebooks", route: "/notebooks", labelKey: "nav.notebooks" },
      { id: "data", route: "/data", labelKey: "nav.data" },
      { id: "experiments", route: "/experiments", labelKey: "nav.experiments" },
      { id: "literature", route: "/literature", labelKey: "nav.literature" },
      { id: "provenance", route: "/provenance", labelKey: "nav.provenance" },
      { id: "publications", route: "/publications", labelKey: "nav.publications" },
    ],
    terminology: { project: "study", task: "research task" },
    density: "compact",
    theme: {
      palette: "research-neutral",
      typography: "notebook",
      dataVisualization: "scientific",
    },
    homeWidgets: ["active-studies", "experiment-state", "review-requests", "milestones"],
    defaultAgentRoles: [
      "literature-analyst",
      "data-steward",
      "experiment-operator",
      "statistical-reviewer",
      "reproducibility-agent",
      "publication-assistant",
    ],
    projectTemplates: ["research-academic"],
    requiredCapabilities: ["projects", "approvals", "audit", "evidence", "provenance"],
    optionalCapabilities: ["compute", "connectors", "notebooks"],
  } as const),
  education: defineWorkspace({
    id: "education",
    labelKey: "workspace.education",
    navigation: [
      { id: "today", route: "/today", labelKey: "nav.today" },
      { id: "courses", route: "/courses", labelKey: "nav.courses" },
      { id: "lessons", route: "/lessons", labelKey: "nav.lessons" },
      { id: "assignments", route: "/assignments", labelKey: "nav.assignments" },
      { id: "tutor", route: "/tutor", labelKey: "nav.tutor" },
      { id: "portfolio", route: "/portfolio", labelKey: "nav.portfolio" },
      { id: "progress", route: "/progress", labelKey: "nav.progress" },
    ],
    terminology: { project: "course", task: "assignment" },
    density: "comfortable",
    theme: {
      palette: "education-warm",
      typography: "readable",
      dataVisualization: "learning-progress",
    },
    homeWidgets: ["next-lesson", "due-work", "tutor-continuity", "class-progress"],
    defaultAgentRoles: [
      "tutor",
      "lesson-planner",
      "practice-coach",
      "accessibility-assistant",
      "feedback-assistant",
      "safeguarding-checker",
    ],
    projectTemplates: ["education"],
    requiredCapabilities: ["projects", "approvals", "audit", "evidence"],
    optionalCapabilities: ["voice", "accessibility", "classrooms"],
  } as const),
  generic: defineWorkspace({
    id: "generic",
    labelKey: "workspace.generic",
    navigation: [
      { id: "home", route: "/home", labelKey: "nav.home" },
      { id: "projects", route: "/projects", labelKey: "nav.projects" },
      { id: "chat", route: "/chat", labelKey: "nav.chat" },
      { id: "tasks", route: "/tasks", labelKey: "nav.tasks" },
      { id: "files", route: "/files", labelKey: "nav.files" },
      { id: "agents", route: "/agents", labelKey: "nav.agents" },
      { id: "artifacts", route: "/artifacts", labelKey: "nav.artifacts" },
      { id: "activity", route: "/activity", labelKey: "nav.activity" },
    ],
    terminology: { project: "project", task: "task" },
    density: "standard",
    theme: {
      palette: "core-neutral",
      typography: "balanced",
      dataVisualization: "general-purpose",
    },
    homeWidgets: ["recent-projects", "active-missions", "assigned-tasks", "pending-approvals"],
    defaultAgentRoles: [
      "coordinator",
      "researcher",
      "document-worker",
      "workflow-operator",
      "independent-validator",
    ],
    projectTemplates: ["professional"],
    requiredCapabilities: ["projects", "approvals", "audit", "evidence"],
    optionalCapabilities: ["connectors", "terminal", "automations"],
  } as const),
} satisfies Readonly<Record<WorkspaceId, WorkspaceManifest>>;

const EDITION_MANIFESTS = {
  industrial: defineEdition({
    id: "industrial",
    label: "Industrial",
    licence: { sku: "kurahi-industrial", edition: "industrial" },
    defaultWorkspace: "industrial",
    allowedBaseWorkspaces: ["industrial"],
    availablePacks: ["analysis", "modernisation", "controls", "maintenance", "cybersecurity"],
  } as const),
  business: defineEdition({
    id: "business",
    label: "Business",
    licence: { sku: "kurahi-business", edition: "business" },
    defaultWorkspace: "backoffice",
    allowedBaseWorkspaces: ["backoffice"],
    availablePacks: [],
  } as const),
  scholars: defineEdition({
    id: "scholars",
    label: "Scholars",
    licence: { sku: "kurahi-scholars", edition: "scholars" },
    defaultWorkspace: "research",
    allowedBaseWorkspaces: ["research", "education"],
    availablePacks: [],
  } as const),
  core: defineEdition({
    id: "core",
    label: "Core",
    licence: { sku: "kurahi-core", edition: "core" },
    defaultWorkspace: "generic",
    allowedBaseWorkspaces: ["generic"],
    availablePacks: [],
  } as const),
} satisfies Readonly<Record<EditionId, EditionManifest>>;

const CAPABILITY_PACKS = {
  analysis: definePack({
    id: "analysis",
    labelKey: "industrial.pack.analysis",
    descriptionKey: "industrial.pack.analysis.description",
    promptKey: "industrial.pack.analysis.prompt",
    availableTo: ["industrial"],
    readiness: "active",
    agentRoles: ["estate-mapper", "dependency-analyst"],
    capabilities: ["legacy-index", "legacy-query", "evidence-map"],
    addsWorkspaces: [],
  } as const),
  modernisation: definePack({
    id: "modernisation",
    labelKey: "industrial.pack.modernisation",
    descriptionKey: "industrial.pack.modernisation.description",
    promptKey: "industrial.pack.modernisation.prompt",
    availableTo: ["industrial"],
    readiness: "unverified",
    agentRoles: ["transformation-engineer", "data-batch-engineer", "independent-validator"],
    capabilities: ["target-design", "transformation-plan", "equivalence-evidence"],
    addsWorkspaces: [],
  } as const),
  controls: definePack({
    id: "controls",
    labelKey: "industrial.pack.controls",
    descriptionKey: "industrial.pack.controls.description",
    promptKey: "industrial.pack.controls.prompt",
    availableTo: ["industrial"],
    readiness: "disabled",
    agentRoles: ["controls-engineer", "independent-validator"],
    capabilities: ["offline-plc-review", "tag-alarm-map"],
    addsWorkspaces: [],
  } as const),
  maintenance: definePack({
    id: "maintenance",
    labelKey: "industrial.pack.maintenance",
    descriptionKey: "industrial.pack.maintenance.description",
    promptKey: "industrial.pack.maintenance.prompt",
    availableTo: ["industrial"],
    readiness: "unverified",
    agentRoles: ["maintenance-engineer", "reliability-analyst"],
    capabilities: ["work-order-analysis", "manual-evidence", "condition-data"],
    addsWorkspaces: [],
  } as const),
  cybersecurity: definePack({
    id: "cybersecurity",
    labelKey: "industrial.pack.cybersecurity",
    descriptionKey: "industrial.pack.cybersecurity.description",
    promptKey: "industrial.pack.cybersecurity.prompt",
    availableTo: ["industrial"],
    readiness: "planned",
    agentRoles: ["cybersecurity-engineer", "independent-validator"],
    capabilities: ["authorized-inventory", "finding-review", "recovery-evidence"],
    addsWorkspaces: [],
  } as const),
} satisfies Readonly<Record<CapabilityPackId, CapabilityPackManifest>>;

export function getEditionManifest(editionId: EditionId): EditionManifest {
  return EDITION_MANIFESTS[editionId];
}

export function getWorkspaceManifest(workspaceId: WorkspaceId): WorkspaceManifest {
  return WORKSPACE_MANIFESTS[workspaceId];
}

export function getCapabilityPackManifest(packId: CapabilityPackId): CapabilityPackManifest {
  return CAPABILITY_PACKS[packId];
}

export function capabilityPacksForEdition(editionId: EditionId): readonly CapabilityPackManifest[] {
  return getEditionManifest(editionId).availablePacks.map((packId) => CAPABILITY_PACKS[packId]);
}

export function isEditionId(value: unknown): value is EditionId {
  return typeof value === "string" && EDITION_IDS.some((id) => id === value);
}

export function isWorkspaceId(value: unknown): value is WorkspaceId {
  return typeof value === "string" && WORKSPACE_IDS.some((id) => id === value);
}

export function workspacesForEdition(
  editionId: EditionId,
  enabledPacks: readonly CapabilityPackId[] = [],
): readonly WorkspaceId[] {
  const edition = getEditionManifest(editionId);
  const workspaces = new Set<WorkspaceId>(edition.allowedBaseWorkspaces);
  for (const packId of enabledPacks) {
    if (!edition.availablePacks.includes(packId)) {
      continue;
    }
    const pack = CAPABILITY_PACKS[packId];
    if (!pack.availableTo.some((availableEdition) => availableEdition === editionId)) {
      continue;
    }
    for (const workspaceId of pack.addsWorkspaces) {
      workspaces.add(workspaceId);
    }
  }
  return [...workspaces];
}

export function resolveWorkspaceId(
  editionId: EditionId,
  requestedWorkspace: string | null | undefined,
  enabledPacks: readonly CapabilityPackId[] = [],
): WorkspaceId {
  const edition = getEditionManifest(editionId);
  const allowed = workspacesForEdition(editionId, enabledPacks);
  return requestedWorkspace && allowed.includes(requestedWorkspace as WorkspaceId)
    ? (requestedWorkspace as WorkspaceId)
    : edition.defaultWorkspace;
}
