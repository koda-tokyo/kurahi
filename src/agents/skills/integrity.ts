// Supply-chain gate for skills (OWASP ASI04, docs/security/skill-integrity.md). Called by the
// skill loader (workspace.ts) on the merged skill set, right before SKILL.md files are read.
import type { Skill } from "@mariozechner/pi-coding-agent";
import { loadConfig, type KoLoConfig } from "../../config/config.js";
import {
  gateArtifact,
  isBundledArtifactPath,
  resolveSupplyChainMode,
} from "../../integrity/supply-chain-gate.js";
import { digestArtifact } from "../../integrity/supply-chain-hash.js";

function sameContent(a: string, b: string): boolean {
  try {
    return digestArtifact(a).sha256 === digestArtifact(b).sha256;
  } catch {
    return false;
  }
}

/**
 * Supply-chain gate (docs/security/skill-integrity.md): drop skills the lock refuses. Bundled
 * skills are exempt, and so is a byte-identical copy of one (the sandbox workspace holds copies,
 * see syncSkillsToWorkspace). In warn mode everything loads and the gate only reports.
 */
export function gatePinnedSkills(
  skills: Skill[],
  config: KoLoConfig | undefined,
  candidates: Skill[],
): Skill[] {
  // Some run paths load skills without passing the config; the gate still needs the mode.
  let effective = config;
  if (!effective) {
    try {
      effective = loadConfig();
    } catch {
      effective = undefined;
    }
  }
  const mode = resolveSupplyChainMode(effective);
  if (mode === "off") {
    return skills;
  }
  const isBundled = (skill: Skill) =>
    skill.source === "kolo-bundled" || isBundledArtifactPath(skill.baseDir);
  const bundledByName = new Map(
    candidates.filter(isBundled).map((skill) => [skill.name, skill.baseDir]),
  );
  return skills.filter((skill) => {
    const shipped = bundledByName.get(skill.name);
    const bundled =
      isBundled(skill) || (shipped !== undefined && sameContent(shipped, skill.baseDir));
    return gateArtifact({
      kind: "skill",
      name: skill.name,
      target: skill.baseDir,
      mode,
      source: "skills",
      bundled,
    }).allowed;
  });
}
