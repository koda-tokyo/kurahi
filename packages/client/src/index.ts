// SPDX-License-Identifier: MIT
// @kodasoken/kurahi-client — typed client for the Kurahi gateway, generated from its OpenAPI 3.1 document.
export { KoloClient } from "./generated/client.js";
export {
  KoloApiError,
  KoloClientBase,
  KoloNetworkError,
  buildRequest,
  defaultBaseUrl,
  getOperation,
  listOperations,
  type FetchLike,
  type KoloClientOptions,
  type KoloCredentials,
  type KoloResponse,
  type OperationInput,
  type ParamValue,
  type RequestOptions,
} from "./base.js";
export { discover, type DiscoverOptions, type DiscoveredGateway } from "./discover.js";
export {
  KoloPairError,
  deviceConnectPayload,
  generateDeviceKey,
  isExpired,
  pair,
  pairProofPayload,
  readDeviceCredential,
  refresh,
  signWithDeviceKey,
  writeDeviceCredential,
  type DeviceCredentialFile,
  type DeviceKey,
  type PairOptions,
  type PairResult,
  type RefreshOptions,
} from "./pair.js";
export {
  KoloWsError,
  connectWs,
  type CallOptions,
  type ConnectClientInfo,
  type KoloSocket,
  type KoloWsOptions,
  type WebSocketCtor,
  type WebSocketLike,
} from "./ws.js";
export type { OperationParamSpec, OperationSpec, ParamLocation } from "./operation-spec.js";
export {
  DEFAULT_PORT,
  OPENAPI_VERSION,
  SPEC_VERSION,
  operations,
  type OperationId,
  type OperationTypes,
} from "./generated/operations.js";
export {
  WS_HANDSHAKE_METHOD,
  WS_PROTOCOL_VERSION,
  wsEvents,
  wsMethods,
  type WsEvent,
  type WsEventMap,
  type WsMethod,
  type WsMethodMap,
} from "./generated/websocket.js";
export type * from "./generated/types.js";
export {
  WORK_ITEM_DECISION_REFUSALS,
  type WorkItem,
  type WorkItemCheck,
  type WorkItemDecision,
  type WorkItemDecisionRefusal,
  type WorkItemDraft,
  type WorkItemEvidenceBundle,
  type WorkItemFilter,
  type WorkItemHistoryEntry,
  type WorkItemPriority,
  type WorkItemSourceDocument,
  type WorkItemStatus,
  type WorkItemSummary,
  type WorkItemType,
  type WorkQueueDef,
  type WorkQueueRule,
} from "./workitems.js";
