// Pin-time static scan for skills and plugin packages (OWASP ASI04).
//
// A short list of line-level regexes for patterns that have no business in most skills:
// piping a download into a shell, decoding base64 into an interpreter, appending to shell rc
// files, reading credential stores, reverse shells. A hit blocks `kurahi skills pin` until the
// operator has looked and passes `--force`. This is a tripwire for the obvious cases, not a
// malware scanner: obfuscated, split or binary payloads pass it, and a clean scan proves nothing.

import fs from "node:fs";
import { listArtifactFiles } from "./supply-chain-hash.js";

export type ScanRule = { id: string; title: string; re: RegExp };

export const SCAN_RULES: ScanRule[] = [
  {
    id: "pipe-to-shell",
    title: "downloads piped into a shell",
    re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b/i,
  },
  {
    id: "base64-exec",
    title: "base64-decoded content executed",
    re: /base64\s+(-d|--decode|-D)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b|\beval\s*\(\s*(atob\s*\(|Buffer\.from\([^)]*["']base64["'])|\bexec\s*\(\s*(base64\.)?b64decode\b/i,
  },
  {
    id: "shell-rc-write",
    title: "writes to a shell startup file",
    re: /(>>?|\btee\s+(-a\s+)?)\s*["']?(~|\$HOME|\$\{HOME\})?[^\s"']*\/\.(bashrc|bash_profile|zshrc|zshenv|zprofile|profile)\b/,
  },
  {
    id: "credential-path",
    title: "references a credential store",
    re: /(~|\$HOME|\$\{HOME\})\/\.(ssh|aws|gnupg|kube|netrc)\b|\.aws\/credentials\b|\.docker\/config\.json\b|\bid_(rsa|ed25519|ecdsa)\b|["']\.(ssh|aws|gnupg)["']/,
  },
  {
    id: "reverse-shell",
    title: "reverse-shell pattern",
    re: /\/dev\/tcp\/|\b(nc|ncat|netcat)\b[^\n]*\s-e\s/,
  },
];

export type ScanFinding = {
  rule: string;
  title: string;
  file: string;
  line: number;
  excerpt: string;
};

export type ScanResult = {
  findings: ScanFinding[];
  scannedFiles: number;
  /** Files not scanned: binary or larger than the cap. */
  skipped: string[];
};

const MAX_SCAN_BYTES = 1024 * 1024;

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

/** Scan the text files of an artifact (same file set as the digest). */
export function scanArtifact(target: string): ScanResult {
  const findings: ScanFinding[] = [];
  const skipped: string[] = [];
  let scannedFiles = 0;
  for (const f of listArtifactFiles(target)) {
    if (f.size < 0) {
      continue;
    }
    if (f.size > MAX_SCAN_BYTES) {
      skipped.push(f.rel);
      continue;
    }
    const buf = fs.readFileSync(f.abs);
    if (looksBinary(buf)) {
      skipped.push(f.rel);
      continue;
    }
    scannedFiles += 1;
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((text, idx) => {
      for (const rule of SCAN_RULES) {
        if (rule.re.test(text)) {
          findings.push({
            rule: rule.id,
            title: rule.title,
            file: f.rel,
            line: idx + 1,
            excerpt: text.trim().slice(0, 160),
          });
        }
      }
    });
  }
  return { findings, scannedFiles, skipped };
}
