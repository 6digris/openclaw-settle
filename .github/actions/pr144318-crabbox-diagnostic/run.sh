#!/usr/bin/env bash
# One diagnostic attempt; preserve the original shard runner and budgets.
set -euo pipefail
payload="$(cd "$(dirname "$0")" && pwd)"
artifact="$PWD/.artifacts/pr144318-crabbox-diagnostic"
mkdir -p "$artifact"
test "$(node --version)" = v24.20.0
python3 "$payload/record.py" runtime
git apply --check "$payload/MAIN22-CRABBOX-HOSTED-WITNESS.patch"
git apply "$payload/MAIN22-CRABBOX-HOSTED-WITNESS.patch"
export OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON="$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).files))' "$payload/MAIN22-CRABBOX-ORIGINAL-SELECTION.json")"
export OPENCLAW_CRABBOX_WITNESS_MODULE="$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' "$payload/MAIN22-CRABBOX-HOSTED-WITNESS.mjs")"
export OPENCLAW_CRABBOX_WITNESS_FILE="$artifact/trace.jsonl"
export NODE_OPTIONS="${NODE_OPTIONS:-} --import=$OPENCLAW_CRABBOX_WITNESS_MODULE"
set +e
time -p node --import tsx scripts/ci-run-node-test-shard.mts 2>&1 | tee "$RUNNER_TEMP/pr144318-diagnostic-shard.log"
status=${PIPESTATUS[0]}
set -e
printf '%s\n' "$status" > "$artifact/shard-exit.txt"
exit "$status"
