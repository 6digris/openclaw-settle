#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BINARY="${1:-$ROOT/apps/linux/src-tauri/gen/runtime/openclaw-runtime}"
# Container owns synthetic state; no host HOME, credentials, Node/npm or sockets.
# Fetch the OS image before the network-isolated program-code bootstrap.
image="openclaw-sea-proof:$(id -u)-$$"
trap 'docker image rm "$image" >/dev/null' EXIT
docker build -f "$ROOT/apps/linux/tests/sea-runtime.Dockerfile" -t "$image" "$ROOT/apps/linux/tests"
docker run --rm --network none --read-only --tmpfs /tmp:exec,size=4g \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/home -e OPENCLAW_STATE_DIR=/tmp/state \
  -e OPENCLAW_DESKTOP_RUNTIME_DIR=/tmp/runtime \
  -v "$BINARY:/included-runtime:ro" \
  -v "$ROOT/apps/linux/scripts/verify-sea-runtime.mjs:/proof.mjs:ro" \
  "$image" /bin/sh -c '
    set -eu
    ! command -v node
    ! command -v npm
    ! command -v openclaw
    mkdir /tmp/home
    /included-runtime --version
    /tmp/runtime/*/bin/node /proof.mjs /included-runtime
  '
