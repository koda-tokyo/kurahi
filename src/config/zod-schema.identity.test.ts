import { describe, expect, it } from "vitest";
import { resolveIdentitySettings } from "../identity/config.js";
import { GatewayIdentitySchema } from "./zod-schema.identity.js";

const provider = (id: string) => ({
  id,
  kind: "oidc" as const,
  issuer: "https://idp.example.test",
  clientId: "kurahi",
});

describe("gateway.identity provider ids", () => {
  it("rejects the reserved ids scim and legacy", () => {
    for (const id of ["scim", "legacy"]) {
      const parsed = GatewayIdentitySchema.safeParse({ providers: [provider(id)] });
      expect(parsed.success, id).toBe(false);
      const scim = GatewayIdentitySchema.safeParse({ scim: { providerId: id } });
      expect(scim.success, id).toBe(false);
    }
    expect(GatewayIdentitySchema.safeParse({ providers: [provider("corp")] }).success).toBe(true);
  });

  it("never uses a reserved provider id even when validation was bypassed", () => {
    const s = resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      providers: [provider("scim"), provider("corp")],
    });
    expect(s.providers.map((p) => p.id)).toEqual(["corp"]);
    expect(s.problems.join(" ")).toContain("reserved");
  });
});
