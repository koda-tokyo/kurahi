import AjvPkg, { type ErrorObject, type ValidateFunction } from "ajv";
import {
  type AgentEvent,
  AgentEventSchema,
  type AgentIdentityParams,
  AgentIdentityParamsSchema,
  type AgentIdentityResult,
  AgentIdentityResultSchema,
  AgentParamsSchema,
  type AgentSummary,
  AgentSummarySchema,
  type AgentsListParams,
  AgentsListParamsSchema,
  type AgentsListResult,
  AgentsListResultSchema,
  type AgentWaitParams,
  AgentWaitParamsSchema,
  type ChannelsLogoutParams,
  ChannelsLogoutParamsSchema,
  type ChannelsStatusParams,
  ChannelsStatusParamsSchema,
  type ChannelsStatusResult,
  ChannelsStatusResultSchema,
  type ChatAbortParams,
  ChatAbortParamsSchema,
  type ChatEvent,
  ChatEventSchema,
  ChatHistoryParamsSchema,
  type ChatInjectParams,
  ChatInjectParamsSchema,
  ChatSendParamsSchema,
  type ConfigApplyParams,
  ConfigApplyParamsSchema,
  type ConfigGetParams,
  ConfigGetParamsSchema,
  type ConfigPatchParams,
  ConfigPatchParamsSchema,
  type ConfigSchemaParams,
  ConfigSchemaParamsSchema,
  type ConfigSchemaResponse,
  ConfigSchemaResponseSchema,
  type ConfigSetParams,
  ConfigSetParamsSchema,
  type ConnectParams,
  ConnectParamsSchema,
  type CronAddParams,
  CronAddParamsSchema,
  type CronJob,
  CronJobSchema,
  type CronListParams,
  CronListParamsSchema,
  type CronRemoveParams,
  CronRemoveParamsSchema,
  type CronRunLogEntry,
  type CronRunParams,
  CronRunParamsSchema,
  type CronRunsParams,
  CronRunsParamsSchema,
  type CronStatusParams,
  CronStatusParamsSchema,
  type CronUpdateParams,
  CronUpdateParamsSchema,
  type DevicePairApproveParams,
  DevicePairApproveParamsSchema,
  type PairNonceParams,
  PairNonceParamsSchema,
  type PairRedeemParams,
  PairRedeemParamsSchema,
  type PairRefreshParams,
  PairRefreshParamsSchema,
  type PairMeParams,
  PairMeParamsSchema,
  type PairInviteParams,
  PairInviteParamsSchema,
  type PairListParams,
  PairListParamsSchema,
  type PairDevicesParams,
  PairDevicesParamsSchema,
  type PairApproveParams,
  PairApproveParamsSchema,
  type PairRevokeParams,
  PairRevokeParamsSchema,
  type DevicePairListParams,
  DevicePairListParamsSchema,
  type DevicePairRejectParams,
  DevicePairRejectParamsSchema,
  type DeviceTokenRevokeParams,
  DeviceTokenRevokeParamsSchema,
  type DeviceTokenRotateParams,
  DeviceTokenRotateParamsSchema,
  type ExecApprovalsGetParams,
  ExecApprovalsGetParamsSchema,
  type ExecApprovalsNodeGetParams,
  ExecApprovalsNodeGetParamsSchema,
  type ExecApprovalsNodeSetParams,
  ExecApprovalsNodeSetParamsSchema,
  type ExecApprovalsSetParams,
  ExecApprovalsSetParamsSchema,
  type ExecApprovalsSnapshot,
  type ExecApprovalRequestParams,
  ExecApprovalRequestParamsSchema,
  type ExecApprovalResolveParams,
  ExecApprovalResolveParamsSchema,
  ErrorCodes,
  type ErrorShape,
  ErrorShapeSchema,
  type EventFrame,
  EventFrameSchema,
  errorShape,
  type GatewayFrame,
  GatewayFrameSchema,
  type HelloOk,
  HelloOkSchema,
  type LogsTailParams,
  LogsTailParamsSchema,
  type LogsTailResult,
  LogsTailResultSchema,
  type ModelsListParams,
  ModelsListParamsSchema,
  type NodeDescribeParams,
  NodeDescribeParamsSchema,
  type NodeEventParams,
  NodeEventParamsSchema,
  type NodeInvokeParams,
  NodeInvokeParamsSchema,
  type NodeInvokeResultParams,
  NodeInvokeResultParamsSchema,
  type NodeListParams,
  NodeListParamsSchema,
  type NodePairApproveParams,
  NodePairApproveParamsSchema,
  type NodePairListParams,
  NodePairListParamsSchema,
  type NodePairRejectParams,
  NodePairRejectParamsSchema,
  type NodePairRequestParams,
  NodePairRequestParamsSchema,
  type NodePairVerifyParams,
  NodePairVerifyParamsSchema,
  type NodeRenameParams,
  NodeRenameParamsSchema,
  type PollParams,
  PollParamsSchema,
  PROTOCOL_VERSION,
  type PresenceEntry,
  PresenceEntrySchema,
  ProtocolSchemas,
  type RequestFrame,
  RequestFrameSchema,
  type ResponseFrame,
  ResponseFrameSchema,
  type SiblingDeliveryAck,
  SiblingDeliveryAckSchema,
  type SiblingEventMessage,
  SiblingEventMessageSchema,
  type SiblingHistoryParams,
  SiblingHistoryParamsSchema,
  type SiblingHistoryResult,
  SiblingHistoryResultSchema,
  type SiblingMessage,
  SiblingMessageSchema,
  type SiblingReadParams,
  SiblingReadParamsSchema,
  SiblingSendParamsSchema,
  type SiblingSendParams,
  type SiblingSendResult,
  SiblingSendResultSchema,
  type SiblingSubscribeParams,
  SiblingSubscribeParamsSchema,
  SendParamsSchema,
  type SessionsCompactParams,
  SessionsCompactParamsSchema,
  type SessionsDeleteParams,
  SessionsDeleteParamsSchema,
  type SessionsListParams,
  SessionsListParamsSchema,
  type SessionsPatchParams,
  SessionsPatchParamsSchema,
  type SessionsPreviewParams,
  SessionsPreviewParamsSchema,
  type SessionsResetParams,
  SessionsResetParamsSchema,
  type SessionsResolveParams,
  SessionsResolveParamsSchema,
  type SessionsDiscoverParams,
  SessionsDiscoverParamsSchema,
  type SessionsDiscoverResult,
  type CodeModeRunParams,
  CodeModeRunParamsSchema,
  type CodeModeRunResult,
  type ConnectorsStatusParams,
  ConnectorsStatusParamsSchema,
  type ConnectorsStatusResult,
  type ConnectorStatusEntry,
  type TerminalAckResult,
  type TerminalCancelParams,
  TerminalCancelParamsSchema,
  type TerminalDiffFile,
  type TerminalDiffFileSummary,
  type TerminalDiffResult,
  type TerminalEvent,
  type TerminalOpenResult,
  type TerminalReplayResult,
  type TerminalRiskPreview,
  type TerminalCloseParams,
  TerminalCloseParamsSchema,
  type TerminalDiffParams,
  TerminalDiffParamsSchema,
  type TerminalInputParams,
  TerminalInputParamsSchema,
  type TerminalOpenParams,
  TerminalOpenParamsSchema,
  type TerminalReplayParams,
  TerminalReplayParamsSchema,
  type TerminalResizeParams,
  TerminalResizeParamsSchema,
  type SessionAttachParams,
  SessionAttachParamsSchema,
  type SessionAttachResult,
  type SessionDetachParams,
  SessionDetachParamsSchema,
  type SessionDetachResult,
  type ShutdownEvent,
  ShutdownEventSchema,
  type SkillsBinsParams,
  SkillsBinsParamsSchema,
  type SkillsBinsResult,
  type SkillsInstallParams,
  SkillsInstallParamsSchema,
  type SkillsStatusParams,
  SkillsStatusParamsSchema,
  type SkillsUpdateParams,
  SkillsUpdateParamsSchema,
  type Snapshot,
  SnapshotSchema,
  type StateVersion,
  StateVersionSchema,
  type TalkModeParams,
  TalkModeParamsSchema,
  type TickEvent,
  TickEventSchema,
  type UpdateRunParams,
  UpdateRunParamsSchema,
  type WakeParams,
  WakeParamsSchema,
  type WebLoginStartParams,
  WebLoginStartParamsSchema,
  type WebLoginWaitParams,
  WebLoginWaitParamsSchema,
  type WizardCancelParams,
  WizardCancelParamsSchema,
  type WizardNextParams,
  WizardNextParamsSchema,
  type WizardNextResult,
  WizardNextResultSchema,
  type WizardStartParams,
  WizardStartParamsSchema,
  type WizardStartResult,
  WizardStartResultSchema,
  type WizardStatusParams,
  WizardStatusParamsSchema,
  type WizardStatusResult,
  WizardStatusResultSchema,
  type WizardStep,
  WizardStepSchema,
  JobRecordSchema,
  JobsCancelParamsSchema,
  JobsCancelResultSchema,
  JobsGetParamsSchema,
  JobsGetResultSchema,
  JobsListParamsSchema,
  JobsListResultSchema,
} from "./schema.js";
import {
  VoiceAudioParamsSchema,
  VoiceCancelParamsSchema,
  VoiceSpeakParamsSchema,
  VoiceStartParamsSchema,
  VoiceStopParamsSchema,
} from "./schema/voice.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

