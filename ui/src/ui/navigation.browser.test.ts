import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KoLoApp } from "./app";
import "../styles.css";

// oxlint-disable-next-line typescript/unbound-method
const originalConnect = KoLoApp.prototype.connect;

function mountApp(pathname: string) {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("kolo-app") as KoLoApp;
  document.body.append(app);
  return app;
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

beforeEach(() => {
  KoLoApp.prototype.connect = () => {
    // no-op: avoid real gateway WS connections in browser tests
  };
  window.__KOLO_CONTROL_UI_BASE_PATH__ = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  KoLoApp.prototype.connect = originalConnect;
  window.__KOLO_CONTROL_UI_BASE_PATH__ = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("control UI routing", () => {
  it("hydrates the tab from the location", async () => {
    const app = mountApp("/agents/sessions");
    await app.updateComplete;

    expect(app.tab).toBe("sessions");
    expect(window.location.pathname).toBe("/agents/sessions");
  });

  it("respects /ui base paths", async () => {
    const app = mountApp("/ui/automations");
    await app.updateComplete;

    expect(app.basePath).toBe("/ui");
    expect(app.tab).toBe("cron");
    expect(window.location.pathname).toBe("/ui/automations");
  });

  it("infers nested base paths", async () => {
    const app = mountApp("/apps/KoLo/agents/sessions");
    await app.updateComplete;

    expect(app.basePath).toBe("/apps/KoLo");
    expect(app.tab).toBe("sessions");
    expect(window.location.pathname).toBe("/apps/KoLo/agents/sessions");
  });

  it("honors explicit base path overrides", async () => {
    window.__KOLO_CONTROL_UI_BASE_PATH__ = "/KoLo";
    const app = mountApp("/KoLo/agents/sessions");
    await app.updateComplete;

    expect(app.basePath).toBe("/KoLo");
    expect(app.tab).toBe("sessions");
    expect(window.location.pathname).toBe("/KoLo/agents/sessions");
  });

  it("updates the URL when clicking nav items", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/connections"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(window.location.pathname).toBe("/connections");
  });

  it("keeps chat and nav usable on narrow viewports", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const split = app.querySelector(".chat-split-container");
    expect(split).not.toBeNull();
    if (split) {
      expect(getComputedStyle(split).position).not.toBe("fixed");
    }

    const chatMain = app.querySelector(".chat-main");
    expect(chatMain).not.toBeNull();
    if (chatMain) {
      expect(getComputedStyle(chatMain).display).not.toBe("none");
    }

    if (split) {
      split.classList.add("chat-split-container--open");
      await app.updateComplete;
      expect(getComputedStyle(split).position).toBe("fixed");
    }
    if (chatMain) {
      expect(getComputedStyle(chatMain).display).toBe("none");
    }
  });

  it("auto-scrolls chat history to the latest message", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const initialContainer = app.querySelector<HTMLElement>(".chat-thread");
    expect(initialContainer).not.toBeNull();
    if (!initialContainer) {
      return;
    }
    initialContainer.style.maxHeight = "180px";
    initialContainer.style.overflow = "auto";

    app.chatMessages = Array.from({ length: 60 }, (_, index) => ({
      role: "assistant",
      content: `Line ${index} - ${"x".repeat(200)}`,
      timestamp: Date.now() + index,
    }));

    await app.updateComplete;
    for (let i = 0; i < 6; i++) {
      await nextFrame();
    }

    const container = app.querySelector<HTMLElement>(".chat-thread");
    expect(container).not.toBeNull();
    if (!container) {
      return;
    }
    const maxScroll = container.scrollHeight - container.clientHeight;
    expect(maxScroll).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      if (container.scrollTop === maxScroll) {
        break;
      }
      await nextFrame();
    }
    expect(container.scrollTop).toBe(maxScroll);
  });

  it("hydrates token from URL params and strips it", async () => {
    const app = mountApp("/ui/overview?token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    // /overview is an old path: it now redirects to Home.
    expect(window.location.pathname).toBe("/ui/home");
    expect(window.location.search).toBe("");
  });

  it("hydrates password from URL params and strips it", async () => {
    const app = mountApp("/ui/overview?password=sekret");
    await app.updateComplete;

    expect(app.password).toBe("sekret");
    expect(window.location.pathname).toBe("/ui/home");
    expect(window.location.search).toBe("");
  });

  it("hydrates token from URL params even when settings already set", async () => {
    localStorage.setItem("KoLo.control.settings.v1", JSON.stringify({ token: "existing-token" }));
    const app = mountApp("/ui/overview?token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    // /overview is an old path: it now redirects to Home.
    expect(window.location.pathname).toBe("/ui/home");
    expect(window.location.search).toBe("");
  });

  it("redirects old URLs to the new sidebar paths", async () => {
    const cases: Array<[string, string, string]> = [
      ["/overview", "home", "/home"],
      ["/fleet", "fleet", "/agents"],
      ["/cron", "cron", "/automations"],
      ["/schedules", "cron", "/automations"],
      ["/channels", "channels", "/connections"],
      ["/instances", "instances", "/devices"],
      ["/nodes", "nodes", "/devices/nodes"],
      ["/debug", "debug", "/settings/debug"],
      ["/logs", "logs", "/settings/logs"],
      ["/ui/cron", "cron", "/ui/automations"],
    ];
    for (const [from, tab, to] of cases) {
      document.body.innerHTML = "";
      const app = mountApp(from);
      await app.updateComplete;
      expect(app.tab, from).toBe(tab);
      expect(window.location.pathname, from).toBe(to);
    }
  });

  it("renders the enterprise sidebar groups with the approvals badge", async () => {
    const app = mountApp("/home");
    await app.updateComplete;
    app.execApprovalQueue = [
      {
        id: "a1",
        request: { command: "ls" },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
    ];
    await app.updateComplete;
    const hrefs = [...app.querySelectorAll<HTMLAnchorElement>("a.nav-item")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "/home",
      "/chat",
      "/projects",
      "/approvals",
      "/agents",
      "/artifacts",
      "/automations",
      "/skills",
      "/connections",
      "/policies",
      "/audit",
      "/evaluation",
      "/devices",
      "/models",
      "/settings",
      "/help",
    ]);
    expect(app.querySelector('a.nav-item[href="/approvals"] .nav-badge')?.textContent?.trim()).toBe(
      "1",
    );
  });
});
