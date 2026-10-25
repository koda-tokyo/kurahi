import { html, nothing } from "lit";
import type { BusinessDepartment } from "../business-departments";

export type BusinessChatEntryState = {
  startBusinessChat?: (projectId: string, message?: string) => Promise<void>;
  businessChatOpening?: boolean;
  businessChatError?: string | null;
  businessChatDraft?: string;
  editBusinessChatDraft?: (text: string) => void;
};

type Props = {
  locale: string;
  projectId: string;
  projectName: string;
  department: BusinessDepartment | null | undefined;
  disabled: boolean;
  state: BusinessChatEntryState;
};

export function renderBusinessChatEntry(props: Props) {
  const { state } = props;
  const ja = props.locale?.startsWith("ja");
  const language = ja ? "ja" : "en";
  const departmentName =
    props.department?.name[language] ?? (ja ? "ビジネス全般" : "Business assistant");
  const disabled =
    props.disabled ||
    Boolean(state.businessChatOpening) ||
    !state.startBusinessChat ||
    !state.editBusinessChatDraft;
  const draft = state.businessChatDraft ?? "";
  const prompts = ja
    ? [
        "今日の仕事の優先順位を一緒に考えてください",
        "依頼文の下書きを手伝ってください",
        "この部門で何を手伝えますか？",
      ]
    : [
        "Help me plan today's priorities",
        "Help me draft a request",
        "What can you help with in this department?",
      ];
  const open = (message?: string) => {
    if (!disabled) {
      void state.startBusinessChat?.(props.projectId, message);
    }
  };
  const send = () => {
    if (draft.trim()) {
      open(draft.trim());
    }
  };
  return html`<section class="business-chat-entry" aria-labelledby="business-chat-heading" aria-busy=${Boolean(state.businessChatOpening)}>
    <div class="business-chat-entry__context">${props.projectName} <span aria-hidden="true">/</span> ${departmentName}</div>
    <h2 id="business-chat-heading">${ja ? "エージェントに話しかける" : "Talk to your agent"}</h2>
    <p>${ja ? "質問や相談、下書きの作成を、会話から始めましょう。" : "Ask a question, think through a task, or start a draft together."}</p>
    <form @submit=${(event: Event) => {
      event.preventDefault();
      send();
    }}>
      <label class="business-chat-entry__label" for="business-chat-message">${ja ? "メッセージ" : "Your message"}</label>
      <textarea id="business-chat-message" rows="3" maxlength="12000" .value=${draft} ?disabled=${disabled}
        aria-describedby="business-chat-keyboard"
        placeholder=${ja ? "どのようなお手伝いが必要ですか？" : "What would you like help with?"}
        @input=${(event: Event) => state.editBusinessChatDraft?.((event.currentTarget as HTMLTextAreaElement).value)}
        @keydown=${(event: KeyboardEvent) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            send();
          }
        }}></textarea>
      <div class="business-chat-entry__actions">
        <small id="business-chat-keyboard">${ja ? "Enterで送信 · Shift+Enterで改行" : "Enter to send · Shift+Enter for a new line"}</small>
        <div><button type="button" ?disabled=${disabled} @click=${() => open()}>${ja ? "会話を開く" : "Open conversation"}</button>
        <button type="submit" class="business-chat-entry__send" ?disabled=${disabled || !draft.trim()}>${state.businessChatOpening ? (ja ? "開いています…" : "Opening…") : ja ? "送信" : "Send"}</button></div>
      </div>
    </form>
    <div class="business-chat-entry__prompts" aria-label=${ja ? "会話の例" : "Try a prompt"}>
      ${prompts.map(
        (prompt) =>
          html`<button type="button" ?disabled=${disabled} @click=${() => {
            state.editBusinessChatDraft?.(prompt);
            document.getElementById("business-chat-message")?.focus();
          }}>${prompt}</button>`,
      )}
    </div>
    ${state.businessChatError ? html`<p class="business-error" role="alert">${state.businessChatError}</p>` : nothing}
  </section>`;
}
