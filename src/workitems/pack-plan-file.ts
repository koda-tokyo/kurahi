// The linked-case plans a project's pack worksheets offer (people-operations onboarding and
// offboarding under requests/). Read-only: a plan only prefills the console builder, and a person
// still submits it through workitems.linked.create. A worksheet is read only from a folder a
// person maintains: one in a folder the agent can write is refused, so a model cannot write its
// own routing and have it offered as the pack's. The bytes come from one descriptor opened without
// following a final link; a hard-linked file, or one whose real path is not the requested name, is
// refused. A missing worksheet is simply not offered.
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../projects/types.js";
import { PLAN_MODE_FOLDERS, resolveProjectFile } from "../projects/scope.js";
import { linkedPlanFromWorksheet, type WorksheetPlan } from "./pack-plan.js";

/** Worksheets that carry a linked-case plan, in the order the console offers them. */
export const PACK_PLAN_FILES = ["requests/onboarding.md", "requests/offboarding.md"] as const;
const MAX_WORKSHEET_BYTES = 64 * 1024;

export type PackPlanFileProblem =
  | { code: "untrusted_file" }
  | { code: "unreadable_file" }
  | { code: "file_too_large" };

export type PackPlan = Omit<WorksheetPlan, "problems"> & {
  file: string;
  problems: Array<WorksheetPlan["problems"][number] | PackPlanFileProblem>;
};

function agentWritable(project: Pick<Project, "rules">, rel: string): boolean {
  return [...project.rules.writable, ...PLAN_MODE_FOLDERS].some(
    (w) => w === "." || w === "" || rel === w || rel.startsWith(`${w.replace(/\/+$/, "")}/`),
  );
}

type Read = { bytes: Buffer } | { problem: PackPlanFileProblem } | null;

function readWorksheet(project: Project, rel: string): Read {
  let file: string;
  try {
    file = resolveProjectFile(project.folder, rel);
  } catch {
    // Missing, or a link leading out of the folder. A missing worksheet is not offered.
    return fs.existsSync(path.join(project.folder, rel))
      ? { problem: { code: "unreadable_file" } }
      : null;
  }
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return { problem: { code: "unreadable_file" } };
  }
  try {
    const opened = fs.fstatSync(fd);
    const real = fs.realpathSync(file);
    const at = fs.statSync(real);
    const relReal = path.relative(fs.realpathSync(project.folder), real).split(path.sep).join("/");
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      relReal !== rel ||
      at.dev !== opened.dev ||
      at.ino !== opened.ino
    ) {
      return { problem: { code: "unreadable_file" } };
    }
    if (opened.size > MAX_WORKSHEET_BYTES) {
      return { problem: { code: "file_too_large" } };
    }
    return { bytes: fs.readFileSync(fd) };
  } catch {
    return { problem: { code: "unreadable_file" } };
  } finally {
    fs.closeSync(fd);
  }
}

/** The plans this project's worksheets offer; a worksheet that cannot be trusted or read is reported, never guessed. */
export function readPackPlans(project: Project): PackPlan[] {
  const out: PackPlan[] = [];
  for (const file of PACK_PLAN_FILES) {
    if (agentWritable(project, file)) {
      if (fs.existsSync(path.join(project.folder, file))) {
        out.push({ file, plan: null, sourceKeys: {}, problems: [{ code: "untrusted_file" }] });
      }
      continue;
    }
    const read = readWorksheet(project, file);
    if (!read) {
      continue;
    }
    if ("problem" in read) {
      out.push({ file, plan: null, sourceKeys: {}, problems: [read.problem] });
      continue;
    }
    out.push({ file, ...linkedPlanFromWorksheet(read.bytes.toString("utf8")) });
  }
  return out;
}
