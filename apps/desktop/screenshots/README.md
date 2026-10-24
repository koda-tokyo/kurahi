# Industrial visual fixtures

These screenshots render the real Industrial workbench component with the fictional
Aoba Components Plant 7 Project. They contain no customer or production data.

- industrial-workbench-desktop.png: 1440 x 1000 viewport
- industrial-workbench-mobile.png: 390 x 844 viewport, full-page capture

Source fixture: ui/visual/industrial-workbench.html.

The terminal captures use illustrative, explicitly labelled output with no gateway connection.
The real component uses terminal.open/input/cancel/close/replay and the shared approval dialog.

- industrial-terminal-desktop.png: 1440 x 1000 viewport
- industrial-terminal-mobile.png: 390 x 844 viewport

Reproduce all four captures: `node ui/visual/capture-industrial.mjs` from the repository root.
The script starts a temporary loopback Vite server, checks horizontal overflow, and closes
Chromium and the server before exiting.
