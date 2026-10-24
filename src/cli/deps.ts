import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import { lazyModule } from "../shared/lazy-module.js";
import { logWebSelfId } from "../web/auth-store.js";

// Each channel's send module (and its SDK) loads on the first send through it, not when the CLI or
// the gateway builds its deps; see src/shared/lazy-module.ts.
const webSend = lazyModule(() => import("../channels/web/index.js"));
const discordSend = lazyModule(() => import("../discord/send.js"));
const imessageSend = lazyModule(() => import("../imessage/send.js"));
const signalSend = lazyModule(() => import("../signal/send.js"));
const slackSend = lazyModule(() => import("../slack/send.js"));
const telegramSend = lazyModule(() => import("../telegram/send.js"));

const sendMessageWhatsApp = webSend.fn("sendMessageWhatsApp");
const sendMessageDiscord = discordSend.fn("sendMessageDiscord");
const sendMessageIMessage = imessageSend.fn("sendMessageIMessage");
const sendMessageSignal = signalSend.fn("sendMessageSignal");
const sendMessageSlack = slackSend.fn("sendMessageSlack");
const sendMessageTelegram = telegramSend.fn("sendMessageTelegram");

export type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageDiscord: typeof sendMessageDiscord;
  sendMessageSlack: typeof sendMessageSlack;
  sendMessageSignal: typeof sendMessageSignal;
  sendMessageIMessage: typeof sendMessageIMessage;
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp,
    sendMessageTelegram,
    sendMessageDiscord,
    sendMessageSlack,
    sendMessageSignal,
    sendMessageIMessage,
  };
}

// Provider docking: extend this mapping when adding new outbound send deps.
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return {
    sendWhatsApp: deps.sendMessageWhatsApp,
    sendTelegram: deps.sendMessageTelegram,
    sendDiscord: deps.sendMessageDiscord,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
  };
}

export { logWebSelfId };
