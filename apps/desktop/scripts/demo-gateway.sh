#!/usr/bin/env bash
# Start the Kurahi gateway for the Kurahi Desktop demo, in the foreground.
#   - its own persistent state directory ~/kurahi-demo-state (never ~/.kolo), port 18871,
#     loopback only; the prepared projects, chats and outputs live there
#   - Bonjour/mDNS advertising off (config + KOLO_DISABLE_BONJOUR=1)
#   - a small local model through Ollama (qwen2.5:1.5b), lean prompt and minimal tools
#   - no bundled skills (skills.allowBundled: [] = none) and a context window (32,768, qwen2.5's
#     native one) well above the compaction reserve (reserveTokensFloor 4,096), so a turn is not
#     followed by a summarising call. An existing kolo.json is brought to these settings.
# Stop it with Ctrl+C. Nothing keeps running afterwards.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEMO_HOME="${KURAHI_DEMO_HOME:-$HOME/kurahi-demo-state}"
PORT="${KURAHI_DEMO_PORT:-18871}"
MODEL="${KURAHI_DEMO_MODEL:-qwen2.5:1.5b}"

case "$PORT" in 18789|18790|18791|18792|18793) echo "port $PORT is the default gateway port or derived from it; pick another" >&2; exit 1 ;; esac
if [ "$DEMO_HOME" = "$HOME/.kolo" ]; then echo "refusing to use ~/.kolo" >&2; exit 1; fi
command -v ollama >/dev/null || { echo "ollama not found" >&2; exit 1; }
ollama list | awk '{print $1}' | grep -qx "$MODEL" || { echo "model $MODEL is not pulled (ollama pull $MODEL)" >&2; exit 1; }
[ -f "$REPO/dist/index.js" ] || { echo "build the runtime first: (cd $REPO && pnpm install && pnpm build)" >&2; exit 1; }
# allowBundled: [] means "no bundled skill" only in builds with 2b0725581d (older ones allowed
# all, 72 skills past the model's context), so refuse a dist older than the sources.
if [ -z "${KURAHI_DEMO_ALLOW_STALE_DIST:-}" ] && [ -n "$(find "$REPO/src" -name '*.ts' -newer "$REPO/dist/index.js" -print -quit)" ]; then
  echo "dist/ is older than src/: rebuild first (cd $REPO && pnpm build), or set KURAHI_DEMO_ALLOW_STALE_DIST=1" >&2
  exit 1
fi

mkdir -p "$DEMO_HOME"
if [ ! -f "$DEMO_HOME/kolo.json" ]; then
  cat > "$DEMO_HOME/kolo.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "discovery": { "mdns": { "mode": "off" } },
  "models": {
    "mode": "replace",
    "providers": {
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434/v1",
        "apiKey": "ollama-local",
        "api": "openai-completions",
        "models": [
          {
            "id": "$MODEL",
            "name": "Local model",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 32768,
            "maxTokens": 512
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "ollama/$MODEL" },
      "models": { "ollama/$MODEL": { "alias": "ローカルモデル / Local model" } },
      "skipBootstrap": true,
      "bootstrapMaxChars": 400,
      "compaction": { "reserveTokensFloor": 4096 }
    }
  },
  "tools": { "profile": "minimal" },
  "skills": { "allowBundled": [] }
}
JSON
fi

# Bring a kolo.json written by an earlier version of this script to the same settings: no bundled
# skills, a context window of at least 32,768 and a 4,096 reserve floor. When anything changed,
# drop the sessions' cached skills snapshots so the next turn rebuilds them from this config.
node - "$DEMO_HOME" "$MODEL" <<'NODE'
const fs = require("fs");
const path = require("path");
const [home, model] = process.argv.slice(2);
const file = path.join(home, "kolo.json");
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const before = JSON.stringify(cfg);
cfg.skills = { ...cfg.skills, allowBundled: [] };
for (const m of cfg.models?.providers?.ollama?.models ?? []) {
  if (m.id === model && !(m.contextWindow >= 32768)) m.contextWindow = 32768;
}
const defaults = (cfg.agents ??= {}).defaults ??= {};
defaults.compaction = { ...defaults.compaction };
if (!(defaults.compaction.reserveTokensFloor <= 4096)) defaults.compaction.reserveTokensFloor = 4096;
if (JSON.stringify(cfg) === before) process.exit(0);
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log("kolo.json: updated skills/context settings");
const agents = path.join(home, "agents");
for (const id of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
  const sess = path.join(agents, id, "sessions", "sessions.json");
  if (!fs.existsSync(sess)) continue;
  const store = JSON.parse(fs.readFileSync(sess, "utf8"));
  let n = 0;
  for (const entry of Object.values(store)) if (entry && entry.skillsSnapshot) { delete entry.skillsSnapshot; n++; }
  if (n) { fs.writeFileSync(sess, JSON.stringify(store, null, 2)); console.log(`${id}: dropped ${n} cached skills snapshot(s)`); }
}
NODE

echo "Kurahi demo gateway: ws://127.0.0.1:$PORT  state: $DEMO_HOME  model: ollama/$MODEL"
echo "Stop with Ctrl+C."
cd "$REPO"
export KOLO_HOME="$DEMO_HOME" KOLO_DISABLE_BONJOUR=1
unset KOLO_STATE_DIR KOLO_GATEWAY_TOKEN KOLO_GATEWAY_TOKEN_FILE
exec node kolo.mjs gateway --port "$PORT" --bind loopback --allow-unconfigured
