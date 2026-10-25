import { html, nothing } from "lit";
import { departmentOfChat } from "../controllers/business-chat";
import { agentIdOfSession } from "../controllers/projects";

export function renderBusinessChatContext(props: {
  sessionKey: string;
  locale: string;
  projectName: string;
  onOpenWork: () => void;
}) {
  const department = departmentOfChat(props.sessionKey);
  if (!department) {
    return nothing;
  }
  const ja = props.locale?.startsWith("ja");
  return html`<aside class="business-chat-context" aria-label=${ja ? "会話のコンテキスト" : "Conversation context"}>
    <div><strong>${props.projectName} · ${department.name[ja ? "ja" : "en"]}</strong>
      <span>${ja ? "エージェント" : "Agent"}: ${agentIdOfSession(props.sessionKey)}</span>
      <p>${ja ? "この部門の仕事について相談できます。依頼や審査は部門の業務画面で確認できます。" : "Discuss this department's work here. Open department work to view requests and reviews."}</p>
    </div>
    <button type="button" @click=${props.onOpenWork}>${ja ? "部門の業務" : "Department work"}</button>
  </aside>`;
}
