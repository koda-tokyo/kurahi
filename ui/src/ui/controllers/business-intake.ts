import type {
  WorkitemsCreateParams,
  WorkitemsCreateResult,
  WorkitemsUpdateParams,
  WorkitemsUpdateResult,
} from "../../../../packages/client/src/generated/types";
import { departmentForQueue } from "../business-departments";
import { t, type MessageId } from "../i18n";
import {
  inFlightBusinessExpenses,
  loadBusiness,
  loadBusinessItem,
  uncertainBusinessExpenses,
  type BusinessHost,
  type ExpenseForm,
} from "./business";

export type { ExpenseForm } from "./business";

function activeProject(host: BusinessHost): string | null {
  return host.connected && host.tab === "projects" && host.projects?.view === "business"
    ? host.projects.selectedId
    : null;
}

function expenseQueues(host: BusinessHost) {
  const config = host.business.config;
  const department = host.business.department ?? "all";
  const templateId =
    host.projects.projects.find((project) => project.id === activeProject(host))?.templateId ??
    undefined;
  return config && !config.error
    ? config.queues.filter(
        (queue) =>
          queue.types.includes("expense") &&
          (department === "all" || departmentForQueue(queue, templateId) === department),
      )
    : [];
}

export function expenseFormValid(form: ExpenseForm): boolean {
  const title = form.title.trim();
  const employeeId = form.employeeId.trim();
  const amount = Number(form.amount.trim());
  const category = form.category.trim();
  const purpose = form.purpose.trim();
  const date = form.expenseDate.trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parsedDate = dateMatch ? new Date(`${date}T00:00:00.000Z`) : null;
  const validDate =
    !!dateMatch &&
    !!parsedDate &&
    Number.isFinite(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === date;
  const refs = form.documents
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const validRefs =
    refs.length <= 50 &&
    refs.every((ref) => {
      const segments = ref.split("/");
      return (
        !ref.startsWith("/") &&
        !/^[a-zA-Z]:/.test(ref) &&
        !ref.includes("\\") &&
        !segments.includes("..") &&
        segments.every((segment) => segment.length > 0 && segment !== ".")
      );
    });
  return (
    title.length > 0 &&
    title.length <= 500 &&
    employeeId.length > 0 &&
    employeeId.length <= 200 &&
    Number.isFinite(amount) &&
    amount > 0 &&
    validDate &&
    category.length > 0 &&
    category.length <= 200 &&
    purpose.length > 0 &&
    purpose.length <= 2000 &&
    validRefs
  );
}

export function canBeginExpense(host: BusinessHost): boolean {
  const state = host.business;
  const projectId = activeProject(host);
  return !!(
    host.client &&
    projectId &&
    state.projectId === projectId &&
    state.config &&
    !state.config.error &&
    expenseQueues(host).length &&
    !state.loading &&
    !state.error &&
    !state.detailLoading &&
    !state.detailError &&
    !state.decisionPending &&
    !state.decisionForm &&
    !state.workPending &&
    !state.workForm &&
    !state.workUncertain &&
    !state.expensePending &&
    !inFlightBusinessExpenses.has(host) &&
    !state.expenseUncertain &&
    !state.expenseForm
  );
}

export function beginBusinessExpense(host: BusinessHost, action?: "edit" | "submit") {
  if (!canBeginExpense(host)) {
    return;
  }
  if (action) {
    const item = host.business.item;
    if (
      !item ||
      item.projectId !== host.business.projectId ||
      item.id !== host.business.selectedId ||
      item.type !== "expense" ||
      !["new", "sent_back"].includes(item.status) ||
      !expenseQueues(host).some((queue) => queue.id === item.queue)
    ) {
      return;
    }
    const fields = item.source.fields;
    host.business = {
      ...host.business,
      expenseNotice: null,
      expenseForm: {
        target: { id: item.id, revision: item.revision, action },
        queue: item.queue,
        title: item.title,
        employeeId: String(fields.employeeId ?? ""),
        amount: String(fields.amount ?? ""),
        expenseDate: String(fields.expenseDate ?? ""),
        category: String(fields.category ?? ""),
        purpose: String(fields.purpose ?? ""),
        documents: item.source.documents
          .filter((doc) => doc.kind === "file")
          .map((doc) => doc.ref)
          .join("\n"),
      },
    };
    return;
  }
  const queues = expenseQueues(host);
  const existing = queues.find((queue) => queue.id === host.business.queue);
  const queue = existing ?? queues[0];
  if (!queue) {
    return;
  }
  host.business = {
    ...host.business,
    expenseForm: {
      queue: queue.id,
      title: "",
      employeeId: "",
      amount: "",
      expenseDate: "",
      category: "",
      purpose: "",
      documents: "",
    },
    expenseNotice: null,
  };
}

export function editBusinessExpense(host: BusinessHost, update: Partial<ExpenseForm>) {
  const form = host.business.expenseForm;
  if (
    !form ||
    form.target?.action === "submit" ||
    host.business.expensePending ||
    host.business.expenseUncertain
  ) {
    return;
  }
  const queues = expenseQueues(host);
  const queue = form.target || update.queue === undefined ? form.queue : update.queue;
  if (!queues.some((candidate) => candidate.id === queue)) {
    return;
  }
  host.business = {
    ...host.business,
    expenseForm: {
      target: form.target,
      queue,
      title: update.title ?? form.title,
      employeeId: update.employeeId ?? form.employeeId,
      amount: update.amount ?? form.amount,
      expenseDate: update.expenseDate ?? form.expenseDate,
      category: update.category ?? form.category,
      purpose: update.purpose ?? form.purpose,
      documents: form.target ? form.documents : (update.documents ?? form.documents),
    },
  };
}

export function cancelBusinessExpense(host: BusinessHost) {
  if (host.business.expensePending) {
    return;
  }
  if (host.business.expenseUncertain) {
    host.business = { ...host.business, expenseForm: null };
    return;
  }
  host.business = { ...host.business, expenseForm: null, expenseNotice: null };
}

export function acknowledgeExpenseOutcome(host: BusinessHost) {
  if (host.business.expensePending) {
    return;
  }
  const projectId = activeProject(host) ?? host.business.projectId;
  if (projectId) {
    const byProject = uncertainBusinessExpenses.get(host);
    byProject?.delete(projectId);
    if (byProject && byProject.size === 0) {
      uncertainBusinessExpenses.delete(host);
    }
  }
  host.business = {
    ...host.business,
    expenseUncertain: false,
    expenseForm: null,
    expenseNotice: null,
  };
}

function rememberUncertain(host: BusinessHost, projectId: string, notice: string) {
  let byProject = uncertainBusinessExpenses.get(host);
  if (!byProject) {
    byProject = new Map();
    uncertainBusinessExpenses.set(host, byProject);
  }
  byProject.set(projectId, notice);
}

export async function createBusinessExpense(host: BusinessHost) {
  const form = host.business.expenseForm;
  const client = host.client;
  const projectId = activeProject(host);
  if (
    !form ||
    !client ||
    !projectId ||
    projectId !== host.business.projectId ||
    !host.business.config ||
    !!host.business.config.error ||
    !expenseQueues(host).some((queue) => queue.id === form.queue) ||
    host.business.loading ||
    !!host.business.error ||
    host.business.detailLoading ||
    !!host.business.detailError ||
    host.business.decisionPending ||
    host.business.workPending ||
    host.business.workForm ||
    host.business.workUncertain ||
    (!form.target && !expenseFormValid(form)) ||
    host.business.expensePending ||
    host.business.expenseUncertain ||
    inFlightBusinessExpenses.has(host)
  ) {
    return;
  }

  const target = form.target;
  const item = host.business.item;
  if (
    target &&
    (!item ||
      item.id !== target.id ||
      item.projectId !== projectId ||
      host.business.selectedId !== target.id ||
      item.revision !== target.revision ||
      item.type !== "expense" ||
      item.queue !== form.queue ||
      !["new", "sent_back"].includes(item.status))
  ) {
    host.business = {
      ...host.business,
      expenseForm: null,
      expenseNotice: t("business.intake.changed" as MessageId),
    };
    return;
  }
  // Existing documents remain untouched; only the fields represented by this form are replaced.
  if (target?.action === "edit" && !expenseFormValid({ ...form, documents: "" })) {
    return;
  }
  const selectedId = host.business.selectedId;
  const queueAtSubmit = host.business.queue;
  const submissionCurrent = () =>
    host.client === client &&
    activeProject(host) === projectId &&
    host.business.projectId === projectId &&
    host.business.expenseForm === form;
  const selectionCurrent = () =>
    submissionCurrent() &&
    host.business.selectedId === selectedId &&
    host.business.queue === queueAtSubmit;

  inFlightBusinessExpenses.add(host);
  host.business = { ...host.business, expensePending: true, expenseNotice: null };
  let createdId: string | null = null;
  let notice: string;
  try {
    const references = form.documents
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const params: WorkitemsCreateParams = {
      projectId,
      queue: form.queue,
      type: "expense",
      title: form.title.trim(),
      source: {
        fields: {
          employeeId: form.employeeId.trim(),
          amount: Number(form.amount.trim()),
          expenseDate: form.expenseDate.trim(),
          category: form.category.trim(),
          purpose: form.purpose.trim(),
        },
        ...(references.length
          ? {
              documents: references.map((ref) => ({
                kind: "file" as const,
                ref,
                name: ref.split("/").at(-1),
              })),
            }
          : {}),
      },
    };
    const result = target
      ? await client.request<WorkitemsUpdateResult>("workitems.update", {
          projectId,
          id: target.id,
          expectedRevision: target.revision,
          patch:
            target.action === "submit"
              ? { status: "awaiting_review" }
              : {
                  title: params.title,
                  source: { fields: { ...item!.source.fields, ...params.source!.fields } },
                },
        } satisfies WorkitemsUpdateParams)
      : await client.request<WorkitemsCreateResult>("workitems.create", params);
    if (
      result.item.projectId !== projectId ||
      result.item.type !== "expense" ||
      result.item.queue !== form.queue ||
      (target && (result.item.id !== target.id || result.item.revision <= target.revision)) ||
      !result.item.id
    ) {
      throw new Error("Created item scope mismatch");
    }
    createdId = result.item.id;
    notice = t(
      (target?.action === "submit"
        ? "business.intake.submitted"
        : "business.intake.saved") as MessageId,
    );
  } catch {
    notice = t((target ? "business.intake.updateUnknown" : "business.intake.unknown") as MessageId);
    rememberUncertain(host, projectId, notice);
  } finally {
    inFlightBusinessExpenses.delete(host);
    host.business = { ...host.business, expensePending: false };
  }

  if (!submissionCurrent()) {
    const uncertainNotice = uncertainBusinessExpenses.get(host)?.get(projectId);
    if (activeProject(host) === projectId && uncertainNotice) {
      host.business = {
        ...host.business,
        expensePending: false,
        expenseUncertain: true,
        expenseNotice: uncertainNotice,
      };
    }
    return;
  }
  if (!createdId) {
    host.business = {
      ...host.business,
      expenseForm: null,
      expenseUncertain: true,
      expenseNotice: notice!,
    };
    return;
  }
  if (!selectionCurrent()) {
    host.business = {
      ...host.business,
      expenseForm: null,
      expenseNotice: notice!,
    };
    await loadBusiness(host, false, true, false);
    return;
  }
  host.business = {
    ...host.business,
    expenseForm: null,
    expenseNotice: notice!,
    queue: form.queue,
    selectedId: createdId,
    item: null,
  };
  await Promise.all([loadBusinessItem(host, createdId), loadBusiness(host, false, true, false)]);
}
