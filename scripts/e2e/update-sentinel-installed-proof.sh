#!/usr/bin/env bash
# Disposable proof only: installed published driver, then installed candidate A/B no-op.
set -Eeuo pipefail
[[ -f /.dockerenv && "${SENTINEL_DISPOSABLE_PROOF:-}" == 1 ]]
[[ "$(id -u)" != 0 && "$HOME" == "$(getent passwd "$(id -u)" | cut -d: -f6)" ]]
[[ "${CANDIDATE_SOURCE:?}" == 16e3ca121ec6b91072d1b2c6c93333381e902e7d ]]
[[ ! -e "$HOME/.openclaw" && ! -e /tmp/openclaw ]]
umask 077
export CI=true OPENCLAW_NO_ONBOARD=1 OPENCLAW_NO_PROMPT=1
export OPENCLAW_SKIP_PROVIDERS=1 OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_DISABLE_BONJOUR=1
unset OPENCLAW_HOME OPENCLAW_PROFILE OPENCLAW_SYSTEMD_UNIT OPENCLAW_UPDATE_RUN_HANDOFF OPENCLAW_SUPERVISOR_MODE
export npm_config_prefix="$HOME/npm-prefix" npm_config_cache="$HOME/npm-cache"
export NPM_CONFIG_PREFIX="$npm_config_prefix" NPM_CONFIG_CACHE="$npm_config_cache"
export npm_config_fund=false npm_config_audit=false
export PATH="$npm_config_prefix/bin:$PATH"
export OPENCLAW_STATE_DIR="$HOME/.openclaw" OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json"
export CALLER_STATE="$OPENCLAW_STATE_DIR" SELECTED_STATE="$HOME/.openclaw-service"
export INSTALLED_ROOT="$npm_config_prefix/lib/node_modules/openclaw"
export PROOF_ROOT=/proof
mkdir -p "$npm_config_prefix" "$npm_config_cache" "$CALLER_STATE" /tmp/openclaw
chmod 700 /tmp/openclaw
registry_pid=""
phase=setup
managed_unit=openclaw-gateway.service
assert_manager_inactive() {
  local status=0
  systemctl --user is-active --quiet "$managed_unit" || status=$?
  [[ "$status" == 3 ]]
}
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -x "$npm_config_prefix/bin/systemctl" ]]; then
    timeout --kill-after=10s 60s systemctl --user stop "$managed_unit" || result=1
    assert_manager_inactive || result=1
  fi
  if [[ -n "$registry_pid" ]]; then
    kill "$registry_pid" 2>/dev/null || true
    wait "$registry_pid" 2>/dev/null || true
  fi
  printf 'phase=%s exit=%s\n' "$phase" "$result"
  if [[ "$result" != 0 ]]; then printf '[sentinel-installed-proof] FAILED (exit %s)\n' "$result" >&2; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
source scripts/e2e/lib/prepublish-plugin-registry.sh
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
for (const [file, hash] of [
  ['scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh', 'de8aa7b0a2c720e523ad314a53be85865966e4cce9b178bbf41b3301f65ee5ab'],
  ['scripts/e2e/lib/upgrade-survivor/systemd-fixture.mjs', '62d361939344871838d764670f38533e97f65664ebae5683bf7cfe147bfa8f73'],
]) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash);
NODE
source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh

run_cli() {
  local name="$1"
  shift
  phase="$name"
  timeout --kill-after=10s 600s openclaw "$@" >"$PROOF_ROOT/$name.json" 2>"$PROOF_ROOT/$name.err"
}

