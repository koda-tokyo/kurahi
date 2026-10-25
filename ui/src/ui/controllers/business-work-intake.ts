import type {
  WorkitemsCreateParams,
  WorkitemsCreateResult,
} from "../../../../packages/client/src/generated/types";
import type { WorkItemType } from "../../../../packages/client/src/workitems";
import { getLocale } from "../i18n";
import { loadBusiness, loadBusinessItem, type BusinessHost } from "./business";

export type BusinessWorkForm = {
  queue: string;
  type: WorkItemType;
  title: string;
  description: string;
  requester: string;
  documents?: string;
};
const pending = new WeakSet<BusinessHost>();
const uncertain = new WeakMap<BusinessHost, Map<string, string>>();
const text = (en: string, ja: string) => (getLocale() === "ja" ? ja : en);
function activeProject(host: BusinessHost) {
  return host.connected && host.tab === "projects" && host.projects.view === "business"
    ? host.projects.selectedId
    : null;
}
function selectedQueue(host: BusinessHost) {
  return host.business.config && !host.business.config.error
    ? host.business.config.queues.find((queue) => queue.id === host.business.queue)
    : undefined;
}
function ready(host: BusinessHost) {
  const state = host.business;
  const projectId = activeProject(host);
  return !!(
    host.client &&
    projectId &&
    state.projectId === projectId &&
    selectedQueue(host)?.types.length &&
    !state.loading &&
    !state.error &&
    !state.detailLoading &&
    !state.detailError &&
    !state.decisionPending &&
    !state.decisionForm &&
    !state.expensePending &&
    !state.expenseForm &&
    !state.expenseUncertain &&
    !state.workPending &&
    !pending.has(host) &&
    !state.workUncertain &&
    !uncertain.get(host)?.has(projectId)
  );
}
function documentRefs(form: BusinessWorkForm) {
  return (form.documents ?? "")
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter(Boolean);
}
export function workFormValid(form: BusinessWorkForm) {
  const refs = documentRefs(form);
  const validRefs =
    refs.length <= 50 &&
    refs.every((ref) => {
      const segments = ref.split("/");
      return (
        !ref.startsWith("/") &&
        !/^[a-zA-Z]:/.test(ref) &&
        !ref.includes("\\") &&
        !Array.from(ref).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }) &&
        !segments.includes("..") &&
        segments.every((segment) => segment.length > 0 && segment !== ".")
      );
    });
  return (
    form.requester.trim().length > 0 &&
    form.requester.trim().length <= 200 &&
    form.title.trim().length > 0 &&
    form.title.trim().length <= 500 &&
    form.description.trim().length > 0 &&
    form.description.trim().length <= 2000 &&
    validRefs
  );
}
export function canBeginBusinessWork(host: BusinessHost) {
  return ready(host) && !host.business.workForm;
}
export function beginBusinessWork(host: BusinessHost) {
  if (!canBeginBusinessWork(host)) {
    return;
  }
  const queue = selectedQueue(host)!;
  host.business = {
    ...host.business,
    workForm: {
      queue: queue.id,
      type: queue.types[0],
      title: "",
      description: "",
      requester: "",
      documents: "",
    },
    workNotice: null,
  };
}
export function editBusinessWork(host: BusinessHost, update: Partial<BusinessWorkForm>) {
  const form = host.business.workForm;
  const queue = selectedQueue(host);
  if (
    !form ||
    !ready(host) ||
    !queue ||
    form.queue !== queue.id ||
    (update.queue !== undefined && update.queue !== form.queue)
  ) {
    return;
  }
  const type = update.type ?? form.type;
  if (!queue.types.includes(type)) {
    return;
  }
  host.business = {
    ...host.business,
    workForm: {
      queue: form.queue,
      type,
      title: update.title ?? form.title,
      description: update.description ?? form.description,
      requester: update.requester ?? form.requester,
      documents: update.documents ?? form.documents ?? "",
    },
  };
}
export function cancelBusinessWork(host: BusinessHost) {
  if (pending.has(host) || host.business.workPending) {
    return;
  }
  host.business = {
    ...host.business,
    workForm: null,
    ...(!host.business.workUncertain ? { workNotice: null } : {}),
  };
}
/** Call after resetting the presentation state; transport locks and uncertain outcomes survive navigation. */
export function resetBusinessWorkState(host: BusinessHost) {
  const projectId = host.projects?.selectedId;
  const notice = projectId ? uncertain.get(host)?.get(projectId) : null;
  host.business = {
    ...host.business,
    workPending: pending.has(host),
    workUncertain: !!notice,
    workNotice: notice ?? null,
  };
}
export function acknowledgeBusinessWorkOutcome(host: BusinessHost) {
  const projectId = activeProject(host);
  if (
    !projectId ||
    projectId !== host.business.projectId ||
    pending.has(host) ||
    host.business.workPending ||
    host.business.loading ||
    host.business.error ||
    !host.business.config ||
    host.business.config.error
  ) {
    return;
  }
  uncertain.get(host)?.delete(projectId);
  host.business = { ...host.business, workUncertain: false, workForm: null, workNotice: null };
}
export async function createBusinessWork(host: BusinessHost) {
  const form = host.business.workForm;
  const client = host.client;
  const projectId = activeProject(host);
  const queue = selectedQueue(host);
  if (
    !form ||
    !client ||
    !projectId ||
    !ready(host) ||
    !queue ||
    form.queue !== queue.id ||
    !queue.types.includes(form.type) ||
    !workFormValid(form)
  ) {
    return;
  }
  const current = () =>
    host.client === client &&
    activeProject(host) === projectId &&
    host.business.projectId === projectId &&
    host.business.workForm === form &&
    host.business.queue === form.queue;
  pending.add(host);
  host.business = { ...host.business, workPending: true, workNotice: null };
  let id: string | null = null;
  try {
    const result = await client.request<WorkitemsCreateResult>("workitems.create", {
      projectId,
      queue: form.queue,
      type: form.type,
      title: form.title.trim(),
      source: {
        fields: { description: form.description.trim(), requester: form.requester.trim() },
        ...(documentRefs(form).length
          ? { documents: documentRefs(form).map((ref) => ({ kind: "file" as const, ref })) }
          : {}),
      },
    } satisfies WorkitemsCreateParams);
    if (
      !result.item.id ||
      result.item.projectId !== projectId ||
      result.item.queue !== form.queue ||
      result.item.type !== form.type
    ) {
      throw new Error("Created item scope mismatch");
    }
    id = result.item.id;
  } catch {
    const notice = text(
      "Creation could not be confirmed. Refresh and check this project's queue before creating another item.",
      "作成結果を確認できませんでした。更新してこのプロジェクトのキューを確認してから、次の案件を作成してください。",
    );
    let byProject = uncertain.get(host);
    if (!byProject) {
      byProject = new Map();
      uncertain.set(host, byProject);
    }
    byProject.set(projectId, notice);
  } finally {
    pending.delete(host);
    host.business = { ...host.business, workPending: false };
  }
  if (!current()) {
    resetBusinessWorkState(host);
    return;
  }
  if (!id) {
    host.business = { ...host.business, workForm: null };
    resetBusinessWorkState(host);
    return;
  }
  host.business = {
    ...host.business,
    workForm: null,
    workNotice: text(
      "Work item created. Review its checks and next action.",
      "案件を作成しました。確認結果と次の対応を確認してください。",
    ),
    selectedId: id,
    item: null,
  };
  await Promise.all([loadBusinessItem(host, id), loadBusiness(host, false, true, false)]);
}
