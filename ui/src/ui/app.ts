import { LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { EventLogEntry } from "./app-events";
import type { DevicePairingList } from "./controllers/devices";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals";
import type { FleetState } from "./controllers/fleet";
import type { Project } from "./controllers/projects";
import type { SkillMessage } from "./controllers/skills";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import type { Tab } from "./navigation";
import type { ResolvedTheme, ThemeMode } from "./theme";
import type {
  AgentsListResult,
  ConfigSnapshot,
  ConfigUiHints,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
  NostrProfile,
} from "./types";
import type { ChatStreamReasoning } from "./types/chat-types";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form";
import {
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
} from "./app-channels";
import {
  handleAbortChat as handleAbortChatInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
} from "./app-chat";
import { refreshChatAvatar as refreshChatAvatarInternal } from "./app-chat";
import { DEFAULT_CRON_FORM, DEFAULT_LOG_LEVEL_FILTERS } from "./app-defaults";
import { connectGateway as connectGatewayInternal } from "./app-gateway";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle";
import { renderApp } from "./app-render";
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
} from "./app-scroll";
import {
  applySettings as applySettingsInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  onPopState as onPopStateInternal,
  refreshActiveTab as refreshActiveTabInternal,
} from "./app-settings";
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
} from "./app-tool-stream";
import { resolveInjectedAssistantIdentity } from "./assistant-identity";
import { chatMessageHooks } from "./chat/grouped-render";
import {
  compareWith as compareArtifactInternal,
  DEFAULT_ARTIFACTS_STATE,
  guessType,
  loadArtifacts as loadArtifactsInternal,
  openArtifact as openArtifactInternal,
  saveNewVersion as saveArtifactVersionInternal,
  setStatus as setArtifactStatusInternal,
  submitSave as submitArtifactSaveInternal,
  titleFromContent,
  type ArtifactStatus,
  type ArtifactsState,
} from "./controllers/artifacts";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity";
import {
  reportAutopilotError,
  setAutopilotReportReason,
  changeAutopilotRoutine,
  setAutopilotRoutineReason,
  closeAutopilotRun,
  declineAutonomy,
  acceptAutonomy,
  canDeclineAutonomy,
  setAutonomyDeclineReason,
  inspectAutopilotRun,
  emptyAutopilot,
  loadAutopilot,
  resetAutopilot,
  setAutopilotFilters,
  type AutopilotFilters,
} from "./controllers/autopilot";
import {
  beginBusinessReport as beginBusinessReportInternal,
  editBusinessReport as editBusinessReportInternal,
  cancelBusinessReport as cancelBusinessReportInternal,
  submitBusinessReport as submitBusinessReportInternal,
  beginBusinessDecision as beginBusinessDecisionInternal,
  editBusinessDecision as editBusinessDecisionInternal,
  cancelBusinessDecision as cancelBusinessDecisionInternal,
  submitBusinessDecision as submitBusinessDecisionInternal,
  type BusinessDecisionForm,
  emptyBusiness,
  isBusinessProject,
  loadBusiness,
  loadBusinessItem,
  resetBusiness,
  selectBusinessQueue as selectBusinessQueueInternal,
  selectBusinessDepartment as selectBusinessDepartmentInternal,
  setBusinessOrganizationMode as setBusinessOrganizationModeInternal,
  filterBusiness as filterBusinessInternal,
  type BusinessState,
} from "./controllers/business";
import {
  departmentOfChat,
  startBusinessChat as startBusinessChatInternal,
} from "./controllers/business-chat";
import { loadBusinessDocument } from "./controllers/business-document";
import { loadBusinessDraft } from "./controllers/business-draft";
import { verifyBusinessEvidence } from "./controllers/business-evidence";
import {
  beginBusinessExpense as beginBusinessExpenseInternal,
  editBusinessExpense as editBusinessExpenseInternal,
  cancelBusinessExpense as cancelBusinessExpenseInternal,
  createBusinessExpense as createBusinessExpenseInternal,
  acknowledgeExpenseOutcome as acknowledgeExpenseOutcomeInternal,
  type ExpenseForm,
} from "./controllers/business-intake";
import {
  beginBusinessLinkedAttach,
  cancelBusinessLinkedAttach,
  editBusinessLinkedAttach,
  submitBusinessLinkedAttach,
  beginBusinessLinkedCreate,
  applyBusinessLinkedPlan,
  loadBusinessLinkedPlans,
  cancelBusinessLinkedCreate,
  editBusinessLinkedCreate,
  submitBusinessLinkedCreate,
  type BusinessLinkedCreateStep,
} from "./controllers/business-linked";
import {
  loadBusinessNotifications,
  showMoreBusinessNotifications,
  businessNotificationTarget,
  toggleBusinessNotifications as toggleBusinessNotificationsInternal,
  markBusinessNotificationRead as markBusinessNotificationReadInternal,
} from "./controllers/business-notifications";
import {
  beginSupplier,
  editSupplier,
  cancelSupplier,
  submitSupplier,
} from "./controllers/business-supplier";
import {
  beginBusinessWork as beginBusinessWorkInternal,
  editBusinessWork as editBusinessWorkInternal,
  cancelBusinessWork as cancelBusinessWorkInternal,
  createBusinessWork as createBusinessWorkInternal,
  acknowledgeBusinessWorkOutcome as acknowledgeBusinessWorkOutcomeInternal,
  type BusinessWorkForm,
} from "./controllers/business-work-intake";
import { loadChatHistory as loadChatHistoryInternal } from "./controllers/chat";
import {
  archiveChat as archiveChatInternal,
  DEFAULT_CHAT_HISTORY_STATE,
  loadChatHistoryPanel,
  newChatKey,
  renameChat as renameChatInternal,
  searchChatText,
  type ChatHistoryState,
} from "./controllers/chat-history";
import {
  DEFAULT_ENTERPRISE_STATE,
  recordApprovalDecision,
  serviceStatus,
  type AuditSource,
  type EnterpriseState,
  type ServiceStatus,
} from "./controllers/enterprise";
import { DEFAULT_FLEET_STATE } from "./controllers/fleet";
import { sessionKeyForAgent } from "./controllers/picker";
import {
  changeProjectMode as changeProjectModeInternal,
  createProjectFromForm,
  DEFAULT_PROJECTS_STATE,
  loadProjectFiles,
  loadProjectPack,
  loadProjects as loadProjectsInternal,
  newProjectChatKey,
  projectIdOfSession,
  type ProjectMode,
  type ProjectView,
  type ProjectsState,
} from "./controllers/projects";
import {
  emptyTerminal,
  openTerminal,
  terminalAction,
  replayTerminal,
} from "./controllers/terminal";
import {
  collapseDocumentBlocks,
  composeWithDocuments,
  DEFAULT_UPLOAD_STATE,
  uploadFile,
  type UploadState,
} from "./controllers/uploads";
import {
  cancelVoice,
  emptyVoice,
  startVoice,
  stopVoice,
  type VoiceHost,
} from "./controllers/voice";
import { getLocale, osLocales, resolveLocale, setLocale, t } from "./i18n";
import { audienceFromAuth, type Audience } from "./navigation";
import {
  clearSsoToken,
  loadSsoToken,
  ssoLoginHref,
  ssoLogout,
  type SsoConfig,
  type SsoProvider,
  type WhoAmI,
} from "./sso";
import { loadSettings, type UiSettings } from "./storage";
import { type ChatAttachment, type ChatQueueItem, type CronFormState } from "./ui-types";

