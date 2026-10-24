import { describe, expect, it } from "vitest";
import { rewriteWorkspaceSpecs } from "../../scripts/npm-pack.mjs";

describe("npm-pack workspace specifiers", () => {
  it("pins workspace: dependencies to the workspace package version", () => {
    const pkg = {
      name: "kurahi",
      dependencies: { "@kodasoken/kurahi-client": "workspace:*", chalk: "^5.6.2" },
      devDependencies: { kolo: "workspace:kurahi@*" },
    };
    const out = rewriteWorkspaceSpecs(pkg, new Map([["@kodasoken/kurahi-client", "2.1.0"]]));
    expect(out.dependencies).toEqual({ "@kodasoken/kurahi-client": "2.1.0", chalk: "^5.6.2" });
    // devDependencies are not installed from the registry tarball; left as they are.
    expect(out.devDependencies).toEqual({ kolo: "workspace:kurahi@*" });
    expect(pkg.dependencies["@kodasoken/kurahi-client"]).toBe("workspace:*");
  });

  it("refuses a workspace: dependency with no workspace package", () => {
    expect(() =>
      rewriteWorkspaceSpecs({ dependencies: { missing: "workspace:*" } }, new Map()),
    ).toThrow(/no workspace package/);
  });
});
