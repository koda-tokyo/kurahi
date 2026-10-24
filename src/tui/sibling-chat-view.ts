import { randomUUID } from "node:crypto";
import type { GatewayChatClient, SiblingMessage } from "../tui/gateway-chat.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("tui-sibling-chat");

export type SiblingChatState = {
  currentSibling: string | null;
  messages: SiblingMessage[];
  isSubscribed: boolean;
  lastReadSeq: number;
};

export class SiblingChatView {
  private client: GatewayChatClient;
  private state: SiblingChatState;
  private eventHandler: ((event: unknown) => void) | undefined = undefined;

  /** `selfAgentId`: this terminal's agent; when set, sends are signed with its key. */
  constructor(
    client: GatewayChatClient,
    private readonly selfAgentId?: string,
  ) {
    this.client = client;
    this.state = {
      currentSibling: null,
      messages: [],
      isSubscribed: false,
      lastReadSeq: 0,
    };
  }

  async openChat(siblingName: string): Promise<void> {
    if (this.state.currentSibling === siblingName) {
      log.info(`Already in chat with ${siblingName}`);
      return;
    }

    // Close existing chat
    if (this.state.currentSibling) {
      await this.closeChat();
    }

    this.state.currentSibling = siblingName;

    // Load history
    try {
      const history = await this.client.getSiblingHistory({
        with: siblingName,
        limit: 50,
      });
      this.state.messages = history.messages;
      this.state.lastReadSeq =
        history.messages.length > 0 ? Math.max(...history.messages.map((m) => m.seq)) : 0;
    } catch (err) {
      log.error(`Failed to load history with ${siblingName}: ${String(err)}`);
      this.state.messages = [];
    }

    // Subscribe to real-time messages
    try {
      await this.client.subscribeSiblingMessages({
        from: siblingName,
      });
      this.state.isSubscribed = true;

      // Set up event handler for incoming messages
      this.eventHandler = (event: unknown) => this.handleIncomingEvent(event);
      this.client.onEvent = this.eventHandler;
    } catch (err) {
      log.error(`Failed to subscribe to ${siblingName}: ${String(err)}`);
      this.state.isSubscribed = false;
    }

    log.info(`Opened chat with ${siblingName}`);
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.state.currentSibling) {
      log.error("No sibling chat open");
      return;
    }

    try {
      const result = await this.client.sendSiblingMessage({
        to: this.state.currentSibling,
        text,
        ...(this.selfAgentId ? { fromAgentId: this.selfAgentId } : {}),
      });

      if (result.ok) {
        log.info(`Message sent to ${this.state.currentSibling} (seq: ${result.seq})`);
      } else {
        log.error(`Failed to send message to ${this.state.currentSibling}`);
      }
    } catch (err) {
      log.error(`Error sending message to ${this.state.currentSibling}: ${String(err)}`);
    }
  }

  async markAsRead(): Promise<void> {
    if (!this.state.currentSibling) {
      return;
    }

    try {
      const result = await this.client.markSiblingRead({
        with: this.state.currentSibling,
        upToSeq: this.state.lastReadSeq,
      });

      if (result.ok) {
        log.info(`Marked ${result.markedRead} messages as read with ${this.state.currentSibling}`);
      }
    } catch (err) {
      log.error(`Failed to mark messages as read: ${String(err)}`);
    }
  }

  async closeChat(): Promise<void> {
    if (!this.state.currentSibling) {
      return;
    }

    const sibling = this.state.currentSibling;

    // Mark as read before closing
    await this.markAsRead();

    // Unsubscribe
    if (this.state.isSubscribed) {
      this.client.onEvent = undefined;
      this.eventHandler = undefined;
      this.state.isSubscribed = false;
    }

    this.state.currentSibling = null;
    this.state.messages = [];

    log.info(`Closed chat with ${sibling}`);
  }

  getMessages(): SiblingMessage[] {
    return this.state.messages;
  }

  getCurrentSibling(): string | null {
    return this.state.currentSibling;
  }

  private handleIncomingEvent(event: unknown): void {
    const evt = event as { event?: string; payload?: unknown };
    if (evt.event !== "sibling") {
      return;
    }

    const payload = evt.payload as {
      type?: string;
      from?: string;
      text?: string;
      seq?: number;
      runId?: string;
      timestamp?: string;
      attachments?: Array<Record<string, unknown>>;
    } | null;

    if (!payload || payload.type !== "message") {
      return;
    }

    if (payload.from && this.state.currentSibling && payload.from !== this.state.currentSibling) {
      return; // Filter by current chat
    }

    const msg: SiblingMessage = {
      id: randomUUID(),
      runId: payload.runId || "",
      from: payload.from || "unknown",
      to: this.state.currentSibling || "unknown",
      text: payload.text || "",
      attachments: payload.attachments,
      seq: payload.seq || 0,
      timestamp: payload.timestamp || new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      readAt: undefined,
    };

    this.state.messages.push(msg);
    this.state.lastReadSeq = Math.max(this.state.lastReadSeq, msg.seq);

    log.info(`Received message from ${msg.from}: ${msg.text.slice(0, 50)}...`);
  }
}
