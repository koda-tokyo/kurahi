# Kurahi Desktop demo script (v0.3)

**Unsigned test build.** The demo runs the Linux build of Kurahi Desktop through WSLg on
Windows 11 (the Windows installer is still blocked, see WINDOWS_BUILD.md). Everything runs on
this computer: a Kurahi gateway on loopback with a small local model through Ollama, and the
demo content packs in `~/kurahi-demo-packs/`.

The demo shows **prepared work**. The local model needs 3 to 5 minutes per answer on this PC,
so the four template answers were run earlier and saved as outputs. Say so:

> 「これらの回答は、本日あらかじめ小さなローカルモデルで作成したものです。本番では、日本国内または御社のサーバー上で、より大きなモデルを使います。」
> "These answers were prepared earlier today on a small local model; production uses a larger
> model in Japan or on your own servers."

## 08:30 check sheet (5 minutes, no sudo)

1. Terminal 1: `~/kolo-2-desktop/apps/desktop/scripts/demo-gateway.sh` and wait for the line `listening on ws://127.0.0.1:18871`.
2. Terminal 2: `~/kolo-2-desktop/apps/desktop/scripts/demo-app.sh`, then press **Use this computer's token** on the first-run screen; the window must open under WSLg and reach **Home** with the status 稼働中 / Running.
3. Projects: open each of the four projects; the Rules tab shows the folders and 端末プロファイル (v0.4).
4. Outputs (成果物): three outputs are listed: one 承認済み, one 確認中, one 下書き; the Research project has none yet (see the table below).
5. Stop: quit the app from the tray (or close the window), then Ctrl+C in terminal 1. Leave both stopped until the demo.

## State and scripts

- `~/kurahi-demo-state/` is the demo gateway's state (outside the repository): config, the four
  projects, the prepared chats, outputs and the audit trail. It survives restarts.
  Port **18871**, loopback only, Bonjour/mDNS **off** (`discovery.mdns.mode: "off"` and
  `KOLO_DISABLE_BONJOUR=1`).
- The model is `ollama/qwen2.5:1.5b`, shown in the app as 「ローカルモデル / Local model」
  (config alias `agents.defaults.models["ollama/qwen2.5:1.5b"].alias`). Every project tells the
  agent not to name its underlying model or vendor. The small model does not always obey.
- `scripts/demo-gateway.sh`: starts the gateway in the foreground (refuses `~/.kolo` and family ports).
- `scripts/demo-app.sh`: starts Kurahi Desktop (the build made on this PC, or the AppImage)
  with its own config/data folders under `~/kurahi-demo-state/desktop/`. Under WSLg the window
  opens on the Windows desktop.
- `scripts/demo-prerun.py`: how the prepared answers were made (setup, run, save, status) and
  `approval <template>` for the live approval card.

Never point the demo at `~/.kolo` or the family gateways (18790, 18791, 18797, 18799).

## Prepared outputs (made on 20 October 2026, local model, unedited)

Each prompt was sent through `chat.send` like the chat box, with the source file attached the
way **Attach file** does. The 4k-token context of the small model forced short attachments (noted
below). Answers were saved exactly as returned; only lines carrying the gateway's internal
project-context markers were removed, as the app does when saving. At most two reruns each.

| Project | Prompt | Attached | Result kept | Status |
| --- | --- | --- | --- | --- |
| 給与システム刷新 / Payroll modernisation (Industry) | 「PAYCALC の残業計算ルールを抽出して」 | `PAYCALC.cbl` lines 1-60 (header with the rate table) | Attempt 2 of 3. **Poor**: it does not list the rules; it only says it extracted them and that the translation needs approval (it did follow the approval rule). Attempts 1 and 3 echoed the prompt or project text. | 下書き |
| 長時間労働の文献レビュー / Working hours review (Research) | "Answer Q1 in questions.md, citing the source file for every claim." | — | **Pending a stronger model.** The small-model answer cited Virtanen 2018 correctly but also **invented references**. We never show fabricated citations, so it was withdrawn: the chat is archived and the output moved to `~/kurahi-demo-state/artifacts-archived/` (kept, not deleted, not listed in the app). The project has no output yet. | — |
| 業務委託契約レビュー / Vendor contract review (Professional) | "Review this contract for risks, then draft a short reply to the vendor. The reply must wait for approval before it is sent." | `documents/en/01-service-agreement-draft.md` (full) | Attempt 2 of 3. **Poor**: it acknowledges the contract and asks for approval before reviewing, but gives no risk review. Attempt 1 did not see the file; attempt 3 produced unrelated Japanese text. | **確認中** (approve or return it live) |
| 日本語 N4 クラス / Japanese N4 class (Education) | 「ごみの出し方の読み物を使った N4 の授業計画を作成してください。」 | `readings/01-gomi-no-hi.md` (full) | Attempt 1 of 3. **Partly useful**: a lesson-plan structure (comprehension, role play, activities, teacher notes), but in English, with factual slips about the collection days, a garbled copy of the reading, and stray markup at the end. Attempts 2 and 3 produced nothing usable. | **承認済み** (approved from the desktop app by a different device than the author) |

