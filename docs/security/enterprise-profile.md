---
summary: "Enterprise build profile (Kurahi 2.2): which extensions the enterprise package ships, which are separate opt-in plugins and which are excluded, how the runtime refuses excluded plugins, and how to verify a package yourself"
read_when:
  - Answering a security review question about consumer channels or plugins in Kurahi
  - Building or verifying the enterprise package
  - Deciding whether an optional plugin may be installed in a business deployment
title: "Enterprise profile"
---

# Enterprise profile

Also available in [Japanese](/ja/security/enterprise-profile).

Kurahi grew out of a general-purpose agent runtime that also carried consumer chat channels,
consumer OAuth logins and free-tier data feeds. A business deployment needs none of them, and a
security review should not have to read them. From release 2.2 there is an **enterprise profile**:

- an **enterprise package** (runtime bundle and npm tarball) that contains only the core and the
  extensions classified as enterprise;
- **optional plugins**, each a separate archive that an administrator installs and enables on
  purpose;
- a **runtime guard**: under the enterprise profile the gateway refuses an excluded plugin even
  when someone copies it into a plugin directory and enables it, and writes the refusal to the
  audit log.

The classification is one file, `src/packaging/profiles/enterprise.json`: one entry per directory
in `extensions/`, each with a tier and a reason. The build, the runtime guard and the package check
all read that file. A test fails when an extension has no entry, so a new extension cannot reach a
package unclassified. No extension is deleted from the repository; the profile is packaging and
runtime gating only.

## What is in and what is out

### Enterprise (shipped, allowed)

| Extension                                       | Why                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `microsoft-365`, `entra`, `gmail`               | Business mail, calendar, files and directory; read-only by default; Entra provides OIDC sign-in.                                                                                             |
| `box`, `kintone`, `line-works`                  | Business connectors; read-only by default, bounded queries, field allow-lists.                                                                                                               |
| `freee`, `money-forward`, `smarthr`             | Japanese accounting, invoicing and HR connectors; read-only; SmartHR returns work fields only.                                                                                               |
| `office`, `legacy-analyzer`                     | Office documents (PPTX, DOCX, XLSX) written into the Project; COBOL/JCL analysis. Local only.                                                                                                |
| `scholar-sources`                               | Read-only research metadata (arXiv, OpenAlex, Crossref, PubMed) for Kurahi Scholars.                                                                                                         |
| `a2a`                                           | Agent2Agent interoperability with enterprise agent platforms, behind gateway auth and signed agent messaging.                                                                                |
| `diagnostics-otel`                              | OpenTelemetry export to the customer's own collector.                                                                                                                                        |
| `watsonx-orchestrate`, `ibm-data`               | IBM watsonx Orchestrate agent client (allow-listed agents, replies wrapped as untrusted) and read-only watsonx.data and Db2 REST queries (allow-lists, row and byte limits); off by default. |
| `msteams`                                       | Teams through an Azure bot in the customer's Entra tenant. Direct messages default to pairing (owner approval), group chats to an allow-list.                                                |
| `slack`                                         | Slack workspaces and Enterprise Grid through a customer-installed app. Direct messages default to pairing; under the enterprise profile an unset channel policy is an allow-list.            |
| `memory-core`, `llm-task`                       | Local memory search (the default memory slot); a JSON-only task tool on the configured model.                                                                                                |
| `health-watchdog`, `self-check`, `log-rotation` | Local operations: audited liveness watchdog, security self-check, log retention caps.                                                                                                        |

Teams and Slack are in because they are the customer's own business tenants and nothing reaches an
agent without an approval: an unknown sender in a direct message gets a pairing code that the owner
must approve, and a channel or group chat must be on the allow-list. For Slack the runtime default
for an unset `channels.slack.groupPolicy` was `open` (mention-gated); under the enterprise profile it
is `allowlist`. An explicit value in the config still wins.

### Optional (separate archive, explicit opt-in)

