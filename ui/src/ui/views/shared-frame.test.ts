import { describe, expect, it } from "vitest";
import type { AppViewState } from "../app-view-state";
import { resolveFrameSelection } from "./shared-frame";

function stateWithFrame(
  edition: AppViewState["settings"]["edition"],
  workspace: AppViewState["settings"]["workspace"],
): AppViewState {
  return { settings: { edition, workspace } } as AppViewState;
}

describe("shared edition frame", () => {
  it("resolves an allowed workspace", () => {
    const frame = resolveFrameSelection(stateWithFrame("scholars", "education"));
    expect(frame.edition.id).toBe("scholars");
    expect(frame.workspace.id).toBe("education");
    expect(frame.workspace.density).toBe("comfortable");
  });

  it("falls back when a workspace is not licensed for the edition", () => {
    const frame = resolveFrameSelection(stateWithFrame("business", "industrial"));
    expect(frame.workspace.id).toBe("backoffice");
  });
});