declare global {
  interface Window {
    __KOLO_CONTROL_UI_BASE_PATH__?: string;
  }
}

const injectedAssistantIdentity = resolveInjectedAssistantIdentity();

function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

@customElement("kolo-app")
export class KoLoApp extends LitElement {
  @state() settings: UiSettings = loadSettings();
  @state() password = "";
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeMode = this.settings.theme ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  /** Organisation sign-in (enterprise identity): providers offered, and who is connected. */
  @state() ssoConfig: SsoConfig | null = null;
  @state() identity: WhoAmI | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() assistantName = injectedAssistantIdentity.name;
  @state() assistantAvatar = injectedAssistantIdentity.avatar;
  @state() assistantAgentId = injectedAssistantIdentity.agentId ?? null;

  @state() sessionKey = this.settings.sessionKey;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatStreamReasoning: ChatStreamReasoning | null = null;
  @state() chatRunId: string | null = null;
  @state() compactionStatus: import("./app-tool-stream").CompactionStatus | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatAttachments: ChatAttachment[] = [];
  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: string | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;
  @state() enterprise: EnterpriseState = { ...DEFAULT_ENTERPRISE_STATE };
  @state() voice = emptyVoice();
  // Installed only by a native desktop capture integration; unavailable in this build.
  @state() voiceCapture: VoiceHost["voiceCapture"] = null;
  @state() terminal = emptyTerminal();
  @state() business = emptyBusiness();
  @state() autopilot = emptyAutopilot();
  businessChatGeneration = 0;
  chatSessionGeneration = 0;
  @state() businessChatDraft = "";
  @state() businessChatOpening = false;
  @state() businessChatError: string | null = null;
  @state() projects: ProjectsState = { ...DEFAULT_PROJECTS_STATE };
  @state() artifacts: ArtifactsState = { ...DEFAULT_ARTIFACTS_STATE };
  @state() chatHistory: ChatHistoryState = { ...DEFAULT_CHAT_HISTORY_STATE };
  @state() uploads: UploadState = { ...DEFAULT_UPLOAD_STATE };
  /** Organisation default locale (`gateway.controlUi.defaultLocale`), when the config says so. */
  @state() orgLocale: string | null = null;
  @state() pendingGatewayUrl: string | null = null;

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() updateRunning = false;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() configFormDirty = false;
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() fleetState: FleetState = { ...DEFAULT_FLEET_STATE };

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;

