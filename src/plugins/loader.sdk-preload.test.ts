import { describe, expect, test } from "vitest";
import { sourceImportsPluginSdkValues } from "./loader.js";

describe("sourceImportsPluginSdkValues", () => {
  test("type-only imports do not need the SDK at runtime", () => {
    expect(
      sourceImportsPluginSdkValues('import type { KoLoPluginApi } from "KoLo/plugin-sdk";'),
    ).toBe(false);
    expect(sourceImportsPluginSdkValues('import fs from "node:fs";\nexport default {};')).toBe(
      false,
    );
  });

  test("value imports and re-exports do", () => {
    expect(
      sourceImportsPluginSdkValues('import { emptyPluginConfigSchema } from "KoLo/plugin-sdk";'),
    ).toBe(true);
    expect(sourceImportsPluginSdkValues('import {\n  a,\n  b,\n} from "KoLo/plugin-sdk";')).toBe(
      true,
    );
    expect(sourceImportsPluginSdkValues('export { a } from "KoLo/plugin-sdk";')).toBe(true);
  });
});
