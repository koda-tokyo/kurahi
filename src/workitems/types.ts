// Work queue (Kurahi Business edition): a governed queue of back-office work items per Project.
// Agents draft, people decide. Stored under the project's data area
// `<KOLO_HOME>/projects/<projectId>/workitems/<itemId>/` (item.json + one signed evidence bundle
// per transition). See docs/business/work-queue.md.

export const WORK_ITEM_TYPES = [
  "request",
  "case",
  "document",
  "invoice",
  "leave",
  "expense",
  "purchase",
  "custom",
] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const WORK_ITEM_STATUSES = [
  "new",
  "drafting",
  "awaiting_review",
  "approved",
  "sent_back",
  "done",
  "cancelled",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set(["done", "cancelled"]);

export type WorkItemAssignee = { kind: "agent" | "person"; id: string } | null;

/** A document the item is about: an uploaded attachment, a project file or an artifact. */
export type WorkItemSourceDocument = {
  kind: "attachment" | "file" | "artifact";
  /** Attachment path (under the project data area), project-relative path, or artifact id. */
  ref: string;
  name: string;
  sha256?: string;
};

export type WorkItemSource = {
  documents: WorkItemSourceDocument[];
  /** Form fields (amount, dates, vendor, …). Scalars only. */
  fields: Record<string, string | number | boolean | null>;
};

export type WorkItemDraft = {
  artifactId: string;
  version: number;
  sha256: string;
  agentId: string | null;
  runId: string | null;
  createdAt: string;
};

export type CheckResult = "pass" | "fail" | "warn";

export type WorkItemCheck = {
  policyId: string;
  label: { ja?: string; en?: string };
  result: CheckResult;
  /** A failing blocking check stops approval unless a person overrides it with a reason. */
  blocking: boolean;
  /** What the rule looked at and why it decided (field, value, threshold, matched phrase …). */
  evidence: Record<string, unknown>;
  checkedAt: string;
  /** Draft version the check ran against (null = fields only). */
  draftVersion: number | null;
  /** SHA-256 of the policy document the rule came from. */
  policyDigest: string;
};

export type WorkItemApproval = { by: string; at: string; comment: string | null };

export type WorkItemOverride = {
  by: string;
  at: string;
  reason: string;
  policyIds: string[];
};

export type WorkItemHistoryEntry = {
  at: string;
  by: string;
  /** "person" | "agent" | "system" */
  actorKind: "person" | "agent" | "system";
  action: string;
  from?: WorkItemStatus;
  to?: WorkItemStatus;
  comment?: string | null;
  detail?: Record<string, unknown>;
  /** Evidence bundle written for this transition (id under the item's evidence/ folder). */
  evidence?: { bundle: string; root: string } | null;
};

export type WorkItem = {
  id: string;
  projectId: string;
  queue: string;
  type: WorkItemType;
  title: string;
  source: WorkItemSource;
  status: WorkItemStatus;
  assignee: WorkItemAssignee;
  priority: WorkItemPriority;
  /** ISO timestamp the item is due (SLA); null = no SLA. */
  dueAt: string | null;
  /** SLA in hours from creation that produced dueAt (informational). */
  slaHours: number | null;
  draft: WorkItemDraft | null;
  checks: WorkItemCheck[];
  /** Distinct people whose approval is needed (from policy rules; default 1). */
  requiredApprovals: number;
  approvals: WorkItemApproval[];
  override: WorkItemOverride | null;
  history: WorkItemHistoryEntry[];
  runIds: string[];
  /** Last agent-run error (cleared when a draft arrives). */
  lastError: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  /** Incremented on every write; pass as expectedRevision for optimistic concurrency. */
  revision: number;
};

/** Summary row for lists (no history). */
export type WorkItemSummary = Omit<WorkItem, "history" | "source"> & {
  source: { documents: number; fields: string[] };
  overdue: boolean;
};

export type ActorKind = WorkItemHistoryEntry["actorKind"];
export type Actor = { id: string; kind: ActorKind };
