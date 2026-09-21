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
