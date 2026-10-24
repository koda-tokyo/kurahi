#!/usr/bin/env bash
# Launch Kurahi Desktop for the demo against the demo gateway (see demo-gateway.sh).
# Uses its own config/data folders so the demo never touches another Kurahi Desktop setup.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_HOME="${KURAHI_DEMO_HOME:-$HOME/kurahi-demo-state}"
PORT="${KURAHI_DEMO_PORT:-18871}"
XDG_ROOT="$DEMO_HOME/desktop"

APP="${KURAHI_DESKTOP_BIN:-}"
# Prefer the binary built against this system's WebKitGTK (what the demo was tested with);
# fall back to the AppImage, which carries its own libraries.
if [ -z "$APP" ] && [ -x "$HERE/src-tauri/target/release/kurahi-desktop" ]; then
  APP="$HERE/src-tauri/target/release/kurahi-desktop"
fi
if [ -z "$APP" ]; then
  APP="$(ls -1 "$HERE"/src-tauri/target/release/bundle/appimage/Kurahi_*_amd64.AppImage 2>/dev/null | tail -1 || true)"
fi
[ -n "$APP" ] || { echo "no Kurahi Desktop build found; run: (cd $HERE && npx tauri build --bundles deb,appimage)" >&2; exit 1; }
[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || { echo "no display (WSLg sets DISPLAY / WAYLAND_DISPLAY)" >&2; exit 1; }

mkdir -p "$XDG_ROOT/config/com.kodasoken.kurahi" "$XDG_ROOT/data" "$XDG_ROOT/cache"
echo "{\"gatewayUrl\":\"ws://127.0.0.1:$PORT\"}" > "$XDG_ROOT/config/com.kodasoken.kurahi/desktop.json"

export KOLO_HOME="$DEMO_HOME"             # "Use this computer's token" reads the demo token
export XDG_CONFIG_HOME="$XDG_ROOT/config" XDG_DATA_HOME="$XDG_ROOT/data" XDG_CACHE_HOME="$XDG_ROOT/cache"
export WEBKIT_DISABLE_DMABUF_RENDERER=1   # WSLg / Xvfb: avoids a blank window
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export APPIMAGE_EXTRACT_AND_RUN=1         # WSL has no FUSE by default
exec "$APP"
