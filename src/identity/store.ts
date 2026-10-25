// Identity directory: persons, SCIM groups, org units, role assignments and group mappings.
//
// State lives in memory and is mirrored to `<KOLO_HOME>/identity/directory.json` (0600, written
// atomically) after every mutation. One writer: the gateway process. Nothing is read at import.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AssignmentSubject,
  GroupMapping,
  OrgRole,
  OrgUnit,
  OrgUnitKind,
  Person,
  PersonLink,
  RoleAssignment,
  ScimGroup,
  Tombstone,
} from "./types.js";
import { resolveStateDir } from "../config/paths.js";

export const DIRECTORY_FILENAME = "directory.json";
const MAX_PERSONS = 50_000;
const MAX_GROUPS = 10_000;
const MAX_UNITS = 2_000;
const MAX_ASSIGNMENTS = 50_000;
const MAX_MAPPINGS = 2_000;
const MAX_TOMBSTONES = 50_000;
export const UNIT_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

type DirectoryFile = {
  version: 1;
  org: { name: string | null };
  persons: Person[];
  groups: ScimGroup[];
  units: OrgUnit[];
  assignments: RoleAssignment[];
  /** `source` / `matchDisplayName` are absent in directories written before scoping. */
  mappings: Array<
    Omit<GroupMapping, "source" | "matchDisplayName"> & {
      source?: string;
      matchDisplayName?: boolean;
    }
  >;
  tombstones?: Tombstone[];
};

export class IdentityError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

export function identityDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity");
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

const lower = (v: string | null | undefined) => (v ? v.trim().toLowerCase() : null);
const mappingKey = (source: string, group: string) => `${source}\n${group}`;

/** A person's group memberships, by source (what group mappings match against). */
export type GroupMemberships = {
  scim: Array<{ id: string; externalId: string | null; displayName: string }>;
  claims: { providerId: string | null; values: string[] };
};

export class IdentityStore {
  private readonly filePath: string | null;
  private readonly now: () => Date;
  private orgName: string | null = null;
  private persons = new Map<string, Person>();
  private groups = new Map<string, ScimGroup>();
  private units = new Map<string, OrgUnit>();
  private assignments = new Map<string, RoleAssignment>();
  private mappings = new Map<string, GroupMapping>();
  private tombstones = new Map<string, Tombstone>();
  private readonly maxTombstones: number;
  private readonly changeListeners = new Set<() => void>();

