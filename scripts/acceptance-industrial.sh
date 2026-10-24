#!/usr/bin/env bash
# Kurahi Industrial Edition release acceptance (test/acceptance/industrial-edition.e2e.test.ts).
#
# Runs against the BUILT product (dist/ via kolo.mjs) from a clean temporary home: kurahi init,
# gateway start, an Industrial project over a polyglot legacy tree, the analyser tools, artifact
# export with its .sha256 sidecar, the terminal broker's approvals and audit, and the security
# defaults. Writes test/acceptance/REPORT-<release>.md.
#
# The gateway it starts binds 127.0.0.1 on the first free port in 18960-18980, uses its own
# temporary KOLO_HOME, never touches ~/.kolo*, and is stopped when the test ends. Everything runs
# in the foreground under `timeout`. No model is called.
#
# Usage:
#   scripts/acceptance-industrial.sh            build when dist/ is missing, then run
#   scripts/acceptance-industrial.sh --build    always rebuild first (pnpm build)
#   KURAHI_ACCEPT_RELEASE=2.1.0                 release named in the report (default 2.1.0)
#   KURAHI_ACCEPT_KEEP=1                        keep the temporary home for inspection
#   KURAHI_ACCEPT_TIMEOUT=900                   overall time limit in seconds (default 900)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LIMIT="${KURAHI_ACCEPT_TIMEOUT:-900}"
RELEASE="${KURAHI_ACCEPT_RELEASE:-2.1.0}"
export KURAHI_ACCEPT_RELEASE="$RELEASE"

if [[ "${1:-}" == "--build" || ! -f dist/index.js ]]; then
  echo "==> Build (pnpm build)"
  timeout 1500 pnpm build >/dev/null
fi

echo "==> Industrial Edition acceptance (release $RELEASE, limit ${LIMIT}s)"
status=0
timeout "$LIMIT" npx vitest run --config vitest.e2e.config.ts \
  test/acceptance/industrial-edition.e2e.test.ts || status=$?

REPORT="test/acceptance/REPORT-${RELEASE}.md"
if [[ -f "$REPORT" ]]; then
  echo "==> Report: $REPORT"
  sed -n '/^| Step/,/^$/p' "$REPORT"
fi
exit "$status"
