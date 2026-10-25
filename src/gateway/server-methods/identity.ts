// Enterprise identity methods: identity.whoami, the org directory and SSO session control.
//
// Reads: identity.whoami and identity.org.get are observe (the directory detail is filtered by
// role). Writes are admin scope and, in the handler, org-admin only (sessions: org-admin or
// security-admin). Agents never administer identity, whatever their scope. The owner (gateway
// token) may act as a bootstrap admin until the first org-admin exists, or as break-glass while
// SSO is required; both are named in the audit and evidence. Every change is audited and sealed.
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { findProvider } from "../../identity/config.js";
import { declaredAgentOrigin } from "../../identity/connect.js";
import { recordIdentityChange } from "../../identity/evidence.js";
import { DIRECTORY_READ_ROLES, hasRole, personPrincipalId } from "../../identity/rbac.js";
import { getIdentityService } from "../../identity/service.js";
import { IdentityError } from "../../identity/store.js";
import { type AssignmentSubject, type OrgRole } from "../../identity/types.js";
import { DEPARTMENT_IDS } from "../../workitems/types.js";
import { identityValidators, type IdentityMethod } from "../protocol/identity-validators.js";
import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";
import { actorOf } from "./projects.js";

export const IDENTITY_READ_METHODS = [
  "identity.whoami",
  "identity.org.get",
  "identity.sessions.list",
] as const;

type Authority = { actor: string; authority: string };

function refuse(respond: RespondFn, code: string, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message, { details: { code } }));
}

function valid(method: IdentityMethod, params: unknown, respond: RespondFn): boolean {
  const validate = identityValidators[method];
  if (validate(params)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
    ),
  );
  return false;
}

/** An owner-equivalent connection: shared secret or device token, not a pairing credential. */
function isOwnerConnection(client: GatewayClient | null | undefined): boolean {
  return Boolean(
    client?.connect &&
    !client.person &&
    !client.pairing &&
    (client.connect.scopes ?? []).includes("operator.admin"),
  );
}

function orgAdminExists(): boolean {
  const svc = getIdentityService();
  return (
    svc.store.listAssignments().some((a) => a.role === "org-admin") ||
    svc.store.listMappings().some((m) => m.roles.includes("org-admin"))
  );
}

/** Who may change the directory (`org`) or end sessions (`sessions`); null after refusing. */
function authorize(
  method: string,
  client: GatewayClient | null | undefined,
  need: "org" | "sessions",
  respond: RespondFn,
): Authority | null {
  const actor = actorOf(client);
  const deny = (code: string, message: string) => {
    recordIdentityChange({
      action: method,
      actor,
      authority: "none",
      outcome: "denied",
      detail: { code },
    });
    refuse(respond, code, message);
    return null;
  };
  // Agents never administer identity. The owner is checked below as an authority of its own
  // (bootstrap, break-glass), so only the declared-agent part of the person check applies here.
  const origin = declaredAgentOrigin(client);
  if (origin) {
    return deny("not_a_person", `only a person may call ${method} (${origin})`);
  }
  const person = client?.person;
  if (person) {
    if (hasRole(person, "org-admin")) {
      return { actor, authority: "org-admin" };
    }
    if (need === "sessions" && hasRole(person, "security-admin")) {
      return { actor, authority: "security-admin" };
    }
    return deny("role_required", `${method} needs the org-admin role`);
  }
  if (isOwnerConnection(client)) {
    if (client?.breakGlass) {
      return { actor, authority: "break-glass" };
    }
    if (!orgAdminExists()) {
      return { actor, authority: "bootstrap-owner" };
    }
    return deny("role_required", `${method} needs an org-admin sign-in (or a break-glass login)`);
  }
  return deny("role_required", `${method} needs the org-admin role`);
}

function fail(respond: RespondFn, err: unknown) {
  if (err instanceof IdentityError) {
    refuse(respond, err.code, err.message);
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
  );
}

function whoKind(client: GatewayClient | null | undefined) {
  if (client?.person) {
    return "person" as const;
  }
  if (declaredAgentOrigin(client)) {
    return "agent" as const;
  }
  if (client?.pairing) {
    return "pairing" as const;
  }
  return isOwnerConnection(client) ? ("owner" as const) : ("device" as const);
}

