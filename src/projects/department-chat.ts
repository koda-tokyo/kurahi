import type { Project } from "./types.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { isDepartmentId, type DepartmentId } from "../workitems/types.js";
import { isAgentAllowed } from "./store.js";

/** Fallback for projects seeded before queues carried `department`; must match the shipped packs. */
export const LEGACY_QUEUE_DEPARTMENTS: Record<string, Record<string, DepartmentId>> = {
  "business-general-affairs": { "ga-requests": "admin", "ga-facilities": "admin" },
  "business-finance-expense-invoice": {
    "fin-expense": "finance",
    "fin-invoice": "finance",
    "fin-ringi": "finance",
  },
  "business-hr-leave-overtime": { "hr-leave": "hr", "hr-overtime": "hr" },
  "business-procurement": { "proc-requests": "procurement" },
};
const SCOPES: Record<DepartmentId, string> = {
  secretariat: "Secretariat: meetings, correspondence and executive support",
  finance: "Finance: expenses, invoices and financial planning",
  admin: "Administration: office requests and administrative coordination",
  hr: "Human resources: leave, recruitment and employee support",
  planning: "Planning: objectives, plans and progress",
  it: "IT: technical support, systems and access requests",
  procurement: "Procurement: purchasing, suppliers and purchase requests",
  sales: "Sales: opportunities, customer enquiries and proposals",
  marketing: "Marketing: campaigns, content and market research",
  service: "Customer service: support requests and customer follow-up",
  operations: "Operations: delivery, scheduling and operational issues",
  legal: "Legal and compliance: document review, obligations and compliance requests",
  product: "Product and research: requirements, research and development planning",
  facilities: "Facilities: maintenance, premises and equipment",
  quality: "Quality: reviews, incidents and corrective actions",
};

/** Rechecked on every send so changed queue routing cannot silently target another agent. */
export function resolveDepartmentChat(
  project: Project,
  departmentId: unknown,
  defaultAgentId: string,
  requestedAgentId?: string,
): { departmentId: DepartmentId; agentId: string; context: string } {
  if (!isDepartmentId(departmentId)) {
    throw new Error("unknown department");
  }
  if (project.archived) {
    throw new Error("project not found or archived");
  }
  const policy = loadWorkQueuePolicy(project);
  if (policy.error) {
    throw new Error("department work queue configuration is invalid");
  }
  const queues = policy.queues.filter(
    (queue) =>
      (queue.department ??
        (project.templateId
          ? LEGACY_QUEUE_DEPARTMENTS[project.templateId]?.[queue.id]
          : undefined)) === departmentId,
  );
  if (queues.length === 0) {
    throw new Error("department is not configured in this project");
  }
  const agents = new Set(queues.map((queue) => queue.defaultAgent ?? defaultAgentId));
  if (agents.size !== 1) {
    throw new Error("department queues have conflicting agents; configure one department agent");
  }
  const agentId = [...agents][0];
  if (requestedAgentId !== undefined && requestedAgentId !== agentId) {
    throw new Error("agent does not match the configured department agent");
  }
  if (!isAgentAllowed(project, agentId, defaultAgentId)) {
    throw new Error(`agent ${agentId} is not allowed in this project`);
  }
  return {
    departmentId,
    agentId,
    context: `Department: ${departmentId}. ${SCOPES[departmentId]}.\nThis conversation concerns this department's work within the project. Department context does not grant tools, data access, approval authority or permission to execute actions. Use only the tools and project permissions actually available.`,
  };
}
