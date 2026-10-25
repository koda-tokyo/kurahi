// SCIM 2.0 service provider (RFC 7643 / 7644), the subset Entra ID and Okta provisioning use:
// Users and Groups with create, read, replace, patch, delete; list with `filter` (`userName eq`,
// `externalId eq`, `displayName eq`) and `startIndex` / `count` pagination; ServiceProviderConfig,
// ResourceTypes and Schemas discovery.
//
// Bearer token from `gateway.identity.scim.token` (timing-safe compare), a per-token rate limit,
// and 404 when SCIM is off. Deactivating (`active: false`) or deleting a user ends every SSO
// session of that person at once (open connections close); deleting also removes the
// person's role assignments and leaves a tombstone that blocks just-in-time re-creation until an
// admin (identity.persons.restore) or SCIM itself restores the user. Attributes outside the
// subset (enterprise extension, phone numbers, …) are accepted and ignored in full resources and
// in PATCH; any other PATCH path or op is a 400 (scim-patch.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Person, ScimGroup } from "./types.js";
import { recordAuditEvent } from "../security/audit-log.js";
import { applyGroupPatch, userPatchFields } from "./scim-patch.js";
import {
  bool,
  foldKeys,
  GROUP_SCHEMA,
  type Json,
  LIST_SCHEMA,
  MAX_COUNT,
  MULTI_VALUE_KEYS,
  paginate,
  parseEqFilter,
  PATCH_KEYS,
  PATCH_OP_KEYS,
  PATCH_SCHEMA,
  readBody,
  SCIM_BASE,
  ScimError,
  send,
  sendError,
  str,
  USER_SCHEMA,
} from "./scim-protocol.js";
import { getIdentityService, type IdentityService } from "./service.js";
import { IdentityError } from "./store.js";

export { parseEqFilter, SCIM_BASE };

/** An e-mail written by SCIM is vouched for by the provisioning directory. */
function withEmailSource(fields: Partial<Person>): Partial<Person> {
  return "email" in fields ? { ...fields, emailVerifiedBy: fields.email ? "scim" : null } : fields;
}

/** Core User / Group attributes read from create and replace bodies (canonical spelling). */
const USER_KEYS = [
  "schemas",
  "id",
  "meta",
  "userName",
  "externalId",
  "displayName",
  "name",
  "emails",
  "active",
];
const GROUP_KEYS = ["schemas", "id", "meta", "displayName", "externalId", "members"];

