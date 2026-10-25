// SCIM PATCH (RFC 7644 §3.5.2) for Users and Groups, failing closed.
//
// Paths may carry the core schema URN (`urn:ietf:params:scim:schemas:core:2.0:User:active`, as
// some IdPs send them): it is stripped before matching. Supported attributes are applied;
// core attributes the IdPs send that Kurahi does not store (title, phone numbers, addresses,
// the enterprise extension, …) are accepted and ignored. Anything else is a 400 (`invalidPath`)
// instead of a silent 200, so a deprovisioning PATCH can never be dropped unnoticed.
import type { Person } from "./types.js";
import {
  bool,
  foldKeys,
  GROUP_SCHEMA,
  type Json,
  MULTI_VALUE_KEYS,
  ScimError,
  str,
  USER_SCHEMA,
} from "./scim-protocol.js";

export const ENTERPRISE_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

/** Core User attributes accepted and not stored (lowercase, path root). */
const IGNORED_USER_ATTRS = new Set([
  "title",
  "nickname",
  "profileurl",
  "usertype",
  "preferredlanguage",
  "locale",
  "timezone",
  "phonenumbers",
  "addresses",
  "ims",
  "photos",
  "x509certificates",
  "entitlements",
  "roles",
]);
/** `name` sub-attributes accepted and not stored. */
const IGNORED_NAME_ATTRS = new Set([
  "formatted",
  "middlename",
  "honorificprefix",
  "honorificsuffix",
]);
/** Keys of a no-path value that are resource metadata, not attributes. */
const META_KEYS = new Set(["schemas", "id", "meta"]);

/** Strip the schema URN prefix, case-insensitively. */
export function stripSchemaUrn(path: string, schema: string): string {
  const prefix = `${schema}:`;
  return path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : path;
}

function isEnterprise(path: string): boolean {
  const lower = path.toLowerCase();
  const urn = ENTERPRISE_USER_SCHEMA.toLowerCase();
  return lower === urn || lower.startsWith(`${urn}:`);
}

/** `phoneNumbers[type eq "work"].value` → `phonenumbers`; `name.givenName` → `name`. */
function rootOf(path: string): string {
  return (path.split(/[[.]/)[0] ?? "").toLowerCase();
}

const invalidPath = (path: string) =>
  new ScimError(400, "invalidPath", `unsupported attribute path: ${path.slice(0, 200)}`);

function opKind(op: Json): "add" | "replace" | "remove" {
  const kind = (typeof op?.op === "string" ? op.op : "").toLowerCase();
  if (kind !== "add" && kind !== "replace" && kind !== "remove") {
    throw new ScimError(400, "invalidSyntax", `unsupported op ${String(op?.op)}`);
  }
  return kind;
}

function emailOf(value: unknown): string | null {
  let raw: unknown = value;
  if (Array.isArray(value)) {
    const emails = value.map((e) => foldKeys(e, MULTI_VALUE_KEYS));
    raw = (
      emails.find((e) => e.primary === true) ??
      emails.find((e) => e.type === "work") ??
      emails[0]
    )?.value;
  } else if (value && typeof value === "object") {
    raw = foldKeys(value, MULTI_VALUE_KEYS).value;
  }
  const v = str(raw, 320);
  return v && v.includes("@") ? v.toLowerCase() : null;
}

function setUserAttr(path: string, value: unknown, out: Partial<Person>): void {
  const lower = path.toLowerCase();
  const root = rootOf(lower);
  if (isEnterprise(path) || IGNORED_USER_ATTRS.has(root)) {
    return;
  }
  switch (lower) {
    case "username": {
      const v = str(value);
      if (!v) {
        throw new ScimError(400, "invalidValue", "userName is required");
      }
      out.userName = v;
      return;
    }
    case "externalid":
      out.externalId = str(value);
      return;
    case "displayname":
      out.displayName = str(value);
      return;
    case "active": {
      const v = bool(value);
      if (v === null) {
        throw new ScimError(400, "invalidValue", "active must be a boolean");
      }
      out.active = v;
      return;
    }
    case "name.givenname":
      out.givenName = str(value);
      return;
    case "name.familyname":
      out.familyName = str(value);
      return;
    case "name": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ScimError(400, "invalidValue", "name must be an object");
      }
      for (const [k, v] of Object.entries(value as Json)) {
        setUserAttr(`name.${k}`, v, out);
      }
      return;
    }
  }
  if (root === "name" && IGNORED_NAME_ATTRS.has(lower.slice(5))) {
    return;
  }
  if (root === "emails") {
    out.email = emailOf(value);
    return;
  }
  throw invalidPath(path);
}