phase=published-install
node --version
npm --version
mkdir "$HOME/baseline"
(
  cd "$HOME/baseline"
  timeout --kill-after=10s 300s npm pack openclaw@2026.9.4 --json >"$PROOF_ROOT/published-pack.json"
  node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const [pack] = JSON.parse(fs.readFileSync('/proof/published-pack.json', 'utf8'));
assert.equal(pack.version, '2026.9.4');
const expected = 'sha512-lTQpEEe1Xm3u2PCHaPEr+vP8paGk1vLdHuzdItsNToaLI6hAqRVvgJYg+GxukJhETJp4tPy/S1Gftl4KuB8n7A==';
assert.equal(pack.integrity, expected);
assert.equal(`sha512-${crypto.createHash('sha512').update(fs.readFileSync(pack.filename)).digest('base64')}`, expected);
assert.equal(pack.filename, 'openclaw-2026.9.4.tgz');
NODE
  timeout --kill-after=10s 600s npm install -g ./openclaw-2026.9.4.tgz >"$PROOF_ROOT/published-install.log" 2>&1
)
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = process.env.INSTALLED_ROOT;
assert.equal(JSON.parse(fs.readFileSync(`${root}/package.json`)).version, '2026.9.4');
assert.equal(fs.realpathSync(`${process.env.npm_config_prefix}/bin/openclaw`), `${root}/openclaw.mjs`);
fs.copyFileSync(`${root}/dist/build-info.json`, '/proof/published-build-info.json');
fs.writeFileSync(`${process.env.CALLER_STATE}/openclaw.json`, JSON.stringify({gateway: {mode: 'local', auth: {mode: 'token', token: 'disposable-sentinel-proof'}}, plugins: {enabled: false}}));
NODE

# The published driver first updates its ordinary canonical state and generated unit.
run_cli caller-doctor doctor --fix --non-interactive
install_update_restart_systemctl_shim
run_cli service-install gateway install --force --json
timeout --kill-after=10s 60s systemctl --user stop "$managed_unit"
assert_manager_inactive
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const a = process.env.CALLER_STATE;
const config = JSON.parse(fs.readFileSync(`${a}/openclaw.json`, 'utf8'));
assert.equal(config.plugins.enabled, false);
assert.deepEqual(Object.keys(config.agents.entries), ['main']);
// This minimal installed cell has no shared legacy-history/unused-agent specimen.
// The separate published survivor failure remains recorded against that migration path.
for (const dir of [`${a}/sessions`, `${a}/agents/main/sessions`]) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, {recursive: true})) {
    assert(!entry.endsWith('sessions.json') && !entry.endsWith('.jsonl'), entry);
  }
}
assert(!fs.existsSync(process.env.SELECTED_STATE));
const unit = fs.readFileSync(`${process.env.HOME}/.config/systemd/user/openclaw-gateway.service`, 'utf8');
assert(unit.includes(`OPENCLAW_STATE_DIR=${a}`));
assert(unit.includes(process.env.INSTALLED_ROOT));
NODE

phase=published-to-candidate
run_cli first-hop update --tag file:/candidate/openclaw-current.tgz --yes --no-restart --json
assert_manager_inactive
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const installed = json(`${process.env.INSTALLED_ROOT}/dist/build-info.json`);
const expected = json('/candidate/expected-build-info.json');
assert.equal(installed.commit, process.env.CANDIDATE_SOURCE);
assert(installed.buildId);
assert.equal(installed.buildId, expected.buildId);
assert.notEqual(installed.buildId, json('/proof/published-build-info.json').buildId);
fs.writeFileSync('/proof/installed-build-info.json', JSON.stringify(installed));
const text = fs.readFileSync('/proof/first-hop.json', 'utf8');
assert.equal(JSON.parse(text.slice(text.indexOf('{'))).status, 'ok');
NODE

