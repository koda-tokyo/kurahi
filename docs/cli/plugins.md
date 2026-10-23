---
summary: "CLI reference for `kurahi plugins` (list, info, enable, disable, install, update, reload, doctor)"
read_when:
  - You want to install or manage in-process gateway plugins
  - You want to debug a plugin that did not load
title: "plugins"
---

# `kurahi plugins`

Manage the plugins (extensions) the gateway loads in-process.

Related:

- Plugin system: [Plugins](/plugin)
- Plugin manifest and schema: [Plugin manifest](/plugins/manifest)
- Security: [Security](/gateway/security)

## Commands

```bash
kurahi plugins list [--enabled] [--verbose] [--json]
kurahi plugins info <id> [--json]
kurahi plugins enable <id>
kurahi plugins disable <id>
kurahi plugins install <path-or-spec> [--link]
kurahi plugins update <id> | --all [--dry-run]
kurahi plugins reload <id> [--json]
kurahi plugins doctor
kurahi plugins pin <id> | --all [--force] [--json]
kurahi plugins verify [--json]
```

- `list` shows every discovered plugin with its source (bundled, workspace, global, config path)
  and whether it is enabled.
- `install` accepts a local `.ts`/`.js` file, a `.zip`/`.tgz`/`.tar.gz` archive, or an npm package
  spec. `--link` links a local path instead of copying it. Installs are recorded under
  `plugins.installs` in the config.
- `update` applies only to npm installs; `--dry-run` prints what would change.
- `pin` scans a plugin package and approves its SHA-256 into the supply-chain lock; `verify`
  checks every skill and plugin against it. In `integrity.supplyChain.mode: enforce` (new
  installs) an unpinned or changed non-bundled plugin is not loaded. See
  [Skill and plugin integrity](/security/skill-integrity).
- `reload` asks the running gateway to reload one plugin without a restart and reports whether it
  came back, was disabled, or was quarantined.
- `doctor` reports load issues (live gateway state when one runs) and the last self-check.

## Where plugins are found

- Bundled extensions shipped with the product (start disabled; enable them explicitly).
- `<workspace>/.kolo/extensions/`
- `<KOLO_HOME>/extensions/`
- Paths listed in `plugins.load.paths`.

Every plugin ships a `KoLo.plugin.json` manifest with an inline JSON Schema (`configSchema`, even
when empty). A missing or invalid manifest or schema prevents the plugin from loading and shows in
`kurahi plugins doctor`.

## Configuration

Plugins are controlled under `plugins` in the config: `enabled`, `allow`, `deny`,
`entries.<id>.enabled`, `entries.<id>.config`, `load.paths`, `hotReload` and `slots`. See
[Plugins](/plugin) for the full reference.

## Exit codes

- 0: success.
- 1: the plugin was not found, failed to install, or the gateway refused the reload.
- 2: usage.
