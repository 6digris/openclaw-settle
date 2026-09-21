#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PACKAGE="$(realpath "$1")"
OUTPUT="$(realpath -m "$2")"
[[ "$(ps -p 1 -o comm=)" == systemd ]] || { echo 'Native service proof requires a systemd Crabbox VM' >&2; exit 1; }
name="openclaw-sea-$(date +%s)-$RANDOM"
home="/tmp/$name"
created=0
cleanup() {
  if [[ "$created" == 1 ]]; then
    mkdir -p "$OUTPUT"
    if sudo test -d "$home/proof"; then sudo cp -r "$home/proof/." "$OUTPUT/"; fi
    if sudo test -f "$home/app.log"; then sudo cp "$home/app.log" "$OUTPUT/app.log"; fi
    sudo chown -R "$(id -u):$(id -g)" "$OUTPUT"
    sudo loginctl terminate-user "$name" || true
    sudo loginctl disable-linger "$name" || true
    sudo systemctl stop "user@$uid.service" || true
    sudo pkill -KILL -u "$uid" || true
    for attempt in {1..50}; do
      if ! pgrep -u "$uid" >/dev/null; then break; fi
      sleep 0.1
    done
    sudo userdel -r "$name"
  fi
}
trap cleanup EXIT
sudo useradd --create-home --home-dir "$home" --shell /bin/bash "$name"
created=1
uid="$(id -u "$name")"
sudo loginctl enable-linger "$name"
sudo systemctl start "user@$uid.service"
sudo mkdir -p "$home/proof" "$home/app"
# Tauri resolves Linux resources relative to usr/bin -> usr/lib/OpenClaw.
# Extract the real Debian payload rather than relocating only its executable.
sudo dpkg-deb --extract "$PACKAGE" "$home/app"
sudo cp "$ROOT/apps/linux/tests/first_run.py" "$home/app/first_run.py"
sudo chown -R "$name:$name" "$home/proof" "$home/app"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
sudo -u "$name" env -i HOME="$home" USER="$name" PATH=/usr/bin:/bin \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 GTK_MODULES=atk-bridge NO_AT_BRIDGE=0 \
  GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 XDG_RUNTIME_DIR="/run/user/$uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  OPENCLAW_GATEWAY_PORT="$port" \
  xvfb-run -a -s '-screen 0 1280x1024x24' \
  bash -c 'cd "$HOME"; /usr/bin/python3 "$HOME/app/first_run.py" "$HOME/app/usr/bin/openclaw-desktop" --driver --bundled-runtime --artifacts-dir "$HOME/proof"'

# The same included launcher owns the service contract after the window closes.
sudo -u "$name" env -i HOME="$home" USER="$name" PATH=/usr/bin:/bin \
  XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  OPENCLAW_GATEWAY_PORT="$port" bash -c '
    set -euo pipefail
    cd "$HOME"
    cli="$HOME/.local/share/ai.openclaw.linux/runtime/openclaw-runtime"
    "$cli" gateway restart --json
    "$cli" gateway stop --json --force
    "$cli" gateway status --json | python3 -c "import json,sys; s=json.load(sys.stdin); assert not s.get(\"rpc\",{}).get(\"ok\")"
    "$cli" gateway start --json
    ready=0
    for attempt in {1..20}; do
      if "$cli" gateway status --json | python3 -c "import json,sys; assert json.load(sys.stdin).get(\"rpc\",{}).get(\"ok\")"; then ready=1; break; fi
      sleep 0.5
    done
    test "$ready" = 1
    printf "PASS: included runtime service restart, stop, start and readiness\n"
  '

# A separate desktop HOME connects in remote mode to the already-running fixture
# Gateway. Its service definition and PID must remain unchanged.
sudo -u "$name" env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  systemctl --user show openclaw-gateway.service -p MainPID --value > "$OUTPUT.remote-pid-before"
sudo sha256sum "$home/.config/systemd/user/openclaw-gateway.service" > "$OUTPUT.service-before"
sudo -u "$name" python3 - "$home" "$port" <<'PY'
import json, sys
from pathlib import Path
home = Path(sys.argv[1])
config = json.loads((home / '.openclaw/openclaw.json').read_text())
token = config['gateway']['auth']['token']
assert isinstance(token, str)
remote = home / 'remote/.openclaw'
remote.mkdir(parents=True)
(remote / 'openclaw.json').write_text(json.dumps({'gateway': {'mode': 'remote', 'remote': {'url': 'ws://127.0.0.1:' + sys.argv[2], 'token': token}}}))
PY
sudo -u "$name" env -i HOME="$home/remote" USER="$name" PATH=/usr/bin:/bin \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 GTK_MODULES=atk-bridge NO_AT_BRIDGE=0 \
  GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 XDG_RUNTIME_DIR="/run/user/$uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  xvfb-run -a -s '-screen 0 1280x1024x24' \
  bash -c 'cd "$HOME"; /usr/bin/python3 "$1/app/first_run.py" "$1/app/usr/bin/openclaw-desktop" --driver --connected-remote --artifacts-dir "$1/proof/remote"' bash "$home"