# Adapt only task-created manager fixtures to the canonical named-profile identity.
# The real installed candidate writes B's unit; never rewrite its selectors or argv.
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const dir = `${process.env.npm_config_prefix}/bin`;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const changes = [];
for (const [name, replacements] of [
  ['systemctl', [['openclaw-gateway.service', 'openclaw-gateway-service.service', 13]]],
  ['systemd-fixture.mjs', [['openclaw-gateway.service', 'openclaw-gateway-service.service', 1], ['openclaw_2dgateway_2eservice', 'openclaw_2dgateway_2dservice_2eservice', 1]]],
]) {
  const file = `${dir}/${name}`;
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && stat.uid === process.getuid());
  const before = fs.readFileSync(file, 'utf8');
  if (name.endsWith('.mjs')) assert.equal(hash(before), '62d361939344871838d764670f38533e97f65664ebae5683bf7cfe147bfa8f73');
  let after = before;
  for (const [from, to, count] of replacements) {
    assert.equal(after.split(from).length - 1, count);
    after = after.replaceAll(from, to);
  }
  fs.writeFileSync(file, after);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  changes.push({name, before: hash(before), after: hash(after), replacements});
}
fs.writeFileSync('/proof/manager-adaptation.json', JSON.stringify(changes));
fs.mkdirSync(process.env.SELECTED_STATE);
fs.writeFileSync(`${process.env.SELECTED_STATE}/openclaw.json`, JSON.stringify({gateway: {mode: 'local', auth: {mode: 'token', token: 'disposable-sentinel-proof'}}, plugins: {enabled: false}}));
NODE
managed_unit=openclaw-gateway-service.service
OPENCLAW_PROFILE=service OPENCLAW_STATE_DIR="$SELECTED_STATE" OPENCLAW_CONFIG_PATH="$SELECTED_STATE/openclaw.json" \
  run_cli selected-doctor doctor --fix --non-interactive
OPENCLAW_PROFILE=service OPENCLAW_STATE_DIR="$SELECTED_STATE" OPENCLAW_CONFIG_PATH="$SELECTED_STATE/openclaw.json" \
  run_cli selected-install gateway install --force --json
timeout --kill-after=10s 60s systemctl --user stop "$managed_unit"
assert_manager_inactive
systemctl --user daemon-reload
node "$npm_config_prefix/bin/systemd-fixture.mjs" command >"$PROOF_ROOT/loaded-command.txt"
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const unit = `${process.env.HOME}/.config/systemd/user/openclaw-gateway-service.service`;
const definition = fs.readFileSync(unit, 'utf8');
assert.equal(fs.readFileSync(`${unit}.loaded-unit`, 'utf8'), definition);
fs.writeFileSync('/proof/loaded-unit.service', definition);
const command = fs.readFileSync('/proof/loaded-command.txt', 'utf8');
for (const value of ['OPENCLAW_PROFILE=service', `OPENCLAW_STATE_DIR=${process.env.SELECTED_STATE}`, `OPENCLAW_CONFIG_PATH=${process.env.SELECTED_STATE}/openclaw.json`, 'OPENCLAW_SYSTEMD_UNIT=openclaw-gateway-service.service', process.env.INSTALLED_ROOT]) assert(command.includes(value), value);
assert.equal(process.env.OPENCLAW_PROFILE, undefined);
assert.equal(process.env.OPENCLAW_STATE_DIR, process.env.CALLER_STATE);
NODE
export OPENCLAW_SYSTEMD_UNIT="$managed_unit"

candidate_version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.INSTALLED_ROOT + "/package.json")).version')"
openclaw_prepublish_plugin_registry_start "" "$CANDIDATE_SOURCE" "$candidate_version" "" \
  "$HOME/registry" registry_pid openclaw "$candidate_version" /candidate/openclaw-current.tgz

# The old parent may have written a notice. Preserve it, then establish the second invocation's specimen.
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = (state) => new DatabaseSync(`${state}/state/openclaw.sqlite`);
const a = db(process.env.CALLER_STATE), b = db(process.env.SELECTED_STATE);
const rows = (store) => store.prepare('SELECT * FROM gateway_restart_sentinel ORDER BY sentinel_key').all();
fs.writeFileSync('/proof/first-hop-notices.json', JSON.stringify({caller: rows(a), selected: rows(b)}));
a.prepare('DELETE FROM gateway_restart_sentinel').run();
b.prepare('DELETE FROM gateway_restart_sentinel').run();
const payload = JSON.stringify({kind: 'restart', status: 'ok', ts: 1, message: 'unrelated caller notice'});
a.prepare("INSERT INTO gateway_restart_sentinel (sentinel_key,version,kind,status,ts,message,payload_json,updated_at_ms) VALUES ('current',1,'restart','ok',1,'unrelated caller notice',?,1)").run(payload);
const baseline = {caller: rows(a), callerRuns: a.prepare('SELECT run_id FROM update_runs ORDER BY run_id').all(), selectedRuns: b.prepare('SELECT run_id FROM update_runs ORDER BY run_id').all()};
assert.equal(baseline.caller.length, 1);
fs.writeFileSync('/proof/before-noop.json', JSON.stringify(baseline));
a.close(); b.close();
NODE

