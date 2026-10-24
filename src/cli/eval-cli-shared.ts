// Shared plumbing for the `kurahi eval …` command modules.
import { fileURLToPath } from "node:url";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export const EVAL_EXIT = { pass: 0, quality: 1, gate: 2, invalid: 3, usage: 4 } as const;

export type EvalCliDeps = {
  runtime?: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  bundledRoot?: string;
  now?: () => Date;
};

const BUNDLED_ROOT = fileURLToPath(new URL("../../eval/workflows/", import.meta.url));

export function ctxOf(deps: EvalCliDeps = {}) {
  return {
    runtime: deps.runtime ?? defaultRuntime,
    env: deps.env ?? process.env,
    bundledRoot: deps.bundledRoot ?? BUNDLED_ROOT,
    now: deps.now,
  };
}
