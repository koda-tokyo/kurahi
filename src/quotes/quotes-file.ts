// Files under a Project's quotes/ folder that prices may come from: the price list a quotation is
// priced from and the supplier quotes (相見積) a comparison is priced from. Only a person maintains
// them; a file in any folder the agent can write is refused, so a model cannot first write its
// own prices and then price from them. Shared by the office tools and work item procurement.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../projects/types.js";
import { PLAN_MODE_FOLDERS, resolveProjectFile } from "../projects/scope.js";
import { QuoteError, type QuoteLineInput } from "./calculate.js";
import { readXlsxRows } from "./price-list-xlsx.js";
import { decodeCsv, parseCsv, PRICE_LIST_LIMITS } from "./price-list.js";
import { readSupplierQuoteRows } from "./supplier-quote-file.js";

/**
 * Why a requested price list cannot be trusted, or null. Prices come only from a list a person
 * maintains under quotes/: never from a folder the agent can write in any mode, where a model
 * could first write its own prices and then quote from them.
 */
export function priceListDistrust(project: Pick<Project, "rules">, file: string): string | null {
  const rel = file.replace(/^(\.\/)+/, "");
  const parts = rel.split("/");
  if (
    parts[0] !== "quotes" ||
    !/\.(?:csv|xlsx)$/i.test(rel) ||
    /[\\]/.test(rel) ||
    parts.some((x) => x === ".." || x === "." || x === "")
  ) {
    return "must be a .csv or .xlsx file under quotes/";
  }
  const writable = [...project.rules.writable, ...PLAN_MODE_FOLDERS];
  if (
    writable.some(
      (w) => w === "." || w === "" || rel === w || rel.startsWith(`${w.replace(/\/+$/, "")}/`),
    )
  ) {
    return "is in a folder the agent can write, so its prices are not trusted";
  }
  return null;
}

/**
 * Read a person-maintained file under quotes/ that prices may come from, by priceListDistrust,
 * checked on the requested name and again on the real file, so a link under quotes/ cannot point
 * into output/; a hard-linked file is refused. The bytes come from one open descriptor, and the
 * checks are made on that descriptor and on the real path after opening, so the file cannot be
 * swapped between the check and the read. Where the system names an open descriptor's file
 * (/proc/self/fd on Linux) that name is the real path, so a folder swapped back after the open
 * cannot hide where the opened file lives; elsewhere the name is resolved again, which a second
 * swap timed around that check could still defeat. `label` names the file in errors. Throws
 * QuoteError.
 */
export function readTrustedQuotesFile(
  project: Project,
  rel: string,
  label: string,
): { file: string; bytes: Buffer; mtime: Date } {
  const refuse = (why: string) => new QuoteError(`${label} ${rel}: ${why}`);
  const trust = priceListDistrust(project, rel);
  if (trust) {
    throw refuse(trust);
  }
  let file: string;
  let fd: number;
  try {
    file = resolveProjectFile(project.folder, rel);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    throw refuse((err as Error).message);
  }
  try {
    const opened = fs.fstatSync(fd);
    const real = openedPath(fd) ?? fs.realpathSync(file);
    const realTrust = priceListDistrust(
      project,
      path.relative(fs.realpathSync(project.folder), real).split(path.sep).join("/"),
    );
    if (realTrust) {
      throw refuse(realTrust);
    }
    // A hard link has no real path to check: its other name may be in output/, where the agent
    // could rewrite the prices. Only a plain file with one name is trusted.
    if (!opened.isFile() || opened.nlink > 1) {
      throw refuse("must be a plain file with no other links; save a copy under quotes/");
    }
    const atReal = fs.statSync(real);
    if (atReal.dev !== opened.dev || atReal.ino !== opened.ino) {
      throw refuse("changed while it was being read; try again");
    }
    if (opened.size > PRICE_LIST_LIMITS.bytes) {
      throw refuse(`the file is larger than ${PRICE_LIST_LIMITS.bytes} bytes`);
    }
    return { file: real, bytes: fs.readFileSync(fd), mtime: opened.mtime };
  } catch (err) {
    throw err instanceof QuoteError ? err : refuse((err as Error).message);
  } finally {
    fs.closeSync(fd);
  }
}

/** Where the file open on `fd` lives now, from the kernel; null where the system cannot say. */
function openedPath(fd: number): string | null {
  let link: string;
  try {
    link = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
  // A removed file has no path left to check.
  if (!path.isAbsolute(link) || link.endsWith(" (deleted)")) {
    throw new Error("was removed while it was being read; try again");
  }
  return link;
}

/** Rows of a .csv or .xlsx price sheet, with the numbers a person sees for them. */
export function readSheet(
  file: string,
  bytes: Uint8Array,
): { rows: string[][]; rowNumbers?: number[] } {
  return /\.xlsx$/i.test(file) ? readXlsxRows(bytes) : { rows: parseCsv(decodeCsv(bytes)) };
}

export const sha256Hex = (bytes: Uint8Array) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Read a supplier's quotation sheet (相見積) under quotes/ into comparison lines, by the same trust
 * rule as a price list: what a supplier quoted must not come from a file the agent wrote.
 * Throws QuoteError.
 */
export function readSupplierQuoteFile(
  project: Project,
  rel: string,
): { lines: QuoteLineInput[]; sha256: string } {
  const { file, bytes } = readTrustedQuotesFile(project, rel, "supplier quote");
  try {
    const sheet = readSheet(file, bytes);
    return {
      lines: readSupplierQuoteRows(sheet.rows, sheet.rowNumbers),
      sha256: sha256Hex(bytes),
    };
  } catch (err) {
    throw new QuoteError(`supplier quote ${rel}: ${(err as Error).message}`);
  }
}
