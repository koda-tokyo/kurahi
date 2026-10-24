import { describe, expect, it } from "vitest";
import {
  artifactExportFilename,
  buildArtifactExport,
  deterministicArtifactMarkdown,
  sha256Hex,
} from "./artifact-export";

describe("artifact export", () => {
  it("normalizes line endings and produces the same UTF-8 payload for the same version", () => {
    const input = {
      title: "作業報告 / Shift report",
      version: 3,
      status: "approved",
      content: "確認済み\r\nLine two",
      storedContentSha256: "a".repeat(64),
    };
    const expected =
      `<!-- 作業報告 / Shift report | v3 | approved | stored sha256 ${"a".repeat(64)} -->\n\n` +
      "確認済み\nLine two\n";
    expect(deterministicArtifactMarkdown(input)).toBe(expected);
    expect(deterministicArtifactMarkdown(input)).toBe(deterministicArtifactMarkdown(input));
    expect(new TextEncoder().encode(expected)).toEqual(
      new TextEncoder().encode(deterministicArtifactMarkdown(input)),
    );
  });

  it("hashes exact export bytes and writes a matching standard sidecar", async () => {
    const exported = await buildArtifactExport({
      title: "受入検査",
      version: 2,
      status: "approved",
      content: "合格: yes",
    });
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(exported.payload),
    );
    const expectedHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(exported.sha256).toBe(expectedHash);
    expect(exported.filename).toBe("受入検査-v2.md");
    expect(exported.sidecarFilename).toBe("受入検査-v2.md.sha256");
    expect(exported.sidecarPayload).toBe(`${expectedHash}  ${exported.filename}\n`);
  });

  it("uses a known SHA-256 vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("sanitizes filenames and rejects invalid versions", () => {
    expect(artifactExportFilename("../../設備:報告?.md", 4)).toBe("設備-報告-.md-v4.md");
    expect(artifactExportFilename("...", 1)).toBe("artifact-v1.md");
    expect(() => artifactExportFilename("report", 0)).toThrow(RangeError);
    expect(() => artifactExportFilename("report", 1.5)).toThrow(RangeError);
  });

  it("keeps untrusted provenance on one harmless comment line", () => {
    const payload = deterministicArtifactMarkdown({
      title: "title -->\n# injected",
      version: 1,
      status: "review\r\nchanged",
      content: "body",
    });
    expect(payload).toContain("<!-- title - -&gt; # injected | v1 | review  changed -->");
    expect(payload).not.toContain("\r");
  });

  it("blocks export when the digest provider is absent or fails", async () => {
    await expect(sha256Hex("bytes", null)).rejects.toThrow(/SHA-256/);
    await expect(
      sha256Hex("bytes", {
        digest: async () => {
          throw new Error("failure");
        },
      }),
    ).rejects.toThrow("SHA-256 failed; the artifact export was not created.");
  });
});