export const identityHandlers: GatewayRequestHandlers = {
  "identity.whoami": ({ params, client, respond }) => {
    if (!valid("identity.whoami", params, respond)) {
      return;
    }
    const svc = getIdentityService();
    const p = client?.person ?? null;
    const kind = whoKind(client);
    respond(true, {
      kind,
      principal: actorOf(client),
      person: p
        ? {
            id: p.personId,
            email: p.email,
            displayName: p.displayName,
            issuer: p.issuer,
            subject: p.subject,
            providerId: p.providerId,
            groups: p.groups,
          }
        : null,
      roles: p?.roles ?? [],
      units: p?.units ?? [],
      scope: p?.scope ?? client?.pairing?.scope ?? (kind === "owner" ? "owner" : "observe"),
      adminAreas: p?.adminAreas ?? [],
      approvals: p
        ? p.approvals
        : (client?.connect?.scopes ?? []).includes("operator.approvals") ||
          (client?.connect?.scopes ?? []).includes("operator.admin"),
      breakGlass: client?.breakGlass === true,
      session: p ? { id: p.sessionId, expiresAt: p.expiresAt } : null,
      sso: {
        required: svc.settings.ssoRequired,
        providers: svc.settings.providers.map((x) => ({
          id: x.id,
          kind: x.kind,
          label: x.label ?? x.id,
        })),
      },
    });
  },

  "identity.org.get": ({ params, client, respond }) => {
    if (!valid("identity.org.get", params, respond)) {
      return;
    }
    const { store } = getIdentityService();
    const p = client?.person;
    const detail = p
      ? p.roles.some((g) => DIRECTORY_READ_ROLES.has(g.role))
      : isOwnerConnection(client);
    respond(true, {
      org: { name: store.getOrgName() },
      units: store.listUnits(),
      ...(detail
        ? {
            assignments: store.listAssignments(),
            mappings: store.listMappings(),
            persons: store.listPersons().map((x) => ({
              id: x.id,
              userName: x.userName,
              displayName: x.displayName,
              active: x.active,
              source: x.source,
            })),
            tombstones: store.listTombstones().map((t) => ({
              id: t.id,
              personId: t.personId,
              userName: t.userName,
              deletedAt: t.deletedAt,
              deletedBy: t.deletedBy,
            })),
          }
        : {}),
    });
  },

  "identity.org.update": ({ params, client, respond }) => {
    if (!valid("identity.org.update", params, respond)) {
      return;
    }
    const auth = authorize("identity.org.update", client, "org", respond);
    if (!auth) {
      return;
    }
    const name = (params as { name: string | null }).name;
    getIdentityService().store.setOrgName(name?.trim() || null);
    const evidence = recordIdentityChange({
      action: "identity.org.update",
      ...auth,
      outcome: "ok",
      detail: { name },
    });
    respond(true, { ok: true, evidence });
  },

  "identity.units.upsert": ({ params, client, respond }) => {
    if (!valid("identity.units.upsert", params, respond)) {
      return;
    }
    const auth = authorize("identity.units.upsert", client, "org", respond);
    if (!auth) {
      return;
    }
    const p = params as {
      id: string;
      name: string;
      kind: "department" | "team";
      parentId?: string | null;
      department?: string | null;
    };
    if (p.department && !(DEPARTMENT_IDS as readonly string[]).includes(p.department)) {
      refuse(respond, "invalid", `department must be one of ${DEPARTMENT_IDS.join(", ")}`);
      return;
    }
    try {
      const unit = getIdentityService().store.upsertUnit(p);
      const evidence = recordIdentityChange({
        action: "identity.units.upsert",
        ...auth,
        outcome: "ok",
        detail: {
          unit: unit.id,
          kind: unit.kind,
          parentId: unit.parentId,
          department: unit.department,
        },
      });
      respond(true, { ok: true, unit, evidence });
    } catch (err) {
      fail(respond, err);
    }
  },

  "identity.units.remove": ({ params, client, respond }) => {
    if (!valid("identity.units.remove", params, respond)) {
      return;
    }
    const auth = authorize("identity.units.remove", client, "org", respond);
    if (!auth) {
      return;
    }
    const id = (params as { id: string }).id;
    try {
      getIdentityService().store.removeUnit(id);
      const evidence = recordIdentityChange({
        action: "identity.units.remove",
        ...auth,
        outcome: "ok",
        detail: { unit: id },
      });
      respond(true, { ok: true, evidence });
    } catch (err) {
      fail(respond, err);
    }
  },

  "identity.roles.assign": ({ params, client, respond }) => {
    if (!valid("identity.roles.assign", params, respond)) {
      return;
    }
    const auth = authorize("identity.roles.assign", client, "org", respond);
    if (!auth) {
      return;
    }
    const p = params as { subject: string; role: OrgRole; unit?: string | null };
    const subject = (
      p.subject.startsWith("email:") ? p.subject.toLowerCase() : p.subject
    ) as AssignmentSubject;
    try {
      const { store } = getIdentityService();
      if (subject.startsWith("person:") && !store.getPerson(subject.slice(7))) {
        refuse(respond, "not_found", "person not found");
        return;
      }
      const assignment = store.assign(subject, p.role, p.unit ?? null, auth.actor);
      const evidence = recordIdentityChange({
        action: "identity.roles.assign",
        ...auth,
        outcome: "ok",
        detail: { assignment: assignment.id, subject, role: p.role, unit: assignment.unit },
      });
      respond(true, { ok: true, assignment, evidence });
    } catch (err) {
      fail(respond, err);
    }
  },

  "identity.roles.revoke": ({ params, client, respond }) => {
    if (!valid("identity.roles.revoke", params, respond)) {
      return;
    }
    const auth = authorize("identity.roles.revoke", client, "org", respond);
    if (!auth) {
      return;
    }
    try {
      const assignment = getIdentityService().store.revokeAssignment((params as { id: string }).id);
      const evidence = recordIdentityChange({
        action: "identity.roles.revoke",
        ...auth,
        outcome: "ok",
        detail: {
          assignment: assignment.id,
          subject: assignment.subject,
          role: assignment.role,
          unit: assignment.unit,
        },
      });
      respond(true, { ok: true, assignment, evidence });
    } catch (err) {
      fail(respond, err);
    }
  },

  "identity.groupMappings.set": ({ params, client, respond }) => {
    if (!valid("identity.groupMappings.set", params, respond)) {
      return;
    }
    const auth = authorize("identity.groupMappings.set", client, "org", respond);
    if (!auth) {
      return;
    }
    const p = params as {
      source: string;
      group: string;
      roles: OrgRole[];
      units?: string[];
      matchDisplayName?: boolean;
    };
    const svc = getIdentityService();
    if (p.source !== "scim" && !findProvider(svc.settings, p.source)) {
      refuse(respond, "invalid", "source must be scim or a configured provider id");
      return;
    }
    try {
      const mapping = svc.store.setMapping(
        {
          source: p.source,
          group: p.group,
          roles: p.roles,
          units: p.units ?? [],
          matchDisplayName: p.matchDisplayName,
        },
        auth.actor,
      );
      const evidence = recordIdentityChange({
        action: "identity.groupMappings.set",
        ...auth,
        outcome: "ok",
        detail: {
          source: mapping.source,
          group: mapping.group,
          matchDisplayName: mapping.matchDisplayName,
          roles: mapping.roles,
          units: mapping.units,
        },
      });
      respond(true, { ok: true, mapping, evidence });
    } catch (err) {
      fail(respond, err);
    }
  },

  "identity.groupMappings.remove": ({ params, client, respond }) => {
    if (!valid("identity.groupMappings.remove", params, respond)) {
      return;
    }
    const auth = authorize("identity.groupMappings.remove", client, "org", respond);
    if (!auth) {
      return;
    }
    try {
      const p = params as { source: string; group: string };
      const mapping = getIdentityService().store.removeMapping(p.source, p.group);
      const evidence = recordIdentityChange({
        action: "identity.groupMappings.remove",
        ...auth,
        outcome: "ok",
        detail: { source: mapping.source, group: mapping.group, roles: mapping.roles },
      });
      respond(true, { ok: true, mapping, evidence });
    } catch (err) {
      fail(respond, err);
    }
  },

  // Explicit admin link: the only way an identity attaches to a person already linked to another
  // provider (or to a person the sign-in rules would not link by themselves).
  "identity.persons.link": ({ params, client, respond }) => {
    if (!valid("identity.persons.link", params, respond)) {
      return;
    }
    const auth = authorize("identity.persons.link", client, "org", respond);
    if (!auth) {
      return;
    }
    const p = params as { personId: string; providerId: string; subject: string; issuer?: string };
    const svc = getIdentityService();
    const provider = findProvider(svc.settings, p.providerId);
    if (!provider) {
      refuse(respond, "not_found", "unknown sign-in provider");
      return;
    }
    const issuer =
      p.issuer ??
      (provider.kind === "saml" ? provider.idpEntityId : provider.issuer.replace(/\/+$/, ""));
    try {
      const other = svc.store.findByLink(p.providerId, issuer, p.subject);
      if (other && other.id !== p.personId) {
        refuse(respond, "conflict", "this identity is linked to another person");
        return;
      }
      const person = svc.store.addLink(p.personId, {
        providerId: p.providerId,
        issuer,
        subject: p.subject,
      });
      const evidence = recordIdentityChange({
        action: "identity.persons.link",
        ...auth,
        outcome: "ok",
        detail: { person: personPrincipalId(person.id), provider: p.providerId, issuer },
      });
      respond(true, { ok: true, person: { id: person.id, links: person.links }, evidence });
    } catch (err) {
      fail(respond, err);
    }
  },

  "identity.persons.unlink": ({ params, client, respond }) => {
    if (!valid("identity.persons.unlink", params, respond)) {
      return;
    }
    const auth = authorize("identity.persons.unlink", client, "org", respond);
    if (!auth) {
      return;
    }
    const p = params as { personId: string; providerId: string };
    const svc = getIdentityService();
    try {
      const person = svc.store.removeLink(p.personId, p.providerId);
      // Sessions opened through the removed link end now.
      const revoked = svc.sessions
        .listForPerson(person.id)
        .filter((s) => s.providerId === p.providerId)
        .filter((s) => svc.sessions.revoke(s.id, "unlinked")).length;
      const evidence = recordIdentityChange({
        action: "identity.persons.unlink",
        ...auth,
        outcome: "ok",
        detail: { person: personPrincipalId(person.id), provider: p.providerId, revoked },
      });
      respond(true, {
        ok: true,
        revoked,
        person: { id: person.id, links: person.links },
        evidence,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  // A person SCIM deleted may sign in (and be re-created just in time) again only after this.
  "identity.persons.restore": ({ params, client, respond }) => {
    if (!valid("identity.persons.restore", params, respond)) {
      return;
    }
    const auth = authorize("identity.persons.restore", client, "org", respond);
    if (!auth) {
      return;
    }
    try {
      const t = getIdentityService().store.restoreTombstone(
        (params as { tombstoneId: string }).tombstoneId,
      );
      const evidence = recordIdentityChange({
        action: "identity.persons.restore",
        ...auth,
        outcome: "ok",
        detail: { tombstone: t.id, person: personPrincipalId(t.personId), deletedAt: t.deletedAt },
      });
      respond(true, { ok: true, evidence });
    } catch (err) {
      fail(respond, err);
    }
  },

  "identity.sessions.list": ({ params, client, respond }) => {
    if (!valid("identity.sessions.list", params, respond)) {
      return;
    }
    const p = client?.person;
    const allowed = p
      ? hasRole(p, "org-admin", "security-admin", "auditor")
      : isOwnerConnection(client) && !declaredAgentOrigin(client);
    if (!allowed) {
      refuse(
        respond,
        "role_required",
        "identity.sessions.list needs org-admin, security-admin or auditor",
      );
      return;
    }
    const { store, sessions } = getIdentityService();
    const personId = (params as { personId?: string }).personId;
    const ids = personId ? [personId] : store.listPersons().map((x) => x.id);
    respond(true, {
      sessions: ids.flatMap((id) =>
        sessions.listForPerson(id).map((s) => ({
          id: s.id,
          personId: s.personId,
          providerId: s.providerId,
          protocol: s.protocol,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
        })),
      ),
    });
  },

  "identity.sessions.revoke": ({ params, client, respond }) => {
    if (!valid("identity.sessions.revoke", params, respond)) {
      return;
    }
    const auth = authorize("identity.sessions.revoke", client, "sessions", respond);
    if (!auth) {
      return;
    }
    const p = params as { personId?: string; sessionId?: string; reason?: string };
    if (!p.personId === !p.sessionId) {
      refuse(respond, "invalid", "name exactly one of personId or sessionId");
      return;
    }
    const svc = getIdentityService();
    const reason = p.reason ?? "admin";
    let revoked = 0;
    if (p.personId) {
      revoked = svc.revokePersonSessions(p.personId, reason, auth.actor);
    } else if (p.sessionId && svc.sessions.revoke(p.sessionId, reason)) {
      revoked = 1;
    }
    const evidence = recordIdentityChange({
      action: "identity.sessions.revoke",
      ...auth,
      outcome: "ok",
      detail: {
        person: p.personId ? personPrincipalId(p.personId) : null,
        session: p.sessionId ?? null,
        reason,
        revoked,
      },
    });
    respond(true, { ok: true, revoked, evidence });
  },
};
