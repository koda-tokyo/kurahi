// The gateway's HTTP route table (KoLo 2.0, M4a): declarations only — method, path, auth and
// TypeBox schemas. server-http.ts binds a handler to every operationId and a dispatcher to every
// mount (and refuses to start if one is missing); scripts/openapi-gen.mjs builds the committed
// OpenAPI document from the same table.
import { Type, type TSchema } from "@sinclair/typebox";
import {
  type BoundMount,
  type BoundRoute,
  createHttpRouter,
  defineMount,
  defineRoute,
  type HttpRouter,
  type HttpRouterOptions,
  type MountDefinition,
  type MountHandler,
  type ResponseSpec,
  type RouteDefinition,
  type RouteHandler,
} from "./http-registry.js";
import { IDENTITY_ROUTES } from "./http-routes-identity.js";

const Loose = (properties: Record<string, TSchema>, description?: string) =>
  Type.Object(properties, { additionalProperties: true, ...(description ? { description } : {}) });

const OkTrue = Type.Literal(true);
const IsoTime = Type.String({ description: "ISO-8601 timestamp" });

const BuildInfo = Type.Object({ sha: Type.String(), time: Type.String() });

const DeepHealth = Loose(
  {
    status: Type.Union([
      Type.Literal("healthy"),
      Type.Literal("degraded"),
      Type.Literal("unhealthy"),
    ]),
    readiness: Type.Union([
      Type.Literal("process_up"),
      Type.Literal("gateway_ready"),
      Type.Literal("consciousness_ready"),
      Type.Literal("degraded"),
    ]),
    posture: Type.String({ description: "alive | serviceable | handoff_ready" }),
    lease: Type.Optional(
      Type.Union([Type.Object({ held: Type.Boolean(), holdingMs: Type.Number() }), Type.Null()]),
    ),
    integrity: Type.String({ description: "Boot integrity gate state (ok | disabled | …)" }),
    timestamp: IsoTime,
    uptime: Type.Number(),
    version: Type.String(),
    pid: Type.Integer(),
    startedAt: Type.Optional(
      Type.String({
        description: "When the current gateway instance started; changes on every restart.",
      }),
    ),
    memory: Type.Object({ rss: Type.Number(), heapUsed: Type.Number() }),
    auth: Loose({
      status: Type.String({ description: "ok | expiring | expired | missing" }),
      profiles: Type.Array(Loose({ profileId: Type.String(), provider: Type.String() })),
      providers: Type.Array(Loose({ provider: Type.String(), status: Type.String() })),
    }),
    sessions: Type.Object({ active: Type.Integer(), total: Type.Integer() }),
    v3: Type.Optional(Loose({}, "Present only when gateway.v3.health=true.")),
  },
  "Deep health: readiness, lease, integrity, auth profiles and sessions.",
);

const PublicHealth = Type.Object(
  {
    status: Type.Union([
      Type.Literal("healthy"),
      Type.Literal("degraded"),
      Type.Literal("unhealthy"),
    ]),
    version: Type.String(),
    uptime: Type.Number(),
  },
  { description: "Unauthenticated /health body: status, version, uptime. Nothing else." },
);

const BuildHealth = Type.Object({
  status: Type.Literal("ok"),
  build: BuildInfo,
  time: IsoTime,
});

const MigrateKeyHeaders = Type.Object({
  "X-Migrate-Key": Type.String({ description: "INVITE_SIGNING_KEY" }),
});

const InviteRole = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("member"),
]);

const SessionUser = Loose({
  id: Type.String(),
  email: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  role: Type.String(),
});

const HookWakeBody = Type.Object({
  text: Type.String({ minLength: 1 }),
  mode: Type.Optional(Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")])),
});

const HookAgentBody = Loose({
  message: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String()),
  wakeMode: Type.Optional(Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")])),
  sessionKey: Type.Optional(Type.String()),
  deliver: Type.Optional(Type.Boolean()),
  channel: Type.Optional(Type.String({ description: "Message channel id (last, whatsapp, …)" })),
  to: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Number()),
});

const HookAccepted = Type.Object({ ok: OkTrue, runId: Type.String() });

const ToolsInvokeBody = Loose({
  tool: Type.String({ minLength: 1 }),
  action: Type.Optional(Type.String()),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  sessionKey: Type.Optional(Type.String({ description: "Defaults to the main session." })),
});

const ToolsInvokeHeaders = Type.Object({
  "X-KoLo-Message-Channel": Type.Optional(Type.String({ description: "Channel policy hint" })),
  "X-KoLo-Account-Id": Type.Optional(Type.String({ description: "Account policy hint" })),
});

const AgentHeaders = Type.Object({
  "X-KoLo-Agent-Id": Type.Optional(
    Type.String({ description: "Target agent (else from model `agent:<id>`, else main)" }),
  ),
  "X-KoLo-Session-Key": Type.Optional(Type.String({ description: "Explicit session key" })),
});

const ChatCompletionsBody = Loose(
  {
    model: Type.Optional(Type.String({ description: "`agent:<id>` routes to that agent." })),
    messages: Type.Array(
      Loose({
        role: Type.String(),
        content: Type.Union([Type.String(), Type.Array(Type.Unknown())]),
      }),
    ),
    stream: Type.Optional(Type.Boolean()),
    user: Type.Optional(Type.String({ description: "Stable session per user." })),
  },
  "OpenAI Chat Completions request subset.",
);

const ResponsesBody = Loose(
  {
    model: Type.Optional(Type.String()),
    input: Type.Union([Type.String(), Type.Array(Type.Unknown())]),
    instructions: Type.Optional(Type.String()),
    stream: Type.Optional(Type.Boolean()),
    user: Type.Optional(Type.String()),
  },
  "OpenResponses (OpenAI Responses API) request subset.",
);

const AdminStatus = Type.Object({
  ok: Type.Boolean(),
  mode: Type.Union([Type.Literal("alpha"), Type.Literal("production")]),
  database: Type.Union([
    Type.Literal("connected"),
    Type.Literal("disconnected"),
    Type.Literal("not_configured"),
  ]),
  build: BuildInfo,
  features: Type.Object({
    inviteOnly: Type.Boolean(),
    jpComplianceMode: Type.Boolean(),
    auditLogging: Type.Boolean(),
  }),
});

