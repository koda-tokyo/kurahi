// Gateway startup wiring for enterprise identity (called once from server.impl.ts).
//
// Work item access policies resolve `person:<id>` principals to the groups the identity layer
// exports (`role:approver`, `role:department-manager@sales`, `unit:sales`, `group:<IdP group>`),
// so a Project's `access.groups` can grant stage roles to IdP groups and org roles. The stage
// rules still decide; an org role only makes a person eligible where the Project maps it.
import type { KoLoConfig } from "../config/config.js";
import { setPrincipalGroupResolver } from "../workitems/access.js";
import { getIdentityService } from "./service.js";

export function installIdentityHooks(opts: {
  config: KoLoConfig;
  log: { warn: (message: string) => void; info: (message: string) => void };
}): void {
  const svc = getIdentityService(opts.config);
  for (const problem of svc.settings.problems) {
    opts.log.warn(`identity: ${problem}`);
  }
  const s = svc.settings;
  if (s.providers.length > 0 || s.scim.enabled) {
    opts.log.info(
      `identity: ${s.providers.length} SSO provider(s)${s.scim.enabled ? ", SCIM on" : ""}${s.ssoRequired ? ", SSO required" : ""}`,
    );
  }
  setPrincipalGroupResolver((principal) =>
    getIdentityService().projectGroupsForPrincipal(principal),
  );
}
