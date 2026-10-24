# Business queue visual fixture

The fixture uses fictional office data and never opens a gateway connection. Run:

```sh
node ui/visual/capture-business.mjs
```

The finite capture opens a temporary loopback Vite server and closes it and Chromium when done.
It produces English and Japanese desktop (1440×1000), mobile (390×844), and light-theme desktop
captures under `apps/desktop/screenshots/business-*.png`, checking page errors and horizontal overflow.

## Verification — 2026-10-23

- Full UI Chromium run: 279 passed, 6 failed (285 total). The six failures were independently
  reproduced on unchanged integration base `2dd4d942fb`: focus-mode's old sidebar link, navigation's
  old overview URL, and four secret-storage tests assigning the browser's read-only localStorage property.
- All 21 new Business controller/view/route/gateway tests pass, including stale responses, event
  coalescing, disconnected data clearing, request-failure isolation and async queue selection.
- `pnpm --dir ui build` passes. New TypeScript files pass oxlint. UI typecheck reports the same
  170 diagnostics as the base, compared by file and diagnostic text after removing line/column offsets.
- Six screenshot captures pass without horizontal overflow. Dark/light desktop captures were visually
  inspected and the dark text-token inheritance corrected.
- Independent Astra correctness review approved after the queue-selector regression was fixed.

This slice reads queue config/list/item only. Drafts show pinned metadata, not content; evidence
references are not a signature verification result. Item creation, agent assignment, decisions, and
artifact content review are subsequent slices. Background refresh reloads up to the first 200 items;
additional pages remain available through Load more.
