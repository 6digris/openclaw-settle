#!/usr/bin/env bash
set -euo pipefail
# Linux only. macOS/Windows test ports retain their existing runtime contract.
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DESTINATION="${1:-$ROOT/apps/linux/src-tauri/gen/runtime}"
RELEASE_TAG="${2:-}"
SOURCE_SHA="${3:-}"
[[ "$(uname -s)" == Linux ]] || { echo 'SEA production staging requires Linux' >&2; exit 1; }
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 1 ;; esac
mkdir -p "$DESTINATION"
DESTINATION="$(cd "$DESTINATION" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/home" "$SCRATCH/package"
# Build dependencies and downloads belong exclusively to packaging, never app startup.
TARBALL="$(env -i HOME="$SCRATCH/home" PATH="$PATH" TMPDIR="$SCRATCH" \
  node "$ROOT/scripts/package-openclaw-for-docker.mjs" \
  --skip-build --pnpm-pack --allow-unreleased-changelog \
  --output-dir "$SCRATCH/package" --output-name openclaw.tgz)"
env -i HOME="$SCRATCH/home" PATH="$PATH" TMPDIR="$SCRATCH" \
  OPENCLAW_INSTALL_CLI_SH_NO_RUN=1 OPENCLAW_NODE_VERSION=26.8.2 \
  bash -c '
    set -euo pipefail
    source "$1/scripts/install-cli.sh"
    PREFIX="$2/prefix"
    OPENCLAW_VERSION="$3"
    install_node linux "$4"
    export PATH="$(node_dir)/bin:$PATH"
    install_openclaw
    release_args=()
    if [[ -n "$6" || -n "$7" ]]; then
      release_args=("$6" "$7")
    fi
    node "$1/apps/linux/scripts/build-sea-runtime.mjs" "$(node_dir)" "$5/openclaw-runtime" "${release_args[@]}"
  ' bash "$ROOT" "$SCRATCH" "$TARBALL" "$arch" "$DESTINATION" "$RELEASE_TAG" "$SOURCE_SHA"
