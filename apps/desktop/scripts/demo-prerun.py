#!/usr/bin/env python3
"""Prepare the Kurahi Desktop demo state: run one template prompt through the demo gateway.

Usage (the demo gateway must be running, see demo-gateway.sh):
  demo-prerun.py setup                      create the four template projects (once)
  demo-prerun.py run <template> [--save]    send the template's prepared prompt, wait for the
                                            reply, print it; --save stores it as an output
  demo-prerun.py save <template>            save the last reply of that template as an output
  demo-prerun.py status <artifact-id> <s>   move an output to review / approved
  demo-prerun.py approval <template>        raise a prepared approval request in that project's
                                            most recent chat (shows as a card in the chat and in
                                            承認待ち; waits up to 5 minutes for Approve / Reject)

The prompt is sent through chat.send exactly like the chat box, with the source file attached
the way "Attach file" does (a document block). The reply is saved unchanged, except that lines
carrying the gateway's project-context markers are removed, as the app does when saving.
Nothing here edits an answer.
"""

import json
import os
import subprocess
import sys
import time
import uuid

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
HOME = os.path.expanduser("~")
STATE = os.environ.get("KURAHI_DEMO_HOME", os.path.join(HOME, "kurahi-demo-state"))
PORT = os.environ.get("KURAHI_DEMO_PORT", "18871")
PACKS = os.path.join(HOME, "kurahi-demo-packs")

PROJECTS = {
    "industry-legacy-modernisation": ("給与システム刷新 / Payroll modernisation", "industry-legacy-cobol"),
    "research-academic": ("長時間労働の文献レビュー / Working hours review", "research-academic"),
    "professional": ("業務委託契約レビュー / Vendor contract review", "professional-documents"),
    "education": ("日本語 N4 クラス / Japanese N4 class", "education-nihongo"),
}


def read_lines(path, first=None, last=None):
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    return "\n".join(lines[(first or 1) - 1 : last])


def pdf_text(path, max_chars):
    out = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True, check=True).stdout
    return out[:max_chars]


# The prepared prompts: the suggested prompt from DEMO.md plus the file a user would attach.
# The small local model has a 4k-token context, so long files are attached in part; the part
# is stated here and in DEMO.md.
def prompt_for(template):
    pack = lambda *p: os.path.join(PACKS, *p)
    if template == "industry-legacy-modernisation":
        src = pack("industry-legacy-cobol", "source", "cobol", "PAYCALC.cbl")
        return (
            "PAYCALC の残業計算ルールを抽出して",
            [("PAYCALC.cbl (lines 1-60: header and working storage)", read_lines(src, 1, 60))],
        )
    if template == "professional":
        return (
            "Review this contract for risks, then draft a short reply to the vendor. The reply must wait for approval before it is sent.",
            [("01-service-agreement-draft.md", read_lines(pack("professional-documents", "documents", "en", "01-service-agreement-draft.md")))],
        )
    if template == "research-academic":
        q = read_lines(pack("research-academic", "questions.md"))
        q1 = q.split("## Q1.", 1)[1].split("\n## Q2.", 1)[0]
        return (
            "Answer Q1 in questions.md, citing the source file for every claim.\n\nQ1." + q1.split("**Papers")[0].strip(),
            [("01-virtanen-2018-long-hours-cvd-review.pdf (first 2500 characters)", pdf_text(pack("research-academic", "corpus", "01-virtanen-2018-long-hours-cvd-review.pdf"), 2500))],
        )
    if template == "education":
        return (
            "ごみの出し方の読み物を使った N4 の授業計画を作成してください。",
            [("01-gomi-no-hi.md", read_lines(pack("education-nihongo", "readings", "01-gomi-no-hi.md")))],
        )
    raise SystemExit(f"unknown template {template}")


def call(method, params, timeout_ms=60000):
    env = dict(os.environ, KOLO_HOME=STATE)
    out = subprocess.run(
        [
            "node", "kolo.mjs", "gateway", "call", method,
            "--url", f"ws://127.0.0.1:{PORT}", "--json", "--timeout", str(timeout_ms),
            "--params", json.dumps(params, ensure_ascii=False),
        ],
        cwd=REPO, env=env, capture_output=True, text=True, timeout=timeout_ms / 1000 + 30,
    )
    if out.returncode != 0:
        raise RuntimeError(f"{method}: {(out.stderr or out.stdout)[-500:]}")
    return json.loads(out.stdout)


