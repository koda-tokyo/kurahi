# Business queue visual fixture

The fixture uses fictional office data and never opens a gateway connection. Run:

```sh
node ui/visual/capture-business.mjs
```

The finite capture opens a temporary loopback Vite server and closes it and Chromium when done.
It produces English and Japanese desktop (1440×1000), mobile (390×844), and light-theme desktop
captures under `apps/desktop/screenshots/business-*.png`, checking page errors and horizontal overflow.

## Initial baseline — 2026-10-23

- Full UI Chromium run: 279 passed, 6 failed (285 total). The six failures were independently
  reproduced on unchanged integration base `2dd4d942fb`: focus-mode's old sidebar link, navigation's
  old overview URL, and four secret-storage tests assigning the browser's read-only localStorage property.
- All 21 new Business controller/view/route/gateway tests pass, including stale responses, event
  coalescing, disconnected data clearing, request-failure isolation and async queue selection.
- `pnpm --dir ui build` passes. New TypeScript files pass oxlint. UI typecheck reports the same
  170 diagnostics as the base, compared by file and diagnostic text after removing line/column offsets.
- Six screenshot captures pass without horizontal overflow. Dark/light desktop captures were visually
  inspected and the dark text-token inheritance corrected.
- Correctness review approved after the queue-selector regression was fixed.

This slice reads queue config/list/item only. Drafts show pinned metadata, not content; evidence
references are not a signature verification result. Item creation, agent assignment, decisions, and
artifact content review are subsequent slices. Background refresh reloads up to the first 200 items;
additional pages remain available through Load more.

## Expense requester workflow — 2026-10-24

The current fixture also covers configured-queue expense intake, revision-pinned editing and a
separate, read-only submission confirmation in English and Japanese at desktop and mobile sizes.
Use `?expenseAction=edit` or `?expenseAction=submit` on the fixture page to inspect these states.
The capture script checks 22 viewport/state combinations, including the existing review and intake
surfaces. Every example is fictional and the fixture never writes to a gateway.

Saved expenses in `new` or `sent_back` status can be edited and explicitly submitted for review.
Editing preserves existing document references and source fields outside the form; submission
changes only the status to `awaiting_review`. Both actions send the displayed item revision.
The interface blocks repeat writes while a request is pending and asks for reconciliation when
its outcome is unknown. Submission does not approve, pay or complete the request.

The initial baseline above records historical limitations. Subsequent slices added pinned draft
text previews, explicit evidence verification and human decision forms; this expense slice extends
requester intake. Agent assignment and the newer staged-route/document/diff/statistics contracts
remain separate work.

Validation: full Chromium suite 408/408, UI typecheck, production build, changed-file lint/format,
and 22 screenshot overflow checks pass. English mobile submission and Japanese desktop editing
captures were visually reviewed; review approved after a keyboard-focus fix.
The build retains its existing bundle-size and mixed-import warnings.