const AuditQuery = Type.Object({
  userId: Type.Optional(Type.String()),
  action: Type.Optional(Type.String()),
  targetType: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  startDate: Type.Optional(Type.String({ description: "ISO date" })),
  endDate: Type.Optional(Type.String({ description: "ISO date" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  cursor: Type.Optional(Type.String()),
  stats: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
});

const AuditPage = Type.Object({
  ok: Type.Boolean(),
  events: Type.Array(
    Type.Object({
      id: Type.String(),
      timestamp: IsoTime,
      userId: Type.Union([Type.String(), Type.Null()]),
      action: Type.String(),
      targetType: Type.String(),
      targetId: Type.Union([Type.String(), Type.Null()]),
      ipAddress: Type.Union([Type.String(), Type.Null()]),
      metadata: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  stats: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

const WorkspaceList = Type.Object({
  ok: OkTrue,
  workspaces: Type.Array(
    Loose({
      id: Type.String(),
      name: Type.String(),
      tier: Type.Number(),
      jpComplianceMode: Type.Boolean(),
      memberCount: Type.Integer(),
      createdAt: IsoTime,
      updatedAt: IsoTime,
    }),
  ),
});

const UserList = Type.Object({
  ok: Type.Boolean(),
  users: Type.Array(
    Loose({
      id: Type.String(),
      email: Type.String(),
      name: Type.Union([Type.String(), Type.Null()]),
      role: Type.String(),
      workspaces: Type.Array(
        Type.Object({ id: Type.String(), name: Type.String(), role: Type.String() }),
      ),
      createdAt: IsoTime,
      updatedAt: IsoTime,
    }),
  ),
});

const PairScopeSchema = Type.Union([
  Type.Literal("observe"),
  Type.Literal("attach"),
  Type.Literal("admin"),
]);

const SessionAllowlistSchema = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
  maxItems: 32,
  description:
    "Session allowlist (M3b): globs over session keys (`agent:alice:*`), bare agent ids " +
    "(`alice`) or labels (`label:ops`). A credential from this invitation discovers, attaches " +
    "to and drives only matching sessions. Absent = every session.",
});

const PairInvitation = Type.Object({
  id: Type.String(),
  scope: PairScopeSchema,
  label: Type.Optional(Type.String()),
  createdAt: IsoTime,
  expiresAt: IsoTime,
  createdBy: Type.String(),
  autoApprove: Type.Boolean({
    description: "TOFU: the redeeming device key is trusted without a separate approve.",
  }),
  sessions: Type.Optional(SessionAllowlistSchema),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("redeemed"),
    Type.Literal("expired"),
    Type.Literal("revoked"),
  ]),
  redeemedAt: Type.Optional(IsoTime),
  redeemedBy: Type.Optional(Type.String({ description: "Device key fingerprint" })),
  revokedAt: Type.Optional(IsoTime),
});

const PairDeviceStatus = Type.Union([
  Type.Literal("approved"),
  Type.Literal("pending"),
  Type.Literal("revoked"),
  Type.Literal("reconsent"),
]);

const PairDevice = Type.Object({
  fingerprint: Type.String({ description: "SHA-256 of the raw Ed25519 public key, hex" }),
  name: Type.String(),
  scope: PairScopeSchema,
  status: PairDeviceStatus,
  pairedAt: IsoTime,
  approvedAt: Type.Optional(IsoTime),
  approvedBy: Type.Optional(Type.String()),
  lastSeenAt: Type.Optional(IsoTime),
  invitationId: Type.String(),
  sessions: Type.Optional(SessionAllowlistSchema),
  revokedAt: Type.Optional(IsoTime),
  reconsentAt: Type.Optional(IsoTime),
  families: Type.Object({ active: Type.Integer(), total: Type.Integer() }),
});

const PairCredential = Type.Object({
  ok: OkTrue,
  device: Type.Object({
    fingerprint: Type.String(),
    name: Type.String(),
    scope: PairScopeSchema,
    status: PairDeviceStatus,
  }),
  familyId: Type.String(),
  generation: Type.Integer(),
  accessToken: Type.String({ description: "`kpa_…`; Bearer for HTTP and `auth.token` on WS" }),
  accessExpiresAt: IsoTime,
  refreshToken: Type.String({ description: "`kpr_…`; single use, rotated on every refresh" }),
  refreshExpiresAt: IsoTime,
});

const PairProofFields = {
  nonce: Type.String({ description: "From GET /api/pair/nonce; single use" }),
  signature: Type.String({
    description:
      "Ed25519 signature (base64url) by the device key over " +
      "`kolo-pair-v1|<purpose>|<nonce>|<sha256(secret)>`, purpose redeem|refresh, secret = " +
      "the invitation code or the refresh token.",
  }),
};

const PairDenied = Type.Object({
  ok: Type.Literal(false),
  error: Type.String({
    description:
      "invalid_code | code_expired | code_used | code_revoked | invalid_public_key | " +
      "invalid_nonce | invalid_signature | invalid_token | family_revoked | family_expired | " +
      "reuse_detected | device_pending | device_revoked | reconsent_required",
  }),
});

const PairPrincipal = Type.Object({
  ok: OkTrue,
  principal: Type.Union([
    Type.Object({
      kind: Type.Literal("owner"),
      scope: Type.Literal("owner"),
      method: Type.String(),
      user: Type.Optional(Type.String()),
    }),
    Type.Object({
      kind: Type.Literal("pair"),
      scope: PairScopeSchema,
      fingerprint: Type.String(),
      deviceName: Type.String(),
      familyId: Type.String(),
      accessExpiresAt: IsoTime,
      sessions: Type.Optional(SessionAllowlistSchema),
    }),
  ]),
});

const OkFalse = "BadRequest" as const;

const SnapshotFile = Type.Object({
  path: Type.String(),
  existed: Type.Boolean(),
  size: Type.Integer(),
  skipped: Type.Optional(Type.Union([Type.Literal("too-large"), Type.Literal("unreadable")])),
});

const SnapshotSummary = Type.Object({
  id: Type.String(),
  at: IsoTime,
  tool: Type.String(),
  applied: Type.Boolean(),
  files: Type.Array(SnapshotFile),
});

const SnapshotRestoreStep = Type.Object({
  id: Type.String(),
  at: IsoTime,
  tool: Type.String(),
  restored: Type.Array(Type.String()),
  removed: Type.Array(Type.String()),
  skipped: Type.Array(Type.String()),
});

/** Tag order is the reading order of the viewer. */
const T = {
  health: ["health"],
  meta: ["meta"],
  admin: ["admin"],
  auth: ["auth"],
  hooks: ["hooks"],
  tools: ["tools"],
  openai: ["openai-compat"],
  migrate: ["migrate"],
  pairing: ["pairing"],
  sessions: ["sessions"],
  codeMode: ["code-mode"],
  mcp: ["mcp"],
  plugins: ["plugins"],
  jobs: ["jobs"],
  continuity: ["continuity"],
  evidence: ["evidence"],
  factory: ["factory"],
  memory: ["memory"],
  audit: ["audit"],
  policy: ["policy"],
  channels: ["channels"],
};

// M13: policy status and the kill switch. Status is the engine's view (mode, attestation,
// runtime kill state, budget pauses); kill/release take `{agent}` or `{all: true}`.
const PolicyStatusHttp = Loose({
  mode: Type.String({ description: "enforce | audit | off" }),
  loaded: Type.Boolean(),
  path: Type.String(),
  name: Type.Optional(Type.String()),
  sha256: Type.Optional(Type.String()),
  attestation: Type.Optional(
    Type.String({ description: "signed | unsigned | invalid | untrusted | no-owners" }),
  ),
  attestedBy: Type.Optional(Type.String({ description: "Owner key id." })),
  loadedAt: Type.Optional(IsoTime),
  refusedReason: Type.Optional(Type.String()),
  warnings: Type.Array(Type.String()),
  kill: Loose({
    fleet: Type.Union([Loose({ by: Type.String(), at: IsoTime }), Type.Null()]),
    agents: Type.Record(Type.String(), Loose({ by: Type.String(), at: IsoTime })),
  }),
  paused: Type.Record(Type.String(), Loose({ since: IsoTime, rule: Type.String() })),
  fleetPaused: Type.Union([Loose({ since: IsoTime, rule: Type.String() }), Type.Null()]),
});

const PolicyFlipBody = Type.Object(
  {
    agent: Type.Optional(Type.String({ description: "Agent id; omit with all: true." })),
    all: Type.Optional(Type.Boolean({ description: "The whole fleet." })),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

// M11: the continuity manifest — hashes and small structured values only, never file contents.
const ContinuityManifestEntry = Loose({
  kind: Type.String({
    description: "identity | memory | role | model | job | session | transcript | audit",
  }),
  name: Type.String({ description: "Workspace-relative path, job id, session key or label." }),
  sha256: Type.Optional(Type.String()),
  size: Type.Optional(Type.Integer()),
  value: Type.Optional(Loose({})),
  hash: Type.String({ description: "sha256(prevHash + canonical entry); chains the manifest." }),
});

const ContinuityManifest = Loose(
  {
    version: Type.Integer(),
    resident: Type.String(),
    createdAt: IsoTime,
    gatewayVersion: Type.Optional(Type.String()),
    counts: Type.Record(Type.String(), Type.Integer()),
    entries: Type.Array(ContinuityManifestEntry),
    root: Type.String({ description: "Head of the entry hash chain." }),
    signer: Type.Object({
      alg: Type.Literal("ed25519"),
      keyId: Type.String({ description: "SHA-256 of the raw public key, hex." }),
      publicKey: Type.String({ description: "Raw Ed25519 public key, base64url." }),
    }),
    signature: Type.String({ description: "Ed25519 over the manifest signing input, base64url." }),
  },
  "Signed, hash-chained snapshot of a resident (identity, memory, role, jobs, sessions, audit).",
);

const RecallHit = Type.Object({
  path: Type.String({ description: "Memory file, relative to the workspace." }),
  line: Type.Integer(),
  score: Type.Integer({ description: "Distinct query terms found on the line." }),
  snippet: Type.String(),
});

const AuditAnchor = Type.Object({ seq: Type.Integer(), hash: Type.String() });

const JobRecordHttp = Loose(
  {
    id: Type.String(),
    agent: Type.String(),
    sessionKey: Type.String(),
    kind: Type.String(),
    status: Type.String({
      description: "queued | running | succeeded | failed | cancelled | loop_stopped | denied",
    }),
    steps: Type.Integer(),
    toolCalls: Type.Integer(),
    startedAt: IsoTime,
    endedAt: Type.Optional(IsoTime),
    error: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    parentJobId: Type.Optional(
      Type.String({ description: "Parent job id for bridged child jobs." }),
    ),
  },
  "One agent-run job.",
);

const JobNotFound: ResponseSpec = {
  description: "Unknown job id.",
  schema: Loose({ ok: Type.Literal(false), error: Type.String() }),
};

// M12: evidence of one job — a hash-chained event log, signed at job end.
const EvidenceUsage = Loose({
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
  cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()),
  total: Type.Optional(Type.Number()),
});
const EvidenceSummary = Loose(
  {
    jobId: Type.String(),
    agent: Type.String(),
    sessionKey: Type.String(),
    kind: Type.String(),
    status: Type.String(),
    startedAt: IsoTime,
    endedAt: Type.Union([IsoTime, Type.Null()]),
    durationMs: Type.Union([Type.Number(), Type.Null()]),
    events: Type.Integer(),
    modelTurns: Type.Integer(),
    toolCalls: Type.Integer(),
    toolErrors: Type.Integer(),
    filesChanged: Type.Array(Type.String()),
    tools: Type.Record(Type.String(), Type.Integer()),
    usage: EvidenceUsage,
    permissions: Type.Object({ allowed: Type.Integer(), denied: Type.Integer() }),
    loopStops: Type.Integer(),
    auditSeqs: Type.Array(Type.Integer()),
    promptDigest: Type.Union([Type.String(), Type.Null()]),
    promptChars: Type.Union([Type.Integer(), Type.Null()]),
    finalTextDigest: Type.Union([Type.String(), Type.Null()]),
    finalTextExcerpt: Type.Union([Type.String(), Type.Null()]),
    error: Type.Union([Type.String(), Type.Null()]),
    truncated: Type.Boolean(),
    signed: Type.Boolean(),
  },
  "Counts and digests derived from the event log.",
);
const EvidenceSigner = Type.Object({
  alg: Type.Literal("ed25519"),
  keyId: Type.String({ description: "SHA-256 of the raw public key, hex." }),
  publicKey: Type.String({ description: "Raw public key, base64url." }),
});
const EvidenceManifest = Loose(
  {
    version: Type.Literal(1),
    jobId: Type.String(),
    agent: Type.String(),
    sessionKey: Type.String(),
    kind: Type.String(),
    status: Type.String(),
    startedAt: IsoTime,
    endedAt: IsoTime,
    createdAt: IsoTime,
    gatewayVersion: Type.Optional(Type.String()),
    events: Type.Object({
      count: Type.Integer(),
      root: Type.String({ description: "Hash of the last event (chain head)." }),
      truncated: Type.Boolean(),
    }),
    files: Type.Record(Type.String(), Type.Object({ sha256: Type.String(), size: Type.Integer() })),
    signer: EvidenceSigner,
    signature: Type.String({ description: "Ed25519 over the manifest signing input, base64url." }),
  },
  "Signed manifest; null while the job is still running.",
);
const EvidenceEvent = Loose(
  {
    seq: Type.Integer(),
    ts: IsoTime,
    type: Type.String({
      description:
        "job.start | model.turn | tool.call | tool.result | snapshot | permission | loop_guard | audit | truncated | job.end",
    }),
    jobId: Type.String(),
    data: Loose({}),
    prev: Type.String({ description: "Hash of the previous event; 64 zeros for the first." }),
    hash: Type.String({ description: "sha256(prev + newline + canonical JSON of the event)." }),
  },
  "One line of events.jsonl.",
);
const EvidenceNotFound: ResponseSpec = {
  description:
    "Unknown job id, no evidence recorded, or the job is outside the credential's sessions.",
  schema: Loose({ ok: Type.Literal(false), error: Type.String() }),
};

// M15: the factory — boards of cards, each a goal on its way to a reviewed pull request.
const FactoryColumn = Type.String({
  description: "inbox | spec | build | review | ready | merged | failed",
});

const FactoryTimelineEntry = Loose(
  {
    seq: Type.Integer(),
    ts: IsoTime,
    kind: Type.String({
      description: "created | moved | comment | run | engine | job | evidence | pr | merge | error",
    }),
    by: Type.String({ description: "Resident id, owner:…, device:…, runner or engine." }),
    text: Type.String(),
    data: Type.Optional(Loose({})),
  },
  "One timeline entry of a card.",
);

const FactoryPullRequest = Loose({
  url: Type.String(),
  number: Type.Optional(Type.Integer()),
  branch: Type.String(),
  base: Type.Optional(Type.String()),
  openedAt: IsoTime,
});

const FactoryCardFields = {
  id: Type.String(),
  boardId: Type.String(),
  title: Type.String(),
  goal: Type.String(),
  repo: Type.String({ description: "Absolute path of the git checkout on the gateway host." }),
  owner: Type.String({ description: "Resident (agent id) that owns the card." }),
  column: FactoryColumn,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  engineTaskId: Type.Union([Type.String(), Type.Null()]),
  branch: Type.Union([Type.String(), Type.Null()]),
  jobIds: Type.Array(Type.String({ description: "Jobs that ran for this card." })),
  evidenceIds: Type.Array(Type.String({ description: "Job ids with an evidence log." })),
  pr: Type.Union([FactoryPullRequest, Type.Null()]),
  policy: Loose({ autoMerge: Type.Boolean() }),
  runningJobId: Type.Union([Type.String(), Type.Null()]),
  summary: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
};

const FactoryCardSummary = Loose(
  {
    ...FactoryCardFields,
    timelineLength: Type.Integer(),
    lastEntry: Type.Union([FactoryTimelineEntry, Type.Null()]),
  },
  "A card without its timeline.",
);

const FactoryCard = Loose(
  { ...FactoryCardFields, timeline: Type.Array(FactoryTimelineEntry) },
  "A card with its full timeline.",
);

const FactoryBoard = Loose({
  id: Type.String(),
  name: Type.String(),
  repo: Type.Union([Type.String(), Type.Null()]),
  columns: Type.Array(FactoryColumn),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  counts: Type.Record(Type.String(), Type.Integer(), {
    description: "Cards per column on this board.",
  }),
});

const FactoryCardNotFound: ResponseSpec = {
  description: "Unknown card id.",
  schema: Loose({ ok: Type.Literal(false), error: Type.String() }),
};

const FactoryError = Loose({
  ok: Type.Literal(false),
  error: Type.String(),
  code: Type.Optional(Type.String()),
});

// M7: live plugin state as the gateway runs it (not a fresh load from disk).
const PluginStatusRow = Type.Object({
  id: Type.String(),
  name: Type.String(),
  version: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  origin: Type.Union([
    Type.Literal("bundled"),
    Type.Literal("global"),
    Type.Literal("workspace"),
    Type.Literal("config"),
  ]),
  source: Type.String(),
  enabled: Type.Boolean(),
  status: Type.Union([Type.Literal("loaded"), Type.Literal("disabled"), Type.Literal("error")]),
  error: Type.Optional(Type.String()),
  quarantined: Type.Boolean({
    description: "The last load threw; the plugin is listed with its error and never run.",
  }),
  loadedAt: Type.Optional(Type.Number()),
  reloads: Type.Integer(),
  watched: Type.Boolean(),
  tools: Type.Array(Type.String()),
  services: Type.Array(Type.String()),
  runningServices: Type.Array(Type.String()),
  gatewayMethods: Type.Array(Type.String()),
  httpRoutes: Type.Integer(),
  hooks: Type.Integer(),
  resources: Type.Integer({ description: "Timers/listeners/servers held through api.lifecycle." }),
});

const PluginReloadResult = Type.Object({
  id: Type.String(),
  ok: Type.Boolean(),
  status: Type.Union([Type.Literal("loaded"), Type.Literal("disabled"), Type.Literal("error")]),
  error: Type.Optional(Type.String()),
  reloads: Type.Integer(),
  durationMs: Type.Integer(),
});

const SessionState = Type.Union([Type.Literal("running"), Type.Literal("idle")]);

const SessionDiscoveryRow = Type.Object({
  id: Type.String({ description: "Transcript session id when known, else the session key." }),
  key: Type.String({ description: "Session key (`agent:<id>:<rest>`)." }),
  agent: Type.String(),
  kind: Type.Union([
    Type.Literal("direct"),
    Type.Literal("group"),
    Type.Literal("global"),
    Type.Literal("unknown"),
  ]),
  label: Type.Optional(Type.String()),
  displayName: Type.Optional(Type.String()),
  channel: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  started: Type.Union([IsoTime, Type.Null()]),
  lastActivity: Type.Union([IsoTime, Type.Null()]),
  clients: Type.Integer({ description: "Clients attached through `session.attach`." }),
  state: SessionState,
});

const SessionAttachment = Type.Object({
  connId: Type.String(),
  key: Type.String(),
  mode: Type.Union([Type.Literal("interact"), Type.Literal("follow"), Type.Literal("pipe")]),
  since: IsoTime,
  client: Type.Object({
    id: Type.String(),
    mode: Type.Optional(Type.String()),
    displayName: Type.Optional(Type.String()),
  }),
  identity: Type.String(),
  scope: Type.String(),
});

const SessionDiscoveryDetail = Type.Intersect([
  SessionDiscoveryRow,
  Type.Object({ attachments: Type.Array(SessionAttachment) }),
]);

const SessionsQuery = Type.Object({
  agent: Type.Optional(Type.String({ description: "Only this agent's sessions" })),
  search: Type.Optional(Type.String({ description: "Substring over key/label/display name" })),
  activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
  includeGlobal: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })),
});

const CodeModeRunBody = Type.Object({
  script: Type.String({
    minLength: 1,
    description: "Body of an async function; use await/return.",
  }),
  language: Type.Optional(
    Type.Union([Type.Literal("js"), Type.Literal("ts")], { description: "Default: detect." }),
  ),
  sessionKey: Type.Optional(
    Type.String({ description: "Session whose agent and tool policy apply (default: main)." }),
  ),
  allowTools: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      maxItems: 256,
      description: "Globs over tool ids this run may call (e.g. `read_file`, `mcp:docs:*`).",
    }),
  ),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
  maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
});

