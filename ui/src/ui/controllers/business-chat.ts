import type { KoLoApp } from "../app";
import { departmentForQueue, getBusinessDepartment } from "../business-departments";
import { projectIdOfSession } from "./projects";

/** Department context lives in the project session key, so it survives history and reloads. */
export function departmentOfChat(key: string) {
  if (!projectIdOfSession(key)) {
    return undefined;
  }
  const match = /-dept([a-z]+)0[a-z0-9]+$/.exec(key);
  return match ? getBusinessDepartment(match[1]) : undefined;
}

export async function startBusinessChat(host: KoLoApp, projectId: string, message?: string) {
  if (host.businessChatOpening || !host.connected || !host.client) {
    return;
  }
  const business = host.business;
  const project = host.projects.projects.find((entry) => entry.id === projectId);
  const department = getBusinessDepartment(business.department);
  if (
    !project ||
    project.archived ||
    host.projects.selectedId !== projectId ||
    business.projectId !== projectId ||
    business.decisionPending ||
    business.expensePending ||
    business.workPending ||
    business.decisionForm ||
    business.expenseForm ||
    business.workForm
  ) {
    return;
  }
  const ja = host.locale.startsWith("ja");
  if (
    host.chatSending ||
    host.chatRunId ||
    host.chatQueue.length ||
    host.chatMessage.trim() ||
    host.chatAttachments.length ||
    host.uploads.documents.length
  ) {
    host.businessChatError = ja
      ? "現在のチャットの送信や下書きを完了してから、新しい会話を開いてください。"
      : "Finish the current chat or its unsent draft before opening a new conversation.";
    return;
  }
  if (
    department &&
    !(business.config?.queues ?? []).some(
      (queue) => departmentForQueue(queue, project.templateId ?? undefined) === department.id,
    )
  ) {
    host.businessChatError = ja
      ? "この部門はまだ設定されていません。"
      : "This department is not configured yet.";
    return;
  }
  const client = host.client;
  const previousSession = host.sessionKey;
  const tab = host.tab;
  const draft = host.businessChatDraft;
  const generation = host.businessChatGeneration;
  const current = () =>
    host.connected &&
    host.client === client &&
    host.sessionKey === previousSession &&
    host.tab === tab &&
    host.projects.selectedId === projectId &&
    host.projects.view === "business" &&
    host.business.department === business.department &&
    host.businessChatDraft === draft &&
    host.businessChatGeneration === generation;
  host.businessChatOpening = true;
  host.businessChatError = null;
  try {
    const result = await client.request<{ sessionKey: string }>("projects.chatKey", {
      id: projectId,
      ...(department
        ? { departmentId: department.id }
        : {
            agentId: project.allowedAgents[0] ?? host.agentsList?.defaultId ?? "main",
          }),
    });
    if (!current()) {
      return;
    }
    const key = result.sessionKey;
    if (
      typeof key !== "string" ||
      projectIdOfSession(key) !== projectId ||
      departmentOfChat(key)?.id !== department?.id
    ) {
      throw new Error(
        ja
          ? "会話のコンテキストを確認できませんでした。"
          : "The conversation context could not be verified.",
      );
    }
    host.openChatSession(key);
    host.businessChatDraft = "";
    host.chatMessage = message?.trim() ?? draft;
    if (message?.trim()) {
      await host.handleSendChat();
    }
    void host.refreshChatHistoryPanel();
    await host.updateComplete;
    if (host.tab === "chat" && host.sessionKey === key) {
      host.renderRoot.querySelector<HTMLTextAreaElement>(".chat-compose textarea")?.focus();
    }
  } catch (error) {
    if (current()) {
      host.businessChatError = String(error);
    }
  } finally {
    host.businessChatOpening = false;
  }
}
