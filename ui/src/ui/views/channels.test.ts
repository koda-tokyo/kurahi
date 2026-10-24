import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GoogleChatStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { renderChannels } from "./channels";

describe("channel status routing", () => {
  it("passes the Google Chat gateway snapshot to its status card", () => {
    const googlechat: GoogleChatStatus = { configured: true, running: true };
    const props: ChannelsProps = {
      connected: true,
      loading: false,
      snapshot: {
        ts: 1,
        channelOrder: ["googlechat"],
        channelLabels: { googlechat: "Google Chat" },
        channels: { googlechat },
        channelAccounts: {},
        channelDefaultAccountId: {},
      },
      lastError: null,
      lastSuccessAt: null,
      whatsappMessage: null,
      whatsappQrDataUrl: null,
      whatsappConnected: null,
      whatsappBusy: false,
      configSchema: null,
      configSchemaLoading: false,
      configForm: null,
      configUiHints: {},
      configSaving: false,
      configFormDirty: false,
      nostrProfileFormState: null,
      nostrProfileAccountId: null,
      onRefresh: vi.fn(),
      onWhatsAppStart: vi.fn(),
      onWhatsAppWait: vi.fn(),
      onWhatsAppLogout: vi.fn(),
      onConfigPatch: vi.fn(),
      onConfigSave: vi.fn(),
      onConfigReload: vi.fn(),
      onNostrProfileEdit: vi.fn(),
      onNostrProfileCancel: vi.fn(),
      onNostrProfileFieldChange: vi.fn(),
      onNostrProfileSave: vi.fn(),
      onNostrProfileImport: vi.fn(),
      onNostrProfileToggleAdvanced: vi.fn(),
    };
    const root = document.createElement("div");
    render(renderChannels(props), root);

    // Inspect the rendered card, not the raw snapshot printed below it.
    const card = root.querySelector(".grid > .card");
    expect(card?.querySelector(".card-title")?.textContent).toBe("Google Chat");
    const status = new Map(
      Array.from(card?.querySelectorAll(".status-list > div") ?? [], (row) => [
        row.querySelector(".label")?.textContent?.trim(),
        row.querySelector("span:last-child")?.textContent?.trim(),
      ]),
    );
    expect(status.get("Configured")).toBe("Yes");
    expect(status.get("Running")).toBe("Yes");
  });
});
