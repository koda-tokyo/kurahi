// `kurahi guardian …` — Guardian operator commands. `exposure` covers the exposure check
// (docs/security/guardian.md): domain ownership (verify / attest), a run of one or all checks, and
// consent-based personal exposure enrolment. Operator actions are written to the audit log. Never
// prints a secret; a one-time consent code is printed only in relay mode, for the person.
import type { Command } from "commander";
import os from "node:os";
import { appendAudit, flushAudit } from "../audit/audit-log.js";
import { runEngineToolAsync } from "../autopilot/engine-tools.js";
import { loadConfig } from "../config/config.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import {
  defaultResolver,
  recordAttestation,
  revokeAttestation,
  verifyDomains,
  verifyTxtRecord,
  isValidDomain,
} from "../guardian/exposure/common.js";
import { EXPOSURE_CHECK_NAMES } from "../guardian/exposure/index.js";
import {
  CONSENT_TEXT_VERSION,
  type IdentifierKind,
  PERSON_CHECKS,
  type PersonCheck,
  confirmConsent,
  enrolPerson,
  listEnrolments,
  purgeExpired,
  redactedEnrolment,
  revokeConsent,
} from "../guardian/exposure/people.js";
import { defaultRuntime } from "../runtime.js";

/** Shown to the person before they confirm; its version is stored with the consent. */
export const CONSENT_TEXT = [
  `Kurahi Guardian personal exposure — consent (version ${CONSENT_TEXT_VERSION})`,
  "Purpose: protect you from phishing, impersonation and account takeover.",
  "With your consent, Kurahi checks only the identifiers you proved: whether your email appears in",
  "known breaches (Have I Been Pwned), where your handles exist on a short list of public platforms",
  "and whether lookalike handles exist there, and whether your email appears on the organisation's",
  "own websites. Nothing else is searched: no name search, no data brokers, no photos, no family.",
  "Results are visible to you and the security team only. You can revoke at any time; checks stop",
  "at once and stored results are deleted after the retention period.",
].join("\n");

function operatorIdentity(): string {
  try {
    return `operator:${os.userInfo().username}`;
  } catch {
    return "operator";
  }
}

function fail(message: string): never {
  defaultRuntime.error(`kurahi guardian: ${message}`);
  return defaultRuntime.exit(1);
}

async function audit(action: string, outcome: string, detail: Record<string, unknown>) {
  await appendAudit({
    identity: operatorIdentity(),
    device: os.hostname(),
    action,
    outcome,
    source: "cli",
    detail,
  }).catch(() => null);
  await flushAudit();
}

const home = () => resolveKoloHome();

