// LINE WORKS connector configuration: an app in the LINE WORKS Developer Console with a service
// account (API 2.0 "Service Account authentication", a JWT signed with the app's private key), one
// bot, and the channels and users the bot may address. The private key and client secret live in
// the secret store, never in the config file.
//
// Facts used here (LINE WORKS Developers, read 2026-10-25):
//   JWT (RS256; iss = client id, sub = service account, exp at most 60 min after iat), token
//   endpoint and form, token lifetime (1 h or 24 h, `expires_in`), service-account scope limits
//     https://developers.worksmobile.com/jp/docs/auth-jwt
//   send to a user / a channel (POST, 201; scope bot or bot.message)
//     https://developers.worksmobile.com/jp/docs/bot-user-message-send
//     https://developers.worksmobile.com/jp/docs/bot-channel-message-send
//   text content, at most 2,000 characters  https://developers.worksmobile.com/jp/docs/bot-send-text
//   channel info / members (scopes bot, bot.message, bot.read)
//     https://developers.worksmobile.com/jp/docs/bot-channel-get
//     https://developers.worksmobile.com/jp/docs/bot-channel-member-list
//   rate limits (per API per domain: 60/min Free, 240/min Standard and Advanced; 5 parallel)
//     https://developers.worksmobile.com/jp/docs/rate-limits
// There is no API to read message history: a bot receives messages only through its callback
// URL (https://developers.worksmobile.com/jp/docs/bot-callback), which this connector does not
// host. So "read" here means channel information and members, never messages.
import { intParam } from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "line-works";
export const PRIVATE_KEY_NAME = "connector.line-works.privateKey";
export const CLIENT_SECRET_NAME = "connector.line-works.clientSecret";

export const TOKEN_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
export const API_BASE = "https://www.worksapis.com/v1.0";

export const SCOPES = { read: "bot.read", send: "bot.message" } as const;

/** LINE WORKS text messages are limited to 2,000 characters. */
export const MAX_TEXT = 2000;

const BOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_ID = /^[A-Za-z0-9@._-]{1,128}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{4,128}$/;
const SERVICE_ACCOUNT = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,253}$/;

export function isTargetId(v: unknown): v is string {
  return typeof v === "string" && TARGET_ID.test(v);
}

export type LineWorksSettings = {
  clientId?: string;
  serviceAccount?: string;
  botId?: string;
  channels: string[];
  users: string[];
  send: boolean;
  probeIntervalMinutes: number;
  ratePerSecond: number;
  approvalTimeoutMs: number;
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const ids = (v: unknown) =>
  [...new Set((Array.isArray(v) ? v : []).filter(isTargetId))].slice(0, 100);

export function readSettings(raw: unknown): LineWorksSettings {
  const c = rec(raw);
  const write = rec(c.write);
  return {
    clientId: str(c.clientId),
    serviceAccount: str(c.serviceAccount),
    botId: str(c.botId),
    channels: ids(c.channels),
    users: ids(c.users),
    send: write.send === true,
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 30, 5, 1440),
    // 60 requests per minute per API on the Free plan: one per second stays inside it.
    ratePerSecond: intParam(c.ratePerSecond, 1, 1, 4),
    approvalTimeoutMs: intParam(c.approvalTimeoutSeconds, 120, 30, 600) * 1000,
  };
}

export function configProblems(
  s: LineWorksSettings,
  secrets: { privateKey?: string; clientSecret?: string },
): string[] {
  const problems: string[] = [];
  if (!s.clientId || !CLIENT_ID.test(s.clientId)) {
    problems.push("clientId (the app's Client ID) is not set");
  }
  if (!s.serviceAccount || !SERVICE_ACCOUNT.test(s.serviceAccount)) {
    problems.push("serviceAccount (the app's Service Account id) is not set");
  }
  if (!s.botId || !BOT_ID.test(s.botId)) {
    problems.push("botId is not set");
  }
  if (s.channels.length === 0 && s.users.length === 0) {
    problems.push("channels or users must list at least one channel id or user id");
  }
  if (!secrets.privateKey) {
    problems.push(`private key missing: run kurahi secrets set ${PRIVATE_KEY_NAME}`);
  }
  if (!secrets.clientSecret) {
    problems.push(`client secret missing: run kurahi secrets set ${CLIENT_SECRET_NAME}`);
  }
  return problems;
}

export function requestedScopes(s: LineWorksSettings): string[] {
  return s.send ? [SCOPES.read, SCOPES.send] : [SCOPES.read];
}
