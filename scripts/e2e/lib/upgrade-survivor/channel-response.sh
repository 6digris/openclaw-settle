#!/usr/bin/env bash
# Task-scoped fixed-artifact extension; never a standalone host runner.
# Call channel_response_prepare after baseline-sibling-runtime; channel_response_turn baseline
# before update_candidate; channel_response_turn candidate after candidate-sibling-runtime.
# The existing Docker/state/update owners remain authoritative.
channel_response_prepare() {
  [ "$baseline_spec" = openclaw@2026.9.4 ] && [ "$UPDATE_RESTART_MODE" = manual ] &&
    [ "$ROOT_MANAGED_VPS" = 0 ] && [ "$LIVE_OPENAI" = 0 ] || return 1
  [ -f /.dockerenv ] || { echo 'Requires the isolated Docker fixture' >&2; return 1; }
  [ "$(sha256sum "${CANDIDATE_SPEC#file:}" | cut -d ' ' -f 1)" = aa9f817a0880ba0792ec9fd6385151ecf19788e94fcdb3108e71ecd2de2a11eb ] || return 1
  unset OPENCLAW_SKIP_CHANNELS OPENCLAW_SKIP_PROVIDERS
  unset DISCORD_BOT_TOKEN TELEGRAM_BOT_TOKEN
  export OPENCLAW_SKIP_CRON=1 OPENCLAW_SKIP_STARTUP_MODEL_PREWARM=1
  export CLICKCLACK_BOT_TOKEN=channel-survival-synthetic-token
  export MOCK_PORT=44210 MOCK_BIND_HOST=127.0.0.1
  export MOCK_REQUEST_LOG="$ARTIFACT_ROOT/channel-model-requests.jsonl"
  export CLICKCLACK_FIXTURE_PORT=44211 CLICKCLACK_FIXTURE_TOKEN="$CLICKCLACK_BOT_TOKEN"
  export CLICKCLACK_FIXTURE_STATE="$ARTIFACT_ROOT/channel-transport.json"
  # Direct children, not command-substitution detached children: existing stop helper can join.
  node scripts/e2e/mock-openai-server.mjs >"$ARTIFACT_ROOT/channel-model.log" 2>&1 &
  mock_openai_pid=$!
  node scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs >"$ARTIFACT_ROOT/channel-transport.log" 2>&1 &
  channel_fixture_pid=$!
  openclaw_e2e_wait_mock_openai "$MOCK_PORT"
  local ready=0
  for _ in $(seq 1 100); do
    if openclaw_e2e_probe_http_status http://127.0.0.1:44211/health 200 >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.1
  done
  [ "$ready" = 1 ] || return 1
  node scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs baseline "$(package_root)"
  node scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs candidate "$(package_root)" "${CANDIDATE_SPEC#file:}"
  node scripts/e2e/lib/upgrade-survivor/channel-response.mjs identities
  node scripts/e2e/lib/release-user-journey/write-clickclack-plugin.mjs "$RUNTIME_ROOT/channel-plugin"
  openclaw_e2e_fixture_plugin_command openclaw -- plugins install "$RUNTIME_ROOT/channel-plugin" --force >"$ARTIFACT_ROOT/channel-install.log" 2>&1
  node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai "$MOCK_PORT"
  node scripts/e2e/lib/release-user-journey/assertions.mjs configure-clickclack http://127.0.0.1:44211
  node scripts/e2e/lib/upgrade-survivor/channel-response.mjs prepare
  openclaw_e2e_fixture_plugin_command openclaw -- plugins enable openai >"$ARTIFACT_ROOT/channel-provider-enable.log" 2>&1
  node scripts/e2e/lib/upgrade-survivor/channel-response.mjs assert-prepared
  node scripts/e2e/lib/upgrade-survivor/channel-response.mjs snapshot
}
channel_response_turn() {
  local stage="$1"
  [ "$stage" = baseline ] || [ "$stage" = candidate ] || return 1
  if [ "$stage" = candidate ]; then
    [ "$update_exit_code" = 0 ] && [ "$update_outcome" = success ] && [ "$update_repair_required" = 0 ] || return 1
    node scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs installed "$(package_root)" "${CANDIDATE_SPEC#file:}"
    node scripts/e2e/lib/upgrade-survivor/channel-response.mjs preserved
  fi
  node scripts/e2e/lib/upgrade-survivor/channel-response.mjs settings "$stage"
  GATEWAY_LOG="$ARTIFACT_ROOT/channel-$stage-gateway.log"
  start_gateway
  node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-socket http://127.0.0.1:44211 45
  CHANNEL_GATEWAY_PID="$gateway_pid" node scripts/e2e/lib/upgrade-survivor/channel-response.mjs turn "$stage"
  stop_gateway
}
channel_response_cleanup() {
  openclaw_e2e_stop_process "${channel_fixture_pid:-}"
  channel_fixture_pid=''
}

channel_response_complete() {
  channel_response_cleanup
  openclaw_e2e_stop_process "$mock_openai_pid"
  mock_openai_pid=''
  CHANNEL_UPDATE_EXIT="$update_exit_code" CHANNEL_UPDATE_OUTCOME="$update_outcome" \
    node scripts/e2e/lib/upgrade-survivor/channel-response.mjs complete
  cat "$ARTIFACT_ROOT/channel-proof.json"
}
