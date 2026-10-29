# Industrial payroll visual evidence

Run `node ui/visual/capture-industrial-payroll.mjs` from the repository root.
The finite script starts a loopback-only Vite server and Chromium, captures twelve
EN/JA desktop/mobile images, checks horizontal document overflow, page errors,
source citation 140 and the single added comment, then closes both processes.
Images are written to `apps/desktop/screenshots/industrial-payroll/`.

Open `visual/industrial-payroll.html?locale=en&view=document` through Vite to
inspect the fixture. `locale=ja` selects Japanese; views are `workbench`,
`document`, and `change`.

## Provenance and boundaries

- `industrial-payroll-source.cbl` is an unchanged copy of the fictional
  `industry-legacy-cobol` demo pack's `source/cobol/PAYCALC.cbl`. It is demo
  source, not customer payroll data. SHA-256:
  `f4ddee19d373a716bfff1384cd141ff292155975643b5556730a8f9c6fbf7279`. Its legal/business comments are source
  content, not a validation of current payroll compliance.
- Generated documents come directly from
  `packages/legacy-analyzer/examples/payroll-demo/design-doc.{en,ja}.md`.
  The panel displays unchanged section 1, explicitly titled as an excerpt;
  the complete documents exceed the production Markdown parser's 40,000
  character rich-rendering limit. The capture scrolls to section 1.3.
- The second document panel displays numbered source lines 130–150. Calls to
  PAYRND at lines 140 and 147 match the generated document's citations.
- Change review uses the same source excerpt and inserts exactly one
  illustrative comment before `3000-BASE-AND-RATE`. The real artifact renderer
  computes the v1/v2 line diff. This demonstrates review presentation, not
  automatic change detection, impact analysis, or a proposed payroll fix.
- All artifact SHA-256 values are computed with Web Crypto from the exact
  displayed artifact content, including excerpt headers and line numbering.
  They are distinct from the generated document's multi-file source fingerprint.
- `renderIndustrialModernisation`, `renderArtifactList`, and
  `renderArtifactPanel` are production renderers. The fixture wrapper composes
  panels for evidence capture; it does not claim the product ships this split
  view. Styling overrides are scoped to the visual fixture.
- Artifact records, versions, dates and history are local simulated state.
  The workbench is disconnected. Actions report a local preview notice;
  the production export button can download local content. No gateway request,
  payroll execution, status transition or approval occurs.

The existing `industrial-workbench.html` fixture remains available separately.
