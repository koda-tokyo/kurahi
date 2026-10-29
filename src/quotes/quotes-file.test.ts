import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../projects/types.js";
import { readTrustedQuotesFile, sha256Hex } from "./quotes-file.js";

const PERSON = "品番,数量,単価\nA-100,10,1200\n";
const AGENT = "品番,数量,単価\nA-100,10,1\n";

function project(): { project: Project; at: (rel: string) => string } {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "quotes-file-"));
  const at = (rel: string) => path.join(folder, rel);
  fs.mkdirSync(at("quotes/sub"), { recursive: true });
  fs.mkdirSync(at("output/sub"), { recursive: true });
  fs.writeFileSync(at("quotes/a.csv"), PERSON);
  fs.writeFileSync(at("quotes/sub/a.csv"), PERSON);
  fs.writeFileSync(at("output/cheap.csv"), AGENT);
  fs.writeFileSync(at("output/sub/a.csv"), AGENT);
  return { project: { folder, rules: { writable: ["output"] } } as unknown as Project, at };
}

/** Run `swap` just before (and `after` just after) the reader opens its file. */
function aroundOpen(swap: () => void, after?: () => void) {
  const open = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementationOnce((...args: Parameters<typeof fs.openSync>) => {
    swap();
    const fd = open(...args);
    after?.();
    return fd;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readTrustedQuotesFile", () => {
  it("returns the bytes and hash of a plain file under quotes/", () => {
    const { project: p } = project();
    const read = readTrustedQuotesFile(p, "quotes/a.csv", "supplier quote");
    expect(read.bytes.toString()).toBe(PERSON);
    expect(sha256Hex(read.bytes)).toBe(sha256Hex(Buffer.from(PERSON)));
  });

  it("refuses a file replaced by a hard link into output/ after it was checked", () => {
    const { project: p, at } = project();
    aroundOpen(() => {
      fs.rmSync(at("quotes/a.csv"));
      fs.linkSync(at("output/cheap.csv"), at("quotes/a.csv"));
    });
    expect(() => readTrustedQuotesFile(p, "quotes/a.csv", "supplier quote")).toThrow(
      /quotes\/a\.csv: must be a plain file with no other links/,
    );
  });

  it("refuses a folder swapped for a link into output/ after it was checked", () => {
    const { project: p, at } = project();
    aroundOpen(() => {
      fs.renameSync(at("quotes/sub"), at("quotes/kept"));
      fs.symlinkSync(at("output/sub"), at("quotes/sub"));
    });
    expect(() => readTrustedQuotesFile(p, "quotes/sub/a.csv", "supplier quote")).toThrow(
      /must be a \.csv or \.xlsx file under quotes\//,
    );
  });

  it("refuses a folder swapped into output/ only while the file was opened", () => {
    const { project: p, at } = project();
    aroundOpen(
      () => {
        fs.renameSync(at("quotes/sub"), at("quotes/kept"));
        fs.symlinkSync(at("output/sub"), at("quotes/sub"));
      },
      () => {
        fs.rmSync(at("quotes/sub"));
        fs.renameSync(at("quotes/kept"), at("quotes/sub"));
      },
    );
    // Linux names the opened file (it lives in output/); elsewhere the re-check sees the swap.
    expect(() => readTrustedQuotesFile(p, "quotes/sub/a.csv", "supplier quote")).toThrow(
      /must be a \.csv or \.xlsx file under quotes\/|changed while it was being read/,
    );
  });

  it.runIf(fs.existsSync("/proc/self/fd"))(
    "refuses a folder swapped into output/ around both the open and the re-check",
    () => {
      const { project: p, at } = project();
      const swap = () => {
        fs.renameSync(at("quotes/sub"), at("quotes/kept"));
        fs.symlinkSync(at("output/sub"), at("quotes/sub"));
      };
      const restore = () => {
        fs.rmSync(at("quotes/sub"));
        fs.renameSync(at("quotes/kept"), at("quotes/sub"));
      };
      aroundOpen(swap, restore);
      // The same swap again while the real path is stat'ed after the open, so the inode there
      // matches the opened one although the name now resolves into quotes/.
      const stat = fs.statSync;
      vi.spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
        if (args[0] !== at("quotes/sub/a.csv")) {
          return stat(...args);
        }
        swap();
        try {
          return stat(...args);
        } finally {
          restore();
        }
      }) as typeof fs.statSync);
      expect(() => readTrustedQuotesFile(p, "quotes/sub/a.csv", "supplier quote")).toThrow(
        /must be a \.csv or \.xlsx file under quotes\/|folder the agent can write/,
      );
      expect(fs.readFileSync(at("quotes/sub/a.csv"), "utf8")).toBe(PERSON);
    },
  );
});