sudo -u "$name" env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  systemctl --user show openclaw-gateway.service -p MainPID --value > "$OUTPUT.remote-pid-after"
sudo sha256sum "$home/.config/systemd/user/openclaw-gateway.service" > "$OUTPUT.service-after"
cmp "$OUTPUT.remote-pid-before" "$OUTPUT.remote-pid-after"
cmp "$OUTPUT.service-before" "$OUTPUT.service-after"
test ! -e "$home/remote/.config/systemd/user/openclaw-gateway.service"
printf 'PASS: native remote mode did not change the running Gateway or service definition\n'


# Exercise the existing managed-install recovery UI in the actual bundled app.
# The legacy prefix and version failures are synthetic; only the network-facing
# installer is stubbed, and the native action must invoke its canonical resource.
sudo -u "$name" python3 - "$home" <<'PY'
import os, sys
from pathlib import Path
home = Path(sys.argv[1])
installer = home / 'app/usr/lib/OpenClaw/install-cli.sh'
installer.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/proof/managed-installer-args"\nprintf "Fixture: managed reinstall selected.\\n" >&2\nexit 1\n')
installer.chmod(0o700)
(home / '.openclaw/bin').mkdir(parents=True, exist_ok=True)
PY
for mode in broken outdated; do
  sudo -u "$name" python3 - "$home" "$mode" <<'PY'
import sys
from pathlib import Path
home, mode = Path(sys.argv[1]), sys.argv[2]
body = '#!/bin/sh\n'
if mode == 'outdated':
    body += 'if test "$1" = --version; then printf "OpenClaw 2026.1.1\\n"; exit 0; fi\n'
body += 'printf "Fixture: managed CLI needs repair.\\n" >&2\nexit 1\n'
cli = home / '.openclaw/bin/openclaw'
cli.write_text(body)
cli.chmod(0o700)
(home / 'proof/managed-installer-args').unlink(missing_ok=True)
PY
  sudo -u "$name" env -i HOME="$home" USER="$name" PATH=/usr/bin:/bin \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 GTK_MODULES=atk-bridge NO_AT_BRIDGE=0 \
    GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" OPENCLAW_GATEWAY_PORT="$port" \
    xvfb-run -a -s '-screen 0 1280x1024x24' \
    bash -c 'cd "$HOME"; /usr/bin/python3 "$HOME/app/first_run.py" "$HOME/app/usr/bin/openclaw-desktop" --driver --managed-reinstall --artifacts-dir "$HOME/proof/managed-$1"' bash "$mode"
  sudo -u "$name" grep -Fx -- '--prefix' "$home/proof/managed-installer-args"
  sudo -u "$name" grep -Fx -- "$home/.openclaw" "$home/proof/managed-installer-args"
done
sudo -u "$name" rm "$home/.openclaw/bin/openclaw"

# Inject a digest-valid candidate that fails its bootstrap. The prior full SEA
# and real service must remain restartable; this never edits the checked-in app.
launcher="$home/.local/share/ai.openclaw.linux/runtime/openclaw-runtime"
previous="$(sudo -u "$name" readlink "$launcher")"
sudo -u "$name" python3 - "$home" <<'PY'
import hashlib, json, sys
from pathlib import Path
home = Path(sys.argv[1])
resource = home / 'app/usr/lib/OpenClaw/runtime/openclaw-runtime'
body = b'#!/bin/sh\nprintf "Fixture: candidate bootstrap failed.\\n" >&2\nexit 1\n'
resource.write_bytes(body)
resource.chmod(0o700)
resource.with_name('manifest.json').write_text(json.dumps({'version':'0.1.0', 'sha256':hashlib.sha256(body).hexdigest()}))
PY
sudo -u "$name" env -i HOME="$home" USER="$name" PATH=/usr/bin:/bin \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 GTK_MODULES=atk-bridge NO_AT_BRIDGE=0 \
  GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 XDG_RUNTIME_DIR="/run/user/$uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" OPENCLAW_GATEWAY_PORT="$port" \
  xvfb-run -a -s '-screen 0 1280x1024x24' \
  bash -c 'cd "$HOME"; /usr/bin/python3 "$HOME/app/first_run.py" "$HOME/app/usr/bin/openclaw-desktop" --driver --failed-update --artifacts-dir "$HOME/proof/failed-update"'
test "$(sudo -u "$name" readlink "$launcher")" = "$previous"
sudo -u "$name" env -i HOME="$home" USER="$name" PATH=/usr/bin:/bin \
  XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  OPENCLAW_GATEWAY_PORT="$port" bash -c '
    set -euo pipefail
    cd "$HOME"
    cli="$HOME/.local/share/ai.openclaw.linux/runtime/openclaw-runtime"
    "$cli" gateway restart --json
    "$cli" gateway status --json | python3 -c "import json,sys; assert json.load(sys.stdin).get(\"rpc\",{}).get(\"ok\")"
  '
printf 'PASS: failed bundled activation preserved the prior real Gateway runtime\n'
