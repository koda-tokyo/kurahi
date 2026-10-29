#!/usr/bin/env bash
# Cross-compile the Kurahi Desktop Windows x64 exe from Linux/WSL with cargo-xwin
# (MSVC target, the toolchain WebView2/Tauri expect). Nothing runs on Windows.
#
#   apps/desktop/scripts/build-windows-xwin.sh
#
# Needs: rustup target x86_64-pc-windows-msvc, `cargo install --locked cargo-xwin`,
# clang + llvm-rc/llvm-lib (Ubuntu: /usr/lib/llvm-18/bin). cargo-xwin downloads the MSVC CRT and
# Windows SDK headers/libs on first run (~/.cache/cargo-xwin); by using it you accept the
# Microsoft Visual Studio license terms for those files.
#
# Output: $CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/kurahi-desktop.exe
# Unsigned. Microsoft signs it when the MSIX goes through the Store (see MICROSOFT_STORE.md).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"   # apps/desktop
target=x86_64-pc-windows-msvc
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/kolo-2-desktop/apps/desktop/src-tauri/target-win}"

# tauri-winres needs llvm-rc on PATH to embed the icon, version info and app manifest.
for d in /usr/lib/llvm-20/bin /usr/lib/llvm-19/bin /usr/lib/llvm-18/bin; do
  if [ -x "$d/llvm-rc" ]; then PATH="$d:$PATH"; break; fi
done
export PATH

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; exit 1; }; }
need cargo-xwin "cargo install --locked cargo-xwin"
need clang "apt-get install clang"
need llvm-rc "apt-get install llvm"
rustup target list --installed | grep -qx "$target" || rustup target add "$target"

cd "$here"
[ -d node_modules ] || { echo "apps/desktop/node_modules missing (npm ci)" >&2; exit 1; }

# The frontend is platform independent; build it here, then tell Tauri not to rebuild it.
npm run build:web
npx tauri build --runner cargo-xwin --target "$target" --no-bundle \
  --config src-tauri/tauri.prebuilt.json

exe="$CARGO_TARGET_DIR/$target/release/kurahi-desktop.exe"
echo
file "$exe"
ls -l "$exe"
sha256sum "$exe"
echo "DLL imports:"
llvm-readobj --coff-imports "$exe" | sed -n 's/^ *Name: \(.*\.dll\)$/  \1/Ip' | sort -u