  @state() cronLoading = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronRunsJobId: string | null = null;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronBusy = false;

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSnapshot | null = null;
  @state() debugModels: unknown[] = [];
  @state() debugHeartbeat: unknown = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private debugPollInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  refreshSessionsAfterChat = new Set<string>();
  basePath = "";
  private popStateHandler = () =>
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);
  private themeMedia: MediaQueryList | null = null;
  private themeMediaHandler: ((event: MediaQueryListEvent) => void) | null = null;
  private topbarObserver: ResizeObserver | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
  }

  protected firstUpdated() {
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
  }

  disconnectedCallback() {
    resetBusiness(this);
    resetAutopilot(this);
    cancelVoice(this);
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (
      (changed.has("tab") || changed.has("projects")) &&
      this.voice.projectId &&
      (this.tab !== "projects" ||
        this.projects.selectedId !== this.voice.projectId ||
        this.projects.view !== "modernize")
    ) {
      cancelVoice(this);
    }
    handleUpdated(this as unknown as Parameters<typeof handleUpdated>[0], changed);
  }

  connect() {
    connectGatewayInternal(this as unknown as Parameters<typeof connectGatewayInternal>[0]);
  }

  ssoSignIn(provider: SsoProvider) {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(ssoLoginHref(window.location.origin, provider, returnTo));
  }

  async ssoSignOut() {
    const token = loadSsoToken();
    clearSsoToken();
    this.identity = null;
    const endSessionUrl = token ? await ssoLogout(window.location.origin, token) : null;
    if (endSessionUrl) {
      window.location.assign(endSessionUrl);
      return;
    }
    this.connect();
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      this as unknown as Parameters<typeof handleLogsScrollInternal>[0],
      event,
    );
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    resetToolStreamInternal(this as unknown as Parameters<typeof resetToolStreamInternal>[0]);
  }

  resetChatScroll() {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], next);
  }

  setTab(next: Tab) {
    this.businessRunNavigation = (this.businessRunNavigation ?? 0) + 1;
    if (next !== this.tab) {
      cancelVoice(this);
    }
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
  }

  setTheme(next: ThemeMode, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this as unknown as Parameters<typeof setThemeInternal>[0], next, context);
  }

  async loadOverview() {
    await loadOverviewInternal(this as unknown as Parameters<typeof loadOverviewInternal>[0]);
  }

  async loadCron() {
    await loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0]);
  }

  async handleAbortChat() {
    await handleAbortChatInternal(this as unknown as Parameters<typeof handleAbortChatInternal>[0]);
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    // v0.3: uploaded documents travel with the next message as document blocks.
    const docs = this.uploads.documents;
    if (messageOverride == null && docs.length > 0) {
      const text = this.chatMessage.trim() || docs.map((d) => d.name).join(", ");
      this.chatMessage = composeWithDocuments(text, docs);
      this.uploads = { ...this.uploads, documents: [] };
    }
    await handleSendChatInternal(
      this as unknown as Parameters<typeof handleSendChatInternal>[0],
      messageOverride,
      opts,
    );
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("exec.approval.resolve", {
        id: active.id,
        decision,
      });
      this.enterprise = {
        ...this.enterprise,
        approvalHistory: recordApprovalDecision(
          this.enterprise.approvalHistory,
          this.execApprovalQueue,
          {
            id: active.id,
            decision,
            ts: Date.now(),
          },
        ),
      };
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Exec approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    this.pendingGatewayUrl = null;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
    });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: string) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  get serviceStatus(): ServiceStatus {
    return serviceStatus(this.connected, this.debugHealth, this.lastError);
  }

  get audience(): Audience {
    return audienceFromAuth(this.hello?.auth);
  }

  get locale(): string {
    return getLocale();
  }

  patchEnterprise(next: Partial<EnterpriseState>) {
    this.enterprise = { ...this.enterprise, ...next };
  }

  setAuditSource(source: AuditSource) {
    this.patchEnterprise({ auditSource: source });
    void this.refreshEnterprise();
  }

  async refreshEnterprise() {
    await refreshActiveTabInternal(
      this as unknown as Parameters<typeof refreshActiveTabInternal>[0],
    );
  }

  /** The user's language choice; null returns to automatic (organisation default, then OS). */
  setLocalePreference(locale: string | null) {
    this.applySettings({ ...this.settings, locale });
  }

  // ---- v0.3: projects, outputs, chat history, uploads, picker, inline approvals ----

  /** Switch the chat to another conversation (same steps as the session selector). */
  switchSession(next: string) {
    this.chatSessionGeneration++;
    this.chatMessages = [];
    this.chatLoading = false;
    this.chatSending = false;
    this.lastError = null;
    this.sessionKey = next;
    this.chatMessage = "";
    this.chatAttachments = [];
    this.chatStream = null;
    this.chatStreamStartedAt = null;
    this.chatStreamReasoning = null;
    this.chatRunId = null;
    this.chatQueue = [];
    this.resetToolStream();
    this.resetChatScroll();
    this.applySettings({ ...this.settings, sessionKey: next, lastActiveSessionKey: next });
    void this.loadAssistantIdentity();
    void loadChatHistoryInternal(this as unknown as Parameters<typeof loadChatHistoryInternal>[0]);
    void refreshChatAvatarInternal(
      this as unknown as Parameters<typeof refreshChatAvatarInternal>[0],
    );
  }

  openChatSession(key: string) {
    if (!key) {
      return;
    }
    if (key !== this.sessionKey) {
      this.switchSession(key);
    }
    if (this.tab !== "chat") {
      this.setTab("chat");
    }
  }

  async startProjectVoice(project: Project) {
    await startVoice(this, project.id, this.locale === "ja" ? "ja" : "en");
  }
  async stopProjectVoice() {
    await stopVoice(this);
  }
  cancelProjectVoice() {
    cancelVoice(this);
  }
  patchVoiceText(text: string) {
    if (this.voice.phase === "ready") {
      this.voice = { ...this.voice, text };
    }
  }
  async useVoiceDraft(project: Project) {
    if (
      this.voice.phase !== "ready" ||
      this.voice.projectId !== project.id ||
      !this.voice.text.trim()
    ) {
      return;
    }
    const voice = this.voice;
    const client = this.client;
    const agentId = project.allowedAgents[0] ?? this.agentsList?.defaultId ?? "main";
    const key = await newProjectChatKey(this, project.id, agentId);
    // Navigation, editing or disconnect while resolving must not replace another draft.
    if (!key || !this.connected || this.client !== client || this.voice !== voice) {
      return;
    }
    this.openChatSession(key);
    this.chatMessage = voice.text;
  }

  async openProjectTerminal(project: Project) {
    await openTerminal(this, project);
  }
  async runTerminalAction(action: "input" | "cancel" | "close", project: Project) {
    await terminalAction(this, action, project);
  }
  async refreshTerminal() {
    await replayTerminal(this);
  }
  patchTerminalDraft(draft: string) {
    this.terminal = { ...this.terminal, draft };
  }

  patchProjects(next: Partial<ProjectsState>) {
    this.projects = { ...this.projects, ...next };
  }

  async refreshProjects() {
    await loadProjectsInternal(this);
  }

  openProject(id: string | null) {
    this.businessRunNavigation = (this.businessRunNavigation ?? 0) + 1;
    this.businessChatGeneration++;
    this.businessChatDraft = "";
    this.businessChatError = null;
    resetBusiness(this);
    resetAutopilot(this);
    cancelVoice(this);
    const project = this.projects.projects.find((entry) => entry.id === id);
    const view = project && isBusinessProject(project) ? "business" : "chat";
    this.patchProjects({ selectedId: id, view, files: null, filesError: null, pack: null });
    if (this.tab !== "projects") {
      this.setTab("projects");
    } else if (view === "business") {
      void loadBusiness(this);
    }
  }

  async beginBusinessExpense(action?: "edit" | "submit") {
    beginBusinessExpenseInternal(this, action);
    const form = this.business.expenseForm;
    if (!form) {
      return;
    }
    await this.updateComplete;
    if (this.business.expenseForm === form) {
      this.renderRoot
        .querySelector<HTMLElement>(
          action === "submit"
            ? '.business-intake button[type="submit"]'
            : '.business-intake input[name="title"]',
        )
        ?.focus();
    }
  }
  editBusinessExpense(update: Partial<ExpenseForm>) {
    editBusinessExpenseInternal(this, update);
  }
  async cancelBusinessExpense() {
    const projectId = this.business.projectId;
    const action = this.business.expenseForm?.target?.action;
    cancelBusinessExpenseInternal(this);
    await this.updateComplete;
    if (!this.business.expenseForm && this.business.projectId === projectId) {
      const origin = action
        ? this.renderRoot.querySelector<HTMLButtonElement>(`[data-business-expense-${action}]`)
        : null;
      (origin && !origin.disabled
        ? origin
        : this.renderRoot.querySelector<HTMLButtonElement>("[data-business-expense]")
      )?.focus();
    }
  }
  async createBusinessExpense() {
    await createBusinessExpenseInternal(this);
  }
  acknowledgeExpenseOutcome() {
    acknowledgeExpenseOutcomeInternal(this);
  }

  beginBusinessSupplier(supplier: string) {
    beginSupplier(this, supplier);
  }
  editBusinessSupplier(reason: string) {
    editSupplier(this, reason);
  }
  cancelBusinessSupplier() {
    cancelSupplier(this);
  }
  async submitBusinessSupplier() {
    await submitSupplier(this);
  }
  async beginBusinessDecision(decision: BusinessDecisionForm["decision"]) {
    beginBusinessDecisionInternal(this, decision);
    const form = this.business.decisionForm;
    if (!form) {
      return;
    }
    await this.updateComplete;
    if (this.business.decisionForm === form) {
      this.renderRoot
        .querySelector<HTMLTextAreaElement>(".business-decision__form textarea")
        ?.focus();
    }
  }
  editBusinessDecision(
    update: Partial<Pick<BusinessDecisionForm, "comment" | "override" | "overrideReason">>,
  ) {
    editBusinessDecisionInternal(this, update);
  }
  async cancelBusinessDecision() {
    const form = this.business.decisionForm;
    cancelBusinessDecisionInternal(this);
    if (!form || this.business.decisionForm) {
      return;
    }
    await this.updateComplete;
    if (!this.business.decisionForm && this.business.selectedId === form.id) {
      this.renderRoot
        .querySelector<HTMLButtonElement>(`[data-business-decision="${form.decision}"]`)
        ?.focus();
    }
  }
  beginBusinessReport() {
    beginBusinessReportInternal(this);
  }
  editBusinessReport(reason: string) {
    editBusinessReportInternal(this, reason);
  }
  cancelBusinessReport() {
    cancelBusinessReportInternal(this);
  }
  async submitBusinessReport() {
    await submitBusinessReportInternal(this);
  }
  beginBusinessLinkedAttach(stepKey: string) {
    beginBusinessLinkedAttach(this, stepKey);
  }
  editBusinessLinkedAttach(childId: string) {
    editBusinessLinkedAttach(this, childId);
  }
  cancelBusinessLinkedAttach() {
    cancelBusinessLinkedAttach(this);
  }
  async submitBusinessLinkedAttach() {
    await submitBusinessLinkedAttach(this);
  }
  beginBusinessLinkedCreate() {
    beginBusinessLinkedCreate(this);
    void loadBusinessLinkedPlans(this);
  }
  applyBusinessLinkedPlan(file: string) {
    applyBusinessLinkedPlan(this, file, this.locale === "ja" ? "ja" : "en");
  }
  editBusinessLinkedCreate(index: number, patch: Partial<BusinessLinkedCreateStep> | null) {
    editBusinessLinkedCreate(this, index, patch, this.locale === "ja" ? "ja" : "en");
  }
  cancelBusinessLinkedCreate() {
    cancelBusinessLinkedCreate(this);
  }
  async submitBusinessLinkedCreate() {
    await submitBusinessLinkedCreate(this, this.locale === "ja" ? "ja" : "en");
  }
  async submitBusinessDecision() {
    await submitBusinessDecisionInternal(this);
  }
  async verifyBusinessEvidence() {
    await verifyBusinessEvidence(this);
  }
  async loadBusinessDraft() {
    await loadBusinessDraft(this);
  }
  async loadBusinessDocument(ref: string) {
    await loadBusinessDocument(this, ref);
  }
  async refreshBusiness() {
    await loadBusiness(this);
  }
  showMoreBusinessNotifications() {
    showMoreBusinessNotifications(this);
  }
  async refreshBusinessNotifications() {
    await loadBusinessNotifications(this);
  }
  async toggleBusinessNotifications() {
    await toggleBusinessNotificationsInternal(this);
  }
  async openBusinessNotification(id: string) {
    const target = businessNotificationTarget(this, id);
    if (!target) {
      return;
    }
    await loadBusinessItem(this, target.itemId);
    await this.updateComplete;
    if (
      target.current() &&
      this.business.selectedId === target.itemId &&
      this.business.item?.id === target.itemId &&
      !this.business.detailLoading &&
      !this.business.detailError
    ) {
      this.renderRoot.querySelector<HTMLElement>(".business-detail-panel")?.focus();
    }
  }
  async markBusinessNotificationRead(id: string) {
    await markBusinessNotificationReadInternal(this, id);
  }
  async beginBusinessWork() {
    beginBusinessWorkInternal(this);
    await this.updateComplete;
    if (this.business.workForm) {
      this.renderRoot.querySelector<HTMLInputElement>(".business-work-intake input")?.focus();
    }
  }
  editBusinessWork(update: Partial<BusinessWorkForm>) {
    editBusinessWorkInternal(this, update);
  }
  async cancelBusinessWork() {
    cancelBusinessWorkInternal(this);
    await this.updateComplete;
    if (!this.business.workForm) {
      this.renderRoot.querySelector<HTMLButtonElement>("[data-business-work-new]")?.focus();
    }
  }
  async createBusinessWork() {
    await createBusinessWorkInternal(this);
  }
  acknowledgeBusinessWorkOutcome() {
    acknowledgeBusinessWorkOutcomeInternal(this);
  }
  async selectBusinessQueue(queue: string) {
    await selectBusinessQueueInternal(this, queue);
  }
  async selectBusinessDepartment(department: string) {
    if (this.businessChatOpening) {
      return;
    }
    const previous = this.business.department;
    await selectBusinessDepartmentInternal(this, department);
    if (this.business.department !== previous) {
      this.businessChatGeneration++;
      this.businessChatDraft = "";
      this.businessChatError = null;
    }
  }
  async openBusinessChatWork() {
    const projectId = projectIdOfSession(this.sessionKey);
    const department = departmentOfChat(this.sessionKey);
    if (!projectId || !department) {
      return;
    }
    this.openProject(projectId);
    await loadBusiness(this);
    if (
      this.tab === "projects" &&
      this.projects.selectedId === projectId &&
      this.projects.view === "business"
    ) {
      await this.selectBusinessDepartment(department.id);
    }
  }
  editBusinessChatDraft(text: string) {
    if (!this.businessChatOpening) {
      this.businessChatDraft = text;
    }
  }
  async startBusinessChat(projectId: string, message?: string) {
    await startBusinessChatInternal(this, projectId, message);
  }
  setBusinessOrganizationMode(mode: "enterprise" | "sme") {
    setBusinessOrganizationModeInternal(this, mode);
  }
  async filterBusiness(search: string, status: BusinessState["status"]) {
    await filterBusinessInternal(this, search, status);
  }
  async selectBusinessItem(id: string) {
    await loadBusinessItem(this, id);
    await this.updateComplete;
    if (
      this.business.department !== "all" &&
      this.business.selectedId === id &&
      this.business.item?.id === id
    ) {
      const detail = this.renderRoot.querySelector<HTMLElement>(".business-detail-panel");
      detail?.focus();
    }
  }
  async loadMoreBusiness() {
    await loadBusiness(this, true);
  }

  setAutopilotRoutineReason(routineId: string, reason: string) {
    setAutopilotRoutineReason(this, routineId, reason);
  }

  async changeAutopilotRoutine(routineId: string, action: "pause" | "resume") {
    await changeAutopilotRoutine(this, routineId, action);
  }

  get canDeclineAutonomy() {
    return canDeclineAutonomy(this);
  }

  setAutonomyDeclineReason(routineId: string, reason: string) {
    setAutonomyDeclineReason(this, routineId, reason);
  }

  setAutopilotReportReason(itemId: string, reason: string) {
    setAutopilotReportReason(this, itemId, reason);
  }

  async reportAutopilotError(itemId: string) {
    await reportAutopilotError(this, itemId);
  }

  async acceptAutonomy(routineId: string) {
    await acceptAutonomy(this, routineId);
  }

  async declineAutonomy(routineId: string) {
    await declineAutonomy(this, routineId);
  }

  async setAutopilotFilters(filters: AutopilotFilters) {
    await setAutopilotFilters(this, filters);
  }

  closeAutopilotRun() {
    closeAutopilotRun(this);
  }

  async inspectAutopilotRun(id: string) {
    await inspectAutopilotRun(this, id);
  }

  async refreshAutopilot(cursor?: string) {
    await loadAutopilot(this, cursor);
  }

  private businessRunNavigation = 0;

  async openBusinessRun() {
    const item = this.business.item;
    const id = item?.source.fields.autopilotRun;
    const projectId = this.projects.selectedId;
    const client = this.client;
    if (
      !this.connected ||
      !client ||
      this.tab !== "projects" ||
      this.projects.view !== "business" ||
      !item ||
      item.projectId !== projectId ||
      this.business.projectId !== projectId ||
      this.business.selectedId !== item.id ||
      this.business.loading ||
      this.business.detailLoading ||
      this.business.detailError ||
      this.business.error ||
      this.business.decisionPending ||
      !item.createdBy.startsWith("autopilot:") ||
      typeof id !== "string" ||
      !id.trim()
    ) {
      return;
    }
    const load = this.setProjectView("autopilot", { id, itemId: item.id });
    const navigation = this.businessRunNavigation;
    await load;
    if (
      !this.connected ||
      this.client !== client ||
      this.tab !== "projects" ||
      this.businessRunNavigation !== navigation ||
      this.projects.selectedId !== projectId ||
      (this.projects.view as ProjectView) !== "autopilot" ||
      this.autopilot.error
    ) {
      return;
    }
    await this.updateComplete;
    this.querySelector<HTMLElement>("#autopilot-run-details")?.focus();
  }

  setProjectView(view: ProjectView, linkedRun?: { id: string; itemId: string }) {
    this.businessRunNavigation = (this.businessRunNavigation ?? 0) + 1;
    if (view !== this.projects.view) {
      cancelVoice(this);
    }
    if (view !== this.projects.view) {
      resetBusiness(this);
      resetAutopilot(this);
    }
    this.patchProjects({ view });
    if (view === "autopilot") {
      if (linkedRun) {
        this.autopilot = {
          ...this.autopilot,
          projectId: this.projects.selectedId,
          linkedRun,
          selectedRunId: linkedRun.id,
        };
      }
      return loadAutopilot(this);
    }
    if (view === "business") {
      void loadBusiness(this);
    }
    if (view === "files") {
      void loadProjectFiles(this);
    }
    if (view === "pack") {
      void loadProjectPack(this);
    }
    if (view === "artifacts" || view === "history") {
      void loadArtifactsInternal(this);
    }
  }

  async changeProjectMode(id: string, mode: ProjectMode) {
    await changeProjectModeInternal(this, id, mode);
  }

  async submitNewProject() {
    const project = await createProjectFromForm(this);
    if (project) {
      void this.refreshProjects();
    }
  }

  async startProjectChat(projectId: string, draft?: string) {
    const project = this.projects.projects.find((p) => p.id === projectId);
    const agentId = project?.allowedAgents[0] ?? this.agentsList?.defaultId ?? "main";
    const key = await newProjectChatKey(this, projectId, agentId);
    if (!key) {
      return;
    }
    this.openChatSession(key);
    if (draft) {
      this.chatMessage = draft;
    }
  }

  patchArtifacts(next: Partial<ArtifactsState>) {
    this.artifacts = { ...this.artifacts, ...next };
  }

  async refreshArtifacts() {
    await loadArtifactsInternal(this);
  }

  async openArtifactPanel(id: string, version?: number) {
    await openArtifactInternal(this, id, version);
  }

  async compareArtifact(version: number | null) {
    await compareArtifactInternal(this, version);
  }

  async setArtifactStatus(status: ArtifactStatus) {
    await setArtifactStatusInternal(this, status);
  }

  async saveArtifactVersion() {
    await saveArtifactVersionInternal(this);
  }

  async submitArtifactSave() {
    await submitArtifactSaveInternal(this);
  }

  /** "Save as output" on an assistant reply. */
  beginArtifactSave(markdown: string) {
    this.patchArtifacts({
      error: null,
      saveForm: {
        title: titleFromContent(markdown),
        type: guessType(markdown),
        content: markdown,
        sourceSession: this.sessionKey,
      },
    });
  }

  patchChatHistory(next: Partial<ChatHistoryState>) {
    this.chatHistory = { ...this.chatHistory, ...next };
  }

  async refreshChatHistoryPanel() {
    await loadChatHistoryPanel(this);
  }

  async searchChats() {
    await searchChatText(this);
  }

  async archiveChat(key: string, archived: boolean) {
    await archiveChatInternal(this, key, archived);
  }

  async renameChat(key: string, label: string) {
    await renameChatInternal(this, key, label);
  }

  /** New conversation: inside the current project when the chat is in one. */
  async startNewChat() {
    const projectId = projectIdOfSession(this.sessionKey);
    const agentId =
      /^agent:([^:]+):/.exec(this.sessionKey)?.[1] ?? this.agentsList?.defaultId ?? "main";
    const previousSession = this.sessionKey;
    const client = this.client;
    const key = projectId
      ? await newProjectChatKey(this, projectId, agentId, departmentOfChat(previousSession)?.id)
      : newChatKey(agentId);
    if (this.sessionKey !== previousSession || this.client !== client || !this.connected) {
      return;
    }
    if (key) {
      this.openChatSession(key);
      void this.refreshChatHistoryPanel();
    }
  }

  patchUploads(next: Partial<UploadState>) {
    this.uploads = { ...this.uploads, ...next };
  }

  async uploadFiles(files: File[]) {
    const projectId = projectIdOfSession(this.sessionKey);
    for (const file of files) {
      await uploadFile(this, file, projectId);
    }
  }

  async pickAgent(agentId: string) {
    const projectId = projectIdOfSession(this.sessionKey);
    const previousSession = this.sessionKey;
    const client = this.client;
    const key = projectId
      ? await newProjectChatKey(this, projectId, agentId, departmentOfChat(previousSession)?.id)
      : sessionKeyForAgent(this.sessionKey, agentId);
    if (this.sessionKey !== previousSession || this.client !== client || !this.connected) {
      return;
    }
    if (key) {
      this.openChatSession(key);
    }
  }

  async pickModel(model: string) {
    if (!this.client) {
      return;
    }
    try {
      await this.client.request("sessions.patch", { key: this.sessionKey, model: model || null });
      await this.loadSessionsQuiet();
    } catch (err) {
      this.lastError = String(err);
    }
  }

  async loadSessionsQuiet() {
    const { loadSessions } = await import("./controllers/sessions");
    await loadSessions(this as unknown as Parameters<typeof loadSessions>[0]);
  }

  /** Approve / reject one approval by id (chat cards and the Approvals page). */
  async decideApproval(id: string, decision: "allow-once" | "allow-always" | "deny") {
    const entry = this.execApprovalQueue.find((q) => q.id === id);
    if (!entry || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("exec.approval.resolve", { id, decision });
      this.enterprise = {
        ...this.enterprise,
        approvalHistory: recordApprovalDecision(
          this.enterprise.approvalHistory,
          this.execApprovalQueue,
          {
            id,
            decision,
            ts: Date.now(),
          },
        ),
      };
      this.execApprovalQueue = this.execApprovalQueue.filter((q) => q.id !== id);
    } catch (err) {
      this.execApprovalError = String(err);
    } finally {
      this.execApprovalBusy = false;
    }
  }

  render() {
    setLocale(resolveLocale({ user: this.settings.locale, org: this.orgLocale, os: osLocales() }));
    chatMessageHooks.onSaveArtifact = (markdown) => this.beginArtifactSave(markdown);
    chatMessageHooks.saveLabel = t("artifacts.save");
    chatMessageHooks.collapse = (text) =>
      collapseDocumentBlocks(text, (name) => `[${t("upload.attached", { name })}]`);
    return renderApp(this);
  }
}