# A new installed candidate process must adopt B from the loaded unit and restore A before publishing.
manager_lines="$(wc -l <"$npm_config_prefix/bin/systemctl-shim.log")"
run_cli candidate-noop update --tag "$candidate_version" --yes --no-restart --json
assert_manager_inactive
if tail -n +"$((manager_lines + 1))" "$npm_config_prefix/bin/systemctl-shim.log" | grep -E -- '--user (start|restart) '; then
  echo 'Gateway activation would invalidate the no-consumer observation.' >&2
  exit 1
fi
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const plain = value => JSON.parse(JSON.stringify(value));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const text = fs.readFileSync('/proof/candidate-noop.json', 'utf8');
const result = JSON.parse(text.slice(text.indexOf('{')));
assert.equal(result.status, 'skipped');
assert.equal(result.reason, 'already-current');
assert.deepEqual(result.steps, []);
assert(!result.nextAction);
assert(result.runId);
const a = new DatabaseSync(`${process.env.CALLER_STATE}/state/openclaw.sqlite`, {readOnly: true});
const b = new DatabaseSync(`${process.env.SELECTED_STATE}/state/openclaw.sqlite`, {readOnly: true});
const before = json('/proof/before-noop.json');
assert.deepEqual(plain(a.prepare('SELECT * FROM gateway_restart_sentinel ORDER BY sentinel_key').all()), before.caller);
assert.deepEqual(plain(a.prepare('SELECT run_id FROM update_runs ORDER BY run_id').all()), before.callerRuns);
assert.deepEqual(b.prepare('SELECT * FROM gateway_restart_sentinel').all(), []);
const run = b.prepare('SELECT run_id, trigger, status, phase, reason FROM update_runs WHERE run_id=?').get(result.runId);
assert(run);
assert.equal(run.trigger, 'cli');
assert.equal(run.phase, 'finished');
assert(['succeeded', 'skipped'].includes(run.status));
const newRuns = b.prepare('SELECT run_id FROM update_runs ORDER BY run_id').all().filter(row => !before.selectedRuns.some(old => old.run_id === row.run_id));
assert.deepEqual(plain(newRuns), [{run_id: result.runId}]);
const control = new DatabaseSync('/tmp/openclaw/managed-update-handoffs.sqlite', {readOnly: true});
assert.deepEqual(control.prepare('SELECT * FROM managed_update_handoffs').all(), []);
const installed = json(`${process.env.INSTALLED_ROOT}/dist/build-info.json`);
assert.deepEqual(installed, json('/proof/installed-build-info.json'));
assert.equal(fs.readFileSync(`${process.env.HOME}/.config/systemd/user/openclaw-gateway-service.service.loaded-unit`, 'utf8'), fs.readFileSync('/proof/loaded-unit.service', 'utf8'));
a.close(); b.close(); control.close();
fs.writeFileSync('/proof/result.json', JSON.stringify({status: 'passed', source: process.env.CANDIDATE_SOURCE, buildId: installed.buildId, run, callerNoticeUnchanged: true, selectedNoticeAbsent: true, executorLeaseAbsent: true, manager: 'existing loaded-unit fixture; inactive during observation'}));
console.log('PASS: installed candidate adopted B; caller A notice/revision unchanged; B notice absent; lease absent.');
NODE
phase=complete
