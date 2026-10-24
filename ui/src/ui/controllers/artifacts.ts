// 成果物 / Artifacts in the Control UI: list, save from a chat message, side panel with
// versions, diff, review status and Markdown export.
import type { GatewayBrowserClient } from "../gateway";

export type ArtifactStatus = "draft" | "review" | "approved";
export type ArtifactType = "document" | "table" | "draft" | "code" | "other";

export type ArtifactVersion = {
  version: number;
  sha256: string;
  size: number;
  createdAt: string;
  createdByUser: string;
  createdByAgent: string | null;
  sourceSession: string | null;
  note: string | null;
};

export type ArtifactEvent = {
  at: string;
  by: string;
  action: "created" | "version" | "status";
  from?: ArtifactStatus;
  to?: ArtifactStatus;
  version?: number;
  note?: string | null;
};

export type Artifact = {
  id: string;
  title: string;
  type: ArtifactType;
  format: "md" | "txt" | "csv" | "json";
  projectId: string | null;
  status: ArtifactStatus;
  versions: ArtifactVersion[];
  history: ArtifactEvent[];
  createdAt: string;
  updatedAt: string;
};

export type SaveForm = {
  title: string;
  type: ArtifactType;
  content: string;
  sourceSession: string | null;
};

export type ArtifactsState = {
  loading: boolean;
  error: string | null;
  items: Artifact[];
  filterProject: string;
  filterStatus: "" | ArtifactStatus;
  panelOpen: boolean;
  current: Artifact | null;
  currentVersion: number | null;
  content: string;
  compareVersion: number | null;
  compareContent: string | null;
  editing: boolean;
  draft: string;
  saveForm: SaveForm | null;
  busy: boolean;
  exporting: boolean;
  exportSha256: string | null;
};

export const DEFAULT_ARTIFACTS_STATE: ArtifactsState = {
  loading: false,
  error: null,
  items: [],
  filterProject: "",
  filterStatus: "",
  panelOpen: false,
  current: null,
  currentVersion: null,
  content: "",
  compareVersion: null,
  compareContent: null,
  editing: false,
  draft: "",
  saveForm: null,
  busy: false,
  exporting: false,
  exportSha256: null,
};

export const STATUS_ORDER: ArtifactStatus[] = ["draft", "review", "approved"];

/** Status changes the UI offers (the gateway enforces the same table). */
export function nextStatuses(status: ArtifactStatus): ArtifactStatus[] {
  switch (status) {
    case "draft":
      return ["review"];
    case "review":
      return ["approved", "draft"];
    default:
      return [];
  }
}

type Host = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  artifacts: ArtifactsState;
};

function patch(host: Host, next: Partial<ArtifactsState>) {
  host.artifacts = { ...host.artifacts, ...next };
}

export function filterArtifacts(items: Artifact[], projectId: string, status: string): Artifact[] {
  return items.filter(
    (a) => (!projectId || a.projectId === projectId) && (!status || a.status === status),
  );
}

/** Guess a title from the first heading or line of a message. */
export function titleFromContent(content: string): string {
  const line =
    content
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** A table if most non-empty lines look like Markdown table rows. */
export function guessType(content: string): ArtifactType {
  const lines = content.split("\n").filter((l) => l.trim());
  const rows = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  if (lines.length > 0 && rows / lines.length > 0.6) {
    return "table";
  }
  if (/```/.test(content)) {
    return "code";
  }
  return "document";
}

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** Line diff (LCS). Large inputs fall back to a whole-text replace to stay fast. */
export function lineDiff(before: string, after: string, maxLines = 2000): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > maxLines || b.length > maxLines) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i++] });
  }
  while (j < m) {
    out.push({ type: "add", text: b[j++] });
  }
  return out;
}

/** Markdown export with a provenance header (title, version, status, SHA-256). */
export function exportMarkdown(a: Artifact, version: number, content: string): string {
  const v = a.versions.find((x) => x.version === version);
  const header = [
    `<!-- ${a.title} | v${version} | ${a.status} | sha256 ${v?.sha256 ?? ""} -->`,
    "",
  ].join("\n");
  return `${header}${content}${content.endsWith("\n") ? "" : "\n"}`;
}

export async function loadArtifacts(host: Host) {
  if (!host.client || !host.connected) {
    return;
  }
  patch(host, { loading: true, error: null });
  try {
    const res = (await host.client.request("artifacts.list", {})) as { artifacts?: Artifact[] };
    patch(host, { loading: false, items: res?.artifacts ?? [] });
  } catch (err) {
    patch(host, { loading: false, error: String(err) });
  }
}

export async function openArtifact(host: Host, id: string, version?: number) {
  if (!host.client || !host.connected) {
    return;
  }
  patch(host, { busy: true, error: null, panelOpen: true });
  try {
    const res = (await host.client.request("artifacts.get", { id, version })) as {
      artifact: Artifact;
      content: string;
      version: number;
    };
    patch(host, {
      busy: false,
      current: res.artifact,
      currentVersion: res.version,
      content: res.content,
      compareVersion: null,
      compareContent: null,
      editing: false,
      exportSha256: null,
    });
  } catch (err) {
    patch(host, { busy: false, error: String(err) });
  }
}

export async function compareWith(host: Host, version: number | null) {
  const cur = host.artifacts.current;
  if (!host.client || !cur || version === null) {
    patch(host, { compareVersion: null, compareContent: null });
    return;
  }
  try {
    const res = (await host.client.request("artifacts.get", { id: cur.id, version })) as {
      content: string;
    };
    patch(host, { compareVersion: version, compareContent: res.content });
  } catch (err) {
    patch(host, { error: String(err) });
  }
}

function replaceItem(host: Host, a: Artifact) {
  const items = host.artifacts.items.some((x) => x.id === a.id)
    ? host.artifacts.items.map((x) => (x.id === a.id ? a : x))
    : [a, ...host.artifacts.items];
  patch(host, { items });
}

export async function submitSave(host: Host): Promise<Artifact | null> {
  const f = host.artifacts.saveForm;
  if (!host.client || !f) {
    return null;
  }
  patch(host, { busy: true, error: null });
  try {
    const res = (await host.client.request("artifacts.save", {
      title: f.title,
      type: f.type,
      format: "md",
      content: f.content,
      sourceSession: f.sourceSession ?? undefined,
    })) as { artifact: Artifact };
    replaceItem(host, res.artifact);
    patch(host, { busy: false, saveForm: null });
    await openArtifact(host, res.artifact.id);
    return res.artifact;
  } catch (err) {
    patch(host, { busy: false, error: String(err) });
    return null;
  }
}

export async function setStatus(host: Host, status: ArtifactStatus) {
  const cur = host.artifacts.current;
  if (!host.client || !cur) {
    return;
  }
  patch(host, { busy: true, error: null });
  try {
    const res = (await host.client.request("artifacts.setStatus", { id: cur.id, status })) as {
      artifact: Artifact;
    };
    replaceItem(host, res.artifact);
    patch(host, { busy: false, current: res.artifact });
  } catch (err) {
    patch(host, { busy: false, error: String(err) });
  }
}

export async function saveNewVersion(host: Host) {
  const cur = host.artifacts.current;
  if (!host.client || !cur) {
    return;
  }
  patch(host, { busy: true, error: null });
  try {
    const res = (await host.client.request("artifacts.version", {
      id: cur.id,
      content: host.artifacts.draft,
    })) as { artifact: Artifact };
    replaceItem(host, res.artifact);
    patch(host, { busy: false, editing: false });
    await openArtifact(host, cur.id);
  } catch (err) {
    patch(host, { busy: false, error: String(err) });
  }
}
