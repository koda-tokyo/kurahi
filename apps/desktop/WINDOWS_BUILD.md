# Kurahi Desktop: Windows build

Status on the development PC, 2026-10-20: **toolchain present, build blocked by
a Microsoft Defender Attack Surface Reduction rule.** No Windows software was installed and no
Defender setting was changed.

## What is present

| Item | Found |
| --- | --- |
| Rust (MSVC host) | `%USERPROFILE%\.cargo\bin\cargo.exe`, rustc 1.93.0, target `x86_64-pc-windows-msvc` |
| MSVC | VS 2022 Build Tools (MSVC 14.44.35207), VS 18 Community (MSVC 14.51.36231) |
| Windows SDK | 10.0.26100.0 |
| Node.js | `C:\Program Files\nodejs\node.exe` v22.18.0 |
| WebView2 runtime | 155.0.4283.x |
| Tauri bundler tools | `%LOCALAPPDATA%\tauri\NSIS`, `%LOCALAPPDATA%\tauri\WixTools314` (cached) |

## What blocks it

`cargo` compiles each dependency's `build.rs` into a fresh, unsigned `build-script-build.exe`
and runs it. Defender blocks every one of them:

```
error: failed to run custom build command for `serde v1.0.229`
  could not execute process `...\target\release\build\serde-…\build-script-build` (never executed)
  Access is denied. (os error 5)
```

Defender Operational log, event 1121: *"Microsoft Defender Exploit Guard has blocked an operation
that is not allowed by your IT administrator"*, rule
`01443614-CD74-433A-B99E-2ECDC07BFC25` = **Block executable files from running unless they meet a
prevalence, age, or trusted list criterion** (mode: block).

This is a deliberate hardening setting, so it was left alone. Choose one:

1. **Recommended: build on a dedicated build machine or CI runner** (Windows Server / Windows 11
   without that ASR rule in block mode). This is also where code signing will live.
2. Have an administrator add an ASR *per-rule* exclusion for the build folder only, for example
   `C:\build\kurahi-desktop\` (Defender > ASR > exclusions, or
   `Add-MpPreference -AttackSurfaceReductionOnlyExclusions 'C:\build\kurahi-desktop'`), build, then
   remove it.
3. Switch that one rule to audit mode for the build window (admin decision).

Note for enterprise rollout: the same rule will block an **unsigned** `Kurahi.exe` on customer PCs
that enforce it. Code signing with a trusted certificate (and reputation) is required before
any customer deployment.

## Build steps (once unblocked)

The frontend is platform independent; build it on WSL/Linux, then build the Rust shell and the
installers on Windows from a copy on a Windows drive (building on `\\wsl$` is slow and unreliable).

```bash
# WSL
cd ~/kolo-2-desktop/apps/desktop
npm ci && npm run build:web
WINBUILD="$(wslpath 'C:\build\kurahi-desktop')"
mkdir -p "$WINBUILD"
rsync -a --delete --exclude node_modules --exclude src-tauri/target --exclude src-tauri/gen ./ "$WINBUILD/"
```

```bat
:: Windows (cmd)
cd /d C:\build\kurahi-desktop
npm ci
npx tauri build --bundles msi,nsis --config src-tauri\tauri.prebuilt.json
```

`tauri.prebuilt.json` only clears `beforeBuildCommand`, so the Windows side uses the `dist/`
built on Linux. Output: `src-tauri\target\release\bundle\msi\Kurahi_0.2.0_x64_ja-JP.msi`,
`…_en-US.msi` and `src-tauri\target\release\bundle\nsis\Kurahi_0.2.0_x64-setup.exe`.
These are **unsigned test builds**.

## Nothing to install, if the rule is handled

Every prerequisite is already on the PC. On a clean Windows build machine install:

- Visual Studio 2022 Build Tools with "Desktop development with C++" (MSVC v143, Windows 11 SDK)
- Rust via rustup, default host `x86_64-pc-windows-msvc`
- Node.js 22 LTS
- WebView2 Runtime (preinstalled on Windows 11)
- NSIS and WiX 3.14 are downloaded by the Tauri CLI on first build

## Alternative: cross-compile on Linux

`scripts/build-windows-xwin.sh` builds the same exe from WSL with cargo-xwin (MSVC target), so no
unsigned build script ever runs on Windows. `scripts/build-msix.sh` packs it as an MSIX for the
Microsoft Store, which signs it. See [MICROSOFT_STORE.md](MICROSOFT_STORE.md).
