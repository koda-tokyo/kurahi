export type ArtifactExportInput = {
  title: string;
  version: number;
  status: string;
  content: string;
  storedContentSha256?: string;
};

export type ArtifactExport = {
  filename: string;
  payload: string;
  sha256: string;
  sidecarFilename: string;
  sidecarPayload: string;
};

type DigestProvider = Pick<SubtleCrypto, "digest">;

function singleLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/--/g, "- -")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

export function artifactExportFilename(title: string, version: number): string {
  assertVersion(version);
  const stem = title
    .normalize("NFC")
    .replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return `${stem || "artifact"}-v${version}.md`;
}

export function deterministicArtifactMarkdown(input: ArtifactExportInput): string {
  assertVersion(input.version);
  const storedHash = input.storedContentSha256?.trim();
  const hashPart = storedHash ? ` | stored sha256 ${singleLine(storedHash)}` : "";
  const header = `<!-- ${singleLine(input.title)} | v${input.version} | ${singleLine(input.status)}${hashPart} -->\n\n`;
  const body = input.content.replace(/\r\n?/g, "\n");
  return `${header}${body}${body.endsWith("\n") ? "" : "\n"}`;
}

export async function sha256Hex(
  payload: string,
  digestProvider: DigestProvider | null | undefined = globalThis.crypto?.subtle,
): Promise<string> {
  if (!digestProvider) {
    throw new Error("SHA-256 is unavailable; the artifact export was not created.");
  }
  let digest: ArrayBuffer;
  try {
    digest = await digestProvider.digest("SHA-256", new TextEncoder().encode(payload));
  } catch {
    throw new Error("SHA-256 failed; the artifact export was not created.");
  }
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildArtifactExport(
  input: ArtifactExportInput,
  digestProvider?: DigestProvider | null,
): Promise<ArtifactExport> {
  const filename = artifactExportFilename(input.title, input.version);
  const payload = deterministicArtifactMarkdown(input);
  const sha256 = await sha256Hex(payload, digestProvider);
  return {
    filename,
    payload,
    sha256,
    sidecarFilename: `${filename}.sha256`,
    sidecarPayload: `${sha256}  ${filename}\n`,
  };
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError("Artifact version must be a positive safe integer.");
  }
}