// Validators compile on first use: compiling all of them at import cost ~0.2-0.3 s of CPU in
// every process that imports the protocol (each CLI command, each gateway start), most of which
// use a handful. The wrapper is a drop-in ValidateFunction: callers invoke it and read `.errors`.
function lazyCompile<T = unknown>(schema: object): ValidateFunction<T> {
  let compiled: ValidateFunction<T> | null = null;
  const get = (): ValidateFunction<T> => (compiled ??= ajv.compile<T>(schema));
  const validate = ((data: unknown) => get()(data)) as ValidateFunction<T>;
  for (const key of ["errors", "schema", "schemaEnv", "source", "evaluated"] as const) {
    Object.defineProperty(validate, key, {
      configurable: true,
      enumerable: true,
      get: () => (key === "errors" ? (compiled?.errors ?? null) : get()[key]),
      set: (value: unknown) => {
        (get() as unknown as Record<string, unknown>)[key] = value;
      },
    });
  }
  return validate;
}

export const validateConnectParams = lazyCompile<ConnectParams>(ConnectParamsSchema);
export const validateRequestFrame = lazyCompile<RequestFrame>(RequestFrameSchema);
export const validateResponseFrame = lazyCompile<ResponseFrame>(ResponseFrameSchema);
export const validateEventFrame = lazyCompile<EventFrame>(EventFrameSchema);
export const validateSendParams = lazyCompile(SendParamsSchema);
export const validatePollParams = lazyCompile<PollParams>(PollParamsSchema);
export const validateAgentParams = lazyCompile(AgentParamsSchema);
export const validateAgentIdentityParams =
  lazyCompile<AgentIdentityParams>(AgentIdentityParamsSchema);
