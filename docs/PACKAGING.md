# Packaging: prebuilt bundles, releases, updates (M8)

This page is the contract between `scripts/bundle.mjs`, `.github/workflows/release.yml`,
`kurahi update` and the installers that download the artefacts (`scripts/install.sh`,
`scripts/install.ps1`).

## Decision: pinned Node runtime, not a single-file executable

The dependency tree carries native addons that must live on disk next to their package
(`sharp` and its libvips, `@lydell/node-pty`, `sqlite-vec`, `@napi-rs/canvas` for PDF rendering),
bundled extensions are loaded from source through `jiti`, and plugins are discovered as
directories. Node's single-executable application (SEA) embeds one script and cannot embed
addons or a `node_modules` tree, so a SEA would still need everything beside it and would change
`process.execPath`, which the service installer and child-process spawns rely on. A bundle is
therefore:

```
kolo-<version>-<os>-<arch>/
  bin/kolo            POSIX launcher (sh builtins only; works with an empty PATH)
  bin/kolo.cmd        Windows launcher (applies a staged update first, see below)
  node/bin/node       pinned Node runtime, checksum-verified against nodejs.org SHASUMS256.txt
  node/node.exe       (Windows)
  node/LICENSE
  lib/package.json    the version truth for `kurahi --version` (VERSION reads it)
  lib/kolo.mjs        entry; lib/dist/ built output incl. dist/.manifest.json
  lib/node_modules/   production dependencies, flat (pnpm hoisted, frozen lockfile), pruned
  lib/extensions/     bundled extensions (sources) + their non-hoistable deps
  lib/skills/ lib/assets/ lib/docs/
  LICENSE NOTICE LICENSING.md LICENSES/
  bundle-manifest.json
  SHA256SUMS          one line per file; `kurahi update` refuses a bundle that fails it
```

Archive: `kolo-<version>-linux-x64.tar.gz`, `kolo-<version>-darwin-arm64.tar.gz`,
`kolo-<version>-win32-x64.zip`, each with a sibling `.sha256`. The release assembles them into
`SHA256SUMS.txt`.

The launcher exports `KOLO_BUNDLE_ROOT` and runs `node/bin/node lib/kolo.mjs`. Code detects a
bundle through `src/infra/bundle.ts` (env first, then `lib/../bundle-manifest.json`).

### Building

```
pnpm build
node scripts/bundle.mjs [--target linux-x64] [--verify] [--keep] [--version X] [--node-version 22.18.0] [--node-from /path/to/node]
```

The target must equal the host (native addons): CI builds each OS on its own runner. The script
downloads the pinned Node (default `22.18.0`, override `KOLO_BUNDLE_NODE_VERSION` or
`--node-version`; mirror with `KOLO_NODE_DIST_MIRROR`), installs production dependencies into
`release/deps` from a copy of the workspace manifests with `pnpm install --prod --frozen-lockfile
--ignore-scripts --config.node-linker=hoisted`, copies the tree, prunes, writes launchers and
sums, archives, and with `--verify` unpacks the archive into `release/verify/` and runs
`bin/kolo --version` with `PATH=/nonexistent` (Windows: `cmd /c bin\kolo.cmd --version` with only
`%SystemRoot%\system32`). `release/` is git-ignored.

Pruned from every bundle (listed in `bundle-manifest.json` `pruned`):

- platform packages for other os/cpu/libc (musl variants on glibc Linux, etc.);
- `node-llama-cpp` + `@node-llama-cpp/*` (local GGUF embeddings; ~640 MB of prebuilt binaries);
- `@lancedb/*` (~250 MB). The bundled extension `memory-lancedb` is therefore omitted from the
  bundle and listed under `extensions.omitted` with the reason. `memory-core` (sqlite-vec) is
  the default memory backend and is included.

Measured on Linux x64 at 2026.2.1-kolo.1: 60,216 files staged, archive 170.6 MB (tar.gz),
`bin/kolo --version` answers with no Node on PATH, and the gateway boots from the unpacked
bundle (`gateway --port 18895`, `KOLO_SKIP_CHANNELS=1`, empty PATH) and serves `/health` with
the bundle version.

## Version truth

One version: `package.json`. `src/version.ts` reads it (bundles: `lib/package.json`, rewritten
by `bundle.mjs` when `--version`/`KOLO_BUNDLE_VERSION` is set, which is how nightlies get
`<pkg>-nightly.<date>.<sha7>` without touching the repo). `packages/client/package.json` and
`extensions/*/package.json` must carry the same version (`scripts/release-check.ts`).

```
node scripts/release-prep.mjs <version|patch|minor|major|calver> [--dry-run] [--no-commit] [--no-tag] [--allow-dirty]
```

refuses a dirty tree or an existing tag, bumps all package files, requires the top `## <version>`
entry of `CHANGELOG.md` to equal the new version and be non-empty, commits `release: v<version>`
and creates the annotated tag. It never pushes; `git push origin HEAD --follow-tags` starts the
release workflow. Tags with a prerelease suffix (`-beta.1`) publish as prereleases.

## Release workflow

`.github/workflows/release.yml`:

1. `version`: tag → version (must equal package.json), `workflow_dispatch` → nightly or dry run.
2. `build` matrix `ubuntu-latest` / `macos-latest` / `windows-latest`: install (frozen), build,
   `pnpm test` (unit + extensions + gateway), `node scripts/bundle.mjs --verify`, the enterprise
   bundle (`--profile enterprise`, `kolo-<version>-<os>-<arch>-enterprise.*`, checked by
   `scripts/enterprise-check.mjs`; see [Enterprise profile](/security/enterprise-profile)), upload.