function removeUserAttr(path: string, out: Partial<Person>): void {
  const lower = path.toLowerCase();
  const root = rootOf(lower);
  if (isEnterprise(path) || IGNORED_USER_ATTRS.has(root)) {
    return;
  }
  if (root === "name" && IGNORED_NAME_ATTRS.has(lower.slice(5))) {
    return;
  }
  switch (lower) {
    case "externalid":
      out.externalId = null;
      return;
    case "displayname":
      out.displayName = null;
      return;
    case "name.givenname":
      out.givenName = null;
      return;
    case "name.familyname":
      out.familyName = null;
      return;
    case "name":
      out.givenName = null;
      out.familyName = null;
      return;
    case "username":
    case "active":
      throw new ScimError(400, "mutability", `${path} cannot be removed`);
  }
  if (root === "emails") {
    out.email = null;
    return;
  }
  throw invalidPath(path);
}

/** The Person fields a User PatchOp sets. Throws ScimError (400) on anything unsupported. */
export function userPatchFields(ops: Json[]): Partial<Person> {
  const fields: Partial<Person> = {};
  for (const op of ops) {
    const kind = opKind(op);
    const raw = typeof op.path === "string" ? op.path.trim() : "";
    if (!raw) {
      if (kind === "remove") {
        throw new ScimError(400, "noTarget", "remove needs a path");
      }
      if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) {
        throw new ScimError(400, "invalidValue", "a patch without path needs an object value");
      }
      for (const [k, v] of Object.entries(op.value as Json)) {
        if (!META_KEYS.has(k)) {
          setUserAttr(stripSchemaUrn(k, USER_SCHEMA), v, fields);
        }
      }
      continue;
    }
    const path = stripSchemaUrn(raw, USER_SCHEMA);
    if (kind === "remove") {
      removeUserAttr(path, fields);
    } else {
      setUserAttr(path, op.value, fields);
    }
  }
  return fields;
}

export type GroupPatchState = {
  members: string[];
  displayName: string;
  externalId: string | null;
};

/** Apply a Group PatchOp to the current state. Throws ScimError (400) on anything unsupported. */
export function applyGroupPatch(
  ops: Json[],
  current: GroupPatchState,
  membersOf: (value: unknown) => string[],
): GroupPatchState {
  let { members, displayName, externalId } = current;
  const setAttr = (kind: "add" | "replace", key: string, value: unknown) => {
    const lower = key.toLowerCase();
    if (lower === "members") {
      members = kind === "add" ? [...new Set([...members, ...membersOf(value)])] : membersOf(value);
    } else if (lower === "displayname") {
      const v = str(value);
      if (!v) {
        throw new ScimError(400, "invalidValue", "displayName is required");
      }
      displayName = v;
    } else if (lower === "externalid") {
      externalId = str(value);
    } else {
      throw invalidPath(key);
    }
  };
  for (const op of ops) {
    const kind = opKind(op);
    const raw = typeof op?.path === "string" ? op.path.trim() : "";
    const path = stripSchemaUrn(raw, GROUP_SCHEMA);
    const lower = path.toLowerCase();
    if (!path) {
      if (kind === "remove") {
        throw new ScimError(400, "noTarget", "remove needs a path");
      }
      if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) {
        throw new ScimError(400, "invalidValue", "a patch without path needs an object value");
      }
      for (const [k, v] of Object.entries(op.value as Json)) {
        if (!META_KEYS.has(k)) {
          setAttr(kind, stripSchemaUrn(k, GROUP_SCHEMA), v);
        }
      }
      continue;
    }
    if (kind === "remove") {
      const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
      if (filtered) {
        members = members.filter((m) => m !== filtered[1]);
      } else if (lower === "members") {
        let drop: Set<string> | null = null;
        if (op.value !== undefined) {
          // Every entry must name a member: a malformed removal is a 400, never a silent no-op.
          const entries = Array.isArray(op.value) ? op.value : [op.value];
          const ids = membersOf(op.value);
          if (entries.length === 0 || ids.length !== entries.length) {
            throw new ScimError(400, "invalidValue", "each member to remove needs a value");
          }
          drop = new Set(ids);
        }
        members = drop ? members.filter((m) => !drop.has(m)) : [];
      } else if (lower === "externalid") {
        externalId = null;
      } else if (lower === "displayname") {
        throw new ScimError(400, "mutability", "displayName cannot be removed");
      } else {
        throw invalidPath(path);
      }
      continue;
    }
    setAttr(kind, path, op.value);
  }
  return { members, displayName, externalId };
}