def compose(message, docs):
    blocks = []
    for name, text in docs:
        safe = name.replace('"', "_").replace("]", "_")
        blocks.append(f'[[kurahi-document name="{safe}" kind="txt" path="prepared"]]\n{text}\n[[/kurahi-document]]')
    # The attached text comes first and the request last: a small model follows the last
    # instruction it reads much more reliably.
    return "\n\n".join(blocks) + "\n\n" + message.strip()


def strip_markers(text):
    lines = [l for l in text.split("\n") if "kurahi-project]]" not in l]
    return "\n".join(lines).strip()


def project_id(template):
    for p in call("projects.list", {})["projects"]:
        if p.get("templateId") == template:
            return p["id"]
    return None


def setup():
    for template, (name, folder) in PROJECTS.items():
        if project_id(template):
            print(f"exists: {template}")
            continue
        p = call("projects.create", {"name": name, "folder": os.path.join(PACKS, folder), "templateId": template})["project"]
        print(f"created: {template} -> {p['id']}")


def text_of(message):
    c = message.get("content")
    if isinstance(c, str):
        return c
    return "\n".join(part.get("text", "") for part in c or [] if isinstance(part, dict) and part.get("type") == "text")


def run(template, save):
    pid = project_id(template)
    if not pid:
        raise SystemExit("run setup first")
    key = call("projects.chatKey", {"id": pid, "agentId": "main"})["sessionKey"]
    message, docs = prompt_for(template)
    started = time.time()
    call("chat.send", {"sessionKey": key, "message": compose(message, docs), "idempotencyKey": str(uuid.uuid4())})
    print(f"sent to {key}", flush=True)
    reply = None
    while time.time() - started < float(os.environ.get("KURAHI_PRERUN_WAIT_S", "900")):
        time.sleep(20)
        hist = call("chat.history", {"sessionKey": key, "limit": 10})
        msgs = [m for m in hist.get("messages", []) if m.get("role") == "assistant"]
        if msgs and text_of(msgs[-1]).strip():
            reply = text_of(msgs[-1])
            break
    elapsed = int(time.time() - started)
    if reply is None:
        raise SystemExit(f"no reply after {elapsed}s")
    content = strip_markers(reply)
    print(f"--- reply after {elapsed}s ({len(content)} chars) ---\n{content}\n--- end ---", flush=True)
    with open(os.path.join(STATE, f"prerun-{template}.json"), "w", encoding="utf-8") as f:
        json.dump({"sessionKey": key, "content": content, "elapsedS": elapsed}, f, ensure_ascii=False)
    if save:
        save_reply(template)


def save_reply(template):
    with open(os.path.join(STATE, f"prerun-{template}.json"), encoding="utf-8") as f:
        last = json.load(f)
    key, content = last["sessionKey"], last["content"]
    if True:
        title = {
            "industry-legacy-modernisation": "PAYCALC 残業計算ルール(抽出)",
            "research-academic": "Q1: Long working hours and cardiovascular risk",
            "professional": "Contract risk review and vendor reply (draft)",
            "education": "N4 授業計画: ごみの日",
        }[template]
        a = call("artifacts.save", {"title": title, "type": "document", "format": "md", "content": content, "sourceSession": key})["artifact"]
        print(f"saved output {a['id']} v1 sha256 {a['versions'][0]['sha256']}")


def approval(template):
    pid = project_id(template)
    chats = [
        r for r in call("sessions.list", {"limit": 200}).get("sessions", [])
        if r.get("key", "").startswith("agent:") and f":proj-{pid}-" in r.get("key", "")
    ]
    if not chats:
        raise SystemExit("open a chat in that project first")
    key = max(chats, key=lambda r: r.get("updatedAt") or 0)["key"]
    folder = next(p["folder"] for p in call("projects.list", {})["projects"] if p["id"] == pid)
    print(f"approval requested in {key}; decide in the app (Approve / Reject)", flush=True)
    res = call(
        "exec.approval.request",
        {
            "command": "cp output/lesson-plan.md /srv/class-materials/",
            "cwd": folder,
            "agentId": "main",
            "sessionKey": key,
            "timeoutMs": 300000,
        },
        timeout_ms=310000,
    )
    print(f"decision: {res.get('decision')}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    if sys.argv[1] == "setup":
        setup()
    elif sys.argv[1] == "run":
        run(sys.argv[2], "--save" in sys.argv)
    elif sys.argv[1] == "approval":
        approval(sys.argv[2])
    elif sys.argv[1] == "save":
        save_reply(sys.argv[2])
    elif sys.argv[1] == "status":
        a = call("artifacts.setStatus", {"id": sys.argv[2], "status": sys.argv[3]})["artifact"]
        print(a["id"], a["status"])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
