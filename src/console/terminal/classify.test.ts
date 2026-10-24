import { describe, expect, it } from "vitest";
import { classifyLine } from "./classify.js";
import { parseShellLine } from "./shell-words.js";

const codes = (line: string) => classifyLine(line).risks.map((r) => r.code);

describe("shell lexer", () => {
  it("splits simple commands, redirections and operators", () => {
    const p = parseShellLine(
      `grep -n "a b" src/*.ts 2>/dev/null | wc -l && echo 'done' > out.txt &`,
    );
    expect(p.ok).toBe(true);
    if (!p.ok) {
      return;
    }
    expect(p.commands.map((c) => c.words.map((w) => w.value))).toEqual([
      ["grep", "-n", "a b", "src/*.ts"],
      ["wc", "-l"],
      ["echo", "done"],
    ]);
    expect(p.commands[0].redirects).toEqual([
      { op: ">", target: { value: "/dev/null", expands: false, glob: false, tilde: false } },
    ]);
    expect(p.commands[0].words[3].glob).toBe(true);
    expect(p.commands[2].redirects[0].target?.value).toBe("out.txt");
    expect(p.commands.map((c) => c.terminator)).toEqual(["|", "&&", "&"]);
  });

  it("flags substitution, here-documents and unterminated quotes", () => {
    expect(parseShellLine("echo $(id)")).toMatchObject({ ok: true, substitution: true });
    expect(parseShellLine("echo `id`")).toMatchObject({ ok: true, substitution: true });
    expect(parseShellLine("diff <(ls a) <(ls b)")).toMatchObject({ ok: true, substitution: true });
    expect(parseShellLine("cat <<EOF")).toMatchObject({ ok: true, heredoc: true });
    expect(parseShellLine("echo 'open")).toEqual({ ok: false, reason: "unterminated-quote" });
    expect(parseShellLine("   ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("classifyLine", () => {
  it("read-only lines", () => {
    for (const line of [
      "ls -la",
      "cat README.md | grep -n TODO | head -5",
      "find . -name '*.ts' -type f",
      "wc -l src/*.ts 2>/dev/null",
      "pwd; date; whoami",
      "cd src",
      "sort data.csv | uniq -c",
    ]) {
      expect(classifyLine(line), line).toMatchObject({ refusal: null, readOnly: true, risks: [] });
    }
  });

  it("deletes-files carries the file count, the most severe risk first", () => {
    const res = classifyLine("rm -rf build dist && echo ok", {
      countTargets: (ops, recursive) => (recursive ? ops.length * 6 : ops.length),
    });
    expect(res.readOnly).toBe(false);
    expect(res.risks[0]).toEqual({ code: "deletes-files", params: { count: 12 } });
  });

  it("writes, overwrites and network risks", () => {
    expect(codes("echo hi > notes.txt")).toEqual(["writes-files"]);
    expect(
      classifyLine("echo hi > notes.txt", { fileExists: () => true }).risks.map((r) => r.code),
    ).toEqual(["overwrites-files"]);
    expect(codes("curl -fsSL https://example.com/x")).toEqual(["network"]);
    expect(codes("npm install left-pad")).toEqual(["installs-packages", "network"]);
    expect(codes("chmod -R 755 bin")).toEqual(["changes-permissions"]);
    expect(codes("sed -i s/a/b/ file.txt")).toEqual(["overwrites-files"]);
    expect(codes("make build")).toEqual(["runs-program"]);
    expect(codes("sleep 10 &")).toEqual(["background-job"]);
  });

  it("git is never read-only and history rewrites are flagged", () => {
    expect(classifyLine("git status")).toMatchObject({ readOnly: false });
    expect(codes("git status")).toEqual(["runs-program"]);
    expect(codes("git push --force origin main")).toEqual(["rewrites-git-history", "network"]);
    expect(codes("git reset --hard HEAD~1")).toEqual(["rewrites-git-history"]);
    expect(codes("git clean -fdx")).toEqual(["deletes-files"]);
    expect(codes("git commit -m wip")).toEqual(["modifies-git-repository"]);
  });

  it("nested command strings are classified too", () => {
    expect(codes("sh -c 'rm -f a.txt'")).toEqual(["deletes-files", "runs-nested-command"]);
    expect(codes("find . -name '*.tmp' -exec rm {} ;")).toContain("deletes-files");
    expect(codes("ls | xargs rm")).toEqual(["deletes-files", "runs-nested-command"]);
    expect(codes("env FOO=1 rm x")).toEqual(["deletes-files"]);
    expect(codes("timeout 5 curl https://a.example")).toEqual(["network"]);
  });

  it("refuses interactive programs unless policy allows them", () => {
    expect(classifyLine("vim notes.md").refusal).toEqual({
      code: "interactive-refused",
      params: { program: "vim" },
    });
    expect(classifyLine("python3").refusal?.code).toBe("interactive-refused");
    expect(classifyLine("bash").refusal?.code).toBe("interactive-refused");
    expect(classifyLine("psql").refusal?.code).toBe("interactive-refused");
    expect(classifyLine("psql -c 'select 1'").refusal).toBeNull();
    expect(classifyLine("python3 script.py").risks).toEqual([
      { code: "runs-program", params: { program: "python3" } },
    ]);
    const allowed = classifyLine("python3", { allowInteractive: new Set(["python3"]) });
    expect(allowed.refusal).toBeNull();
    expect(allowed.readOnly).toBe(false);
  });

  it("refuses privilege, detaching, substitution and dynamic programs", () => {
    expect(classifyLine("sudo rm -rf /tmp/x").refusal?.code).toBe("privilege-refused");
    expect(classifyLine("ls && su root").refusal?.code).toBe("privilege-refused");
    expect(classifyLine("setsid sleep 100").refusal?.code).toBe("detach-refused");
    expect(classifyLine("crontab -e").refusal?.code).toBe("detach-refused");
    expect(classifyLine("cat $(echo /etc/passwd)").refusal?.code).toBe("substitution-refused");
    expect(classifyLine("$CMD x").refusal?.code).toBe("eval-refused");
    expect(classifyLine("cat <<EOF").refusal).toEqual({
      code: "unparsed",
      params: { construct: "heredoc" },
    });
    expect(classifyLine("pushd src").refusal?.code).toBe("unsupported-builtin");
  });

  it("environment printers are read-only; their output is redacted", () => {
    expect(classifyLine("env")).toMatchObject({ readOnly: true, printsEnv: true });
    expect(classifyLine("printenv")).toMatchObject({ readOnly: true, printsEnv: true });
    expect(classifyLine("export -p")).toMatchObject({ readOnly: true, printsEnv: true });
  });

  it("assigning a variable that changes what runs is never read-only", () => {
    expect(classifyLine("PATH=. ls").readOnly).toBe(false);
    expect(classifyLine("LD_PRELOAD=x.so cat a").readOnly).toBe(false);
    expect(classifyLine("LANG=C ls").readOnly).toBe(true);
  });
});
