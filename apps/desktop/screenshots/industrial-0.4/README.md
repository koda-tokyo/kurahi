# Industrial 0.4 visual review fixtures

Fictional Aoba Components Plant 7 only. The header explicitly labels simulated connection and output. These component fixtures do not demonstrate a live gateway, microphone, terminal execution or release acceptance.

Regenerate from the repository root: `node ui/visual/capture-industrial.mjs`.
The finite runner starts a loopback Vite server, captures Chromium and closes both on completion.

- `desktop`: 1366 × 768 viewport.
- `wide`: 1920 × 1080 viewport.
- `mobile`: 390 × 844 viewport.
- Each viewport has workbench, terminal and transcript-review views.
- Unsuffixed PNGs are exact viewport captures; `-full.png` captures the full scrollable page.

Validation: nine view/viewport combinations completed without page errors or horizontal body overflow. Desktop workbench and mobile captures visually inspected. The nine focused Industrial, manifests, i18n, terminal and voice test files passed 62 tests; UI build and changed TypeScript lint passed. Build retains existing chunk-size and mixed-import warnings. Astra static review approved.

Readiness labels derive from the shipped language registry and describe engine availability, not a completed Project analysis. Native microphone capture remains unavailable pending its separate IPC/access-policy decision. Versioned design-document/wave-plan actions and full release acceptance remain follow-up work; this is not a release-ready declaration.
