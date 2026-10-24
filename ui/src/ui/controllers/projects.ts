// Projects in the Control UI (v0.3): list, create from a template, project page data.
import type { GatewayBrowserClient } from "../gateway";

export type LocalizedText = { ja?: string; en?: string };

export type ProjectRules = {
  readOnly: string[];
  writable: string[];
  artifactApprovalRequired: boolean;
  instructions: LocalizedText[];
};

export type ProjectMode = "read" | "plan" | "act";

export const PROJECT_MODES: ProjectMode[] = ["read", "plan", "act"];

/** Projects made before modes existed behave as "act" (the gateway uses the same default). */
export function projectModeOf(p: { mode?: ProjectMode | string }): ProjectMode {
  return p.mode === "read" || p.mode === "plan" || p.mode === "act" ? p.mode : "act";
}

export type PackFile = {
  section: string;
  source: "project" | "template";
  path: string;
  chars: number;
  includedChars: number;
  truncated: boolean;
};

export type ProjectPack = {
  sections: string[];
  budget: number;
  totalChars: number;
  includedChars: number;
  files: PackFile[];
};

/** Pack files grouped by section, in the gateway's loading order. */
export function groupPack(pack: ProjectPack): Array<{ section: string; files: PackFile[] }> {
  return pack.sections
    .map((section) => ({ section, files: pack.files.filter((f) => f.section === section) }))
    .filter((g) => g.files.length > 0);
}

export type Project = {
  plugins?: string[];
  id: string;
  name: string;
  folder: string;
  allowedAgents: string[];
  allowedModels: string[];
  templateId: string | null;
  rules: ProjectRules;
  suggestedSkills: string[];
  starterPrompts: LocalizedText[];
  terminalProfile: string;
  mode?: ProjectMode;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type ProjectTemplate = {
  plugins?: string[];
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  folders: string[];
  rules: ProjectRules;
  suggestedAgents: string[];
  suggestedSkills: string[];
  starterPrompts: LocalizedText[];
  terminalProfile: string;
  demoFolder?: string;
};

export type TerminalProfile = {
  id: string;
  label: LocalizedText;
  allowedCommandsPolicy: LocalizedText;
  enabledByDefault: boolean;
  clientIsolated: boolean;
  justInTime: boolean;
};

export type ProjectFile = {
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
  access: "read" | "write";
};

export type ProjectView =
  | "business"
  | "terminal"
  | "chat"
  | "modernize"
  | "files"
  | "artifacts"
  | "pack"
  | "agents"
  | "rules"
  | "history";

export const PROJECT_VIEWS: ProjectView[] = [
  "chat",
  "files",
  "artifacts",
  "pack",
  "agents",
  "rules",
  "history",
];

export type NewProjectForm = {
  templateId: string | null;
  name: string;
  folder: string;
  agents: string;
};

export type ProjectsState = {
  loading: boolean;
  error: string | null;
  projects: Project[];
  showArchived: boolean;
  templates: ProjectTemplate[];
  terminalProfiles: TerminalProfile[];
  selectedId: string | null;
  view: ProjectView;
  files: ProjectFile[] | null;
  filesError: string | null;
  pack: ProjectPack | null;
  creating: boolean;
  form: NewProjectForm;
  formError: string | null;
  busy: boolean;
};

export const DEFAULT_PROJECTS_STATE: ProjectsState = {
  loading: false,
  error: null,
  projects: [],
  showArchived: false,
  templates: [],
  terminalProfiles: [],
  selectedId: null,
  view: "chat",
  files: null,
  filesError: null,
  pack: null,
  creating: false,
  form: { templateId: null, name: "", folder: "", agents: "" },
  formError: null,
  busy: false,
};

type Host = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  projects: ProjectsState;
};

function patch(host: Host, next: Partial<ProjectsState>) {
  host.projects = { ...host.projects, ...next };
}

/** Pick the text for a locale, falling back to the other language. */
export function localized(text: LocalizedText | undefined, locale: string): string {
  if (!text) {
    return "";
  }
  return (locale === "ja" ? (text.ja ?? text.en) : (text.en ?? text.ja)) ?? "";
}

/** Keep the project list in most-recently-updated order, with stable ties. */
export function sortProjectsByRecent(projects: Project[]): Project[] {
  return projects
    .map((project, index) => ({ project, index, updated: Date.parse(project.updatedAt) }))
    .toSorted((a, b) => {
      const aTime = Number.isFinite(a.updated) ? a.updated : 0;
      const bTime = Number.isFinite(b.updated) ? b.updated : 0;
      return bTime - aTime || a.index - b.index;
    })
    .map(({ project }) => project);
}

/** Apply the default-hidden archive preference to any project collection. */
export function visibleProjects(projects: Project[], showArchived: boolean): Project[] {
  return sortProjectsByRecent(projects.filter((project) => showArchived || !project.archived));
}

const PROJECT_KEY_RE = /^agent:([^:]+):proj-(p[a-z0-9]{10})-([a-z0-9]{1,32})$/;

/** The project a chat session belongs to (from its key), or null. */
export function projectIdOfSession(key: string): string | null {
  return PROJECT_KEY_RE.exec(key)?.[2] ?? null;
}

