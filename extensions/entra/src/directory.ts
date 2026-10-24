// Entra directory tools (opt-in, read-only): user lookup with basic profiles
// (User.ReadBasic.All), and with `full` also job title/department and groups
// (Directory.Read.All).
import { Type } from "@sinclair/typebox";
import {
  asAgentTool,
  ConnectorError,
  type ConnectorRuntime,
  type GraphPage,
  graphId,
  graphUrl,
  intParam,
  odataString,
  runConnectorTool,
  strParam,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { type DirectoryLevel, SCOPES } from "./config.js";

type User = {
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
};
type Group = {
  id: string;
  displayName?: string;
  mail?: string;
  securityEnabled?: boolean;
  groupTypes?: string[];
  "@odata.type"?: string;
};

function formatUsers(users: User[]): string {
  if (users.length === 0) {
    return "No users found.";
  }
  const lines = users.map((u, i) =>
    [
      `${i + 1}. id: ${u.id}`,
      `   name: ${u.displayName ?? ""}`,
      `   mail: ${u.mail ?? ""}  upn: ${u.userPrincipalName ?? ""}`,
      ...(u.jobTitle || u.department
        ? [`   title: ${u.jobTitle ?? ""}  department: ${u.department ?? ""}`]
        : []),
    ].join("\n"),
  );
  // Display names are set by people in the tenant: treated as untrusted text.
  return wrapUntrusted(lines.join("\n"), { source: "api" });
}

function formatGroups(groups: Group[]): string {
  if (groups.length === 0) {
    return "No groups found.";
  }
  const lines = groups.map((g, i) => {
    const kind = g.groupTypes?.includes("Unified")
      ? "Microsoft 365"
      : g.securityEnabled
        ? "security"
        : "distribution";
    return `${i + 1}. id: ${g.id}\n   name: ${g.displayName ?? ""} (${kind})\n   mail: ${g.mail ?? ""}`;
  });
  return wrapUntrusted(lines.join("\n"), { source: "api" });
}

/** OData startswith filter over the given properties. */
function startsWithFilter(q: string, props: string[]): string {
  const lit = odataString(q);
  return props.map((p) => `startswith(${p},${lit})`).join(" or ");
}

export function createDirectoryTools(deps: {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  level: DirectoryLevel;
}) {
  const { runtime, ctx, level } = deps;
  if (level === "off") {
    return [];
  }
  const userScope = level === "full" ? SCOPES.full : SCOPES.basic;
  const userSelect =
    level === "full"
      ? "id,displayName,mail,userPrincipalName,jobTitle,department"
      : "id,displayName,mail,userPrincipalName";

  const searchUsers = asAgentTool({
    name: "entra_users_search",
    label: "Entra ID: find users",
    description:
      "Find people in the organisation's directory whose name, mail or sign-in name starts with the query. Read-only.",
    parameters: Type.Object({
      query: Type.String(),
      top: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "directory.users.search",
        async () => {
          const q = strParam(params.query, "query", { required: true, max: 120 })!;
          const page = await runtime.json<GraphPage<User>>({
            url: graphUrl("/users", {
              $filter: startsWithFilter(q, ["displayName", "mail", "userPrincipalName"]),
              $select: userSelect,
              $top: intParam(params.top, 10, 1, 50),
            }),
            scopes: [userScope],
          });
          const value = page.value ?? [];
          return { value, result: textResult(formatUsers(value), { count: value.length }) };
        },
        (v) => ({ ids: v.map((u) => u.id), count: v.length }),
      ),
  });

  const getUser = asAgentTool({
    name: "entra_user_get",
    label: "Entra ID: get user",
    description: "Look up one user by object id or user principal name. Read-only.",
    parameters: Type.Object({ id: Type.String({ description: "Object id or UPN" }) }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "directory.users.get",
        async () => {
          const raw = strParam(params.id, "id", { required: true, max: 256 })!;
          // Object id (GUID) or UPN (name@domain); nothing that could change the path.
          if (!/^[A-Za-z0-9._@+-]+$/.test(raw) || raw.includes("..")) {
            throw new ConnectorError("bad_request", "invalid user id");
          }
          const u = await runtime.json<User>({
            url: graphUrl(`/users/${encodeURIComponent(raw)}`, { $select: userSelect }),
            scopes: [userScope],
          });
          return { value: u, result: textResult(formatUsers([u])) };
        },
        (u) => ({ ids: [u.id], count: 1 }),
      ),
  });

  if (level !== "full") {
    return [searchUsers, getUser];
  }

  const searchGroups = asAgentTool({
    name: "entra_groups_search",
    label: "Entra ID: find groups",
    description: "Find groups whose name starts with the query. Read-only.",
    parameters: Type.Object({
      query: Type.String(),
      top: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "directory.groups.search",
        async () => {
          const q = strParam(params.query, "query", { required: true, max: 120 })!;
          const page = await runtime.json<GraphPage<Group>>({
            url: graphUrl("/groups", {
              $filter: startsWithFilter(q, ["displayName", "mail"]),
              $select: "id,displayName,mail,securityEnabled,groupTypes",
              $top: intParam(params.top, 10, 1, 50),
            }),
            scopes: [SCOPES.full],
          });
          const value = page.value ?? [];
          return { value, result: textResult(formatGroups(value), { count: value.length }) };
        },
        (v) => ({ ids: v.map((g) => g.id), count: v.length }),
      ),
  });

  const members = asAgentTool({
    name: "entra_group_members",
    label: "Entra ID: group members",
    description: "List the direct members of a group by group id. Read-only.",
    parameters: Type.Object({
      groupId: Type.String(),
      top: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "directory.groups.members",
        async () => {
          const page = await runtime.json<GraphPage<User>>({
            url: graphUrl(`/groups/${graphId(params.groupId, "group id")}/members`, {
              $select: "id,displayName,mail,userPrincipalName",
              $top: intParam(params.top, 50, 1, 100),
            }),
            scopes: [SCOPES.full],
          });
          const value = page.value ?? [];
          return { value, result: textResult(formatUsers(value), { count: value.length }) };
        },
        (v) => ({ ids: v.map((u) => u.id), count: v.length }),
      ),
  });

  const memberOf = asAgentTool({
    name: "entra_user_groups",
    label: "Entra ID: user's groups",
    description: "List the groups a user is a direct member of. Read-only.",
    parameters: Type.Object({ userId: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "directory.users.memberOf",
        async () => {
          const page = await runtime.json<GraphPage<Group>>({
            url: graphUrl(`/users/${graphId(params.userId, "user id")}/memberOf`, {
              $select: "id,displayName,mail,securityEnabled,groupTypes",
              $top: 100,
            }),
            scopes: [SCOPES.full],
          });
          const value = (page.value ?? []).filter(
            (g) => !g["@odata.type"] || g["@odata.type"] === "#microsoft.graph.group",
          );
          return { value, result: textResult(formatGroups(value), { count: value.length }) };
        },
        (v) => ({ ids: v.map((g) => g.id), count: v.length }),
      ),
  });

  return [searchUsers, getUser, searchGroups, members, memberOf];
}