function parseIdentifiers(opts: { email?: string[]; handle?: string[]; phone?: string[] }) {
  const out: { kind: IdentifierKind; value: string }[] = [];
  for (const [kind, list] of [
    ["email", opts.email],
    ["handle", opts.handle],
    ["phone", opts.phone],
  ] as const) {
    for (const value of list ?? []) {
      out.push({ kind, value });
    }
  }
  return out;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

export function registerGuardianCli(program: Command) {
  const guardian = program.command("guardian").description("Kurahi Guardian operator commands");
  const exposure = guardian
    .command("exposure")
    .description("Exposure check: the organisation's own verified domains seen from outside");

  exposure
    .command("verify [domain]")
    .description("Print the DNS TXT record that proves ownership, and check configured domains")
    .action(async (domain?: string) => {
      const record = verifyTxtRecord(home());
      const domains = domain ? [domain] : (loadConfig().guardian?.exposure?.domains ?? []);
      if (domain && !isValidDomain(domain)) {
        fail("not a valid lowercase domain");
      }
      defaultRuntime.log(`Add this TXT record at the apex of each domain:\n  ${record}\n`);
      const results = await verifyDomains(domains, { home: home(), resolver: defaultResolver() });
      for (const r of results) {
        defaultRuntime.log(
          `${r.domain}: ${r.verified ? `verified (${r.method})` : `NOT verified${r.error ? ` (${r.error})` : ""}`}`,
        );
      }
    });

  exposure
    .command("attest <domain>")
    .description("Record an admin attestation that the organisation owns <domain> (audited)")
    .requiredOption("--by <admin>", "the attesting admin's name or account")
    .action(async (domain: string, opts: { by: string }) => {
      if (!isValidDomain(domain)) {
        fail("not a valid lowercase domain");
      }
      const entry = recordAttestation(home(), domain, `${opts.by} (${operatorIdentity()})`);
      await audit("guardian.exposure.attest", "ok", entry);
      defaultRuntime.log(`${domain}: ownership attested by ${entry.by}`);
    });

  exposure
    .command("unattest <domain>")
    .description("Withdraw an attestation (audited)")
    .action(async (domain: string) => {
      const ok = revokeAttestation(home(), domain);
      await audit("guardian.exposure.unattest", ok ? "ok" : "failed", { domain });
      defaultRuntime.log(ok ? `${domain}: attestation withdrawn` : `${domain}: no attestation`);
    });

  exposure
    .command("run")
    .description("Run the exposure checks now and print their facts and verdicts")
    .option("--check <name>", `one of ${EXPOSURE_CHECK_NAMES.join(", ")} (or its short name)`)
    .action(async (opts: { check?: string }) => {
      const want = opts.check
        ? EXPOSURE_CHECK_NAMES.filter(
            (n) => n === opts.check || n === `guardian_exposure_${opts.check}`,
          )
        : EXPOSURE_CHECK_NAMES.filter((n) => n !== "guardian_exposure_people");
      if (want.length === 0) {
        fail(`unknown check ${opts.check}`);
      }
      for (const name of want) {
        const text = await runEngineToolAsync(name, {}, { projectId: "cli", home: home() });
        defaultRuntime.log(`== ${name}\n${text}\n`);
      }
    });

  const people = exposure
    .command("people")
    .description("Personal exposure with consent (enrol, confirm, revoke, list, purge)");

  people
    .command("consent-text")
    .description("Print the consent text the person must read before confirming")
    .action(() => defaultRuntime.log(CONSENT_TEXT));

  people
    .command("enrol")
    .description("Enrol a person (pending until they confirm with the code for their email)")
    .option("--email <address>", "the person's email (required, repeatable)", collect)
    .option("--handle <handle>", "the person's own public handle (repeatable)", collect)
    .option(
      "--phone <number>",
      "phone (attestation only; never checked without an SMS path)",
      collect,
    )
    .option("--principal <id>", "the person's Kurahi account, so they can see their results")
    .option("--self", "the person is enrolling themselves", false)
    .option("--checks <list>", `comma list of ${PERSON_CHECKS.join(",")} (default all)`)
    .action(
      async (opts: {
        email?: string[];
        handle?: string[];
        phone?: string[];
        principal?: string;
        self?: boolean;
        checks?: string;
      }) => {
        const checks = opts.checks
          ?.split(",")
          .map((c) => c.trim())
          .filter((c): c is PersonCheck => (PERSON_CHECKS as readonly string[]).includes(c));
        let r: Awaited<ReturnType<typeof enrolPerson>>;
        try {
          r = await enrolPerson({
            home: home(),
            enrolledBy: opts.self
              ? `self:${opts.principal ?? operatorIdentity()}`
              : operatorIdentity(),
            selfEnrolled: Boolean(opts.self),
            principal: opts.principal ?? null,
            identifiers: parseIdentifiers(opts),
            checks,
          });
        } catch (err) {
          return fail(String((err as Error).message ?? err));
        }
        await audit("guardian.exposure.people.enrol", "ok", redactedEnrolment(r.enrolment));
        defaultRuntime.log(`Enrolment ${r.enrolment.id} is pending the person's consent.`);
        for (const c of r.relayCodes) {
          defaultRuntime.log(
            `One-time code for ${c.identifierId} (valid 30 minutes): ${c.code}\n` +
              "Give it ONLY to the person; they confirm themselves with:\n" +
              `  kurahi guardian exposure people confirm ${r.enrolment.id} --code <code> --accept ${CONSENT_TEXT_VERSION}`,
          );
        }
      },
    );

  people
    .command("confirm <id>")
    .description(
      "The person confirms consent with their one-time code (after reading consent-text)",
    )
    .requiredOption("--code <code>", "the one-time code for their email")
    .requiredOption("--accept <version>", "the consent text version they read and accept")
    .option("--as <principal>", "the confirming person's account")
    .action(async (id: string, opts: { code: string; accept: string; as?: string }) => {
      try {
        const e = confirmConsent({
          home: home(),
          id,
          code: opts.code,
          by: opts.as ?? operatorIdentity(),
          textVersion: opts.accept,
        });
        await audit("guardian.exposure.people.consent", "ok", redactedEnrolment(e));
        defaultRuntime.log(`${id}: consent given (version ${e.consent.textVersion})`);
      } catch (err) {
        await audit("guardian.exposure.people.consent", "failed", {
          id,
          error: String((err as Error).message),
        });
        fail(String((err as Error).message ?? err));
      }
    });

  people
    .command("revoke <id>")
    .description("Revoke consent: checks stop now; data is deleted after the retention period")
    .action(async (id: string) => {
      const retentionDays = loadConfig().guardian?.exposure?.people?.retentionDays ?? 30;
      try {
        const e = revokeConsent({ home: home(), id, by: operatorIdentity(), retentionDays });
        await audit("guardian.exposure.people.revoke", "ok", { id, purgeAfter: e.purgeAfter });
        defaultRuntime.log(`${id}: consent revoked; data deleted after ${e.purgeAfter}`);
      } catch (err) {
        fail(String((err as Error).message ?? err));
      }
    });

  people
    .command("list")
    .description("List enrolments (identifiers masked)")
    .action(() => {
      defaultRuntime.log(JSON.stringify(listEnrolments(home()).map(redactedEnrolment), null, 2));
    });

  people
    .command("purge")
    .description("Delete revoked enrolments past retention and unconfirmed ones")
    .action(async () => {
      const retentionDays = loadConfig().guardian?.exposure?.people?.retentionDays ?? 30;
      const purged = purgeExpired(home(), retentionDays);
      await audit("guardian.exposure.people.purge", "ok", { purged });
      defaultRuntime.log(`${purged.length} enrolment(s) deleted`);
    });
}