export function agentIdOfSession(key: string): string | null {
  return /^agent:([^:]+):/.exec(key)?.[1] ?? null;
}

/** Comma/space separated agent ids from the form. */
export function parseAgentList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,、]+/)
        .map((s) => s.trim())
        .filter((s) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s)),
    ),
  ];
}

/** Prefill the new-project form from a template. */
export function formFromTemplate(tpl: ProjectTemplate | null, locale: string): NewProjectForm {
  return {
    templateId: tpl?.id ?? null,
    name: tpl ? localized(tpl.name, locale) : "",
    folder: tpl?.demoFolder ?? "",
    agents: (tpl?.suggestedAgents ?? []).join(", "),
  };
}

export async function loadProjects(host: Host) {
  if (!host.client || !host.connected) {
    return;
  }
  patch(host, { loading: true, error: null });
  try {
    const [listResult, templatesResult] = await Promise.allSettled([
      host.client.request("projects.list", {
        includeArchived: host.projects.showArchived,
      }) as Promise<{
        projects?: Project[];
      }>,
      host.client.request("projects.templates", {}) as Promise<{
        templates?: ProjectTemplate[];
        terminalProfiles?: TerminalProfile[];
      }>,
    ]);
    const list = listResult.status === "fulfilled" ? listResult.value : null;
    const tpl = templatesResult.status === "fulfilled" ? templatesResult.value : null;
    const projects = list?.projects
      ? visibleProjects(list.projects, host.projects.showArchived)
      : null;
    const selectedId = projects?.some((project) => project.id === host.projects.selectedId)
      ? host.projects.selectedId
      : null;
    patch(host, {
      loading: false,
      ...(projects ? { projects, selectedId } : {}),
      ...(tpl
        ? { templates: tpl.templates ?? [], terminalProfiles: tpl.terminalProfiles ?? [] }
        : {}),
      error:
        listResult.status === "rejected"
          ? String(listResult.reason)
          : templatesResult.status === "rejected"
            ? String(templatesResult.reason)
            : null,
    });
  } catch (err) {
    patch(host, { loading: false, error: String(err) });
  }
}

export async function loadProjectFiles(host: Host) {
  const id = host.projects.selectedId;
  if (!host.client || !host.connected || !id) {
    return;
  }
  try {
    const res = (await host.client.request("projects.files", { id })) as { files?: ProjectFile[] };
    patch(host, { files: res?.files ?? [], filesError: null });
  } catch (err) {
    patch(host, { files: [], filesError: String(err) });
  }
}

export async function createProjectFromForm(host: Host): Promise<Project | null> {
  if (!host.client || !host.connected) {
    return null;
  }
  const f = host.projects.form;
  patch(host, { busy: true, formError: null });
  try {
    const res = (await host.client.request("projects.create", {
      name: f.name,
      folder: f.folder,
      templateId: f.templateId ?? undefined,
      allowedAgents: parseAgentList(f.agents),
    })) as { project?: Project };
    const project = res?.project ?? null;
    patch(host, {
      busy: false,
      creating: false,
      projects: project ? [...host.projects.projects, project] : host.projects.projects,
      selectedId: project?.id ?? host.projects.selectedId,
      view: "chat",
    });
    return project;
  } catch (err) {
    patch(host, { busy: false, formError: String(err) });
    return null;
  }
}

export async function archiveProject(host: Host, id: string) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    await host.client.request("projects.archive", { id, archived: true });
    patch(host, {
      projects: host.projects.projects.filter((p) => p.id !== id),
      selectedId: host.projects.selectedId === id ? null : host.projects.selectedId,
    });
  } catch (err) {
    patch(host, { error: String(err) });
  }
}

/** Ask the gateway for a new chat session key in a project. */
export async function newProjectChatKey(
  host: Host,
  projectId: string,
  agentId?: string,
): Promise<string | null> {
  if (!host.client || !host.connected) {
    return null;
  }
  try {
    const res = (await host.client.request("projects.chatKey", { id: projectId, agentId })) as {
      sessionKey?: string;
    };
    return res?.sessionKey ?? null;
  } catch (err) {
    patch(host, { error: String(err) });
    return null;
  }
}

export async function loadProjectPack(host: Host) {
  const id = host.projects.selectedId;
  if (!host.client || !host.connected || !id) {
    return;
  }
  try {
    const res = (await host.client.request("projects.pack", { id })) as ProjectPack;
    patch(host, { pack: res, filesError: null });
  } catch (err) {
    patch(host, { pack: null, filesError: String(err) });
  }
}

/** Change the permission mode (admin); the gateway records the change in the audit log. */
export async function changeProjectMode(host: Host, id: string, mode: ProjectMode) {
  if (!host.client || !host.connected) {
    return;
  }
  patch(host, { busy: true, error: null });
  try {
    const res = (await host.client.request("projects.setMode", { id, mode })) as {
      project: Project;
    };
    patch(host, {
      busy: false,
      projects: host.projects.projects.map((p) => (p.id === id ? res.project : p)),
    });
  } catch (err) {
    patch(host, { busy: false, error: String(err) });
  }
}
