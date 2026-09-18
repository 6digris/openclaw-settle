#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 <openclaw.tgz>" >&2
  exit 2
fi

tarball_realpath="$(realpath "$1")"
tarball_sha_before="$(sha256sum "$tarball_realpath" | awk '{print $1}')"
verifier_root="$(mktemp -d)"
trap 'rm -rf "$verifier_root"' EXIT

install -D -m 0444 scripts/verify-npm-tarball-install.mjs "$verifier_root/scripts/verify-npm-tarball-install.mjs"
install -D -m 0444 scripts/npm-runner.mjs "$verifier_root/scripts/npm-runner.mjs"
install -D -m 0444 scripts/windows-cmd-helpers.mjs "$verifier_root/scripts/windows-cmd-helpers.mjs"
install -D -m 0444 scripts/lib/npm-shrinkwrap-dependencies.mjs "$verifier_root/scripts/lib/npm-shrinkwrap-dependencies.mjs"
chmod -R a+rX "$verifier_root"

docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=4g,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 65532:65532 \
  --mount "type=bind,src=$verifier_root,dst=/verifier,readonly" \
  --mount "type=bind,src=$tarball_realpath,dst=/input/openclaw.tgz,readonly" \
  --workdir /tmp \
  node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 \
  sh -euc '
    if env | grep -Eq "^(ACTIONS_|GITHUB_|GH_TOKEN=)"; then
      echo "Publisher credentials crossed the install boundary." >&2
      exit 1
    fi
    test ! -w /input/openclaw.tgz
    test ! -w /verifier
    node /verifier/scripts/verify-npm-tarball-install.mjs /input/openclaw.tgz
  '

tarball_sha_after="$(sha256sum "$tarball_realpath" | awk '{print $1}')"
if [[ "$tarball_sha_before" != "$tarball_sha_after" ]]; then
  echo "Public-install verification modified the publication tarball." >&2
  exit 1
fi
echo "Public-install verifier ran without publisher credentials or writable publication artifacts."
