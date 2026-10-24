import type {
  WorkitemsConfigResult,
  WorkitemsGetResult,
  WorkitemsListResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayBrowserClient } from "../gateway";
import type { Project, ProjectsState } from "./projects";
import { t } from "../i18n";

export type BusinessState = {
  projectId: string | null;
  queue: string;
  config: WorkitemsConfigResult | null;
  list: WorkitemsListResult | null;
  item: WorkitemsGetResult["item"] | null;
  selectedId: string | null;
  loading: boolean;
  detailLoading: boolean;
  error: string | null;
  detailError: string | null;
};
export const emptyBusiness = (): BusinessState => ({
  projectId: null,
  queue: "",
  config: null,
  list: null,
  item: null,
  selectedId: null,
  loading: false,
  detailLoading: false,
  error: null,
  detailError: null,
});
export type BusinessHost = {
  business: BusinessState;
  client: GatewayBrowserClient | null;
  connected: boolean;
  tab: string;
  projects: ProjectsState;
};
const queuedEvents = new WeakMap<BusinessHost, boolean>();
const requests = new WeakMap<BusinessHost, { list: number; detail: number }>();
function tokens(host: BusinessHost) {
  let value = requests.get(host);
  if (!value) {
    value = { list: 0, detail: 0 };
    requests.set(host, value);
  }
  return value;
}
function patch(host: BusinessHost, next: Partial<BusinessState>) {
  host.business = { ...host.business, ...next };
}
export function isBusinessProject(project: Project): boolean {
  return project.templateId?.startsWith("business-") === true;
}
export function resetBusiness(host: BusinessHost) {
  const pending = tokens(host);
  pending.list++;
  pending.detail++;
  queuedEvents.delete(host);
  host.business = emptyBusiness();
}
function activeProject(host: BusinessHost): string | null {
  return host.connected && host.tab === "projects" && host.projects?.view === "business"
    ? host.projects.selectedId
    : null;
}
function current(host: BusinessHost, client: GatewayBrowserClient, projectId: string) {
  return host.client === client && activeProject(host) === projectId;
}

/** Refresh after events, reconnect, or a person choosing Refresh. Events never supply item data. */
export async function loadBusiness(
  host: BusinessHost,
  more = false,
  background = false,
  refreshDetail = true,
) {
  const projectId = activeProject(host);
  const client = host.client;
  if (!projectId || !client) {
    return;
  }
  if (host.business.projectId !== projectId) {
    resetBusiness(host);
    patch(host, { projectId });
  }
  const previous = host.business;
  if (more && (previous.loading || !previous.list?.nextCursor)) {
    return;
  }
  const queue = previous.queue;
  const ticket = ++tokens(host).list;
  patch(host, {
    loading: true,
    error: null,
    ...(more || background ? {} : { list: null }),
  });
  const detail =
    !more && refreshDetail && previous.selectedId
      ? loadBusinessItem(host, previous.selectedId, background)
      : Promise.resolve();
  try {
    const [config, list] = await Promise.all([
      client.request<WorkitemsConfigResult>("workitems.config", { projectId }),
      client.request<WorkitemsListResult>("workitems.list", {
        projectId,
        ...(queue ? { queue } : {}),
        limit: background ? Math.min(200, Math.max(50, previous.list?.items.length ?? 0)) : 50,
        ...(more ? { cursor: previous.list!.nextCursor } : {}),
      }),
    ]);
    if (!current(host, client, projectId) || tokens(host).list !== ticket) {
      return;
    }
    const items = more
      ? [
          ...new Map(
            [...(previous.list?.items ?? []), ...list.items].map((item) => [item.id, item]),
          ).values(),
        ]
      : list.items;
    patch(host, { config, list: { ...list, items }, loading: false });
  } catch {
    if (current(host, client, projectId) && tokens(host).list === ticket) {
      patch(host, { loading: false, list: null, config: null, error: t("business.loadError") });
    }
  }
  await detail;
  if (current(host, client, projectId) && tokens(host).list === ticket && queuedEvents.has(host)) {
    const refreshSelected = queuedEvents.get(host)!;
    queuedEvents.delete(host);
    void loadBusiness(host, false, true, refreshSelected);
  }
}
export async function selectBusinessQueue(host: BusinessHost, queue: string) {
  if (!activeProject(host)) {
    return;
  }
  tokens(host).detail++;
  patch(host, { queue, selectedId: null, item: null, detailLoading: false, detailError: null });
  await loadBusiness(host);
}
export async function loadBusinessItem(host: BusinessHost, id: string, background = false) {
  const projectId = activeProject(host);
  const client = host.client;
  if (!projectId || !client) {
    return;
  }
  const ticket = ++tokens(host).detail;
  patch(host, {
    selectedId: id,
    ...(background && host.business.item?.id === id ? {} : { item: null }),
    detailLoading: true,
    detailError: null,
  });
  try {
    const { item } = await client.request<WorkitemsGetResult>("workitems.get", { projectId, id });
    if (!current(host, client, projectId) || tokens(host).detail !== ticket) {
      return;
    }
    if (item.projectId !== projectId || item.id !== id) {
      throw new Error("Item scope mismatch");
    }
    patch(host, { item, detailLoading: false });
  } catch {
    if (current(host, client, projectId) && tokens(host).detail === ticket) {
      patch(host, { item: null, detailLoading: false, detailError: t("business.detailError") });
    }
  }
}
export function businessEvent(host: BusinessHost, payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  if ((payload as { projectId?: unknown }).projectId === activeProject(host)) {
    const refreshSelected = (payload as { id?: unknown }).id === host.business.selectedId;
    if (host.business.loading) {
      queuedEvents.set(host, (queuedEvents.get(host) ?? false) || refreshSelected);
    } else {
      void loadBusiness(host, false, true, refreshSelected);
    }
  }
}