export function createScimHandler(opts: { service?: () => IdentityService; now?: () => number }) {
  const svc = () => (opts.service ?? getIdentityService)();
  const now = opts.now ?? Date.now;
  let window: number[] = [];

  const location = (kind: "Users" | "Groups", id: string) =>
    `${svc().settings.publicUrl ?? ""}${SCIM_BASE}/${kind}/${id}`;

  const userResource = (p: Person) => {
    const s = svc();
    const groups = s.store
      .listGroups()
      .filter((g) => g.members.includes(p.id))
      .map((g) => ({ value: g.id, display: g.displayName }));
    return {
      schemas: [USER_SCHEMA],
      id: p.id,
      ...(p.externalId ? { externalId: p.externalId } : {}),
      userName: p.userName,
      name: { givenName: p.givenName ?? undefined, familyName: p.familyName ?? undefined },
      ...(p.displayName ? { displayName: p.displayName } : {}),
      emails: p.email ? [{ value: p.email, type: "work", primary: true }] : [],
      active: p.active,
      groups,
      meta: {
        resourceType: "User",
        created: p.createdAt,
        lastModified: p.updatedAt,
        location: location("Users", p.id),
      },
    };
  };

  const groupResource = (g: ScimGroup, withMembers = true) => ({
    schemas: [GROUP_SCHEMA],
    id: g.id,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.displayName,
    ...(withMembers
      ? {
          members: g.members.map((m) => ({
            value: m,
            display: svc().store.getPerson(m)?.userName ?? undefined,
            $ref: location("Users", m),
          })),
        }
      : {}),
    meta: {
      resourceType: "Group",
      created: g.createdAt,
      lastModified: g.updatedAt,
      location: location("Groups", g.id),
    },
  });

  const audit = (action: string, detail: Json) =>
    recordAuditEvent({
      action,
      outcome: "allowed",
      source: "gateway.scim",
      identity: "scim",
      detail,
    });

  /** The operations of a PatchOp body, attribute names folded; null when there are none. */
  const patchOps = (body: Json): Json[] | null =>
    Array.isArray(body.Operations)
      ? body.Operations.map((op) => foldKeys(op, PATCH_OP_KEYS))
      : null;

  /** Apply user attributes from a SCIM body (create / replace) or a patch value. */
  const userFields = (rawBody: Json): Partial<Person> => {
    // Attribute names are case-insensitive (RFC 7643): `Active: false` must deactivate too.
    const body = foldKeys(rawBody, USER_KEYS);
    const out: Partial<Person> = {};
    if ("userName" in body) {
      const v = str(body.userName);
      if (!v) {
        throw new ScimError(400, "invalidValue", "userName is required");
      }
      out.userName = v;
    }
    if ("externalId" in body) {
      out.externalId = str(body.externalId);
    }
    if ("displayName" in body) {
      out.displayName = str(body.displayName);
    }
    const name = body.name ? foldKeys(body.name, ["givenName", "familyName"]) : undefined;
    if (name) {
      if ("givenName" in name) {
        out.givenName = str(name.givenName);
      }
      if ("familyName" in name) {
        out.familyName = str(name.familyName);
      }
    }
    for (const [k, v] of Object.entries(body)) {
      if (k.toLowerCase() === "name.givenname") {
        out.givenName = str(v);
      } else if (k.toLowerCase() === "name.familyname") {
        out.familyName = str(v);
      }
    }
    if (Array.isArray(body.emails)) {
      const emails = body.emails.map((e) => foldKeys(e, MULTI_VALUE_KEYS));
      const primary =
        emails.find((e) => e.primary === true) ??
        emails.find((e) => e.type === "work") ??
        emails[0];
      const v = str(primary?.value, 320);
      out.email = v && v.includes("@") ? v.toLowerCase() : null;
    }
    if ("active" in body) {
      const v = bool(body.active);
      if (v === null) {
        throw new ScimError(400, "invalidValue", "active must be a boolean");
      }
      out.active = v;
    }
    return out;
  };

  const saveUser = (id: string, fields: Partial<Person>) => {
    const s = svc();
    const before = s.store.getPerson(id);
    if (!before) {
      throw new ScimError(404, null, "user not found");
    }
    const after = s.store.updatePerson(id, { ...withEmailSource(fields), source: "scim" });
    if (before.active && !after.active) {
      // Deprovisioning: every SSO session of this person ends now.
      const n = s.revokePersonSessions(id, "scim_deactivated", "scim");
      audit("identity.scim.user.deactivate", { person: id, sessions: n });
    }
    return after;
  };

  const patchUser = (id: string, rawBody: Json) => {
    const body = foldKeys(rawBody, PATCH_KEYS);
    const ops = patchOps(body);
    if (!ops || !(Array.isArray(body.schemas) && body.schemas.includes(PATCH_SCHEMA))) {
      throw new ScimError(400, "invalidSyntax", "a PatchOp with Operations is required");
    }
    // Unsupported paths are a 400, never a silent 200 (a dropped `active: false` would leave
    // a deprovisioned person signed in).
    return saveUser(id, userPatchFields(ops));
  };

  const groupMembers = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [value])
      .map((m) => str(foldKeys(m, MULTI_VALUE_KEYS).value, 64))
      .filter((m): m is string => Boolean(m));

  const patchGroup = (id: string, body: Json) => {
    const s = svc();
    const g = s.store.getGroup(id);
    if (!g) {
      throw new ScimError(404, null, "group not found");
    }
    const ops = patchOps(foldKeys(body, PATCH_KEYS));
    if (!ops) {
      throw new ScimError(400, "invalidSyntax", "a PatchOp with Operations is required");
    }
    const next = applyGroupPatch(
      ops,
      { members: [...g.members], displayName: g.displayName, externalId: g.externalId },
      groupMembers,
    );
    return s.store.updateGroup(id, next);
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const s = svc();
    const rest = url.pathname.slice(SCIM_BASE.length).replace(/\/+$/, "");
    const [, kind, id, extra] = rest.split("/");
    const method = req.method ?? "GET";
    if (extra !== undefined) {
      throw new ScimError(404, null, "not found");
    }
    if (kind === "ServiceProviderConfig" && method === "GET") {
      return send(res, 200, {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: MAX_COUNT },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [
          {
            type: "oauthbearertoken",
            name: "Bearer token",
            description: "gateway.identity.scim.token",
          },
        ],
      });
    }
    if (kind === "ResourceTypes" && method === "GET") {
      const types = [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: USER_SCHEMA,
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "Group",
          name: "Group",
          endpoint: "/Groups",
          schema: GROUP_SCHEMA,
        },
      ];
      return send(res, 200, {
        schemas: [LIST_SCHEMA],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
        Resources: types,
      });
    }
    if (kind === "Schemas" && method === "GET") {
      const schemas = [
        {
          id: USER_SCHEMA,
          name: "User",
          attributes: [
            "userName",
            "externalId",
            "name",
            "displayName",
            "emails",
            "active",
            "groups",
          ],
        },
        { id: GROUP_SCHEMA, name: "Group", attributes: ["displayName", "externalId", "members"] },
      ];
      return send(res, 200, {
        schemas: [LIST_SCHEMA],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
        Resources: schemas,
      });
    }
    if (kind === "Users") {
      if (!id && method === "GET") {
        const f = parseEqFilter(url.searchParams.get("filter"), ["userName", "externalId"]);
        const all = s.store
          .listPersons()
          .filter((p) =>
            !f
              ? true
              : f.attr === "userName"
                ? p.userName.toLowerCase() === f.value.toLowerCase()
                : p.externalId === f.value,
          );
        const { page, startIndex, total } = paginate(all, url);
        return send(res, 200, {
          schemas: [LIST_SCHEMA],
          totalResults: total,
          startIndex,
          itemsPerPage: page.length,
          Resources: page.map(userResource),
        });
      }
      if (!id && method === "POST") {
        const body = await readBody(req);
        const fields = userFields(body);
        if (!fields.userName) {
          throw new ScimError(400, "invalidValue", "userName is required");
        }
        const p = s.store.createPerson({
          ...withEmailSource(fields),
          userName: fields.userName,
          source: "scim",
        });
        // The directory provisioning the same user again is the restore: its tombstone goes.
        const restored = s.store.clearTombstonesFor(p);
        audit("identity.scim.user.create", { person: p.id, active: p.active, restored });
        res.setHeader("Location", location("Users", p.id));
        return send(res, 201, userResource(p));
      }
      const person = id ? s.store.getPerson(id) : null;
      if (!person) {
        throw new ScimError(404, null, "user not found");
      }
      if (method === "GET") {
        return send(res, 200, userResource(person));
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const fields = userFields(body);
        const p = saveUser(person.id, {
          externalId: null,
          displayName: null,
          givenName: null,
          familyName: null,
          ...fields,
          userName: fields.userName ?? person.userName,
          // A replace without `active` keeps the current state: it never reactivates.
          active: fields.active ?? person.active,
        });
        audit("identity.scim.user.replace", { person: p.id, active: p.active });
        return send(res, 200, userResource(p));
      }
      if (method === "PATCH") {
        const p = patchUser(person.id, await readBody(req));
        audit("identity.scim.user.patch", { person: p.id, active: p.active });
        return send(res, 200, userResource(p));
      }
      if (method === "DELETE") {
        const n = s.revokePersonSessions(person.id, "scim_deleted", "scim");
        // Deleting removes the person's assignments (also by e-mail) and leaves a tombstone so
        // the next IdP sign-in cannot re-create the person just in time.
        let deleted: { assignments: number } | null = null;
        try {
          deleted = s.store.deletePerson(person.id, {
            tombstone: "scim",
            evictOldestTombstone: s.settings.requireProvisioned,
          });
        } catch (err) {
          if (!(err instanceof IdentityError) || err.code !== "limit") {
            throw err;
          }
        }
        if (!deleted) {
          // Tombstones full and just-in-time sign-in allowed: keep the person, deactivated, so
          // the deletion still locks them out (an evicted tombstone would not).
          saveUser(person.id, { active: false });
          audit("identity.scim.user.delete", {
            person: person.id,
            sessions: n,
            deactivatedInstead: "tombstone store full",
          });
          return send(res, 204);
        }
        audit("identity.scim.user.delete", {
          person: person.id,
          sessions: n,
          assignments: deleted.assignments,
        });
        return send(res, 204);
      }
    }
    if (kind === "Groups") {
      const withMembers = !/\bmembers\b/.test(url.searchParams.get("excludedAttributes") ?? "");
      if (!id && method === "GET") {
        const f = parseEqFilter(url.searchParams.get("filter"), ["displayName", "externalId"]);
        const all = s.store
          .listGroups()
          .filter((g) =>
            !f
              ? true
              : f.attr === "displayName"
                ? g.displayName.toLowerCase() === f.value.toLowerCase()
                : g.externalId === f.value,
          );
        const { page, startIndex, total } = paginate(all, url);
        return send(res, 200, {
          schemas: [LIST_SCHEMA],
          totalResults: total,
          startIndex,
          itemsPerPage: page.length,
          Resources: page.map((g) => groupResource(g, withMembers)),
        });
      }
      if (!id && method === "POST") {
        const body = foldKeys(await readBody(req), GROUP_KEYS);
        const displayName = str(body.displayName);
        if (!displayName) {
          throw new ScimError(400, "invalidValue", "displayName is required");
        }
        const g = s.store.createGroup({
          displayName,
          externalId: str(body.externalId),
          members: groupMembers(body.members ?? []),
        });
        audit("identity.scim.group.create", { group: g.id, members: g.members.length });
        res.setHeader("Location", location("Groups", g.id));
        return send(res, 201, groupResource(g));
      }
      const group = id ? s.store.getGroup(id) : null;
      if (!group) {
        throw new ScimError(404, null, "group not found");
      }
      if (method === "GET") {
        return send(res, 200, groupResource(group, withMembers));
      }
      if (method === "PUT") {
        const body = foldKeys(await readBody(req), GROUP_KEYS);
        const g = s.store.updateGroup(group.id, {
          displayName: str(body.displayName) ?? group.displayName,
          externalId: str(body.externalId),
          members: groupMembers(body.members ?? []),
        });
        audit("identity.scim.group.replace", { group: g.id, members: g.members.length });
        return send(res, 200, groupResource(g));
      }
      if (method === "PATCH") {
        const g = patchGroup(group.id, await readBody(req));
        audit("identity.scim.group.patch", { group: g.id, members: g.members.length });
        // Entra ID accepts 204; Okta expects the resource. The resource satisfies both.
        return send(res, 200, groupResource(g));
      }
      if (method === "DELETE") {
        s.store.deleteGroup(group.id);
        audit("identity.scim.group.delete", { group: group.id });
        return send(res, 204);
      }
    }
    throw new ScimError(kind === "Users" || kind === "Groups" ? 405 : 404, null, "not supported");
  };

  /** Bearer check for the router's `scim-token` authenticator. */
  const authorize = (req: IncomingMessage): boolean => {
    const s = svc().settings.scim;
    const raw = req.headers.authorization;
    const value =
      typeof raw === "string" && raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : "";
    if (!s.enabled || !s.token || !value) {
      return false;
    }
    const a = Buffer.from(value);
    const b = Buffer.from(s.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const s = svc().settings.scim;
    if (!s.enabled) {
      return sendError(res, new ScimError(404, null, "SCIM provisioning is not enabled"));
    }
    const t = now();
    window = window.filter((x) => x > t - 60_000);
    if (window.length >= s.ratePerMinute) {
      res.setHeader("Retry-After", "60");
      return sendError(res, new ScimError(429, null, "too many requests"));
    }
    window.push(t);
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof ScimError) {
        return sendError(res, err);
      }
      if (err instanceof IdentityError) {
        const status = err.code === "conflict" ? 409 : err.code === "not_found" ? 404 : 400;
        return sendError(
          res,
          new ScimError(
            status,
            err.code === "conflict" ? "uniqueness" : "invalidValue",
            err.message,
          ),
        );
      }
      return sendError(res, new ScimError(500, null, "internal error"));
    }
  };

  return { handle, authorize };
}
