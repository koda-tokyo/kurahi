import { render } from "lit";
import "../src/styles.css";
import type { AppViewState } from "../src/ui/app-view-state";
import type { Project } from "../src/ui/controllers/projects";
import { emptyTerminal } from "../src/ui/controllers/terminal";
import { emptyVoice } from "../src/ui/controllers/voice";
import { setLocale } from "../src/ui/i18n";
import { renderIndustrialModernisation } from "../src/ui/views/industrial-modernisation";
import { renderTerminal } from "../src/ui/views/terminal";

const project = {
  id: "fictional-aoba-plant-7",
  plugins: ["legacy-analyzer"],
  name: "Aoba Components Plant 7 (Fictional demo)",
  folder: "/demo/aoba-components/plant-7",
  mode: "plan",
  rules: {
    readOnly: ["/demo/aoba-components/plant-7"],
    writable: ["/demo/aoba-components/plant-7/outputs"],
    artifactApprovalRequired: true,
    instructions: [],
  },
  templateId: "industry-legacy-modernisation",
  allowedAgents: [],
  allowedModels: [],
  suggestedSkills: [],
  starterPrompts: [],
  terminalProfile: "industrial-readonly",
  archived: false,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  createdBy: "demo",
} satisfies Project;

setLocale("en");
document.documentElement.dataset.theme = "dark";
document.body.className = "industrial-visual-fixture";

const voiceDemo = new URLSearchParams(location.search).get("view") === "voice";
const terminalDemo = new URLSearchParams(location.search).get("view") === "terminal";
const demoState = {
  voice: voiceDemo
    ? {
        ...emptyVoice(),
        phase: "ready",
        projectId: project.id,
        text: "Fictional transcript fixture — no microphone or gateway connected. Summarize the verified modernization findings for Plant 7.",
      }
    : emptyVoice(),
  voiceCapture: null,
  startProjectVoice: async () => undefined,
  stopProjectVoice: async () => undefined,
  cancelProjectVoice: () => undefined,
  patchVoiceText: () => undefined,
  useVoiceDraft: async () => undefined,
  locale: "en",
  connected: true,
  execApprovalQueue: [],
  setProjectView: () => undefined,
  startProjectChat: async () => undefined,
  openProjectTerminal: async () => undefined,
  runTerminalAction: async () => undefined,
  refreshTerminal: async () => undefined,
  patchTerminalDraft: () => undefined,
  terminal: {
    ...emptyTerminal(),
    synced: true,
    session: {
      sessionId: "fictional-session",
      projectId: project.id,
      name: "Workbench",
      mode: "plan",
      sandboxed: true,
      cwd: project.folder,
      seq: 3,
      limits: {
        maxLineLength: 4096,
        idleTimeoutMs: 1800000,
        outputBytesPerSecond: 524288,
        approvalTimeoutMs: 120000,
      },
    },
    events: [
      {
        sessionId: "fictional-session",
        seq: 1,
        ts: 1,
        type: "stdout",
        data: "Fictional plant fixture — illustrative output; no gateway connected.\n\n$ ls\r\nassets  evidence  outputs  README.md\r\n",
      },
      {
        sessionId: "fictional-session",
        seq: 2,
        ts: 2,
        type: "exit",
        runId: "fictional-run",
        exitCode: 0,
        signal: null,
        durationMs: 12,
        reason: "exited",
      },
      { sessionId: "fictional-session", seq: 3, ts: 3, type: "stdout", data: "$ " },
    ],
  },
} as unknown as AppViewState;
render(
  terminalDemo
    ? renderTerminal(demoState, project)
    : renderIndustrialModernisation(demoState, project),
  document.querySelector("#fixture")!,
);