export const validateAgentWaitParams = lazyCompile<AgentWaitParams>(AgentWaitParamsSchema);
export const validateWakeParams = lazyCompile<WakeParams>(WakeParamsSchema);
export const validateAgentsListParams = lazyCompile<AgentsListParams>(AgentsListParamsSchema);
export const validateNodePairRequestParams = lazyCompile<NodePairRequestParams>(
  NodePairRequestParamsSchema,
);
export const validateNodePairListParams = lazyCompile<NodePairListParams>(NodePairListParamsSchema);
export const validateNodePairApproveParams = lazyCompile<NodePairApproveParams>(
  NodePairApproveParamsSchema,
);
export const validateNodePairRejectParams = lazyCompile<NodePairRejectParams>(
  NodePairRejectParamsSchema,
);
export const validateNodePairVerifyParams = lazyCompile<NodePairVerifyParams>(
  NodePairVerifyParamsSchema,
);
export const validateNodeRenameParams = lazyCompile<NodeRenameParams>(NodeRenameParamsSchema);
export const validateNodeListParams = lazyCompile<NodeListParams>(NodeListParamsSchema);
export const validateNodeDescribeParams = lazyCompile<NodeDescribeParams>(NodeDescribeParamsSchema);
export const validateNodeInvokeParams = lazyCompile<NodeInvokeParams>(NodeInvokeParamsSchema);
export const validateNodeInvokeResultParams = lazyCompile<NodeInvokeResultParams>(
  NodeInvokeResultParamsSchema,
);
export const validateNodeEventParams = lazyCompile<NodeEventParams>(NodeEventParamsSchema);
export const validateSessionsListParams = lazyCompile<SessionsListParams>(SessionsListParamsSchema);
export const validateSessionsPreviewParams = lazyCompile<SessionsPreviewParams>(
  SessionsPreviewParamsSchema,
);
export const validateSessionsResolveParams = lazyCompile<SessionsResolveParams>(
  SessionsResolveParamsSchema,
);
export const validateSessionsPatchParams =
  lazyCompile<SessionsPatchParams>(SessionsPatchParamsSchema);
