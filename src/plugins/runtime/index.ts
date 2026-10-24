import { createRequire } from "node:module";
import type { PluginRuntime } from "./types.js";
import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import { createMemoryGetTool, createMemorySearchTool } from "../../agents/tools/memory-tool.js";
import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import {
  hasControlCommand,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../auto-reply/commands-registry.js";
import {
  formatAgentEnvelope,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "../../auto-reply/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply, shouldAckReaction } from "../../channels/ack-reactions.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { discordMessageActions } from "../../channels/plugins/actions/discord.js";
import { signalMessageActions } from "../../channels/plugins/actions/signal.js";
import { telegramMessageActions } from "../../channels/plugins/actions/telegram.js";
import { createWhatsAppLoginTool } from "../../channels/plugins/agent-tools/whatsapp-login.js";
import { recordInboundSession } from "../../channels/session.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
import { shouldLogVerbose } from "../../globals.js";
import { getChannelActivity, recordChannelActivity } from "../../infra/channel-activity.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  listLineAccountIds,
  normalizeAccountId as normalizeLineAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../line/accounts.js";
import { createQuickReplyItems } from "../../line/quick-reply.js";
import { buildTemplateMessageFromPayload } from "../../line/template-messages.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { isVoiceCompatibleAudio } from "../../media/audio.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { getImageMetadata, resizeToJpeg } from "../../media/image-ops.js";
import { detectMime } from "../../media/mime.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { lazyModule } from "../../shared/lazy-module.js";
import { collectTelegramUnmentionedGroupIds } from "../../telegram/audit.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import { getActiveWebListener } from "../../web/active-listener.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../web/auth-store.js";
import { loadWebMedia } from "../../web/media.js";
import { formatNativeDependencyHint } from "./native-deps.js";

// Channel and provider modules load on first use: they pull in Slack Bolt, discord carbon, grammy,
// the LINE SDK, Baileys and the TTS provider SDKs, which every plugin load (each CLI command and
// each gateway start) paid for even when no channel is configured. Only async exports are wrapped,
// so the runtime surface plugins see is unchanged.
const slackActions = lazyModule(() => import("../../agents/tools/slack-actions.js"));
const whatsappActions = lazyModule(() => import("../../agents/tools/whatsapp-actions.js"));
const webChannel = lazyModule(() => import("../../channels/web/index.js"));
const discordAudit = lazyModule(() => import("../../discord/audit.js"));
const discordDirectory = lazyModule(() => import("../../discord/directory-live.js"));
const discordMonitor = lazyModule(() => import("../../discord/monitor.js"));
const discordProbe = lazyModule(() => import("../../discord/probe.js"));
const discordResolveChannels = lazyModule(() => import("../../discord/resolve-channels.js"));
const discordResolveUsers = lazyModule(() => import("../../discord/resolve-users.js"));
const discordSend = lazyModule(() => import("../../discord/send.js"));
const imessageMonitor = lazyModule(() => import("../../imessage/monitor.js"));
const imessageProbe = lazyModule(() => import("../../imessage/probe.js"));
const imessageSend = lazyModule(() => import("../../imessage/send.js"));
const lineMonitor = lazyModule(() => import("../../line/monitor.js"));
const lineProbe = lazyModule(() => import("../../line/probe.js"));
const lineSend = lazyModule(() => import("../../line/send.js"));
const signalMonitor = lazyModule(() => import("../../signal/index.js"));
const signalProbe = lazyModule(() => import("../../signal/probe.js"));
const signalSend = lazyModule(() => import("../../signal/send.js"));
const slackDirectory = lazyModule(() => import("../../slack/directory-live.js"));
const slackMonitor = lazyModule(() => import("../../slack/index.js"));
const slackProbe = lazyModule(() => import("../../slack/probe.js"));
const slackResolveChannels = lazyModule(() => import("../../slack/resolve-channels.js"));
const slackResolveUsers = lazyModule(() => import("../../slack/resolve-users.js"));
const slackSend = lazyModule(() => import("../../slack/send.js"));
const telegramAudit = lazyModule(() => import("../../telegram/audit.js"));
const telegramMonitor = lazyModule(() => import("../../telegram/monitor.js"));
const telegramProbe = lazyModule(() => import("../../telegram/probe.js"));
const telegramSend = lazyModule(() => import("../../telegram/send.js"));
const tts = lazyModule(() => import("../../tts/tts.js"));
const webLoginQr = lazyModule(() => import("../../web/login-qr.js"));
const webLogin = lazyModule(() => import("../../web/login.js"));
const webOutbound = lazyModule(() => import("../../web/outbound.js"));

let cachedVersion: string | null = null;

function resolveVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
}

export function createPluginRuntime(): PluginRuntime {
  return {
    version: resolveVersion(),
    config: {
      loadConfig,
      writeConfigFile,
    },
    system: {
      enqueueSystemEvent,
      runCommandWithTimeout,
      formatNativeDependencyHint,
    },
    media: {
      loadWebMedia,
      detectMime,
      mediaKindFromMime,
      isVoiceCompatibleAudio,
      getImageMetadata,
      resizeToJpeg,
    },
    tts: {
      textToSpeechTelephony: tts.fn("textToSpeechTelephony"),
    },
    tools: {
      createMemoryGetTool,
      createMemorySearchTool,
      registerMemoryCli,
    },
    channel: {
      text: {
        chunkByNewline,
        chunkMarkdownText,
        chunkMarkdownTextWithMode,
        chunkText,
        chunkTextWithMode,
        resolveChunkMode,
        resolveTextChunkLimit,
        hasControlCommand,
        resolveMarkdownTableMode,
        convertMarkdownTables,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        createReplyDispatcherWithTyping,
        resolveEffectiveMessagesConfig,
        resolveHumanDelayConfig,
        dispatchReplyFromConfig,
        finalizeInboundContext,
        formatAgentEnvelope,
        formatInboundEnvelope,
        resolveEnvelopeFormatOptions,
      },
      routing: {
        resolveAgentRoute,
      },
      pairing: {
        buildPairingReply,
        readAllowFromStore: readChannelAllowFromStore,
        upsertPairingRequest: upsertChannelPairingRequest,
      },
      media: {
        fetchRemoteMedia,
        saveMediaBuffer,
      },
      activity: {
        record: recordChannelActivity,
        get: getChannelActivity,
      },
      session: {
        resolveStorePath,
        readSessionUpdatedAt,
        recordSessionMetaFromInbound,
        recordInboundSession,
        updateLastRoute,
      },
      mentions: {
        buildMentionRegexes,
        matchesMentionPatterns,
        matchesMentionWithExplicit,
      },
      reactions: {
        shouldAckReaction,
        removeAckReactionAfterReply,
      },
      groups: {
        resolveGroupPolicy: resolveChannelGroupPolicy,
        resolveRequireMention: resolveChannelGroupRequireMention,
      },
      debounce: {
        createInboundDebouncer,
        resolveInboundDebounceMs,
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers,
        isControlCommandMessage,
        shouldComputeCommandAuthorized,
        shouldHandleTextCommands,
      },
      discord: {
        messageActions: discordMessageActions,
        auditChannelPermissions: discordAudit.fn("auditDiscordChannelPermissions"),
        listDirectoryGroupsLive: discordDirectory.fn("listDiscordDirectoryGroupsLive"),
        listDirectoryPeersLive: discordDirectory.fn("listDiscordDirectoryPeersLive"),
        probeDiscord: discordProbe.fn("probeDiscord"),
        resolveChannelAllowlist: discordResolveChannels.fn("resolveDiscordChannelAllowlist"),
        resolveUserAllowlist: discordResolveUsers.fn("resolveDiscordUserAllowlist"),
        sendMessageDiscord: discordSend.fn("sendMessageDiscord"),
        sendPollDiscord: discordSend.fn("sendPollDiscord"),
        monitorDiscordProvider: discordMonitor.fn("monitorDiscordProvider"),
      },
      slack: {
        listDirectoryGroupsLive: slackDirectory.fn("listSlackDirectoryGroupsLive"),
        listDirectoryPeersLive: slackDirectory.fn("listSlackDirectoryPeersLive"),
        probeSlack: slackProbe.fn("probeSlack"),
        resolveChannelAllowlist: slackResolveChannels.fn("resolveSlackChannelAllowlist"),
        resolveUserAllowlist: slackResolveUsers.fn("resolveSlackUserAllowlist"),
        sendMessageSlack: slackSend.fn("sendMessageSlack"),
        monitorSlackProvider: slackMonitor.fn("monitorSlackProvider"),
        handleSlackAction: slackActions.fn("handleSlackAction"),
      },
      telegram: {
        auditGroupMembership: telegramAudit.fn("auditTelegramGroupMembership"),
        collectUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
        probeTelegram: telegramProbe.fn("probeTelegram"),
        resolveTelegramToken,
        sendMessageTelegram: telegramSend.fn("sendMessageTelegram"),
        monitorTelegramProvider: telegramMonitor.fn("monitorTelegramProvider"),
        messageActions: telegramMessageActions,
      },
      signal: {
        probeSignal: signalProbe.fn("probeSignal"),
        sendMessageSignal: signalSend.fn("sendMessageSignal"),
        monitorSignalProvider: signalMonitor.fn("monitorSignalProvider"),
        messageActions: signalMessageActions,
      },
      imessage: {
        monitorIMessageProvider: imessageMonitor.fn("monitorIMessageProvider"),
        probeIMessage: imessageProbe.fn("probeIMessage"),
        sendMessageIMessage: imessageSend.fn("sendMessageIMessage"),
      },
      whatsapp: {
        getActiveWebListener,
        getWebAuthAgeMs,
        logoutWeb,
        logWebSelfId,
        readWebSelfId,
        webAuthExists,
        sendMessageWhatsApp: webOutbound.fn("sendMessageWhatsApp"),
        sendPollWhatsApp: webOutbound.fn("sendPollWhatsApp"),
        loginWeb: webLogin.fn("loginWeb"),
        startWebLoginWithQr: webLoginQr.fn("startWebLoginWithQr"),
        waitForWebLogin: webLoginQr.fn("waitForWebLogin"),
        monitorWebChannel: webChannel.fn("monitorWebChannel"),
        handleWhatsAppAction: whatsappActions.fn("handleWhatsAppAction"),
        createLoginTool: createWhatsAppLoginTool,
      },
      line: {
        listLineAccountIds,
        resolveDefaultLineAccountId,
        resolveLineAccount,
        normalizeAccountId: normalizeLineAccountId,
        probeLineBot: lineProbe.fn("probeLineBot"),
        sendMessageLine: lineSend.fn("sendMessageLine"),
        pushMessageLine: lineSend.fn("pushMessageLine"),
        pushMessagesLine: lineSend.fn("pushMessagesLine"),
        pushFlexMessage: lineSend.fn("pushFlexMessage"),
        pushTemplateMessage: lineSend.fn("pushTemplateMessage"),
        pushLocationMessage: lineSend.fn("pushLocationMessage"),
        pushTextMessageWithQuickReplies: lineSend.fn("pushTextMessageWithQuickReplies"),
        createQuickReplyItems,
        buildTemplateMessageFromPayload,
        monitorLineProvider: lineMonitor.fn("monitorLineProvider"),
      },
    },
    logging: {
      shouldLogVerbose,
      getChildLogger: (bindings, opts) => {
        const logger = getChildLogger(bindings, {
          level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
        });
        return {
          debug: (message) => logger.debug?.(message),
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
        };
      },
    },
    state: {
      resolveStateDir,
    },
  };
}

export type { PluginRuntime } from "./types.js";
