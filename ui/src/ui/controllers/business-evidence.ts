import type { WorkitemsEvidenceResult } from "../../../../packages/client/src/generated/types";
import type { BusinessEvidence, BusinessHost } from "./business";

/** Match both identifiers; never carry a successful badge across an aggregate failure. */
export function businessHistoryEvidenceStatus(
  evidence: BusinessEvidence | null,
  reference: { bundle: string; root: string },
): "unchecked" | "loading" | "verified" | "retained" | "failed" | "unavailable" {
  if (!evidence) {
    return "unchecked";
  }
  if (evidence.status === "loading") {
    return "loading";
  }
  const checks = evidence.historyChecks?.filter(
    (check) => check.bundle === reference.bundle && check.root === reference.root,
  );
  if (!checks?.length || checks.some((check) => check.status !== checks[0].status)) {
    return "unavailable";
  }
  const status = checks[0].status;
  return (status === "verified" || status === "retained") && evidence.status !== "verified"
    ? "unavailable"
    : status;
}

/** Explicit read-only gateway verification. The endpoint does not attest an item revision. */
export async function verifyBusinessEvidence(host: BusinessHost) {
  const client = host.client;
  const item = host.business.item;
  if (
    !client ||
    !host.connected ||
    host.tab !== "projects" ||
    host.projects.view !== "business" ||
    !item ||
    item.projectId !== host.projects.selectedId ||
    item.projectId !== host.business.projectId ||
    item.id !== host.business.selectedId ||
    host.business.loading ||
    host.business.detailLoading ||
    host.business.detailError ||
    host.business.decisionPending ||
    host.business.evidence?.status === "loading"
  ) {
    return;
  }
  const pending: BusinessEvidence = {
    itemId: item.id,
    revision: item.revision,
    status: "loading",
    checkedAt: null,
    bundles: 0,
  };
  host.business = { ...host.business, evidence: pending };
  const current = () =>
    host.client === client &&
    host.connected &&
    host.tab === "projects" &&
    host.projects.view === "business" &&
    host.projects.selectedId === item.projectId &&
    host.business.projectId === item.projectId &&
    host.business.item === item &&
    host.business.selectedId === item.id &&
    host.business.evidence === pending;
  try {
    const result = await client.request<WorkitemsEvidenceResult>("workitems.evidence", {
      projectId: item.projectId,
      id: item.id,
    });
    if (!current()) {
      return;
    }
    if (
      !result ||
      typeof result.chainOk !== "boolean" ||
      !Array.isArray(result.bundles) ||
      result.bundles.some(
        (bundle) =>
          !bundle ||
          typeof bundle.bundle !== "string" ||
          typeof bundle.ok !== "boolean" ||
          (bundle.tombstone !== undefined && typeof bundle.tombstone !== "boolean") ||
          !Array.isArray(bundle.problems),
      )
    ) {
      throw new Error("Invalid evidence result");
    }
    const names = new Set(result.bundles.map((bundle) => bundle.bundle));
    // Never claim success for a partial response that omits the history already on screen.
    const coversHistory = item.history.every(
      (event) =>
        !event.evidence ||
        result.bundles.some(
          (bundle) =>
            bundle.bundle === event.evidence!.bundle && bundle.root === event.evidence!.root,
        ),
    );
    let status: BusinessEvidence["status"];
    if (
      !result.chainOk ||
      result.bundles.some((bundle) => !bundle.ok || bundle.problems.length > 0)
    ) {
      status = "failed";
    } else if (
      !result.bundles.length ||
      names.size !== result.bundles.length ||
      !coversHistory ||
      result.bundles.some(
        (bundle) =>
          typeof bundle.root !== "string" ||
          !bundle.root ||
          typeof bundle.signer !== "string" ||
          !bundle.signer,
      )
    ) {
      status = "unavailable";
    } else {
      status = "verified";
    }
    host.business = {
      ...host.business,
      evidence: {
        ...pending,
        status,
        checkedAt: new Date().toISOString(),
        bundles: result.bundles.length,
        historyChecks: item.history.flatMap((event) => {
          if (!event.evidence) {
            return [];
          }
          const matches = result.bundles.filter(
            (bundle) =>
              bundle.bundle === event.evidence!.bundle && bundle.root === event.evidence!.root,
          );
          const bundle = matches.length === 1 ? matches[0] : undefined;
          const checkStatus = !bundle
            ? "unavailable"
            : !bundle.ok || bundle.problems.length > 0
              ? "failed"
              : status !== "verified"
                ? "unavailable"
                : bundle.tombstone === true
                  ? "retained"
                  : "verified";
          return [{ ...event.evidence, status: checkStatus }];
        }),
        retainedTombstones:
          status === "verified"
            ? result.bundles.filter((bundle) => bundle.tombstone === true).length
            : 0,
      },
    };
  } catch {
    if (current()) {
      // Transport messages can contain paths; expose only the localized unavailable state.
      host.business = { ...host.business, evidence: { ...pending, status: "unavailable" } };
    }
  }
}
