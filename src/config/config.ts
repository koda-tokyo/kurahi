export {
  createConfigIO,
  isConfigLoadFailure,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  writeConfigFile,
} from "./io.js";
export { migrateLegacyConfig } from "./legacy-migrate.js";
export * from "./paths.js";
export * from "./runtime-overrides.js";
export * from "./types.js";
export { validateConfigObject, validateConfigObjectWithPlugins } from "./validation.js";
export { KoLoSchema } from "./zod-schema.js";

// Alias for backward compatibility with code expecting lowercase 'koloConfig'
export type { KoLoConfig as koloConfig } from "./types.kolo.js";