export const validateSessionsResetParams =
  lazyCompile<SessionsResetParams>(SessionsResetParamsSchema);
export const validateSessionsDeleteParams = lazyCompile<SessionsDeleteParams>(
  SessionsDeleteParamsSchema,
);
export const validateSessionsCompactParams = lazyCompile<SessionsCompactParams>(
  SessionsCompactParamsSchema,
);
export const validateSessionsDiscoverParams = lazyCompile<SessionsDiscoverParams>(
  SessionsDiscoverParamsSchema,
);
export const validateCodeModeRunParams = lazyCompile<CodeModeRunParams>(CodeModeRunParamsSchema);
export const validateConnectorsStatusParams = lazyCompile<ConnectorsStatusParams>(
  ConnectorsStatusParamsSchema,
);
export const validateVoiceStartParams = lazyCompile(VoiceStartParamsSchema);
export const validateVoiceAudioParams = lazyCompile(VoiceAudioParamsSchema);
export const validateVoiceStopParams = lazyCompile(VoiceStopParamsSchema);
export const validateVoiceSpeakParams = lazyCompile(VoiceSpeakParamsSchema);
export const validateVoiceCancelParams = lazyCompile(VoiceCancelParamsSchema);
export const validateTerminalOpenParams = lazyCompile<TerminalOpenParams>(TerminalOpenParamsSchema);
export const validateTerminalInputParams =
  lazyCompile<TerminalInputParams>(TerminalInputParamsSchema);
export const validateTerminalResizeParams = lazyCompile<TerminalResizeParams>(
  TerminalResizeParamsSchema,
);
export const validateTerminalCancelParams = lazyCompile<TerminalCancelParams>(
  TerminalCancelParamsSchema,
);
export const validateTerminalCloseParams =
  lazyCompile<TerminalCloseParams>(TerminalCloseParamsSchema);
export const validateTerminalReplayParams = lazyCompile<TerminalReplayParams>(
  TerminalReplayParamsSchema,
);
export const validateTerminalDiffParams = lazyCompile<TerminalDiffParams>(TerminalDiffParamsSchema);
export const validateSessionAttachParams =
  lazyCompile<SessionAttachParams>(SessionAttachParamsSchema);
export const validateSessionDetachParams =
  lazyCompile<SessionDetachParams>(SessionDetachParamsSchema);
export const validateConfigGetParams = lazyCompile<ConfigGetParams>(ConfigGetParamsSchema);
export const validateConfigSetParams = lazyCompile<ConfigSetParams>(ConfigSetParamsSchema);
export const validateConfigApplyParams = lazyCompile<ConfigApplyParams>(ConfigApplyParamsSchema);
export const validateConfigPatchParams = lazyCompile<ConfigPatchParams>(ConfigPatchParamsSchema);
export const validateConfigSchemaParams = lazyCompile<ConfigSchemaParams>(ConfigSchemaParamsSchema);
export const validateWizardStartParams = lazyCompile<WizardStartParams>(WizardStartParamsSchema);
export const validateWizardNextParams = lazyCompile<WizardNextParams>(WizardNextParamsSchema);
export const validateWizardCancelParams = lazyCompile<WizardCancelParams>(WizardCancelParamsSchema);
export const validateWizardStatusParams = lazyCompile<WizardStatusParams>(WizardStatusParamsSchema);
export const validateTalkModeParams = lazyCompile<TalkModeParams>(TalkModeParamsSchema);
export const validateChannelsStatusParams = lazyCompile<ChannelsStatusParams>(
  ChannelsStatusParamsSchema,
);
export const validateChannelsLogoutParams = lazyCompile<ChannelsLogoutParams>(
  ChannelsLogoutParamsSchema,
);
export const validateModelsListParams = lazyCompile<ModelsListParams>(ModelsListParamsSchema);
export const validateSkillsStatusParams = lazyCompile<SkillsStatusParams>(SkillsStatusParamsSchema);
export const validateSkillsBinsParams = lazyCompile<SkillsBinsParams>(SkillsBinsParamsSchema);
export const validateSkillsInstallParams =
  lazyCompile<SkillsInstallParams>(SkillsInstallParamsSchema);