| Extension                                              | Why it is not in the package                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp`                                             | Separate since 2.1.0: its libsignal dependency is GPL-3.0.                                                                 |
| `memory-lancedb`                                       | Needs the LanceDB native runtime (about 250 MB).                                                                           |
| `ocr-space`                                            | Uploads document content to the OCR.space cloud on a free tier; needs the customer's data-processing review.               |
| `brave-search`, `opencorporates`                       | External APIs with their own keys and licences; queries leave the network.                                                 |
| `libretranslate`                                       | The default public instance would receive document text; point it at a self-hosted server.                                 |
| `googlechat`, `mattermost`, `nextcloud-talk`, `matrix` | Business-capable chat, outside the channel set reviewed for 2.2 (Matrix also brings a native crypto addon and federation). |
| `voice-call`                                           | Telephony and call recording need their own review.                                                                        |

Each is built as `kurahi-<id>-<version>.tgz` with a `.sha256` next to it
(`node scripts/pack-plugin.mjs --tier optional`). Under the enterprise profile an optional plugin
loads only when the administrator opted in explicitly: `plugins.entries.<id>.enabled: true`, an
entry in `plugins.allow`, or (for `memory-lancedb`) `plugins.slots.memory`. The same rule applies
to a plugin the manifest does not know, such as a customer's own plugin.

### Excluded (not shipped, refused at runtime)

| Extension                                                                                                         | Why                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `telegram`, `discord`, `signal`, `imessage`, `bluebubbles`, `line`, `nostr`, `tlon`, `twitch`, `zalo`, `zalouser` | Consumer channels (personal accounts, public networks, streaming). The business LINE path is `line-works`.                                |
| `copilot-proxy`, `google-gemini-cli-auth`, `minimax-portal-auth`, `qwen-portal-auth`                              | Personal subscriptions or consumer OAuth logins reused as model credentials; enterprise deployments use contracted API keys.              |
| `alpha-vantage`, `newsdata`, `wolfram-alpha`, `locationiq`, `open-meteo`                                          | Free-tier consumer data feeds for personal briefings.                                                                                     |
| `circadian`, `proactive-triggers`, `memory-boot-inject`                                                           | Persona and continuity features of a private deployment; agents that start conversations unprompted are not wanted in a business product. |
| `lobster`, `open-prose`                                                                                           | Depend on external tooling (a workflow CLI, a skill-pack VM with its own telemetry) that is neither shipped nor reviewed.                 |

The reason for every extension, word for word, is in `src/packaging/profiles/enterprise.json`.

## Turning the profile on

The profile is on when **either** of these is set; neither can switch the other off:

- the environment variable `KURAHI_PROFILE=enterprise` (the launcher of the enterprise bundle
  always exports it);
- `profile: "enterprise"` in the config file.

Set both. The launcher covers anyone who starts Kurahi normally; the config covers someone who
starts `lib/kolo.mjs` with a Node binary directly, which bypasses the launcher.

Under the profile the plugin loader decides before it imports a plugin module:

| Tier                        | Standard profile | Enterprise profile                                                  |
| --------------------------- | ---------------- | ------------------------------------------------------------------- |
| enterprise                  | normal rules     | normal rules                                                        |
| optional, or not classified | normal rules     | loads only with an explicit opt-in (above)                          |
| excluded                    | normal rules     | refused, whatever the config says and wherever the plugin was found |

A refused plugin is listed by `kurahi plugins list` as `disabled` with the reason, the gateway
logs a warning, and the gateway writes one audit row per refusal: action `plugin.refused`, outcome
`denied`, with the plugin id, profile, tier, origin and path. `kurahi audit tail` shows it and
`kurahi audit verify` covers it like every other row.

An enterprise install updates only to the enterprise asset: `kurahi update` asks for
`kolo-<version>-<os>-<arch>-enterprise.*` and refuses a downloaded bundle whose manifest is not the
enterprise profile.

## How the package is built

```bash
pnpm build
node scripts/bundle.mjs --profile enterprise --verify          # kolo-<v>-<os>-<arch>-enterprise.tar.gz (.zip on Windows)
node scripts/npm-pack.mjs --profile enterprise --out <dir>      # kurahi-<v>-enterprise.tgz
node scripts/pack-plugin.mjs --tier optional --out <dir>        # kurahi-<id>-<v>.tgz per optional plugin
```

The enterprise bundle

- copies only enterprise-tier extensions;
- installs production dependencies for the core and those extensions, then removes every package
  that only an omitted extension needs (a package that the core or a shipped extension also needs
  stays);
- writes `profile: "enterprise"` and the omitted extensions with their reasons into
  `bundle-manifest.json`;
- runs the package check (below) on the staged tree and fails the build on a finding.

Extensions import some core modules by their source path. A package ships the built core
(`dist/`), not its sources, so both the bundle and the npm tarball carry small generated files
under `src/` that re-export the built module. Without them those plugins would not load; the
package check fails when an extension import resolves to nothing.

## Verify the package yourself

1. Check the archive against the published checksums:
   `sha256sum -c --ignore-missing SHA256SUMS.txt`.
2. Unpack it and read `bundle-manifest.json`: `profile` is `enterprise`, `extensions.included`
   lists only enterprise-tier extensions, `extensions.omitted` gives a reason for each of the rest.
   `ls lib/extensions` shows the same list.
3. Run the package check from a source checkout of the same tag (CI runs it on Linux, macOS and
   Windows for every change):

   ```bash
   node scripts/enterprise-check.mjs kolo-<v>-linux-x64-enterprise.tar.gz
   ```

   It fails (exit 1) on any of:
   - an extension that is not enterprise tier (excluded, optional or unclassified);
   - a private-deployment identifier in `dist/` or the extension sources (the patterns of
     `scripts/family-internal-check.mjs`, with its reviewed exceptions);
   - an installed dependency with a strong copyleft licence (GPL, AGPL, SSPL and similar, the
     classification of `scripts/sbom.mjs`);
   - a static import in a shipped extension that resolves to nothing in the package.

   Weak copyleft and unknown licences are printed as warnings; `--strict` fails on unknown
   licences too. `--json` prints the full result.

4. Start it and list the plugins: `kurahi plugins list --json`. Copy an excluded plugin into
   `<KOLO_HOME>/extensions/` and enable it to see the refusal and its audit row.

## Known limits

- The core still contains the code of the consumer channels that are built into it (for example
  the Telegram, Discord, Signal, iMessage, LINE and WhatsApp Web modules under `dist/`) and their
  libraries. That code runs only when its channel plugin registers it, and those plugins are not in
  the package and are refused at runtime. Removing the modules from the core build is planned work.
- Weak copyleft libraries remain: libvips (LGPL-3.0, through sharp) and lightningcss (MPL-2.0).
  They are dynamically linked or unmodified; the warnings name them on every check.
- The npm tarball has no `node_modules`; its dependency licences are checked on the bundle and
  listed in the SBOM (`node scripts/sbom.mjs`).
- `KURAHI_PROFILE` is read by the runtime; a profile set only in the environment of one shell does
  not apply to a service started elsewhere. Put `profile: "enterprise"` in the config.