3. `release`: download, `SHA256SUMS.txt` (+ `sha256sum -c`), CycloneDX SBOM from the Linux
   bundle (syft via `anchore/sbom-action`), provenance attestation
   (`actions/attest-build-provenance`, verify with `gh attestation verify <file> -R <repo>`),
   GitHub Release with the CHANGELOG section as notes (`scripts/release-notes.mjs`), assets:
   the three archives and the three enterprise archives, `SHA256SUMS.txt`, the SBOM.

Unsigned by decision for the evaluation kit. The optional signing steps are gated on
`MACOS_CERT_P12` / `WINDOWS_CERT_PFX` being present and currently only echo; wiring them means a
macOS job (`scripts/codesign-mac-app.sh`, `scripts/notarize-mac-artifact.sh`) and a Windows job
(signtool on `node.exe` and the launcher). Until then macOS users need
`xattr -dr com.apple.quarantine <dir>` after unpacking and Windows shows SmartScreen once.

`.github/workflows/ci.yml` runs the same matrix on pull requests (typecheck, unit, extensions,
gateway on all three; smoke and a bundle build with the empty-PATH check on Linux). Known
OS-specific test exclusions are explicit in `test/ci-os-skips.json` (applied by
`vitest.config.ts` for `process.platform`); the list is empty until the first macOS/Windows
matrix run reports what needs it.

## `kurahi update` on a bundle

`src/infra/update-bundle.ts`, CLI in `src/cli/update-bundle-cli.ts`, audited (`update.check`,
`update.download`, `update.apply` / `update.stage`, `update.refused`).

- Channel: `--channel stable|nightly` > `KOLO_UPDATE_CHANNEL` > config `update.channel`
  (`beta`/`dev` map to nightly) > `stable`. Stable asks the GitHub Releases API for `latest`
  (never a prerelease); nightly takes the newest non-draft release. Repo: `KOLO_RELEASE_REPO`
  (default `koda-tokyo/kurahi`), API base `KOLO_RELEASE_API_BASE`; `GITHUB_TOKEN` is used when set.
- `kurahi update --check` (and `kurahi update status`) only reports current/latest.
- Install: download `SHA256SUMS.txt`, then the archive while hashing; a mismatch deletes the
  download, writes `update.refused`, exits 1 and changes nothing. A release without
  `SHA256SUMS.txt` or without an entry for the asset is refused. The unpacked bundle must
  pass its own `SHA256SUMS` and its manifest must match os/arch/version.
- POSIX: each top-level entry (`bin`, `lib`, `node`, licence files, manifest, sums) is renamed
  into `.previous/` and the new one renamed in; `.previous/` is the rollback. The gateway
  service is restarted unless `--no-restart`.
- Windows: the running `node.exe` and its addons cannot be replaced, so the new bundle is staged
  under `.update/staged`, `.update/pending.json` + `.update/apply.cmd` are written, and
  `bin\kolo.cmd` applies the swap the next time it starts. The launcher itself is never
  replaced while running (a newer launcher lands as `bin\kolo.cmd.new`). If the gateway service
  holds the files the script says so: `kurahi service stop`, any `kolo` command, `kurahi service
start`.

## Services from a bundle

- The service always runs on the bundled Node: `resolvePreferredNodePath` returns
  `process.execPath` inside a bundle, so a system Node (older, nvm-managed, absent at boot) is
  never picked. `KOLO_BUNDLE_ROOT` is in the service environment.
- Windows (`kurahi service install`): a Scheduled Task registered from an XML definition
  (`<state>/gateway.task.xml`): logon trigger (persists across reboots, starts at the next
  logon), `ExecutionTimeLimit PT0S` (the `/SC ONLOGON` form has a 72 h default that would stop
  the gateway), restart on failure, battery settings off, hidden, `LeastPrivilege`. The action is
  `wscript.exe //B //Nologo gateway.vbs`, a one-line hidden launcher for `gateway.cmd`, so no
  console window appears. If `/XML` is rejected the installer falls back to the argument form
  with the same hidden launcher. Without administrator rights Windows cannot start a user task
  before logon; a boot-time service (`sc`/SYSTEM) is a later option. Verified with a fake
  `schtasks` on PATH (`src/daemon/schtasks.test.ts`), not on a Windows machine.
- macOS: `~/Library/LaunchAgents/ai.kolo.gateway.plist` with `RunAtLoad` + `KeepAlive`,
  program arguments `node/bin/node lib/dist/entry.js gateway ...`; `launchctl bootstrap` +
  `kickstart`. Verified with a fake `launchctl` (`src/daemon/bundle-service.test.ts`).
- Linux: systemd user unit as before.

## Verifying a download by hand

```
sha256sum -c SHA256SUMS.txt --ignore-missing
gh attestation verify kolo-<version>-linux-x64.tar.gz -R koda-tokyo/kurahi
tar -xzf kolo-<version>-linux-x64.tar.gz && kolo-<version>-linux-x64/bin/kolo --version
```

## Verification record

| Target       | Date         | Result                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux-x64    | 2026-10-14   | `bin/kolo --version` with `PATH=/nonexistent`; full stranger pass from the archive (install, init, gateway, pairing, plugins, policy, factory, channels, evidence, support).                                                                                                                                                                    |
| win32-x64    | 2026-10-14   | `bin\kolo.cmd --version` with `PATH=C:\WINDOWS\system32`; full stranger pass from the archive on Windows 11 (install via `install.ps1`, init, gateway, pairing, plugins, providers, policy, factory, support). Archive extraction uses `tar.exe` because Windows PowerShell 5.1 `Expand-Archive` silently extracts nothing from zip64 archives. |
| darwin-arm64 | each release | Built and checked by the release workflow on a macOS runner; CI on Linux, macOS and Windows gates every tag.                                                                                                                                                                                                                                    |