export const validateSkillsUpdateParams = lazyCompile<SkillsUpdateParams>(SkillsUpdateParamsSchema);
export const validateCronListParams = lazyCompile<CronListParams>(CronListParamsSchema);
export const validateCronStatusParams = lazyCompile<CronStatusParams>(CronStatusParamsSchema);
export const validateCronAddParams = lazyCompile<CronAddParams>(CronAddParamsSchema);
export const validateCronUpdateParams = lazyCompile<CronUpdateParams>(CronUpdateParamsSchema);
export const validateCronRemoveParams = lazyCompile<CronRemoveParams>(CronRemoveParamsSchema);
export const validateCronRunParams = lazyCompile<CronRunParams>(CronRunParamsSchema);
export const validateCronRunsParams = lazyCompile<CronRunsParams>(CronRunsParamsSchema);
export const validateJobsListParams = lazyCompile(JobsListParamsSchema);
export const validateJobsGetParams = lazyCompile(JobsGetParamsSchema);
export const validateJobsCancelParams = lazyCompile(JobsCancelParamsSchema);
export const validateDevicePairListParams = lazyCompile<DevicePairListParams>(
  DevicePairListParamsSchema,
);
export const validatePairNonceParams = lazyCompile<PairNonceParams>(PairNonceParamsSchema);
export const validatePairRedeemParams = lazyCompile<PairRedeemParams>(PairRedeemParamsSchema);
export const validatePairRefreshParams = lazyCompile<PairRefreshParams>(PairRefreshParamsSchema);
export const validatePairMeParams = lazyCompile<PairMeParams>(PairMeParamsSchema);
export const validatePairInviteParams = lazyCompile<PairInviteParams>(PairInviteParamsSchema);
export const validatePairListParams = lazyCompile<PairListParams>(PairListParamsSchema);
export const validatePairDevicesParams = lazyCompile<PairDevicesParams>(PairDevicesParamsSchema);
export const validatePairApproveParams = lazyCompile<PairApproveParams>(PairApproveParamsSchema);
export const validatePairRevokeParams = lazyCompile<PairRevokeParams>(PairRevokeParamsSchema);
export const validateDevicePairApproveParams = lazyCompile<DevicePairApproveParams>(
  DevicePairApproveParamsSchema,
);
export const validateDevicePairRejectParams = lazyCompile<DevicePairRejectParams>(
  DevicePairRejectParamsSchema,
);
export const validateDeviceTokenRotateParams = lazyCompile<DeviceTokenRotateParams>(
  DeviceTokenRotateParamsSchema,
);
export const validateDeviceTokenRevokeParams = lazyCompile<DeviceTokenRevokeParams>(
  DeviceTokenRevokeParamsSchema,
);
export const validateExecApprovalsGetParams = lazyCompile<ExecApprovalsGetParams>(
  ExecApprovalsGetParamsSchema,
);
export const validateExecApprovalsSetParams = lazyCompile<ExecApprovalsSetParams>(
  ExecApprovalsSetParamsSchema,
);
export const validateExecApprovalRequestParams = lazyCompile<ExecApprovalRequestParams>(
  ExecApprovalRequestParamsSchema,
);
export const validateExecApprovalResolveParams = lazyCompile<ExecApprovalResolveParams>(
  ExecApprovalResolveParamsSchema,
);
export const validateExecApprovalsNodeGetParams = lazyCompile<ExecApprovalsNodeGetParams>(
  ExecApprovalsNodeGetParamsSchema,
);
export const validateExecApprovalsNodeSetParams = lazyCompile<ExecApprovalsNodeSetParams>(
  ExecApprovalsNodeSetParamsSchema,
);
export const validateLogsTailParams = lazyCompile<LogsTailParams>(LogsTailParamsSchema);
export const validateChatHistoryParams = lazyCompile(ChatHistoryParamsSchema);
export const validateChatSendParams = lazyCompile(ChatSendParamsSchema);
export const validateChatAbortParams = lazyCompile<ChatAbortParams>(ChatAbortParamsSchema);
export const validateChatInjectParams = lazyCompile<ChatInjectParams>(ChatInjectParamsSchema);
export const validateChatEvent = lazyCompile(ChatEventSchema);
export const validateUpdateRunParams = lazyCompile<UpdateRunParams>(UpdateRunParamsSchema);
export const validateWebLoginStartParams =
  lazyCompile<WebLoginStartParams>(WebLoginStartParamsSchema);
