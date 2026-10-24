import { describe, expect, it } from "vitest";
import {
  exportMarkdown,
  filterArtifacts,
  guessType,
  lineDiff,
  nextStatuses,
  titleFromContent,
  type Artifact,
} from "./artifacts";
import { chatTitle, groupHistory, newChatKey, type HistoryRow } from "./chat-history";
import {
  allowedAgents,
  allowedModels,
  configuredModels,
  modelLabel,
  sessionKeyForAgent,
} from "./picker";
import {
  agentIdOfSession,
  formFromTemplate,
  groupPack,
  projectModeOf,
  localized,
  parseAgentList,
  projectIdOfSession,
  type ProjectTemplate,
} from "./projects";
import {
  chunkRanges,
  collapseDocumentBlocks,
  composeWithDocuments,
  MAX_UPLOAD_BYTES,
  precheckFile,
  stripProjectMarkers,
  type UploadedDocument,
} from "./uploads";

const PID = "pabcdefghij";
const pkey = (chat: string, agent = "main") => `agent:${agent}:proj-${PID}-${chat}`;

describe("permission modes and engineering pack (UI)", () => {
  it("defaults projects without a mode to act, like the gateway", () => {
    expect(projectModeOf({})).toBe("act");
    expect(projectModeOf({ mode: "plan" })).toBe("plan");
    expect(projectModeOf({ mode: "weird" })).toBe("act");
  });

  it("groups pack files by section in loading order", () => {
    const f = (section: string, path: string) => ({
      section,
      path,
      source: "project" as const,
      chars: 1,
      includedChars: 1,
      truncated: false,
    });
    const groups = groupPack({
      sections: ["rules", "processes", "guides", "templates", "prompts"],
      budget: 10,
      totalChars: 3,
      includedChars: 3,
      files: [f("prompts", "prompts/a.md"), f("rules", "rules/a.md"), f("rules", "rules/b.md")],
    });
    expect(groups.map((g) => [g.section, g.files.length])).toEqual([
      ["rules", 2],
      ["prompts", 1],
    ]);
  });
});

describe("projects (UI)", () => {
  it("reads project and agent ids from session keys", () => {
    expect(projectIdOfSession(pkey("k1"))).toBe(PID);
    expect(projectIdOfSession("agent:main:main")).toBeNull();
    expect(projectIdOfSession("agent:main:proj-short-k1")).toBeNull();
    expect(agentIdOfSession(pkey("k1", "ops"))).toBe("ops");
  });

  it("localizes with fallback", () => {
    expect(localized({ ja: "教育", en: "Education" }, "ja")).toBe("教育");
    expect(localized({ ja: "教育" }, "en")).toBe("教育");
    expect(localized(undefined, "en")).toBe("");
  });

  it("parses agent lists and prefills from templates", () => {
    expect(parseAgentList("main, ops、bad!id,main")).toEqual(["main", "ops"]);
    const tpl = {
      id: "education",
      name: { ja: "教育", en: "Education" },
      suggestedAgents: ["main"],
      demoFolder: "/home/u/packs/education",
    } as unknown as ProjectTemplate;
    expect(formFromTemplate(tpl, "ja")).toEqual({
      templateId: "education",
      name: "教育",
      folder: "/home/u/packs/education",
      agents: "main",
    });
    expect(formFromTemplate(null, "en")).toEqual({
      templateId: null,
      name: "",
      folder: "",
      agents: "",
    });
  });
});

const artifact = (over: Partial<Artifact>): Artifact => ({
  id: "a000000000001",
  title: "T",
  type: "document",
  format: "md",
  projectId: null,
  status: "draft",
  versions: [
    {
      version: 1,
      sha256: "abc",
      size: 1,
      createdAt: "2026-10-20T00:00:00Z",
      createdByUser: "owner",
      createdByAgent: null,
      sourceSession: null,
      note: null,
    },
  ],
  history: [],
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
  ...over,
});

