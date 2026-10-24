import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";

async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  metadata?: string;
  body?: string;
}) {
  const { dir, name, description, metadata, body } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}${metadata ? `\nmetadata: ${metadata}` : ""}
---

${body ?? `# ${name}\n`}
`,
    "utf-8",
  );
}

describe("buildWorkspaceSkillsPrompt", () => {
  it("applies bundled allowlist without affecting workspace skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "kolo-"));
    const bundledDir = path.join(workspaceDir, ".bundled");
    const bundledSkillDir = path.join(bundledDir, "peekaboo");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: bundledSkillDir,
      name: "peekaboo",
      description: "Capture UI",
      body: "# Peekaboo\n",
    });
    await writeSkill({
      dir: workspaceSkillDir,
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: bundledDir,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      config: { skills: { allowBundled: ["missing-skill"] } },
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("peekaboo");
  });

  it("an empty bundled allowlist allows no bundled skill; unset allows all", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "kolo-"));
    const bundledDir = path.join(workspaceDir, ".bundled");
    await writeSkill({
      dir: path.join(bundledDir, "peekaboo"),
      name: "peekaboo",
      description: "Capture UI",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "demo-skill"),
      name: "demo-skill",
      description: "Workspace version",
    });
    const build = (config: object) =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: bundledDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config,
      });

    const none = build({ skills: { allowBundled: [] } });
    expect(none).toContain("Workspace version");
    expect(none).not.toContain("peekaboo");
    expect(build({ skills: { allowBundled: ["  "] } })).not.toContain("peekaboo");
    expect(build({ skills: {} })).toContain("peekaboo");
  });
});
