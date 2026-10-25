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

/**
 * Business departments a queue may map to (stable catalogue, in display order). A department is a
 * view over queues for the console's department workspaces, never an authorization boundary.
 * Labels are UI data; the backend only knows these ids.
 */
export const DEPARTMENT_IDS = [
  "secretariat",
  "finance",
  "admin",
  "hr",
  "planning",
  "it",
  "procurement",
  "sales",
  "marketing",
  "service",
  "operations",
  "legal",
  "product",
  "facilities",
  "quality",
] as const;
export type DepartmentId = (typeof DEPARTMENT_IDS)[number];
/** List filter value for items whose queue maps to no department. */
export const UNMAPPED_DEPARTMENT = "unmapped";
export type DepartmentFilter = DepartmentId | typeof UNMAPPED_DEPARTMENT;

export function isDepartmentId(v: unknown): v is DepartmentId {
  return typeof v === "string" && (DEPARTMENT_IDS as readonly string[]).includes(v);
}

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

/** Connectors an email reference may come from. */
export const EMAIL_CONNECTORS = ["microsoft-365", "gmail"] as const;
export type EmailConnector = (typeof EMAIL_CONNECTORS)[number];

/**
 * Where the item came from: a REFERENCE to a message in the connected mailbox, never a copy of
 * it. The body stays in the mailbox; only these bounded header values are stored.
 */
export type WorkItemOrigin = {
  kind: "email";
  connector: EmailConnector;
  /** The connector's own message id (Graph message id, Gmail message id). */
  messageId: string;
  receivedAt?: string;
  /** Sender address only (no display name). */
  from?: string;
  /** Subject line, bounded. */
  subject?: string;
};

export type WorkItemSource = {
  documents: WorkItemSourceDocument[];
  /** Form fields (amount, dates, vendor, …). Scalars only. */
  fields: Record<string, string | number | boolean | null>;
  /** Set when the item was taken in from an email (workitems.intakeEmail). */
  origin?: WorkItemOrigin;
};

/**
 * Risk flags on an item. `suspected_fraud` blocks approval (and completion) until a PERSON
 * clears it with a written reason (workitems.clearFlag); agents may raise flags, never clear them.
 */
export const WORK_ITEM_FLAGS = [
  "suspected_fraud",
  "phishing",
  "prompt_injection",
  "unverified_sender",
  // An attachment of the item's message was refused by the attachment intake (static policy or
  // malware scan, docs/security/attachment-intake.md). Set by the engine, cleared by a person.
  "malicious_attachment",
] as const;
export type WorkItemFlag = (typeof WORK_ITEM_FLAGS)[number];

export type WorkItemFlagClearance = {
  flag: WorkItemFlag;
  by: string;
  at: string;
  reason: string;
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

export type WorkItemApproval = {
  by: string;
  at: string;
  comment: string | null;
  /** Route stage the approval was given in (absent on items approved before staged routes). */
  stageId?: string;
  /** Set when a delegate approved for the named approver. */
  onBehalfOf?: string | null;
  /** How the person was entitled to decide this stage. */
  via?: "approver" | "delegation" | "escalation";
};

export type WorkItemText = { ja?: string; en?: string };

export type StageApprovers = {
  /** Anyone allowed to approve (single-stage review without a route). */
  any: boolean;
  roles: string[];
  principals: string[];
  /** Form field naming the department whose approvers decide (e.g. `department`). */
  departmentField: string | null;
  /** The department value read from the item when the route was built. */
  department: string | null;
};

export type WorkItemDelegation = {
  from: string;
  to: string;
  reason: string;
  at: string;
  expiresAt: string;
};

export type WorkItemStage = {
  id: string;
  name: WorkItemText;
  approvers: StageApprovers;
  minApprovals: number;
  dueHours: number | null;
  /** Where send back goes: the requester (status sent_back) or the previous stage. */
  onReturn: "requester" | "previous";
  delegation: boolean;
  escalation: { afterHours: number; to: { roles: string[]; principals: string[] } } | null;
  status: "pending" | "active" | "approved";
  approvals: WorkItemApproval[];
  delegations: WorkItemDelegation[];
  activatedAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  overdueAt: string | null;
  escalatedAt: string | null;
};

export type WorkItemRoute = {
  /** Route id from the policy, or `single` for the single-stage review. */
  id: string;
  kind: "staged" | "single";
  policyDigest: string;
  stages: WorkItemStage[];
  /** Stages left out by their conditions, with the reason. */
  skipped: Array<{ id: string; name: WorkItemText; reason: string }>;
  /** Index of the active stage; null before submission and after the last approval. */
  current: number | null;
};

/** Compact view of the active stage for lists and inboxes. */
export type WorkItemStageSummary = {
  id: string;
  name: WorkItemText;
  index: number;
  count: number;
  dueAt: string | null;
  overdue: boolean;
  escalated: boolean;
  approvals: number;
  minApprovals: number;
};

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
  /** Principal (connection identity) that created the request; owner of "My requests". */
  requestedBy: string;
  /** Approval route (稟議); null on items created before routes existed until first decided. */
  route: WorkItemRoute | null;
  /** Short description in the intake agent's own words (never the email body). */
  summary?: string;
  /** Active risk flags (absent = none). */
  flags?: WorkItemFlag[];
  /** Why the flags were raised (bounded). Removed when the last flag is cleared. */
  flagReason?: string;
  /** Flags a person cleared, with who, when and why (append-only). */
  flagClearances?: WorkItemFlagClearance[];
  updatedAt: string;
  /** Incremented on every write; pass as expectedRevision for optimistic concurrency. */
  revision: number;
};

/** Summary row for lists (no history). */
export type WorkItemSummary = Omit<WorkItem, "history" | "source"> & {
  source: { documents: number; fields: string[]; origin?: WorkItemOrigin };
  overdue: boolean;
  currentStage: WorkItemStageSummary | null;
};

export type ActorKind = WorkItemHistoryEntry["actorKind"];
/** `privileged`: holds operator scopes (operator.admin) and may read and update every item. */
export type Actor = { id: string; kind: ActorKind; privileged?: boolean };
