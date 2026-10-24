#!/usr/bin/env bash
# Build the Kurahi Desktop MSIX for the Microsoft Store, on Linux/WSL. Unsigned on purpose:
# the Store re-signs submitted packages with Microsoft's certificate.
#
#   apps/desktop/scripts/build-windows-xwin.sh      # first: the Windows exe
#   apps/desktop/scripts/build-msix.sh              # then: layout + .msix
#
# Identity (PLACEHOLDERS until filled from Partner Center > Product identity):
#   MSIX_IDENTITY_NAME            default KODASOKEN.Kurahi
#   MSIX_IDENTITY_PUBLISHER       default CN=00000000-0000-0000-0000-000000000000
#   MSIX_PUBLISHER_DISPLAY_NAME   default "KODA SōKEN"
# Other:
#   MSIX_OUT    output dir (default $CARGO_TARGET_DIR/msix)
#   MAKEMSIX    path to makemsix (default: PATH, then ~/.local/src/msix-packaging/.vs/bin)
#
# Output: $MSIX_OUT/layout/ (package folder), $MSIX_OUT/Assets-scaled/, $MSIX_OUT/pack-msix.ps1,
#         $MSIX_OUT/Kurahi_<ver>_x64.msix (when makemsix is available).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"   # apps/desktop
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/kolo-2-desktop/apps/desktop/src-tauri/target-win}"
exe="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/kurahi-desktop.exe"
out="${MSIX_OUT:-$CARGO_TARGET_DIR/msix}"

id_name="${MSIX_IDENTITY_NAME:-KODASOKEN.Kurahi}"
id_publisher="${MSIX_IDENTITY_PUBLISHER:-CN=00000000-0000-0000-0000-000000000000}"
pub_display="${MSIX_PUBLISHER_DISPLAY_NAME:-KODA SōKEN}"

[ -f "$exe" ] || { echo "missing $exe: run scripts/build-windows-xwin.sh first" >&2; exit 1; }
file "$exe" | grep -q 'PE32+ executable (GUI) x86-64' || { echo "not a Windows x64 GUI exe: $exe" >&2; exit 1; }

# Store package versions are Major.Minor.Build.0 (the 4th field is reserved for the Store).
ver3="$(sed -n 's/^ *"version": *"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/p' "$here/src-tauri/tauri.conf.json" | head -1)"
[ -n "$ver3" ] || { echo "cannot read version from tauri.conf.json" >&2; exit 1; }
version="$ver3.0"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
sed_escape() { sed -e 's/[\/&|]/\\&/g'; }

rm -rf "$out/layout" "$out/Assets-scaled"
mkdir -p "$out/layout"

# 1. Executable. Tauri compiles the frontend, tray icons and app manifest into the exe;
#    tauri.conf.json declares no extra resources, so the exe is the whole app.
cp "$exe" "$out/layout/Kurahi.exe"

# 2. Visual assets from the Kurahi mark (rendered by the Tauri CLI's SVG rasteriser).
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$here" && npx tauri icon assets/kurahi-mark.svg -o "$tmp/icon" -p 1024 >/dev/null)
python3 -P "$here/scripts/msix/make-assets.py" "$tmp/icon/1024x1024.png" "$tmp/assets" >/dev/null
mv "$tmp/assets/Assets" "$out/layout/Assets"
mv "$tmp/assets/Assets-scaled" "$out/Assets-scaled"

# 3. Manifest.
n="$(printf '%s' "$id_name" | xml_escape | sed_escape)"
p="$(printf '%s' "$id_publisher" | xml_escape | sed_escape)"
d="$(printf '%s' "$pub_display" | xml_escape | sed_escape)"
sed -e "s|@IDENTITY_NAME@|$n|g" -e "s|@IDENTITY_PUBLISHER@|$p|g" \
    -e "s|@PUBLISHER_DISPLAY_NAME@|$d|g" -e "s|@VERSION@|$version|g" \
    "$here/scripts/msix/AppxManifest.template.xml" > "$out/layout/AppxManifest.xml"
if grep -q '@[A-Z_]*@' "$out/layout/AppxManifest.xml"; then
  echo "unfilled placeholder in AppxManifest.xml" >&2; exit 1
fi
python3 -I -c 'import sys, xml.dom.minidom as m; m.parse(sys.argv[1])' "$out/layout/AppxManifest.xml"

# 4. Windows-side packer (makepri + makeappx from the Windows SDK, both Microsoft-signed).
cp "$here/scripts/msix/pack-msix.ps1" "$out/pack-msix.ps1"

# 5. Pack on Linux with Microsoft's open-source makemsix, if present.
makemsix="${MAKEMSIX:-$(command -v makemsix || true)}"
[ -n "$makemsix" ] || makemsix="$HOME/.local/src/msix-packaging/.vs/bin/makemsix"
msix="$out/Kurahi_${ver3}_x64.msix"
rm -f "$msix"
if [ -x "$makemsix" ]; then
  "$makemsix" pack -d "$out/layout" -p "$msix"
  echo
  file "$msix"
  ls -l "$msix"
  sha256sum "$msix"
else
  echo "makemsix not found; pack on Windows instead:"
  echo "  makeappx pack /d layout /p Kurahi_${ver3}_x64.msix /o"
  echo "  (or: powershell -ExecutionPolicy Bypass -File pack-msix.ps1)"
fi

case "$id_publisher" in
  CN=00000000-0000-0000-0000-000000000000)
    echo
    echo "NOTE: identity is still the PLACEHOLDER. Rebuild with MSIX_IDENTITY_NAME,"
    echo "      MSIX_IDENTITY_PUBLISHER and MSIX_PUBLISHER_DISPLAY_NAME from Partner Center."
    ;;
esac
echo "layout: $out/layout"