const CodeModeCall = Type.Object({
  seq: Type.Integer(),
  tool: Type.String(),
  ok: Type.Boolean(),
  ms: Type.Integer(),
  error: Type.Optional(Type.String()),
});

const CodeModeRunResponse = Type.Object({
  ok: Type.Boolean(),
  runId: Type.String(),
  value: Type.Optional(Type.Unknown()),
  error: Type.Optional(
    Type.Object({
      code: Type.String(),
      message: Type.String(),
      stack: Type.Optional(Type.String()),
    }),
  ),
  calls: Type.Array(CodeModeCall),
  toolCalls: Type.Integer(),
  logs: Type.Array(Type.Object({ level: Type.String(), text: Type.String() })),
  logsTruncated: Type.Boolean(),
  durationMs: Type.Integer(),
  tools: Type.Array(Type.String(), { description: "Tool ids the script could call." }),
});

const McpToolInfo = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String()),
  inputSchema: Type.Record(Type.String(), Type.Unknown()),
  exposed: Type.Boolean(),
  execLike: Type.Boolean(),
  reason: Type.Optional(Type.String()),
});

const McpServerStatus = Type.Object({
  id: Type.String(),
  transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
  target: Type.String(),
  enabled: Type.Boolean(),
  state: Type.Union([
    Type.Literal("stopped"),
    Type.Literal("connecting"),
    Type.Literal("ready"),
    Type.Literal("error"),
    Type.Literal("backoff"),
  ]),
  serverName: Type.Optional(Type.String()),
  serverVersion: Type.Optional(Type.String()),
  tools: Type.Array(McpToolInfo),
  resources: Type.Array(
    Type.Object({
      uri: Type.String(),
      name: Type.Optional(Type.String()),
      mimeType: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
  ),
  prompts: Type.Array(
    Type.Object({
      name: Type.String(),
      description: Type.Optional(Type.String()),
      arguments: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  restarts: Type.Integer(),
  lastError: Type.Optional(Type.String()),
  nextRetryAt: Type.Optional(IsoTime),
  connectedAt: Type.Optional(IsoTime),
});

export const GATEWAY_ROUTES: readonly RouteDefinition[] = [
  defineRoute({
    method: "GET",
    path: "/health",
    operationId: "getHealth",
    summary: "Health and readiness",
    description:
      "Liveness probe. Without a credential the body is {status, version, uptime}; with a " +
      "Bearer credential of at least the observe scope it is the full readiness picture " +
      "(lease, integrity, auth profiles, sessions). 200 for healthy or degraded (key on " +
      "`status`), 503 when unhealthy. Dispatched before the credential gates.",
    tags: T.health,
    auth: "none",
    stage: "pre-auth",
    responses: {
      200: {
        description: "Healthy or degraded. Public body without a credential; DeepHealth with one.",
        schema: Type.Union([PublicHealth, DeepHealth]),
      },
      405: "MethodNotAllowed",
      503: { description: "Unhealthy.", schema: Type.Union([PublicHealth, DeepHealth]) },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/health",
    operationId: "getBuildHealth",
    summary: "Lightweight build probe",
    tags: T.health,
    auth: "none",
    stage: "pre-auth",
    responses: {
      200: { description: "Build info.", schema: BuildHealth },
      405: "MethodNotAllowed",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/metrics",
    operationId: "getMetrics",
    summary: "Prometheus metrics",
    tags: T.admin,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    responses: {
      200: {
        description: "Prometheus text exposition format 0.0.4.",
        contentType: "text/plain; version=0.0.4",
        schema: Type.String(),
      },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/doc",
    operationId: "getOpenApiDocument",
    summary: "This OpenAPI document",
    description:
      "Live copy generated from the route registry, including plugin webhooks registered at " +
      "runtime and the WebSocket protocol (x-kolo-websocket).",
    tags: T.meta,
    auth: ["gateway-token", "pair-credential"],
    responses: {
      200: { description: "OpenAPI 3.1 document.", schema: Loose({ openapi: Type.String() }) },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/doc/",
    operationId: "getApiViewer",
    summary: "Minimal HTML viewer for /doc",
    description:
      "Static page (no data, no external assets). It asks for the gateway token and fetches " +
      "GET /doc with it.",
    tags: T.meta,
    auth: "none",
    responses: {
      200: { description: "HTML page.", contentType: "text/html", schema: Type.String() },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/migrate",
    operationId: "runDatabaseMigration",
    summary: "Apply the invite-flow database schema",
    tags: T.migrate,
    auth: "migrate-key",
    authEnforcedBy: "handler",
    request: { headers: MigrateKeyHeaders },
    responses: {
      200: {
        description: "Migration applied.",
        schema: Type.Object({
          ok: OkTrue,
          message: Type.String(),
          tables: Type.Array(Type.String()),
        }),
      },
      403: "Forbidden",
      500: {
        description: "DATABASE_URL missing or migration failed.",
        schema: Loose({ ok: Type.Literal(false) }),
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/bootstrap-invite",
    operationId: "createBootstrapInvite",
    summary: "Create the first owner invite",
    tags: T.migrate,
    auth: "migrate-key",
    authEnforcedBy: "handler",
    request: {
      headers: MigrateKeyHeaders,
      body: Type.Object({ email: Type.String(), role: Type.Optional(InviteRole) }),
    },
    responses: {
      201: {
        description: "Invite created; the token is returned once.",
        schema: Type.Object({
          ok: OkTrue,
          message: Type.String(),
          email: Type.String(),
          role: Type.String(),
          expiresAt: IsoTime,
          inviteUrl: Type.String(),
          token: Type.String(),
        }),
      },
      400: OkFalse,
      403: "Forbidden",
      500: {
        description: "Database not configured or insert failed.",
        schema: Loose({ ok: Type.Literal(false) }),
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/hooks/wake",
    operationId: "hookWake",
    summary: "Queue a system wake event",
    description: "Base path is `hooks.path` (default /hooks); enabled by `hooks.enabled`.",
    tags: T.hooks,
    auth: "hook-token",
    authEnforcedBy: "handler",
    servedBy: "hooks",
    request: { body: HookWakeBody },
    responses: {
      200: {
        description: "Queued.",
        schema: Type.Object({ ok: OkTrue, mode: Type.String() }),
      },
      400: OkFalse,
      401: {
        description: "Missing or wrong hook token.",
        contentType: "text/plain",
        schema: Type.String(),
      },
      413: "PayloadTooLarge",
    },
    extensions: { "x-kolo-path-prefix-config": "hooks.path" },
  }),
  defineRoute({
    method: "POST",
    path: "/hooks/agent",
    operationId: "hookAgent",
    summary: "Run an agent turn from a webhook",
    tags: T.hooks,
    auth: "hook-token",
    authEnforcedBy: "handler",
    servedBy: "hooks",
    request: { body: HookAgentBody },
    responses: {
      202: { description: "Accepted; the run continues asynchronously.", schema: HookAccepted },
      400: OkFalse,
      401: {
        description: "Missing or wrong hook token.",
        contentType: "text/plain",
        schema: Type.String(),
      },
      413: "PayloadTooLarge",
    },
    extensions: { "x-kolo-path-prefix-config": "hooks.path" },
  }),
  defineRoute({
    method: "POST",
    path: "/hooks/{mapping}",
    operationId: "hookMapped",
    summary: "Mapped hook (hooks.mappings) → wake or agent action",
    tags: T.hooks,
    auth: "hook-token",
    authEnforcedBy: "handler",
    servedBy: "hooks",
    request: {
      params: Type.Object({ mapping: Type.String({ description: "Mapping path" }) }),
      body: Type.Record(Type.String(), Type.Unknown()),
    },
    responses: {
      200: {
        description: "Wake action queued.",
        schema: Type.Object({ ok: OkTrue, mode: Type.String() }),
      },
      202: { description: "Agent action accepted.", schema: HookAccepted },
      204: { description: "Mapping matched and chose no action." },
      400: OkFalse,
      401: {
        description: "Missing or wrong hook token.",
        contentType: "text/plain",
        schema: Type.String(),
      },
      404: "NotFound",
      500: { description: "Mapping transform failed.", schema: Loose({ ok: Type.Literal(false) }) },
    },
    extensions: { "x-kolo-path-prefix-config": "hooks.path" },
  }),
  defineRoute({
    method: "POST",
    path: "/tools/invoke",
    operationId: "invokeTool",
    summary: "Invoke one agent tool under the session's tool policy",
    tags: T.tools,
    auth: ["gateway-token", "pair-credential"],
    request: { headers: ToolsInvokeHeaders, body: ToolsInvokeBody },
    responses: {
      200: {
        description: "Tool result.",
        schema: Type.Object({ ok: OkTrue, result: Type.Unknown() }),
      },
      400: {
        description: "Invalid body or tool error.",
        schema: Loose({ ok: Type.Literal(false) }),
      },
      403: {
        description: "Blocked by tool policy or backend capability.",
        schema: Loose({ ok: Type.Literal(false) }),
      },
      404: { description: "Tool not available.", schema: Loose({ ok: Type.Literal(false) }) },
      405: "MethodNotAllowed",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/admin/covenants",
    operationId: "listCovenants",
    summary: "List user covenants (Control Room)",
    tags: T.admin,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    responses: {
      200: {
        description: "Covenant index (currently always empty).",
        schema: Type.Object({
          ok: OkTrue,
          covenants: Type.Array(
            Type.Object({ userId: Type.String(), userName: Type.Optional(Type.String()) }),
          ),
        }),
      },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/admin/covenants/{userId}",
    operationId: "getCovenant",
    summary: "Covenant summary for one user (created with defaults if missing)",
    tags: T.admin,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    request: { params: Type.Object({ userId: Type.String() }) },
    responses: {
      200: {
        description: "Covenant summary.",
        schema: Type.Object({
          ok: OkTrue,
          userId: Type.String(),
          covenant: Loose({}),
          raw: Type.Optional(
            Type.Object({ id: Type.String(), createdAt: IsoTime, updatedAt: IsoTime }),
          ),
        }),
      },
      400: OkFalse,
      500: { description: "Covenant store failed.", schema: Loose({ ok: Type.Literal(false) }) },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/admin/invites",
    operationId: "createInvite",
    summary: "Create an invite (admin session)",
    tags: T.admin,
    auth: "session-admin",
    authEnforcedBy: "handler",
    request: {
      body: Type.Object({
        email: Type.String({ format: "email" }),
        workspaceId: Type.String({ format: "uuid" }),
        role: Type.Optional(InviteRole),
      }),
    },
    responses: {
      201: {
        description: "Invite created.",
        schema: Type.Object({ ok: OkTrue, invite: Loose({ id: Type.String() }) }),
      },
      400: OkFalse,
      401: { description: "No session.", schema: Loose({ ok: Type.Literal(false) }) },
      403: "Forbidden",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/admin/invites",
    operationId: "listInvites",
    summary: "List pending invites of a workspace (admin session)",
    tags: T.admin,
    auth: "session-admin",
    authEnforcedBy: "handler",
    request: { query: Type.Object({ workspaceId: Type.String() }) },
    responses: {
      200: {
        description: "Pending invites.",
        schema: Type.Object({ ok: OkTrue, invites: Type.Array(Loose({ id: Type.String() })) }),
      },
      400: OkFalse,
      401: { description: "No session.", schema: Loose({ ok: Type.Literal(false) }) },
      403: "Forbidden",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/admin/status",
    operationId: "getAdminStatus",
    summary: "System status (database, build, features)",
    tags: T.admin,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    responses: { 200: { description: "Status.", schema: AdminStatus }, 405: "MethodNotAllowed" },
  }),
  defineRoute({
    method: "GET",
    path: "/api/admin/audit",
    operationId: "listAuditEvents",
    summary: "Audit log page with filters",
    tags: T.admin,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    request: { query: AuditQuery },
    responses: {
      200: { description: "Audit events.", schema: AuditPage },
      500: { description: "Query failed.", schema: Loose({ ok: Type.Literal(false) }) },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/jobs",
    operationId: "listJobs",
    summary: "List agent-run jobs (newest first)",
    description:
      "Every agent run is a job: embedded runner turns, cron lane tasks and sibling A2A turns. Filter by agent id, status, and limit.",
    tags: T.jobs,
    auth: ["gateway-token", "session-admin"],
    request: {
      query: Type.Object({
        agent: Type.Optional(Type.String({ description: "Filter by agent id." })),
        status: Type.Optional(
          Type.String({
            description:
              "queued | running | succeeded | failed | cancelled | loop_stopped | denied",
          }),
        ),
        limit: Type.Optional(
          Type.String({ description: "Max jobs to return (1-500, default 100)." }),
        ),
      }),
    },
    responses: {
      200: {
        description: "Jobs, newest first.",
        schema: Type.Object({ ok: OkTrue, jobs: Type.Array(JobRecordHttp) }),
      },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/jobs/{id}",
    operationId: "getJob",
    summary: "Fetch one agent-run job",
    tags: T.jobs,
    auth: ["gateway-token", "session-admin"],
    request: { params: Type.Object({ id: Type.String() }) },
    responses: {
      200: {
        description: "The job.",
        schema: Type.Object({ ok: OkTrue, job: JobRecordHttp }),
      },
      404: JobNotFound,
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/jobs/{id}/cancel",
    operationId: "cancelJob",
    summary: "Cancel a queued or running job",
    description:
      "Aborts the underlying agent run and audits job.cancelled. Already-finished jobs return ok=false with a reason.",
    tags: T.jobs,
    auth: ["gateway-token", "session-admin"],
    request: { params: Type.Object({ id: Type.String() }) },
    responses: {
      200: {
        description: "Cancel result.",
        schema: Loose({
          ok: Type.Boolean(),
          job: Type.Optional(JobRecordHttp),
          reason: Type.Optional(Type.String({ description: "not_found | already_finished" })),
        }),
      },
      404: JobNotFound,
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/jobs/{id}/evidence",
    operationId: "getJobEvidence",
    summary: "Evidence summary and signed manifest of one job",
    description:
      "Every job records a hash-chained event log (model turns, tool calls, file snapshots, " +
      "permission decisions, loop-guard verdicts, audit links) under KOLO_HOME/evidence/<jobId>, " +
      "signed at job end with the gateway's continuity key. Prompts and assistant text are " +
      "digests unless evidence.includePrompts is on; arguments and results are redacted and bounded.",
    tags: T.evidence,
    auth: ["gateway-token", "pair-credential", "session-admin", "sso-session"],
    minScope: "attach",
    request: { params: Type.Object({ id: Type.String() }) },
    responses: {
      200: {
        description: "Summary derived from the events, and the manifest when the job has ended.",
        schema: Type.Object({
          ok: OkTrue,
          job: Type.String(),
          summary: EvidenceSummary,
          manifest: Type.Union([EvidenceManifest, Type.Null()]),
        }),
      },
      404: EvidenceNotFound,
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/jobs/{id}/evidence/events",
    operationId: "listJobEvidenceEvents",
    summary: "Page through a job's evidence events",
    tags: T.evidence,
    auth: ["gateway-token", "pair-credential", "session-admin", "sso-session"],
    minScope: "attach",
    request: {
      params: Type.Object({ id: Type.String() }),
      query: Type.Object({
        from: Type.Optional(
          Type.String({ description: "First seq to return (1-based, default 1)." }),
        ),
        limit: Type.Optional(Type.String({ description: "Events per page (1-500, default 100)." })),
      }),
    },
    responses: {
      200: {
        description: "A page of events in seq order; `next` is the seq to ask for next, or null.",
        schema: Type.Object({
          ok: OkTrue,
          job: Type.String(),
          from: Type.Integer(),
          count: Type.Integer(),
          total: Type.Integer(),
          next: Type.Union([Type.Integer(), Type.Null()]),
          events: Type.Array(EvidenceEvent),
        }),
      },
      400: "BadRequest",
      404: EvidenceNotFound,
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/policy/status",
    operationId: "getPolicyStatus",
    summary: "Policy engine status",
    description:
      "Mode, attestation of the loaded policy.yaml, the runtime kill switch and budget pauses (M13).",
    tags: T.policy,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "observe",
    responses: {
      200: {
        description: "Policy status.",
        schema: Type.Object({ ok: OkTrue, status: PolicyStatusHttp }),
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/jobs/{id}/evidence/export",
    operationId: "exportJobEvidence",
    summary: "Write a signed evidence bundle for a finished job",
    description:
      "The bundle (manifest.json, events.jsonl, audit-slice.jsonl, snapshots/, REPORT.md) is " +
      "written under KOLO_HOME/evidence-exports on the gateway host; the response carries its " +
      "path and manifest. Verify it anywhere with `kurahi evidence verify`.",
    tags: T.evidence,
    auth: ["gateway-token", "pair-credential", "session-admin", "sso-session"],
    minScope: "admin",
    request: {
      params: Type.Object({ id: Type.String() }),
      body: Type.Object({
        format: Type.Optional(
          Type.Union([Type.Literal("zip"), Type.Literal("dir")], { description: "Default zip." }),
        ),
      }),
    },
    responses: {
      200: {
        description: "Bundle written.",
        schema: Type.Object({
          ok: OkTrue,
          job: Type.String(),
          path: Type.String(),
          format: Type.Union([Type.Literal("zip"), Type.Literal("dir")]),
          bytes: Type.Integer(),
          files: Type.Array(Type.String()),
          manifest: EvidenceManifest,
        }),
      },
      400: "BadRequest",
      404: EvidenceNotFound,
      409: {
        description: "The job has not ended; there is no signed manifest to export yet.",
        schema: Loose({ ok: Type.Literal(false), error: Type.String() }),
      },
      500: "InternalError",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/evidence/{id}",
    operationId: "getEvidenceView",
    summary: "Read-only HTML timeline of a job's evidence",
    description:
      "Static page (no scripts, no external assets) rendered from the same events as " +
      "GET /api/jobs/{id}/evidence/events, with the job's state after each step.",
    tags: T.evidence,
    auth: ["gateway-token", "pair-credential", "session-admin", "sso-session"],
    minScope: "attach",
    request: { params: Type.Object({ id: Type.String() }) },
    responses: {
      200: { description: "HTML page.", contentType: "text/html", schema: Type.String() },
      404: EvidenceNotFound,
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/policy/kill",
    operationId: "killPolicy",
    summary: "Stop one agent or the fleet",
    description:
      "Flips the runtime kill switch: running jobs are aborted, new jobs, model calls, tool calls " +
      "and channel deliveries for the target are refused until release. Owner or admin; the " +
      "policy's kill.mayFlip can narrow it to owner. Audited as policy.kill.",
    tags: T.policy,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "admin",
    request: { body: PolicyFlipBody, bodyRequired: true },
    responses: {
      200: {
        description: "Switch flipped.",
        schema: Loose({
          ok: OkTrue,
          agent: Type.Union([Type.String(), Type.Null()]),
          jobsAborted: Type.Integer(),
          status: PolicyStatusHttp,
        }),
      },
      400: "BadRequest",
      403: "Forbidden",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/policy/release",
    operationId: "releasePolicy",
    summary: "Release one agent or the fleet",
    description:
      "Clears the runtime kill switch (and any budget pause) for the target. Audited as policy.release.",
    tags: T.policy,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "admin",
    request: { body: PolicyFlipBody, bodyRequired: true },
    responses: {
      200: {
        description: "Switch released.",
        schema: Loose({
          ok: OkTrue,
          agent: Type.Union([Type.String(), Type.Null()]),
          released: Type.Boolean(),
          status: PolicyStatusHttp,
        }),
      },
      400: "BadRequest",
      403: "Forbidden",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/factory/boards",
    operationId: "listFactoryBoards",
    summary: "Factory boards with card counts per column",
    description:
      "The factory turns a goal into a reviewed pull request: a card moves inbox → spec → build → " +
      "review → ready → merged (or failed) as the KIP engine works; every card links its jobs, " +
      "evidence logs and pull request. Boards live under KOLO_HOME/factory.",
    tags: T.factory,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "attach",
    responses: {
      200: {
        description: "Boards.",
        schema: Type.Object({ ok: OkTrue, boards: Type.Array(FactoryBoard) }),
      },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/factory/cards",
    operationId: "listFactoryCards",
    summary: "List factory cards (most recently updated first)",
    tags: T.factory,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "attach",
    request: {
      query: Type.Object({
        board: Type.Optional(Type.String({ description: "Board id." })),
        column: Type.Optional(FactoryColumn),
        owner: Type.Optional(Type.String({ description: "Owner resident id." })),
        limit: Type.Optional(Type.String({ description: "Max cards (1-1000, default 200)." })),
      }),
    },
    responses: {
      200: {
        description: "Cards without their timelines.",
        schema: Type.Object({ ok: OkTrue, cards: Type.Array(FactoryCardSummary) }),
      },
      400: "BadRequest",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/factory/cards",
    operationId: "createFactoryCard",
    summary: "Create a factory card in the inbox",
    tags: T.factory,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "admin",
    request: {
      body: Type.Object({
        goal: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        repo: Type.Optional(
          Type.String({ description: "Absolute path (default: the board's repository)." }),
        ),
        board: Type.Optional(
          Type.String({ description: "Board id (default: factory.defaultBoard)." }),
        ),
        owner: Type.Optional(
          Type.String({ description: "Owner resident (default: the default agent)." }),
        ),
        autoMerge: Type.Optional(
          Type.Boolean({
            description:
              "Merge through the engine when ready; still needs the merge permission. Default false.",
          }),
        ),
        run: Type.Optional(Type.Boolean({ description: "Start the engine run at once." })),
      }),
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "The new card (with its timeline).",
        schema: Type.Object({
          ok: OkTrue,
          card: FactoryCard,
          jobId: Type.Optional(
            Type.String({ description: "Present when run=true started a job." }),
          ),
        }),
      },
      400: { description: "Invalid input.", schema: FactoryError },
      409: { description: "run=true but the engine is not configured.", schema: FactoryError },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/factory/cards/{id}",
    operationId: "getFactoryCard",
    summary: "One factory card with its timeline",
    tags: T.factory,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "attach",
    request: { params: Type.Object({ id: Type.String() }) },
    responses: {
      200: {
        description: "The card.",
        schema: Type.Object({
          ok: OkTrue,
          card: FactoryCard,
          running: Type.Boolean({ description: "A run is in progress in this gateway." }),
        }),
      },
      404: FactoryCardNotFound,
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/factory/cards/{id}/move",
    operationId: "moveFactoryCard",
    summary: "Move a card to another column (audited; the state machine decides)",
    description:
      "Allowed moves: inbox→spec, spec→build|inbox, build→review|spec, review→ready|build, " +
      "ready→merged|review, any non-terminal→failed, failed→inbox. A move to merged records that " +
      "the owner merged the result outside the engine.",
    tags: T.factory,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "admin",
    request: {
      params: Type.Object({ id: Type.String() }),
      body: Type.Object({ to: FactoryColumn, reason: Type.Optional(Type.String()) }),
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "The card after the move.",
        schema: Type.Object({ ok: OkTrue, card: FactoryCard }),
      },
      400: { description: "Unknown column.", schema: FactoryError },
      404: FactoryCardNotFound,
      409: { description: "The state machine refuses the move.", schema: FactoryError },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/factory/cards/{id}/run",
    operationId: "runFactoryCard",
    summary: "Run a card on the KIP engine",
    description:
      "Starts a job (kind factory) that creates an engine task for the card's goal, follows its " +
      "events into the card timeline and the job's evidence log, and moves the card through the " +
      "columns. On ready, a pull request is opened when factory.github is enabled; otherwise the " +
      "ready branch stays in the repository. Merging happens only with the card's autoMerge " +
      "policy and the merge permission.",
    tags: T.factory,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "admin",
    request: {
      params: Type.Object({ id: Type.String() }),
      body: Type.Object({
        profile: Type.Optional(Type.String({ description: "Engine profile override." })),
        merge: Type.Optional(
          Type.Boolean({
            description:
              "Allow the auto-merge gate for this run (owner credentials only; the card policy must also allow it).",
          }),
        ),
      }),
    },
    responses: {
      200: {
        description: "Run started.",
        schema: Type.Object({ ok: OkTrue, jobId: Type.String(), card: FactoryCardSummary }),
      },
      404: FactoryCardNotFound,
      409: {
        description:
          "Not startable: engine not configured, a run is in progress, or the card is not in inbox/failed.",
        schema: FactoryError,
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/factory/cards/{id}/cancel",
    operationId: "cancelFactoryCard",
    summary: "Cancel the card's run in progress",
    tags: T.factory,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "admin",
    request: { params: Type.Object({ id: Type.String() }) },
    responses: {
      200: {
        description: "Cancel requested; the card ends in failed once the engine confirms.",
        schema: Type.Object({ ok: OkTrue, jobId: Type.String() }),
      },
      404: FactoryCardNotFound,
      409: { description: "No run in progress.", schema: FactoryError },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/factory",
    operationId: "getFactoryView",
    summary: "Kanban view of the factory boards",
    description:
      "Static page (no data, no external assets). It takes the gateway token or a pairing " +
      "access token from the URL fragment or a prompt, keeps it in memory, reads the factory " +
      "API (attach scope) and follows factory.card events on the WebSocket. Move, run and " +
      "cancel need an admin or owner credential.",
    tags: T.factory,
    auth: "none",
    responses: {
      200: { description: "HTML page.", contentType: "text/html", schema: Type.String() },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/continuity/manifest",
    operationId: "getContinuityManifest",
    summary: "Signed continuity manifest of one resident",
    description:
      "Hashes of the resident's identity and memory files, its role (config minus model), the " +
      "current model profile, jobs, session index, transcripts and the audit chain head, chained " +
      "and signed with this gateway's Ed25519 signing key. No file contents and no secrets. " +
      "`kurahi continuity run` takes one before and one after a disruption and compares them.",
    tags: T.continuity,
    auth: ["gateway-token", "pair-credential"],
    request: {
      query: Type.Object({
        agent: Type.Optional(
          Type.String({ description: "Agent id (default: the default agent)." }),
        ),
      }),
    },
    responses: {
      200: {
        description: "The manifest.",
        schema: Type.Object({ ok: OkTrue, manifest: ContinuityManifest }),
      },
      404: "NotFound",
      500: "InternalError",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/memory/recall",
    operationId: "recallMemory",
    summary: "Deterministic keyword recall over a resident's memory files",
    description:
      "Scores every line of MEMORY.md and memory/*.md by the distinct query terms it contains " +
      "and returns the best lines. No embeddings and no provider: the same files and query give " +
      "the same hits on every machine, which is what a continuity proof needs.",
    tags: T.memory,
    auth: ["gateway-token", "pair-credential"],
    request: {
      query: Type.Object({
        agent: Type.Optional(
          Type.String({ description: "Agent id (default: the default agent)." }),
        ),
        q: Type.String({ minLength: 1, maxLength: 512 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 8 })),
      }),
    },
    responses: {
      200: {
        description: "Best-matching memory lines, highest score first.",
        schema: Type.Object({
          ok: OkTrue,
          agent: Type.String(),
          backend: Type.Literal("keyword"),
          query: Type.String(),
          hits: Type.Array(RecallHit),
        }),
      },
      400: OkFalse,
      404: "NotFound",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/audit/chain",
    operationId: "getAuditChain",
    summary: "Verify the local hash-chained audit log and read its head",
    description:
      "Re-walks the append-only audit chain under the state dir and reports its head (last seq " +
      "and entry hash). With `seq`, also returns that entry's hash so a client can prove a " +
      "previous head is an ancestor of the current one.",
    tags: T.audit,
    auth: ["gateway-token", "pair-credential", "sso-session"],
    request: {
      query: Type.Object({
        seq: Type.Optional(Type.Integer({ minimum: 1, description: "Entry to anchor on." })),
      }),
    },
    responses: {
      200: {
        description: "Chain state.",
        schema: Loose({
          ok: OkTrue,
          verified: Type.Boolean(),
          entries: Type.Integer(),
          lastSeq: Type.Integer(),
          months: Type.Array(Type.String()),
          head: Type.Union([AuditAnchor, Type.Null()]),
          anchor: Type.Optional(
            Type.Union([Loose({ seq: Type.Integer(), hash: Type.String() }), Type.Null()]),
          ),
          firstBreak: Type.Union([Loose({}), Type.Null()]),
        }),
      },
      400: OkFalse,
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/admin/workspaces",
    operationId: "listWorkspaces",
    summary: "List workspaces",
    tags: T.admin,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    responses: {
      200: { description: "Workspaces.", schema: WorkspaceList },
      500: { description: "Query failed.", schema: Loose({ ok: Type.Literal(false) }) },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/admin/users",
    operationId: "listUsers",
    summary: "List users and their workspace memberships",
    tags: T.admin,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    request: { query: Type.Object({ workspaceId: Type.Optional(Type.String()) }) },
    responses: {
      200: { description: "Users.", schema: UserList },
      500: { description: "Query failed.", schema: Loose({ ok: Type.Literal(false) }) },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/auth/redeem",
    operationId: "redeemInvite",
    summary: "Redeem an invite token; sets the kolo_session cookie",
    description: "Public login flow. Every POST here counts as a credential attempt.",
    tags: T.auth,
    auth: "none",
    request: {
      body: Type.Object({
        token: Type.String({ minLength: 1 }),
        name: Type.Optional(Type.String()),
      }),
    },
    responses: {
      200: {
        description: "Session created (Set-Cookie: kolo_session).",
        schema: Type.Object({ ok: OkTrue, user: SessionUser }),
        headers: {
          "Set-Cookie": {
            description: "kolo_session, HttpOnly, SameSite=Strict",
            schema: Type.String(),
          },
        },
      },
      400: OkFalse,
      500: { description: "Redeem failed.", schema: Loose({ ok: Type.Literal(false) }) },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/auth/me",
    operationId: "getSessionUser",
    summary: "Current session user",
    description: "Reads the kolo_session cookie when present; 401 without one.",
    tags: T.auth,
    auth: "none",
    responses: {
      200: { description: "Session user.", schema: Type.Object({ ok: OkTrue, user: SessionUser }) },
      401: {
        description: "Not authenticated or invalid session.",
        schema: Loose({ ok: Type.Literal(false) }),
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/auth/logout",
    operationId: "logout",
    summary: "End the current session",
    tags: T.auth,
    auth: "none",
    responses: {
      200: { description: "Logged out (cookie cleared).", schema: Type.Object({ ok: OkTrue }) },
      400: OkFalse,
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/pair/invite",
    operationId: "createPairInvitation",
    summary: "Create a one-shot pairing invitation",
    description:
      "Admin or owner. The code is returned once and never stored in clear; it is single use " +
      "and expires after `ttlMinutes` (default 10, max 60). The invitation can never grant more " +
      "than the creator holds.",
    tags: T.pairing,
    auth: ["gateway-token", "pair-credential"],
    minScope: "admin",
    request: {
      body: Type.Object({
        scope: PairScopeSchema,
        ttlMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })),
        label: Type.Optional(Type.String({ maxLength: 80 })),
        autoApprove: Type.Optional(
          Type.Boolean({
            description:
              "Default true (TOFU on an authenticated surface). false leaves the device " +
              "pending until approved.",
          }),
        ),
        sessions: Type.Optional(SessionAllowlistSchema),
      }),
    },
    responses: {
      201: {
        description: "Invitation created; `code` is shown once.",
        schema: Type.Object({ ok: OkTrue, invitation: PairInvitation, code: Type.String() }),
      },
      400: OkFalse,
      403: "Forbidden",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/pair/invitations",
    operationId: "listPairInvitations",
    summary: "List pairing invitations",
    tags: T.pairing,
    auth: ["gateway-token", "pair-credential"],
    minScope: "admin",
    responses: {
      200: {
        description: "Invitations, newest first.",
        schema: Type.Object({ ok: OkTrue, invitations: Type.Array(PairInvitation) }),
      },
      403: "Forbidden",
    },
  }),
  defineRoute({
    method: "DELETE",
    path: "/api/pair/invitations/{id}",
    operationId: "revokePairInvitation",
    summary: "Revoke an unredeemed invitation",
    tags: T.pairing,
    auth: ["gateway-token", "pair-credential"],
    minScope: "admin",
    request: { params: Type.Object({ id: Type.String() }) },
    responses: {
      200: { description: "Revoked.", schema: Type.Object({ ok: OkTrue, id: Type.String() }) },
      403: "Forbidden",
      404: "NotFound",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/pair/nonce",
    operationId: "createPairNonce",
    summary: "Server nonce for a device-key proof",
    description:
      "Public. The device signs it for POST /api/pair/redeem or /api/pair/refresh; single use, " +
      "two-minute lifetime.",
    tags: T.pairing,
    auth: "none",
    responses: {
      200: {
        description: "Nonce.",
        schema: Type.Object({ ok: OkTrue, nonce: Type.String(), expiresAt: IsoTime }),
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/pair/redeem",
    operationId: "redeemPairInvitation",
    summary: "Redeem an invitation for a device-bound credential",
    description:
      "Public, rate-limited as a credential attempt. Returns a short-lived access token and a " +
      "rotating refresh token bound to `deviceKeyPub`. Devices redeemed through an invitation " +
      "with autoApprove are trusted at once (TOFU on an authenticated surface); otherwise the " +
      "credential stays pending until `kurahi pair approve <fingerprint>`.",
    tags: T.pairing,
    auth: "none",
    request: {
      body: Type.Object({
        code: Type.String({ minLength: 1 }),
        deviceKeyPub: Type.String({ description: "Raw Ed25519 public key, base64url (or PEM)" }),
        deviceName: Type.Optional(Type.String({ maxLength: 80 })),
        ...PairProofFields,
      }),
    },
    responses: {
      200: { description: "Credential issued.", schema: PairCredential },
      400: OkFalse,
      401: {
        description: "Invalid, expired, used or revoked code; bad proof.",
        schema: PairDenied,
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/pair/refresh",
    operationId: "refreshPairCredential",
    summary: "Rotate a credential family",
    description:
      "Public, rate-limited. The presented refresh token is retired and a new access + refresh " +
      "pair is issued. Presenting a refresh token that was already rotated is reuse: the whole " +
      "family is revoked (audited as pair.reuse_detected) and the client must pair again.",
    tags: T.pairing,
    auth: "none",
    request: {
      body: Type.Object({ refreshToken: Type.String({ minLength: 1 }), ...PairProofFields }),
    },
    responses: {
      200: { description: "Rotated.", schema: PairCredential },
      400: OkFalse,
      401: { description: "Unknown/revoked token, reuse detected, bad proof.", schema: PairDenied },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/pair/me",
    operationId: "getPairPrincipal",
    summary: "The principal behind this Bearer credential",
    tags: T.pairing,
    auth: ["gateway-token", "pair-credential"],
    minScope: "observe",
    responses: { 200: { description: "Principal.", schema: PairPrincipal } },
  }),
  defineRoute({
    method: "GET",
    path: "/api/sessions",
    operationId: "listSessions",
    summary: "Discover live sessions",
    description:
      "Sessions of every agent on this gateway with their attached clients and run state. " +
      "Owner/admin see all; an attach credential whose invitation carries a `sessions` " +
      "allowlist sees only matching sessions.",
    tags: T.sessions,
    auth: ["gateway-token", "pair-credential"],
    minScope: "attach",
    request: { query: SessionsQuery },
    responses: {
      200: {
        description: "Sessions, newest activity first.",
        schema: Type.Object({
          ok: OkTrue,
          ts: Type.Number(),
          count: Type.Integer(),
          sessions: Type.Array(SessionDiscoveryRow),
        }),
      },
      400: OkFalse,
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/sessions/{id}",
    operationId: "getSession",
    summary: "One session with its attached clients",
    description:
      "`id` is a session id, a session key, a label or an agent id (its main session). A " +
      "session outside the credential's allowlist answers 404.",
    tags: T.sessions,
    auth: ["gateway-token", "pair-credential"],
    minScope: "attach",
    request: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    responses: {
      200: {
        description: "The session.",
        schema: Type.Object({ ok: OkTrue, session: SessionDiscoveryDetail }),
      },
      404: "NotFound",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/sessions/{id}/snapshots",
    operationId: "listSnapshots",
    summary: "File snapshots recorded before tool edits in a session",
    description:
      "Entries in order; `applied` is false for entries that were undone. `cursor` counts the " +
      "applied entries. `id` resolves like `getSession`.",
    tags: T.sessions,
    auth: ["gateway-token", "pair-credential"],
    minScope: "attach",
    request: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    responses: {
      200: {
        description: "The snapshot list.",
        schema: Type.Object({
          ok: OkTrue,
          session: Type.String(),
          cursor: Type.Integer(),
          snapshots: Type.Array(SnapshotSummary),
        }),
      },
      404: "NotFound",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/sessions/{id}/snapshots/restore",
    operationId: "restoreSnapshot",
    summary: "Undo, redo, or restore the files of a session to a snapshot",
    description:
      '`{"action":"undo"}` (the default) restores the files of the newest applied snapshot ' +
      'after capturing their current content for redo; `{"action":"redo"}` puts the newest ' +
      'undone edit back; `{"id":"<snapshot>"}` undoes every snapshot down to that one. ' +
      "Audited as `session.snapshot_restore`.",
    tags: T.sessions,
    auth: ["gateway-token", "pair-credential"],
    minScope: "attach",
    request: {
      params: Type.Object({ id: Type.String({ minLength: 1 }) }),
      body: Type.Object(
        {
          action: Type.Optional(Type.Union([Type.Literal("undo"), Type.Literal("redo")])),
          id: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    },
    responses: {
      200: {
        description: "What was restored.",
        schema: Type.Object({
          ok: OkTrue,
          action: Type.Union([Type.Literal("undo"), Type.Literal("redo"), Type.Literal("restore")]),
          cursor: Type.Integer(),
          steps: Type.Array(SnapshotRestoreStep),
        }),
      },
      400: OkFalse,
      404: "NotFound",
      409: {
        description: "Nothing to undo or redo, or the snapshot is unknown.",
        schema: Type.Object({ ok: Type.Literal(false), error: Type.String() }),
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/code-mode/run",
    operationId: "runCodeMode",
    summary: "Run a Code Mode script",
    description:
      "Runs one agent-written JavaScript/TypeScript script in a sandboxed worker thread. The " +
      "script calls the session's tools as `await tools.<name>({...})` and returns a value: one " +
      "round trip instead of one call per tool. Tools are the session agent's policy-filtered " +
      "list (core, plugin, `mcp:<server>:<tool>`); `allowTools` narrows it further. Limits: wall " +
      "clock (default 60 s), heap, tool calls per script (default 200). Every tool call is " +
      "audited under the run id. A backend with tools=none answers 403.",
    tags: T.codeMode,
    auth: ["gateway-token", "pair-credential"],
    minScope: "attach",
    request: { body: CodeModeRunBody, bodyRequired: true },
    responses: {
      200: {
        description:
          "Run outcome: `ok` with `value`, or `ok:false` with `error.code` (invalid_script, " +
          "script_error, timeout, memory, tool_call_limit, result_too_large, worker_error).",
        schema: CodeModeRunResponse,
      },
      400: OkFalse,
      403: "Forbidden",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/mcp/servers",
    operationId: "listMcpServers",
    summary: "Configured MCP servers and their live state",
    description:
      "Every `mcp.servers.<id>` with connection state, restart count, exposed/hidden tools " +
      "(policy applied), resources and prompts (read-only inventory).",
    tags: T.mcp,
    auth: ["gateway-token", "pair-credential"],
    minScope: "observe",
    responses: {
      200: {
        description: "Servers.",
        schema: Type.Object({ ok: OkTrue, servers: Type.Array(McpServerStatus) }),
      },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/plugins",
    operationId: "listPlugins",
    summary: "Plugins as the gateway runs them",
    description:
      "Every discovered plugin with its live status (loaded, disabled, error = quarantined with " +
      "the message), reload count, running services and whether its directory is watched for " +
      "hot reload (M7).",
    tags: T.plugins,
    auth: ["gateway-token", "pair-credential"],
    minScope: "observe",
    responses: {
      200: {
        description: "Plugins.",
        schema: Type.Object({
          ok: OkTrue,
          hotReload: Type.Object({
            enabled: Type.Boolean(),
            watch: Type.Boolean(),
            debounceMs: Type.Integer(),
            watching: Type.Boolean(),
          }),
          plugins: Type.Array(PluginStatusRow),
          diagnostics: Type.Array(
            Type.Object({
              level: Type.Union([Type.Literal("warn"), Type.Literal("error")]),
              pluginId: Type.Optional(Type.String()),
              message: Type.String(),
            }),
          ),
        }),
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/plugins/{id}/reload",
    operationId: "reloadPlugin",
    summary: "Reload one plugin in place",
    description:
      "Stops the plugin's services, disposes the instance (dispose() export + every timer, " +
      "listener and server registered through api.lifecycle), drops its files from the module " +
      "cache, imports and registers it again and restarts its services. No gateway restart. A " +
      "plugin whose load throws is quarantined (status error) and the error is returned.",
    tags: T.plugins,
    auth: ["gateway-token", "pair-credential"],
    minScope: "admin",
    request: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    responses: {
      200: {
        description: "Reload outcome (ok=false with status error when the plugin is quarantined).",
        schema: Type.Object({ ok: OkTrue, plugin: PluginReloadResult }),
      },
      404: "NotFound",
      409: {
        description: "Hot reload disabled by config.",
        schema: Type.Object({
          ok: Type.Literal(false),
          error: Type.Object({ type: Type.String(), message: Type.String() }),
        }),
      },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/pair/devices",
    operationId: "listPairDevices",
    summary: "List paired devices",
    tags: T.pairing,
    auth: ["gateway-token", "pair-credential"],
    minScope: "admin",
    responses: {
      200: {
        description: "Devices, newest first.",
        schema: Type.Object({ ok: OkTrue, devices: Type.Array(PairDevice) }),
      },
      403: "Forbidden",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/pair/devices/{fingerprint}/approve",
    operationId: "approvePairDevice",
    summary: "Approve a pending device",
    tags: T.pairing,
    auth: ["gateway-token", "pair-credential"],
    minScope: "admin",
    request: { params: Type.Object({ fingerprint: Type.String() }) },
    responses: {
      200: {
        description: "Approved.",
        schema: Type.Object({ ok: OkTrue, fingerprint: Type.String() }),
      },
      403: "Forbidden",
      404: {
        description: "Unknown device or not pending.",
        schema: Loose({ ok: Type.Literal(false) }),
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/pair/devices/{fingerprint}/revoke",
    operationId: "revokePairDevice",
    summary: "Revoke a device and every credential family it holds",
    tags: T.pairing,
    auth: ["gateway-token", "pair-credential"],
    minScope: "admin",
    request: { params: Type.Object({ fingerprint: Type.String() }) },
    responses: {
      200: {
        description: "Revoked.",
        schema: Type.Object({ ok: OkTrue, fingerprint: Type.String() }),
      },
      403: "Forbidden",
      404: { description: "Unknown device.", schema: Loose({ ok: Type.Literal(false) }) },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/v1/responses",
    operationId: "createResponse",
    summary: "OpenResponses-compatible agent turn",
    description: "Enabled by gateway.http.endpoints.responses. `stream: true` answers SSE.",
    tags: T.openai,
    auth: ["gateway-token", "pair-credential"],
    request: { headers: AgentHeaders, body: ResponsesBody },
    responses: {
      200: {
        description: "Response object (or text/event-stream when streaming).",
        schema: Loose({ id: Type.String() }),
      },
      400: { description: "Invalid request.", schema: Loose({ error: Loose({}) }) },
      405: "MethodNotAllowed",
    },
    extensions: { "x-kolo-config-enabled": "gateway.http.endpoints.responses.enabled" },
  }),
  defineRoute({
    method: "POST",
    path: "/v1/chat/completions",
    operationId: "createChatCompletion",
    summary: "OpenAI Chat Completions-compatible agent turn",
    description: "Enabled by gateway.http.endpoints.chatCompletions. `stream: true` answers SSE.",
    tags: T.openai,
    auth: ["gateway-token", "pair-credential"],
    request: { headers: AgentHeaders, body: ChatCompletionsBody },
    responses: {
      200: {
        description: "Chat completion (or text/event-stream when streaming).",
        schema: Loose({ id: Type.String() }),
      },
      400: { description: "Invalid request.", schema: Loose({ error: Loose({}) }) },
      405: "MethodNotAllowed",
    },
    extensions: { "x-kolo-config-enabled": "gateway.http.endpoints.chatCompletions.enabled" },
  }),
  defineRoute({
    method: "GET",
    path: "/api/channels/status",
    operationId: "getChannelsDeliveryStatus",
    summary: "Per-channel delivery health: queue, retries, dead letters",
    description:
      "Live counters of the outbound delivery queue for every channel that sent something since " +
      "the gateway started, plus the dead-letter files under KOLO_HOME/channels/dead-letter. " +
      "The same data appears in `kurahi channels status`.",
    tags: T.channels,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "observe",
    responses: {
      200: {
        description: "Delivery health per channel.",
        schema: Type.Object({
          ok: OkTrue,
          ts: Type.Integer(),
          channels: Type.Record(
            Type.String(),
            Type.Object({
              channel: Type.String(),
              queued: Type.Integer(),
              inFlight: Type.Integer(),
              sent: Type.Integer(),
              retried: Type.Integer(),
              deadLettered: Type.Integer(),
              duplicates: Type.Integer(),
              policyDenied: Type.Integer(),
              lastSentAt: Type.Union([Type.Integer(), Type.Null()]),
              lastError: Type.Union([Type.String(), Type.Null()]),
              lastErrorAt: Type.Union([Type.Integer(), Type.Null()]),
              deadLetterFile: Type.Union([Type.String(), Type.Null()]),
            }),
          ),
          deadLetterDir: Type.String(),
          deadLetterFiles: Type.Array(
            Type.Object({ channel: Type.String(), file: Type.String(), records: Type.Integer() }),
          ),
          policy: Type.Union([Type.Literal("human-triggered"), Type.Literal("allow-automated")]),
        }),
      },
    },
  }),
  // M14: channel-native residents — the generic webhook channel ingress.
  defineRoute({
    method: "POST",
    path: "/api/channels/webhook/{account}/inbound",
    operationId: "postWebhookInbound",
    summary: "Deliver an inbound message on the generic webhook channel",
    description:
      "A custom integration posts a message from a person; it resolves to the resident's session " +
      "like any channel message (channels.sessionMode), appears in attached terminals, and the " +
      "replies are posted as JSON chunks to the account's channels.webhook outboundUrl. Repeated " +
      "messageId values are ignored. Attachments are copied to KOLO_HOME/inbox/webhook/.",
    tags: T.channels,
    auth: ["gateway-token", "pair-credential", "session-admin"],
    minScope: "attach",
    request: {
      params: Type.Object({
        account: Type.String({ description: "Webhook account id (default)." }),
      }),
      body: Type.Object({
        from: Type.String({ description: "Sender id as the integration knows it." }),
        name: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        messageId: Type.Optional(
          Type.String({ description: "Provider message id (idempotency)." }),
        ),
        conversationId: Type.Optional(Type.String({ description: "Defaults to `from`." })),
        chatType: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("group")])),
        attachments: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              contentType: Type.Optional(Type.String()),
              dataBase64: Type.String(),
            }),
          ),
        ),
      }),
    },
    responses: {
      200: {
        description: "The message was dispatched; replies (if any) were posted outbound.",
        schema: Type.Object({
          ok: OkTrue,
          sessionKey: Type.String(),
          agentId: Type.String(),
          accountId: Type.String(),
          conversationId: Type.String(),
          queuedFinal: Type.Boolean(),
          replies: Type.Array(Type.Object({ kind: Type.String(), text: Type.String() })),
          outbound: Type.Union([Type.Literal("posted"), Type.Literal("none")]),
        }),
      },
      400: "BadRequest",
      404: {
        description: "Webhook account not configured.",
        schema: Loose({ ok: Type.Literal(false), error: Type.String() }),
      },
    },
  }),
  ...IDENTITY_ROUTES,
];

/** Dispatch order of the mounts is the order below (per phase). */
export const GATEWAY_MOUNTS: readonly MountDefinition[] = [
  defineMount({
    id: "hooks",
    summary: "Webhook dispatcher under hooks.path",
    paths: ["/hooks/*"],
    methods: ["POST"],
    auth: "hook-token",
    phase: "before-routes",
    reason:
      "The base path comes from config (hooks.path) at request time, so the dispatcher stays a " +
      "prefix handler; its operations are documented as /hooks/wake, /hooks/agent and " +
      "/hooks/{mapping} at the default prefix.",
    documents: ["hookWake", "hookAgent", "hookMapped"],
  }),
  defineMount({
    id: "slack-webhooks",
    summary: "Slack Events API / interactivity endpoints",
    paths: ["/slack/events", "<channels.slack.webhookPath>"],
    methods: "*",
    auth: "plugin",
    reason:
      "Paths are per Slack account config and registered when the channel starts; verified with " +
      "the Slack signing secret by the channel. Registered paths appear in the live GET /doc.",
  }),
  defineMount({
    id: "admin-fallback",
    summary: "Unknown /api/admin/* subpaths",
    paths: ["/api/admin/*"],
    methods: "*",
    auth: ["gateway-token", "pair-credential", "session-admin"],
    reason:
      "Keeps the pre-registry answers for paths no route declares: 405 for non-GET, JSON 404 " +
      "for unknown GET subpaths (after the admin auth gate).",
  }),
  defineMount({
    id: "plugin-http",
    summary: "Plugin HTTP routes and handlers (LINE, Zalo, Google Chat, BlueBubbles, Nostr, …)",
    paths: ["/line/webhook", "<plugin route path>", "<any path a plugin handler claims>"],
    methods: "*",
    auth: "plugin",
    reason:
      "Registered by plugins at runtime; each verifies its provider's signature. Routes " +
      "registered with registerPluginHttpRoute/registerHttpRoute are listed as operations in the " +
      "live GET /doc (auth: plugin); catch-all registerHttpHandler handlers cannot be described.",
  }),
  defineMount({
    id: "a2ui",
    summary: "A2UI static bundle",
    paths: ["/__KOLO__/a2ui/*"],
    methods: ["GET", "HEAD"],
    auth: "gateway-token",
    reason:
      "Static assets. Non-local clients need the gateway token (M2a remote gate); local direct " +
      "clients are exempt.",
  }),
  defineMount({
    id: "canvas-host",
    summary: "Canvas host files and live-reload WebSocket",
    paths: ["/__KOLO__/canvas/*", "/__KOLO__/ws"],
    methods: ["GET", "HEAD"],
    auth: "gateway-token",
    reason:
      "Serves the agent canvas directory as static files plus a live-reload upgrade; gated for " +
      "non-local clients like A2UI.",
  }),
  defineMount({
    id: "control-ui-avatar",
    summary: "Agent avatar files and ?meta=1 lookups",
    paths: ["<gateway.controlUi.basePath>/avatar/{agentId}"],
    methods: ["GET", "HEAD"],
    auth: "gateway-token",
    reason:
      "Lives under the configurable Control UI base path; gated for non-local clients. To be " +
      "described when the Control UI routes move into the registry.",
  }),
  defineMount({
    id: "control-ui",
    summary: "Control UI single-page app",
    paths: ["<gateway.controlUi.basePath>/*"],
    methods: ["GET", "HEAD"],
    auth: "none",
    reason:
      "Public static bundle with an SPA fallback (any unknown GET under the base path returns " +
      "index.html); all data flows over the authenticated WebSocket.",
  }),
];

export type GatewayRouteBindings = {
  handlers: Partial<Record<string, RouteHandler>>;
  enabled?: Record<string, () => boolean>;
  mounts: Partial<Record<string, MountHandler>>;
};

/**
 * Router over the gateway table. With bindings, every non-`servedBy` route needs a handler and
 * every mount a dispatcher (fail closed: an unbound declaration is a startup error). Without
 * bindings the router is declaration-only (spec generation).
 */
export function createGatewayRouter(
  bindings?: GatewayRouteBindings,
  opts?: HttpRouterOptions,
): HttpRouter {
  const router = createHttpRouter(opts);
  const known = new Set(GATEWAY_ROUTES.map((r) => r.operationId));
  if (bindings) {
    for (const id of Object.keys(bindings.handlers)) {
      if (!known.has(id)) {
        throw new Error(`http handler bound to undeclared operation: ${id}`);
      }
    }
  }
  for (const def of GATEWAY_ROUTES) {
    const route: BoundRoute = { ...def };
    if (bindings) {
      const handler: RouteHandler | undefined = bindings.handlers[def.operationId];
      if (def.servedBy) {
        if (handler) {
          throw new Error(`http route ${def.operationId} is served by mount ${def.servedBy}`);
        }
      } else if (!handler) {
        throw new Error(`http route ${def.operationId} has no handler`);
      }
      route.handler = handler;
      route.enabled = bindings.enabled?.[def.operationId];
    }
    router.add(route);
  }
  for (const def of GATEWAY_MOUNTS) {
    const mount: BoundMount = { ...def };
    if (bindings) {
      const handler: MountHandler | undefined = bindings.mounts[def.id];
      if (!handler) {
        throw new Error(`http mount ${def.id} has no dispatcher`);
      }
      mount.handler = handler;
    }
    router.mount(mount);
  }
  if (bindings) {
    for (const id of Object.keys(bindings.mounts)) {
      if (!GATEWAY_MOUNTS.some((m) => m.id === id)) {
        throw new Error(`http dispatcher bound to undeclared mount: ${id}`);
      }
    }
  }
  return router;
}