export const validateWebLoginWaitParams = lazyCompile<WebLoginWaitParams>(WebLoginWaitParamsSchema);
export const validateSiblingSendParams = lazyCompile(SiblingSendParamsSchema);
export const validateSiblingSubscribeParams = lazyCompile(SiblingSubscribeParamsSchema);
export const validateSiblingHistoryParams = lazyCompile(SiblingHistoryParamsSchema);
export const validateSiblingReadParams = lazyCompile(SiblingReadParamsSchema);

export function formatValidationErrors(errors: ErrorObject[] | null | undefined) {
  if (!errors?.length) {
    return "unknown validation error";
  }

  const parts: string[] = [];

  for (const err of errors) {
    const keyword = typeof err?.keyword === "string" ? err.keyword : "";
    const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";

    if (keyword === "additionalProperties") {
      const params = err?.params as { additionalProperty?: unknown } | undefined;
      const additionalProperty = params?.additionalProperty;
      if (typeof additionalProperty === "string" && additionalProperty.trim()) {
        const where = instancePath ? `at ${instancePath}` : "at root";
        parts.push(`${where}: unexpected property '${additionalProperty}'`);
        continue;
      }
    }

    const message =
      typeof err?.message === "string" && err.message.trim() ? err.message : "validation error";
    const where = instancePath ? `at ${instancePath}: ` : "";
    parts.push(`${where}${message}`);
  }

  // De-dupe while preserving order.
  const unique = Array.from(new Set(parts.filter((part) => part.trim())));
  if (!unique.length) {
    const fallback = ajv.errorsText(errors, { separator: "; " });
    return fallback || "unknown validation error";
  }
  return unique.join("; ");
}

export {
  ConnectParamsSchema,
  HelloOkSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  GatewayFrameSchema,
  PresenceEntrySchema,
  SnapshotSchema,
  ErrorShapeSchema,
  StateVersionSchema,
  AgentEventSchema,
  ChatEventSchema,
  SendParamsSchema,
  PollParamsSchema,
  AgentParamsSchema,
  AgentIdentityParamsSchema,
  AgentIdentityResultSchema,
  WakeParamsSchema,
  NodePairRequestParamsSchema,
  NodePairListParamsSchema,
  NodePairApproveParamsSchema,
  NodePairRejectParamsSchema,
  NodePairVerifyParamsSchema,
  NodeListParamsSchema,
  NodeInvokeParamsSchema,
  SessionsListParamsSchema,
  SessionsPreviewParamsSchema,
  SessionsPatchParamsSchema,
  SessionsResetParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsCompactParamsSchema,
  SessionsDiscoverParamsSchema,
  SessionAttachParamsSchema,
  SessionDetachParamsSchema,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
  ConfigApplyParamsSchema,
  ConfigPatchParamsSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaResponseSchema,
  WizardStartParamsSchema,
  WizardNextParamsSchema,
  WizardCancelParamsSchema,
  WizardStatusParamsSchema,
  WizardStepSchema,
  WizardNextResultSchema,
  WizardStartResultSchema,
  WizardStatusResultSchema,
  ChannelsStatusParamsSchema,
  ChannelsStatusResultSchema,
  ChannelsLogoutParamsSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
  AgentSummarySchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  ModelsListParamsSchema,
  SkillsStatusParamsSchema,
  SkillsInstallParamsSchema,
  SkillsUpdateParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronStatusParamsSchema,
  CronAddParamsSchema,
  CronUpdateParamsSchema,
  CronRemoveParamsSchema,
  CronRunParamsSchema,
  JobRecordSchema,
  JobsListParamsSchema,
  JobsListResultSchema,
  JobsGetParamsSchema,
  JobsGetResultSchema,
  JobsCancelParamsSchema,
  JobsCancelResultSchema,
  CronRunsParamsSchema,
  LogsTailParamsSchema,
  LogsTailResultSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  ChatInjectParamsSchema,
  UpdateRunParamsSchema,
  TickEventSchema,
  ShutdownEventSchema,
  ProtocolSchemas,
  PROTOCOL_VERSION,
  ErrorCodes,
  errorShape,
};

