// First setup file: install the isolated test HOME before any product module loads. Several modules
// compute paths when they are imported (src/config/paths.ts STATE_DIR / CONFIG_PATH,
// src/utils.ts CONFIG_DIR); ES imports in test/setup.ts are hoisted above its own code, so doing
// this there let those paths capture the real home (seen on macOS: tests wrote into ~/.kolo).
import { withIsolatedTestHome } from "./test-env";

const env = withIsolatedTestHome();
(globalThis as { __kurahiTestHome?: typeof env }).__kurahiTestHome = env;
