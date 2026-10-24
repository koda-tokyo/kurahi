import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentKeyLocations } from "./keys.js";

/** Isolated key locations under a fresh temp dir (tests). */
export function tempAgentKeyLocations(): AgentKeyLocations & { home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-agent-keys-"));
  return {
    home,
    keysDir: path.join(home, "secrets", "agent-keys"),
    registryPath: path.join(home, "identity", "agent-keys.json"),
    ownerKeyPath: path.join(home, "secrets", "policy-owner.json"),
    ownersPath: path.join(home, "policy", "owners.json"),
  };
}