export type {
  TerminalAckResult,
  TerminalCancelParams,
  TerminalCloseParams,
  TerminalDiffFile,
  TerminalDiffFileSummary,
  TerminalDiffParams,
  TerminalDiffResult,
  TerminalEvent,
  TerminalInputParams,
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalReplayParams,
  TerminalReplayResult,
  TerminalResizeParams,
  TerminalRiskPreview,
  GatewayFrame,
  ConnectParams,
  HelloOk,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  PresenceEntry,
  Snapshot,
  ErrorShape,
  StateVersion,
  AgentEvent,
  AgentIdentityParams,
  AgentIdentityResult,
  AgentWaitParams,
  ChatEvent,
  TickEvent,
  ShutdownEvent,
  WakeParams,
  NodePairRequestParams,
  NodePairListParams,
  NodePairApproveParams,
  DevicePairListParams,
  DevicePairApproveParams,
  DevicePairRejectParams,
  PairNonceParams,
  PairRedeemParams,
  PairRefreshParams,
  PairMeParams,
  PairInviteParams,
  PairListParams,
  PairDevicesParams,
  PairApproveParams,
  PairRevokeParams,
  ConfigGetParams,
  ConfigSetParams,
  ConfigApplyParams,
  ConfigPatchParams,
  ConfigSchemaParams,
  ConfigSchemaResponse,
  WizardStartParams,
  WizardNextParams,
  WizardCancelParams,
  WizardStatusParams,
  WizardStep,
  WizardNextResult,
  WizardStartResult,
  WizardStatusResult,
  TalkModeParams,
  ChannelsStatusParams,
  ChannelsStatusResult,
  ChannelsLogoutParams,
  WebLoginStartParams,
  WebLoginWaitParams,
  AgentSummary,
  AgentsListParams,
  AgentsListResult,
  SkillsStatusParams,
  SkillsBinsParams,
  SkillsBinsResult,
  SkillsInstallParams,
  SkillsUpdateParams,
  NodePairRejectParams,
  NodePairVerifyParams,
  NodeListParams,
  NodeInvokeParams,
  NodeInvokeResultParams,
  NodeEventParams,
  SessionsListParams,
  SessionsPreviewParams,
  SessionsResolveParams,
  SessionsPatchParams,
  SessionsResetParams,
  SessionsDeleteParams,
  SessionsCompactParams,
  SessionsDiscoverParams,
  SessionsDiscoverResult,
  CodeModeRunParams,
  CodeModeRunResult,
  ConnectorsStatusParams,
  ConnectorsStatusResult,
  ConnectorStatusEntry,
  SessionAttachParams,
  SessionAttachResult,
  SessionDetachParams,
  SessionDetachResult,
  CronJob,
  CronListParams,
  CronStatusParams,
  CronAddParams,
  CronUpdateParams,
  CronRemoveParams,
  CronRunParams,
  CronRunsParams,
  CronRunLogEntry,
  ExecApprovalsGetParams,
  ExecApprovalsSetParams,
  ExecApprovalsSnapshot,
  LogsTailParams,
  LogsTailResult,
  PollParams,
  UpdateRunParams,
  ChatInjectParams,
  SiblingSendParams,
  SiblingSendResult,
  SiblingSubscribeParams,
  SiblingHistoryParams,
  SiblingHistoryResult,
  SiblingReadParams,
  SiblingMessage,
  SiblingEventMessage,
  SiblingDeliveryAck,
};
export type {
  VoiceStartParams,
  VoiceStartResult,
  VoiceAudioParams,
  VoiceAudioResult,
  VoiceStopParams,
  VoiceStopResult,
  VoiceSpeakParams,
  VoiceSpeakResult,
  VoiceCancelParams,
  VoiceCancelResult,
  VoiceTranscriptPartialEvent,
  VoiceTranscriptFinalEvent,
  VoiceAudioOutEvent,
  VoiceSessionEndedEvent,
} from "./schema/types.js";