  constructor(opts: { filePath?: string | null; now?: () => Date; maxTombstones?: number } = {}) {
    this.filePath =
      opts.filePath === undefined ? path.join(identityDir(), DIRECTORY_FILENAME) : opts.filePath;
    this.now = opts.now ?? (() => new Date());
    this.maxTombstones = opts.maxTombstones ?? MAX_TOMBSTONES;
    this.load();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private load(): void {
    if (!this.filePath) {
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    const parsed = JSON.parse(raw) as DirectoryFile;
    if (!parsed || parsed.version !== 1) {
      throw new Error(`identity directory has an unsupported version: ${this.filePath}`);
    }
    this.orgName = parsed.org?.name ?? null;
    for (const p of parsed.persons ?? []) {
      this.persons.set(p.id, p);
    }
    for (const g of parsed.groups ?? []) {
      this.groups.set(g.id, g);
    }
    for (const u of parsed.units ?? []) {
      this.units.set(u.id, u);
    }
    for (const a of parsed.assignments ?? []) {
      this.assignments.set(a.id, a);
    }
    for (const raw of parsed.mappings ?? []) {
      // Unscoped mappings from before provider scoping never match (fail closed).
      const m: GroupMapping = {
        ...raw,
        source: raw.source || "legacy",
        matchDisplayName: raw.matchDisplayName === true,
      };
      this.mappings.set(mappingKey(m.source, m.group), m);
    }
    for (const t of parsed.tombstones ?? []) {
      this.tombstones.set(t.id, t);
    }
  }

  /**
   * Called after every directory change (persons, groups, units, assignments, mappings, org,
   * tombstones); open person connections re-evaluate their principal. Returns the unsubscribe.
   */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  private emitChange(): void {
    for (const fn of this.changeListeners) {
      try {
        fn();
      } catch {
        // a listener failure never blocks a directory write
      }
    }
  }

  // Every mutation ends here, so this is also the change hook.
  private persist(): void {
    try {
      this.writeFile();
    } finally {
      this.emitChange();
    }
  }

  private writeFile(): void {
    if (!this.filePath) {
      return;
    }
    const state: DirectoryFile = {
      version: 1,
      org: { name: this.orgName },
      persons: [...this.persons.values()],
      groups: [...this.groups.values()],
      units: [...this.units.values()],
      assignments: [...this.assignments.values()],
      mappings: [...this.mappings.values()],
      tombstones: [...this.tombstones.values()],
    };
    writeJsonAtomic(this.filePath, state);
  }

  // ── persons ────────────────────────────────────────────────────────────────────────────

  listPersons(): Person[] {
    return [...this.persons.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getPerson(id: string): Person | null {
    return this.persons.get(id) ?? null;
  }

  findByUserName(userName: string): Person | null {
    const key = lower(userName);
    return [...this.persons.values()].find((p) => lower(p.userName) === key) ?? null;
  }

  findByLink(providerId: string, issuer: string, subject: string): Person | null {
    // Issuers compare without a trailing slash (the OIDC client accepts both forms).
    const iss = issuer.replace(/\/+$/, "");
    return (
      [...this.persons.values()].find((p) =>
        p.links.some(
          (l) =>
            l.providerId === providerId &&
            l.issuer.replace(/\/+$/, "") === iss &&
            l.subject === subject,
        ),
      ) ?? null
    );
  }

  /** A SCIM-provisioned person whose `externalId` is this IdP subject. */
  findByExternalId(externalId: string): Person | null {
    return (
      [...this.persons.values()].find(
        (p) => p.source === "scim" && p.externalId !== null && p.externalId === externalId,
      ) ?? null
    );
  }

  /** A person whose userName or e-mail equals the signed-in e-mail. */
  findByEmail(email: string): Person | null {
    const key = lower(email);
    if (!key) {
      return null;
    }
    return (
      [...this.persons.values()].find((p) => lower(p.userName) === key || lower(p.email) === key) ??
      null
    );
  }

  createPerson(input: Partial<Person> & { userName: string; source: Person["source"] }): Person {
    if (this.persons.size >= MAX_PERSONS) {
      throw new IdentityError("limit", "too many persons");
    }
    if (this.findByUserName(input.userName)) {
      throw new IdentityError("conflict", "userName is already in use");
    }
    const now = this.iso();
    const person: Person = {
      id: randomUUID(),
      userName: input.userName.trim(),
      externalId: input.externalId ?? null,
      email: input.email ?? null,
      displayName: input.displayName ?? null,
      givenName: input.givenName ?? null,
      familyName: input.familyName ?? null,
      active: input.active ?? true,
      links: input.links ?? [],
      emailVerifiedBy: input.emailVerifiedBy ?? null,
      claimGroups: input.claimGroups ?? [],
      source: input.source,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      deactivatedAt: input.active === false ? now : null,
    };
    this.persons.set(person.id, person);
    this.persist();
    return person;
  }

  updatePerson(id: string, patch: Partial<Omit<Person, "id" | "createdAt">>): Person {
    const cur = this.persons.get(id);
    if (!cur) {
      throw new IdentityError("not_found", "person not found");
    }
    if (patch.userName !== undefined) {
      const other = this.findByUserName(patch.userName);
      if (other && other.id !== id) {
        throw new IdentityError("conflict", "userName is already in use");
      }
    }
    const next: Person = { ...cur, ...patch, id, updatedAt: this.iso() };
    if (cur.active && !next.active) {
      next.deactivatedAt = this.iso();
    } else if (next.active) {
      next.deactivatedAt = null;
    }
    this.persons.set(id, next);
    this.persist();
    return next;
  }

  /** Remove a person's link to one provider (admin); returns the updated person. */
  removeLink(id: string, providerId: string): Person {
    const cur = this.getPerson(id);
    if (!cur) {
      throw new IdentityError("not_found", "person not found");
    }
    return this.updatePerson(id, { links: cur.links.filter((l) => l.providerId !== providerId) });
  }

  addLink(id: string, link: PersonLink): Person {
    const cur = this.getPerson(id);
    if (!cur) {
      throw new IdentityError("not_found", "person not found");
    }
    const links = cur.links.filter((l) => l.providerId !== link.providerId);
    return this.updatePerson(id, { links: [...links, link] });
  }

  /**
   * Delete a person, their group memberships and every role assignment naming them (by id, and
   * by their e-mail or userName). With `tombstone`, remember who they were so a later sign-in
   * cannot re-create them just in time.
   */
  deletePerson(
    id: string,
    opts: {
      tombstone?: string;
      /**
       * At the tombstone cap, drop the oldest one. Only safe while sign-in requires provisioning
       * (`requireProvisioned`): otherwise a dropped tombstone lets that person be re-created just
       * in time. Without it a full store refuses the delete (`limit`) before changing anything.
       */
      evictOldestTombstone?: boolean;
    } = {},
  ): { assignments: number; tombstone: Tombstone | null } {
    const person = this.persons.get(id);
    if (!person) {
      throw new IdentityError("not_found", "person not found");
    }
    if (
      opts.tombstone &&
      this.tombstones.size >= this.maxTombstones &&
      !opts.evictOldestTombstone
    ) {
      throw new IdentityError("limit", "tombstone store is full");
    }
    this.persons.delete(id);
    for (const g of this.groups.values()) {
      g.members = g.members.filter((m) => m !== id);
    }
    const subjects = new Set<string>([`person:${id}`]);
    for (const e of [person.email, person.userName]) {
      if (e && e.includes("@")) {
        subjects.add(`email:${e.trim().toLowerCase()}`);
      }
    }
    let assignments = 0;
    for (const [aid, a] of this.assignments) {
      if (subjects.has(a.subject)) {
        this.assignments.delete(aid);
        assignments += 1;
      }
    }
    let tombstone: Tombstone | null = null;
    if (opts.tombstone) {
      if (this.tombstones.size >= this.maxTombstones) {
        // Oldest first: the cap bounds the file, the newest deletions matter most.
        const oldest = [...this.tombstones.values()].toSorted((a, b) =>
          a.deletedAt.localeCompare(b.deletedAt),
        )[0];
        if (oldest) {
          this.tombstones.delete(oldest.id);
        }
      }
      tombstone = {
        id: randomUUID(),
        personId: id,
        userName: person.userName,
        email: person.email,
        externalId: person.externalId,
        links: person.links,
        deletedAt: this.iso(),
        deletedBy: opts.tombstone,
      };
      this.tombstones.set(tombstone.id, tombstone);
    }
    this.persist();
    return { assignments, tombstone };
  }

  // ── tombstones (deleted persons that may not come back by sign-in) ────────────────────

  listTombstones(): Tombstone[] {
    return [...this.tombstones.values()].toSorted((a, b) => a.deletedAt.localeCompare(b.deletedAt));
  }

  /** The tombstone a sign-in matches: same link, same subject as externalId, or same e-mail. */
  findTombstone(claims: {
    providerId: string;
    issuer: string;
    subject: string;
    email: string | null;
  }): Tombstone | null {
    const iss = claims.issuer.replace(/\/+$/, "");
    const email = lower(claims.email);
    return (
      [...this.tombstones.values()].find(
        (t) =>
          t.links.some(
            (l) =>
              l.providerId === claims.providerId &&
              l.issuer.replace(/\/+$/, "") === iss &&
              l.subject === claims.subject,
          ) ||
          (t.externalId !== null && t.externalId === claims.subject) ||
          (email !== null && (lower(t.email) === email || lower(t.userName) === email)),
      ) ?? null
    );
  }

  restoreTombstone(id: string): Tombstone {
    const t = this.tombstones.get(id);
    if (!t) {
      throw new IdentityError("not_found", "tombstone not found");
    }
    this.tombstones.delete(id);
    this.persist();
    return t;
  }

  /** SCIM provisioned this user again: drop tombstones with the same userName or externalId. */
  clearTombstonesFor(person: Person): number {
    let n = 0;
    for (const [tid, t] of this.tombstones) {
      if (
        lower(t.userName) === lower(person.userName) ||
        (t.externalId !== null && t.externalId === person.externalId)
      ) {
        this.tombstones.delete(tid);
        n += 1;
      }
    }
    if (n > 0) {
      this.persist();
    }
    return n;
  }

  // ── SCIM groups ────────────────────────────────────────────────────────────────────────

  listGroups(): ScimGroup[] {
    return [...this.groups.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getGroup(id: string): ScimGroup | null {
    return this.groups.get(id) ?? null;
  }

  createGroup(input: { displayName: string; externalId?: string | null; members?: string[] }) {
    if (this.groups.size >= MAX_GROUPS) {
      throw new IdentityError("limit", "too many groups");
    }
    const name = lower(input.displayName);
    if ([...this.groups.values()].some((g) => lower(g.displayName) === name)) {
      throw new IdentityError("conflict", "displayName is already in use");
    }
    const now = this.iso();
    const group: ScimGroup = {
      id: randomUUID(),
      displayName: input.displayName.trim(),
      externalId: input.externalId ?? null,
      members: this.knownMembers(input.members ?? []),
      createdAt: now,
      updatedAt: now,
    };
    this.groups.set(group.id, group);
    this.persist();
    return group;
  }

  updateGroup(
    id: string,
    patch: Partial<Pick<ScimGroup, "displayName" | "externalId" | "members">>,
  ) {
    const cur = this.groups.get(id);
    if (!cur) {
      throw new IdentityError("not_found", "group not found");
    }
    const next: ScimGroup = {
      ...cur,
      ...patch,
      members: patch.members ? this.knownMembers(patch.members) : cur.members,
      updatedAt: this.iso(),
    };
    this.groups.set(id, next);
    this.persist();
    return next;
  }

  deleteGroup(id: string): void {
    if (!this.groups.delete(id)) {
      throw new IdentityError("not_found", "group not found");
    }
    this.persist();
  }

  private knownMembers(ids: string[]): string[] {
    return [...new Set(ids)].filter((m) => this.persons.has(m));
  }

  /** SCIM memberships and the claim groups of the last sign-in, kept apart by source. */
  groupMembershipsOf(personId: string): GroupMemberships {
    const person = this.persons.get(personId);
    return {
      scim: [...this.groups.values()]
        .filter((g) => g.members.includes(personId))
        .map((g) => ({ id: g.id, externalId: g.externalId, displayName: g.displayName })),
      claims: {
        providerId: person?.claimGroupsFrom ?? null,
        values: person?.claimGroupsFrom ? person.claimGroups : [],
      },
    };
  }

  /**
   * Scoped, immutable group values a person carries: `scim:<id>` and `scim:<externalId>` for
   * SCIM groups, `<providerId>:<value>` for the groups the last sign-in asserted. Display names
   * are not included (they can be renamed).
   */
  groupValuesOf(personId: string): string[] {
    const m = this.groupMembershipsOf(personId);
    const out = new Set<string>();
    for (const g of m.scim) {
      out.add(`scim:${g.id}`);
      if (g.externalId) {
        out.add(`scim:${g.externalId}`);
      }
    }
    if (m.claims.providerId) {
      for (const v of m.claims.values) {
        out.add(`${m.claims.providerId}:${v}`);
      }
    }
    return [...out];
  }

  // ── org ────────────────────────────────────────────────────────────────────────────────

  getOrgName(): string | null {
    return this.orgName;
  }

  setOrgName(name: string | null): void {
    this.orgName = name;
    this.persist();
  }

  listUnits(): OrgUnit[] {
    return [...this.units.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  getUnit(id: string): OrgUnit | null {
    return this.units.get(id) ?? null;
  }

  upsertUnit(input: {
    id: string;
    name: string;
    kind: OrgUnitKind;
    parentId?: string | null;
    department?: string | null;
  }): OrgUnit {
    if (!UNIT_ID_RE.test(input.id)) {
      throw new IdentityError("invalid", "unit id must be a lowercase slug");
    }
    const cur = this.units.get(input.id);
    if (!cur && this.units.size >= MAX_UNITS) {
      throw new IdentityError("limit", "too many org units");
    }
    const parentId = input.parentId ?? null;
    if (input.kind === "team" && !parentId) {
      throw new IdentityError("invalid", "a team needs a parent unit");
    }
    if (parentId) {
      if (!this.units.has(parentId)) {
        throw new IdentityError("invalid", `parent unit ${parentId} does not exist`);
      }
      // No cycles: walk up from the parent.
      for (let at: string | null = parentId, hops = 0; at; hops += 1) {
        if (at === input.id || hops > MAX_UNITS) {
          throw new IdentityError("invalid", "unit parents may not form a cycle");
        }
        at = this.units.get(at)?.parentId ?? null;
      }
    }
    const now = this.iso();
    const unit: OrgUnit = {
      id: input.id,
      name: input.name.trim().slice(0, 120),
      kind: input.kind,
      parentId,
      department: input.department ?? null,
      createdAt: cur?.createdAt ?? now,
      updatedAt: now,
    };
    this.units.set(unit.id, unit);
    this.persist();
    return unit;
  }

  removeUnit(id: string): void {
    if (!this.units.has(id)) {
      throw new IdentityError("not_found", "unit not found");
    }
    if ([...this.units.values()].some((u) => u.parentId === id)) {
      throw new IdentityError("conflict", "unit has child units");
    }
    if ([...this.assignments.values()].some((a) => a.unit === id)) {
      throw new IdentityError("conflict", "unit is used by role assignments");
    }
    if ([...this.mappings.values()].some((m) => m.units.includes(id))) {
      throw new IdentityError("conflict", "unit is used by group mappings");
    }
    this.units.delete(id);
    this.persist();
  }

  /** The unit and every unit above it (a team member belongs to its department too). */
  unitAncestry(id: string): string[] {
    const out: string[] = [];
    for (let at: string | null = id; at && out.length <= MAX_UNITS; ) {
      out.push(at);
      at = this.units.get(at)?.parentId ?? null;
    }
    return out;
  }

  /** The unit and every unit below it (a manager of a department covers its teams). */
  unitDescendants(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length && out.length <= MAX_UNITS; i += 1) {
      for (const u of this.units.values()) {
        if (u.parentId === out[i] && !out.includes(u.id)) {
          out.push(u.id);
        }
      }
    }
    return out;
  }

  // ── role assignments ───────────────────────────────────────────────────────────────────

  listAssignments(): RoleAssignment[] {
    return [...this.assignments.values()].toSorted((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  assign(
    subject: AssignmentSubject,
    role: OrgRole,
    unit: string | null,
    by: string,
  ): RoleAssignment {
    if (unit && !this.units.has(unit)) {
      throw new IdentityError("invalid", `unit ${unit} does not exist`);
    }
    const existing = [...this.assignments.values()].find(
      (a) => a.subject === subject && a.role === role && a.unit === unit,
    );
    if (existing) {
      return existing;
    }
    if (this.assignments.size >= MAX_ASSIGNMENTS) {
      throw new IdentityError("limit", "too many role assignments");
    }
    const a: RoleAssignment = {
      id: randomUUID(),
      subject,
      role,
      unit,
      createdAt: this.iso(),
      createdBy: by,
    };
    this.assignments.set(a.id, a);
    this.persist();
    return a;
  }

  revokeAssignment(id: string): RoleAssignment {
    const a = this.assignments.get(id);
    if (!a) {
      throw new IdentityError("not_found", "assignment not found");
    }
    this.assignments.delete(id);
    this.persist();
    return a;
  }

  // ── group mappings ─────────────────────────────────────────────────────────────────────

  listMappings(): GroupMapping[] {
    return [...this.mappings.values()].toSorted(
      (a, b) => a.source.localeCompare(b.source) || a.group.localeCompare(b.group),
    );
  }

  setMapping(
    input: {
      source: string;
      group: string;
      roles: OrgRole[];
      units: string[];
      matchDisplayName?: boolean;
    },
    by: string,
  ): GroupMapping {
    for (const u of input.units) {
      if (!this.units.has(u)) {
        throw new IdentityError("invalid", `unit ${u} does not exist`);
      }
    }
    if (input.matchDisplayName && input.source !== "scim") {
      throw new IdentityError("invalid", "matchDisplayName applies to SCIM groups only");
    }
    const key = mappingKey(input.source, input.group);
    if (!this.mappings.has(key) && this.mappings.size >= MAX_MAPPINGS) {
      throw new IdentityError("limit", "too many group mappings");
    }
    const m: GroupMapping = {
      source: input.source,
      group: input.group,
      matchDisplayName: input.matchDisplayName === true,
      roles: [...new Set(input.roles)],
      units: [...new Set(input.units)],
      updatedAt: this.iso(),
      updatedBy: by,
    };
    this.mappings.set(key, m);
    this.persist();
    return m;
  }

  removeMapping(source: string, group: string): GroupMapping {
    const key = mappingKey(source, group);
    const m = this.mappings.get(key);
    if (!m) {
      throw new IdentityError("not_found", "mapping not found");
    }
    this.mappings.delete(key);
    this.persist();
    return m;
  }
}
