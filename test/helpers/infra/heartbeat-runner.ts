import { getRuntimeConfigSnapshot } from "../../../src/config/runtime-snapshot.js";
import { startHeartbeatRunner } from "../../../src/infra/heartbeat-runner-scheduler.js";
import {
  acceptSessionEventStoreTestConfig,
  installSessionEventStoreTestConfig,
} from "./session-event-store.js";

/** Mirror the Gateway's accepted-config publication around standalone scheduler fixtures. */
export function installHeartbeatRunnerStoreTestConfig(): typeof startHeartbeatRunner {
  installSessionEventStoreTestConfig();
  return (options) => {
    acceptSessionEventStoreTestConfig(options.cfg ?? getRuntimeConfigSnapshot() ?? {});
    const runner = startHeartbeatRunner(options);
    return {
      stop: runner.stop,
      updateConfig: (cfg) => {
        acceptSessionEventStoreTestConfig(cfg);
        runner.updateConfig(cfg);
      },
    };
  };
}