describe("artifacts (UI)", () => {
  it("offers the review flow", () => {
    expect(nextStatuses("draft")).toEqual(["review"]);
    expect(nextStatuses("review")).toEqual(["approved", "draft"]);
    expect(nextStatuses("approved")).toEqual([]);
  });

  it("diffs text line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" },
    ]);
    expect(lineDiff("x", "x")).toEqual([{ type: "same", text: "x" }]);
    expect(lineDiff("a\nb", "a\nb\nc").filter((l) => l.type === "add")).toEqual([
      { type: "add", text: "c" },
    ]);
    expect(lineDiff("1\n2\n3", "1\n2", 2).every((l) => l.type !== "same")).toBe(true);
  });

  it("guesses titles and types", () => {
    expect(titleFromContent("\n## 残業計算ルール\n1. 時間外は 1.25 倍")).toBe("残業計算ルール");
    expect(titleFromContent("x".repeat(100))).toHaveLength(80);
    expect(guessType("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("table");
    expect(guessType("```py\nprint(1)\n```")).toBe("code");
    expect(guessType("plain text")).toBe("document");
  });

  it("exports Markdown with provenance and filters lists", () => {
    const a = artifact({ status: "approved" });
    expect(exportMarkdown(a, 1, "body")).toBe("<!-- T | v1 | approved | sha256 abc -->\nbody\n");
    const items = [
      artifact({ id: "a1", projectId: PID }),
      artifact({ id: "a2", status: "review" }),
    ];
    expect(filterArtifacts(items, PID, "").map((x) => x.id)).toEqual(["a1"]);
    expect(filterArtifacts(items, "", "review").map((x) => x.id)).toEqual(["a2"]);
  });
});

describe("chat history (UI)", () => {
  const rows: HistoryRow[] = [
    { key: "agent:main:main", derivedTitle: "Hello there", updatedAt: 3 },
    { key: pkey("k1"), label: "PAYCALC rules", updatedAt: 5 },
    {
      key: pkey("k2"),
      derivedTitle: "Data dictionary",
      lastMessagePreview: "copybook PAYREC",
      updatedAt: 9,
    },
    { key: "agent:main:chat-x", derivedTitle: "Old", updatedAt: 1 },
  ];
  const base = {
    projects: [{ id: PID, name: "Payroll" }],
    archived: ["agent:main:chat-x"],
    showArchived: false,
    query: "",
    textHits: null,
    noProjectLabel: "No project",
  };

  it("groups by project, newest first, hiding archived", () => {
    const groups = groupHistory(rows, base);
    expect(groups.map((g) => g.name)).toEqual(["Payroll", "No project"]);
    expect(groups[0].rows.map(chatTitle)).toEqual(["Data dictionary", "PAYCALC rules"]);
    expect(groups[1].rows.map((r) => r.key)).toEqual(["agent:main:main"]);
    expect(groupHistory(rows, { ...base, showArchived: true })[0].rows.map((r) => r.key)).toEqual([
      "agent:main:chat-x",
    ]);
  });

  it("searches titles, previews and server text hits", () => {
    expect(
      groupHistory(rows, { ...base, query: "paycalc" }).flatMap((g) => g.rows.map((r) => r.key)),
    ).toEqual([pkey("k1")]);
    expect(
      groupHistory(rows, { ...base, query: "payrec" }).flatMap((g) => g.rows.map((r) => r.key)),
    ).toEqual([pkey("k2")]);
    expect(
      groupHistory(rows, { ...base, query: "overtime", textHits: ["agent:main:main"] }).flatMap(
        (g) => g.rows.map((r) => r.key),
      ),
    ).toEqual(["agent:main:main"]);
  });

  it("makes new chat keys", () => {
    expect(newChatKey("main", 0)).toMatch(/^agent:main:chat-0[a-z0-9]{2}$/);
  });
});

