// `kurahi demo invite …`: the operator side of the private online demo invites (KURAHI_DEMO=1).
//
//   kurahi demo invite create --project <id> --label <who> [--days N] [--url <demo base url>]
//   kurahi demo invite list [--json]
//   kurahi demo invite revoke <invite id>
//
// The invite code is printed once, at create time. The store keeps only its hash, so a lost code
// cannot be shown again: revoke it and create a new one. Exit codes: 0 ok, 1 refused, 2 usage.
import type { Command } from "commander";
import {
  type DemoInvite,
  type DemoInviteDenial,
  DemoInviteStore,
  MAX_DEMO_INVITE_DAYS,
} from "../packaging/demo-invites.js";
import { isDemoProfile } from "../packaging/release-profile.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";

export const DEMO_EXIT = { ok: 0, refused: 1, usage: 2 } as const;

export type DemoCliDeps = {
  runtime?: RuntimeEnv;
  store?: () => DemoInviteStore;
  env?: Record<string, string | undefined>;
};

const DENIAL_TEXT: Record<DemoInviteDenial["reason"], string> = {
  invalid_label: "--label is required (who the invite is for)",
  invalid_project: "--project is not a Project id",
  project_has_active_invite: "that Project already has an active invite; revoke it first",
  unknown_code: "unknown invite code",
  expired: "the invite has expired",
  revoked: "the invite is already revoked",
  unknown_invite: "no invite with that id",
};

/** The link a visitor opens. The code sits in the fragment, so it never reaches a server log. */
export function demoInviteLink(baseUrl: string, code: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  url.hash = `invite=${code}`;
  return url.toString();
}

function storeOf(deps: DemoCliDeps): DemoInviteStore {
  return deps.store ? deps.store() : new DemoInviteStore();
}

export function runDemoInviteCreate(
  opts: { project?: string; label?: string; days?: string; url?: string },
  deps: DemoCliDeps = {},
): number {
  const runtime = deps.runtime ?? defaultRuntime;
  let days: number | undefined;
  if (opts.days !== undefined) {
    days = Number(opts.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DEMO_INVITE_DAYS) {
      runtime.error(`--days must be a whole number from 1 to ${MAX_DEMO_INVITE_DAYS}`);
      return DEMO_EXIT.usage;
    }
  }
  if (opts.url !== undefined && demoInviteLink(opts.url, "x") === null) {
    runtime.error("--url must be an http(s) URL");
    return DEMO_EXIT.usage;
  }
  const created = storeOf(deps).create({
    label: opts.label ?? "",
    projectId: opts.project ?? "",
    days,
  });
  if (!created.ok) {
    runtime.error(DENIAL_TEXT[created.reason]);
    return created.reason === "project_has_active_invite" ? DEMO_EXIT.refused : DEMO_EXIT.usage;
  }
  const { invite, code } = created;
  runtime.log(`Invite ${invite.id} for ${invite.label}`);
  runtime.log(`  Project  ${invite.projectId}`);
  runtime.log(`  Expires  ${invite.expiresAt}`);
  runtime.log(`  Code     ${code}`);
  if (opts.url !== undefined) {
    runtime.log(`  Link     ${demoInviteLink(opts.url, code)}`);
  }
  runtime.log(theme.muted("The code is shown only now. Send it privately."));
  if (!isDemoProfile(deps.env)) {
    runtime.log(theme.muted("Sign-in works only on a gateway started with KURAHI_DEMO=1."));
  }
  return DEMO_EXIT.ok;
}

export function runDemoInviteList(opts: { json?: boolean }, deps: DemoCliDeps = {}): number {
  const runtime = deps.runtime ?? defaultRuntime;
  const store = storeOf(deps);
  // The code hash stays in the store: a listing is often pasted into chat or a ticket.
  const rows = store.list().map((invite: DemoInvite) => ({
    id: invite.id,
    label: invite.label,
    projectId: invite.projectId,
    status: store.status(invite),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    ...(invite.revokedAt ? { revokedAt: invite.revokedAt } : {}),
    ...(invite.lastUsedAt ? { lastUsedAt: invite.lastUsedAt } : {}),
  }));
  if (opts.json) {
    runtime.log(JSON.stringify(rows, null, 2));
    return DEMO_EXIT.ok;
  }
  if (rows.length === 0) {
    runtime.log("No demo invites.");
    return DEMO_EXIT.ok;
  }
  for (const row of rows) {
    const used = row.lastUsedAt ? `  last used ${row.lastUsedAt}` : "";
    runtime.log(
      `${row.id}  ${row.status.padEnd(7)}  ${row.projectId}  ${row.label}  expires ${row.expiresAt}${used}`,
    );
  }
  return DEMO_EXIT.ok;
}

export function runDemoInviteRevoke(id: string, deps: DemoCliDeps = {}): number {
  const runtime = deps.runtime ?? defaultRuntime;
  const revoked = storeOf(deps).revoke(id);
  if (!revoked.ok) {
    runtime.error(DENIAL_TEXT[revoked.reason]);
    return revoked.reason === "unknown_invite" ? DEMO_EXIT.usage : DEMO_EXIT.refused;
  }
  runtime.log(`Revoked ${revoked.invite.id} (${revoked.invite.label}).`);
  return DEMO_EXIT.ok;
}

export function registerDemoCli(program: Command, deps: DemoCliDeps = {}) {
  const runtime = deps.runtime ?? defaultRuntime;
  const done = (code: number) => {
    if (code !== DEMO_EXIT.ok) {
      runtime.exit(code);
    }
  };
  const invite = program
    .command("demo")
    .description("Private online demo (KURAHI_DEMO=1)")
    .command("invite")
    .description("Create, list and revoke the invites that let a visitor into one Project")
    .addHelpText("after", () =>
      [
        "",
        theme.muted("Examples:"),
        `  ${formatCliCommand('kurahi demo invite create --project <id> --label "Tanaka, Example Corp" --url https://demo.example.com')}`,
        `  ${formatCliCommand("kurahi demo invite list")}`,
        `  ${formatCliCommand("kurahi demo invite revoke dinv_…")}`,
        "",
        "Exit codes: 0 ok, 1 refused, 2 usage.",
        "",
      ].join("\n"),
    );

  invite
    .command("create")
    .description("Create an invite for one Project and print its code once")
    .option("--project <id>", "the Project the visitor may open")
    .option("--label <who>", 'who the invite is for ("Tanaka, Example Corp")')
    .option("--days <n>", `days until it expires (7, at most ${MAX_DEMO_INVITE_DAYS})`)
    .option("--url <base>", "demo base URL; also print the visitor link")
    .action((opts: { project?: string; label?: string; days?: string; url?: string }) => {
      done(runDemoInviteCreate(opts, deps));
    });

  invite
    .command("list")
    .description("List invites with their status (no codes)")
    .option("--json", "JSON output", false)
    .action((opts: { json?: boolean }) => {
      done(runDemoInviteList(opts, deps));
    });

  invite
    .command("revoke <id>")
    .description("Revoke an invite; a signed-in visitor is refused on its next request")
    .action((id: string) => {
      done(runDemoInviteRevoke(id, deps));
    });
}
