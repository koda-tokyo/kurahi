---
summary: "Updating a Kurahi installation and rolling back"
read_when:
  - You want to update
  - Something broke after an update and you need the previous version back
title: "Updating"
---

# Updating

Treat an update like any change to a service: update, check, verify.

## Prebuilt bundle (the installer)

```bash
kurahi update --check      # what is newer, without changing anything
kurahi update              # download, verify SHA-256, switch atomically, restart the service
kurahi health              # the gateway answers on its port
```

Each release is a self-contained bundle: its own Node.js runtime, the built product and its
dependencies, a `bundle-manifest.json` and a `SHA256SUMS` file. `kurahi update` refuses a bundle whose
checksum does not match the published `SHA256SUMS.txt`, and the unpacked bundle must pass its own
`SHA256SUMS` and match the OS, architecture and version in its manifest before it is switched in.
On Windows the new version is staged and applied by the launcher on the next start.

Re-running the installer is equivalent and also works offline with a local bundle:

```bash
curl -fsSL https://kodasoken.com/kurahi/install.sh | bash -s -- --no-init --no-service --no-invite
curl -fsSL https://kodasoken.com/kurahi/install.sh | bash -s -- --bundle ./kolo-<version>-linux-x64.tar.gz --sums ./SHA256SUMS.txt
```

```powershell
& ([scriptblock]::Create((iwr -useb https://kodasoken.com/kurahi/install.ps1))) -NoInit -NoService -NoInvite
```

## Package install

```bash
npm install -g kurahi@latest
# or
pnpm add -g kurahi@latest
kurahi doctor
kurahi service restart
```

## Source checkout

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
kurahi doctor
kurahi service restart
```

`kurahi update` runs those steps for you and stops when the working tree has uncommitted changes.

## After an update

- `kurahi doctor` reports config and service issues and offers repairs.
- `kurahi health` confirms the gateway is serving; `kurahi service status` shows the supervisor view.
- `kurahi update status` shows the running version and the newest release.

## Rollback

Bundle installs keep every installed version under the install prefix (default
`~/.local/share/kolo/<version>` on Linux and macOS, `%LOCALAPPDATA%\KoLo\app\<version>` on Windows)
and point the `kolo` command at one of them. To go back:

```bash
curl -fsSL https://kodasoken.com/kurahi/install.sh | bash -s -- --version <previous> --no-init --no-service --no-invite
kurahi service restart
```

Package installs: `npm install -g kurahi@<version>`. Source checkouts: check out the
previous tag, build, restart.

State in `KOLO_HOME` is not touched by updates or rollbacks. Config changes are merged, never
rewritten, so a rollback never needs a config restore. An older version does not accept keys it
does not know, though: if you turned on a setting that is new in the later release, remove it
before you start the older version (for 2.2.0 back to 2.1.0, see
[Kurahi 2.2.0](/releases/2.2.0#roll-back)).
