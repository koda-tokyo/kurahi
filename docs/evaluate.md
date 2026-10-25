---
summary: "The Kurahi evaluation pack: prerequisites, install, a sample policy, a business workflow exercise, failure drills, success measures and support scope"
read_when:
  - You are starting an evaluation of Kurahi
  - You need a test plan an evaluator can run and sign off
title: "Evaluate Kurahi"
---

# Evaluate Kurahi

This pack is what an evaluator needs to decide, on evidence, whether Kurahi fits. It takes about
half a day for the core exercises; the rest of the evaluation is your own workflow. Everything in
the pack runs on the Free plan, which has no time limit. For an evaluation that needs Enterprise
features (digital staff at L2 and L3, governance, air-gap), contact us for written evaluation
terms.

## 1. Prerequisites

- One machine: Linux x64, macOS on Apple silicon, or Windows 10/11 x64. No Node.js needed; the
  download carries its own runtime.
- A model: a local model through [Ollama](https://ollama.com) for the fully local configuration,
  or an API key for a [curated provider](/providers/support). See
  [Deployment and data boundaries](/deployment) to choose.
- Optional: a chat workspace (Slack, Teams, LINE) for approvals on a phone.

## 2. Install

```bash
curl -fsSL https://kodasoken.com/kurahi/install.sh | bash        # Linux, macOS
```

```powershell
irm https://kodasoken.com/kurahi/install.ps1 | iex               # Windows
```

Then `kurahi health` should report the gateway, integrity and audit chain as ok.

## 3. Sample policy

Save as `evaluation.yaml`, then `kurahi policy apply evaluation.yaml --sign`.

```yaml
version: 1
name: evaluation
description: Starter policy for a Kurahi evaluation. Tighten it before production.
agents:
  "*":
    tools:
      deny: ["browser"]
    limits:
      maxSteps: 40
      wallClockPerJobMs: 900000
budgets:
  currency: JPY
  fleet:
    tokensPerDay: 2000000
    toolCallsPerHour: 600
    onBreach: pause
kill:
  mayFlip: [owner, admin]
approvals:
  # channel: "slack:#kurahi-approvals"   # uncomment to receive approvals in chat
  timeoutMs: 600000
  require:
    - class: exec
    - class: write
network:
  egress:
    deny: ["169.254.169.254"]
data:
  neverRead: ["~/.ssh/**", "**/.env", "**/*.pem"]
  neverWrite: ["/etc/**"]
  redact:
    fields: ["@personal", "inspector"]
    restoreTo: [message]
shield:
  mode: stop
attestation:
  required: true
```

Every file write and every shell command now needs your approval, personal data in tool results is
masked before the model sees it, and ransomware detection is armed.

## 4. A business workflow, end to end

This exercise uses **illustrative data you create**; it is not a customer system.

1. In the agent's workspace, create `inspections.csv`:

   ```csv
   asset,inspector,reading,limit
   Press 4,Sato Ken,92,80
   Press 7,Tanaka Yui,61,80
   Conveyor 2,Ito Mai,85,80
   ```

2. Ask the resident:

   ```bash
   kurahi agent --message "Read inspections.csv. For every asset over its limit, draft a work order in work-orders.md with the asset, reading and a recommended check. Do not include inspector names."
   ```

3. Watch what happens, and check each step:

   | Step            | What you should see                                                                                                                                                                               |
   | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Retrieval       | The agent reads the file. With the context guard on, inspector names reach the model as `[[PII:INSPECTOR:1]]` placeholders.                                                                       |
   | Proposed action | The agent asks to write `work-orders.md`. The policy holds it for approval.                                                                                                                       |
   | Approval        | Approve in the terminal (or in your chat channel). Try it once with **deny** first: the job reports the refusal and stops cleanly.                                                                |
   | Outcome         | `work-orders.md` lists Press 4 and Conveyor 2 only.                                                                                                                                               |
   | Evidence        | `kurahi evidence list`, then `kurahi evidence export <job> --out job.zip` and `kurahi evidence verify job.zip`. The bundle shows what was read, the approval, the write and the redaction counts. |

## 5. Failure and recovery drills

| Drill             | How                                                                                             | Pass when                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Provider outage   | Configure a fallback (`kurahi models fallbacks add ollama/<model>`), then break the primary key | The job completes on the fallback, and the evidence records which model answered          |
| Rejected approval | Deny the write in step 4                                                                        | The job stops with a clear refusal; nothing is written; the evidence shows the denial     |
| Stop everything   | `kurahi policy kill --all --reason drill`, then send a message                                  | New work is refused and running jobs are cancelled; `kurahi policy release --all` resumes |
| Ransomware drill  | Create `HOW_TO_DECRYPT_FILES.txt` in the workspace                                              | Every agent stops; `kurahi audit tail` shows `shield.trigger`; release resumes            |
| Tampered evidence | Change one byte inside an exported bundle                                                       | `kurahi evidence verify` fails and names the broken record                                |
| Continuity        | `kurahi continuity run --throwaway --disruption all --out ./continuity-out`                     | The report passes and `kurahi continuity verify` re-checks it offline                     |
| Inventory         | `kurahi inventory export -o inventory.json`, then `kurahi inventory verify inventory.json`      | The signed inventory lists every agent, model and policy rule and verifies                |

## 6. Success measures

Agree these at the start, and record the result of each:

1. Every drill in section 5 passes on your machine.
2. Your own workflow (chosen in the kick-off call) runs end to end with the approvals your
   organisation needs, and every run leaves a bundle that verifies.
3. Your security reviewer can answer, from the evidence and the [deployment page](/deployment),
   what data left the host and why.
4. Time from request to approved outcome for your workflow, measured against how it is done today.

## 7. Support during the evaluation

- E-mail [support@kodasoken.com](mailto:support@kodasoken.com); we reply within two business days.
- A kick-off call to choose your workflow, and a review call at the end.
- Security questions: [security@kodasoken.com](mailto:security@kodasoken.com).
- Not included during evaluation: production support hours, custom development, or a service level.
  Those are part of [Kurahi Enterprise](https://kurahi.kodasoken.com/enterprise/).

See also: [Capabilities in this release](/capabilities).