describe("uploads (UI)", () => {
  it("pre-checks files", () => {
    expect(precheckFile({ name: "a.pdf", size: 10 })).toBeNull();
    expect(precheckFile({ name: "契約書.DOCX", size: 10 })).toBeNull();
    expect(precheckFile({ name: "a.exe", size: 10 })).toBe("type");
    expect(precheckFile({ name: "a.pdf", size: 0 })).toBe("empty");
    expect(precheckFile({ name: "a.pdf", size: MAX_UPLOAD_BYTES + 1 })).toBe("size");
  });

  it("splits into chunks", () => {
    expect(chunkRanges(10, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(chunkRanges(0, 4)).toEqual([]);
  });

  it("attaches documents and shows only their names", () => {
    const doc: UploadedDocument = {
      name: "契約書.pdf",
      kind: "pdf",
      size: 10,
      sha256: "x",
      path: "/s/p/attachments/20261020-契約書.pdf",
      projectId: PID,
      text: "第1条 ...",
      textChars: 30000,
      textTruncated: true,
    };
    const msg = composeWithDocuments("リスクを確認して", [doc]);
    expect(msg).toContain(
      '[[kurahi-document name="契約書.pdf" kind="pdf" path="/s/p/attachments/20261020-契約書.pdf"]]',
    );
    expect(msg).toContain("第1条");
    expect(msg).toContain("more characters in");
    expect(collapseDocumentBlocks(msg, (n) => `[Attached: ${n}]`)).toBe(
      "リスクを確認して\n\n[Attached: 契約書.pdf]",
    );
    expect(composeWithDocuments("hi", [])).toBe("hi");
    expect(stripProjectMarkers("[[kurahi-project]] [Project: X] folder /x\nThe answer.")).toBe(
      "The answer.",
    );
    expect(stripProjectMarkers("[[kurahi-project]]\nctx\n[[/kurahi-project]]\nAnswer")).toBe(
      "Answer",
    );
    expect(stripProjectMarkers("plain")).toBe("plain");
  });
});

describe("agent and model picker", () => {
  const agents = [
    { id: "main", identity: { name: "Kurahi" } },
    { id: "ops" },
    { id: "legal", name: "Legal" },
  ];

  it("narrows agents to the project", () => {
    expect(allowedAgents(agents, "main", null).map((a) => a.id)).toEqual(["main", "ops", "legal"]);
    expect(allowedAgents(agents, "main", { allowedAgents: [] }).map((a) => a.id)).toEqual(["main"]);
    expect(allowedAgents(agents, "main", { allowedAgents: ["legal"] })).toEqual([
      { id: "legal", label: "Legal" },
    ]);
  });

  it("reads models from the config only", () => {
    const config = {
      agents: { defaults: { model: { primary: "local/a", fallbacks: ["remote/b"] } } },
      models: { providers: { local: { models: [{ id: "a" }, { id: "c" }] } } },
    };
    expect(configuredModels(config)).toEqual(["local/a", "remote/b", "local/c"]);
    expect(configuredModels(null)).toEqual([]);
    expect(allowedModels(config, { allowedModels: ["local/c"] })).toEqual(["local/c"]);
    expect(allowedModels(config, { allowedModels: [] })).toHaveLength(3);
  });

  it("shows the configured alias as the model name", () => {
    const config = {
      agents: { defaults: { models: { "local/a": { alias: "ローカルモデル / Local model" } } } },
    };
    expect(modelLabel(config, "local/a")).toBe("ローカルモデル / Local model");
    expect(modelLabel(config, "local/b")).toBe("local/b");
    expect(modelLabel(null, "x/y")).toBe("x/y");
  });

  it("keeps the conversation when switching agents", () => {
    expect(sessionKeyForAgent("agent:main:chat-x1", "ops")).toBe("agent:ops:chat-x1");
    expect(sessionKeyForAgent("weird", "ops")).toBe("agent:ops:main");
  });
});