Discarded attempts are kept, not deleted: their chats are archived (Chat → history panel →
"Show archived"). The two short Education chats starting 「「ごみの日」…」 are the live-question
timing tests.

The governance does not depend on answer quality: scope, approval states, the author/approver
rule and the audit trail behave the same with any model.

## Running the demo (about 10 minutes)

1. **Start** as in steps 1-2 of the check sheet. Switch 日本語 | English at the bottom of the sidebar.
2. **Projects → each project → Rules**: read-only and writable folders, approval rule, the rules
   given to the agent, 端末プロファイル / Terminal profile (v0.4, not enabled). **Files** shows Read
   only / Read and write per path. The hidden `_answer-keys` folder can never be a project
   folder or be reached by an agent.
3. **成果物 / Outputs**: open the approved N4 lesson plan (承認済み; history shows who approved),
   then the vendor-reply draft (確認中): **Approve** or **Return to draft** live. Show the version
   list, SHA-256, source chat and **Export Markdown**. Be honest about the quality column above.
4. **Chat → history panel**: the prepared conversations are grouped by project.
5. **Live part** (choose what fits the time):
   - **Approval card (instant)**: open the latest chat in the Education project (Projects →
     日本語 N4 クラス → Chat → a chat in the list), then in terminal 3 run
     `~/kolo-2-desktop/apps/desktop/scripts/demo-prerun.py approval education`.
     A card 「承認が必要です / Approval needed」 appears inside the chat and the 承認待ち badge
     counts it. Press **Reject** (or Approve): terminal 3 prints the decision, and the audit log
     records it.
   - **One short question (slow)**: in the Education chat ask
     「「ごみの日」の授業の最初に聞く質問を一つ、短く書いてください。」.
     **Measured: 4 to 5 minutes** on this PC (the local model reads a 4k-token context on the
     CPU every time). Send it at the start of the demo and come back to it; do not wait for it.
6. **監査ログ / Audit log** (Service log) or `~/kurahi-demo-state/audit/`: `project.create`,
   `artifact.save`, `artifact.review`, `artifact.approved`, `exec.approval.resolve`.

## After the demo

- Quit Kurahi Desktop from the tray, then Ctrl+C in terminal 1.
- Keep `~/kurahi-demo-state/` for the next demo. To start over: stop everything, then
  `rm -rf ~/kurahi-demo-state` and repeat the preparation below (about an hour).

## Preparing the state again (only if it was deleted)

```bash
cd ~/kolo-2-desktop && pnpm install && pnpm build            # runtime (dist/)
(cd ui && npm ci) && (cd apps/desktop && npm ci && npx tauri build --bundles deb,appimage)
# terminal 1: scripts/demo-gateway.sh ; terminal 2:
S=~/kolo-2-desktop/apps/desktop/scripts
python3 $S/demo-prerun.py setup
python3 $S/demo-prerun.py run industry-legacy-modernisation   # one at a time; 3-9 min each
python3 $S/demo-prerun.py save industry-legacy-modernisation  # keep the best of at most 3
# … the same for research-academic, professional, education
python3 $S/demo-prerun.py status <output-id> review
```

Approve from the desktop app (the author's device cannot approve its own version).

## Known limits in v0.3

- Windows installer blocked by a Defender rule (WINDOWS_BUILD.md); Linux build via WSLg instead.
- No OS keychain under WSL: tokens and the device key live in memory until the app quits, so
  each app start counts as a new device.
- The small local model is slow (3-5 min per answer) and weak; it sometimes repeats the project
  instructions or invents references.
- Files, Agents and Rules on the project page are read-only; project editing is admin-only.
- PDF export of outputs is not available; Markdown only.
- Saving an output is done by a person ("Save as output"); there is no agent tool for it yet.
- Terminal profiles are data only (v0.4).
