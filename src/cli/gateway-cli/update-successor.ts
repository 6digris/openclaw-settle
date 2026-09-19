import type { ChildProcess } from "node:child_process";
import { formatErrorMessage } from "../../infra/errors.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";

export class GatewayUpdateSuccessor {
  private child: ChildProcess | true | null = null;
  private closed: Promise<void> | undefined;
  stopRequested = false;

  constructor(
    private readonly logger: Pick<SubsystemLogger, "info" | "warn" | "error">,
    private readonly lifecycle: Pick<
      typeof import("./lifecycle.runtime.js"),
      | "readRestartSentinelReadOnly"
      | "writeRestartSentinelIfUnchanged"
      | "waitForGatewayHealthyRestart"
    >,
  ) {}

  get committed(): boolean {
    return this.child !== null;
  }

  get running(): boolean {
    const child = this.child;
    return Boolean(
      child && child !== true && child.pid && child.exitCode === null && child.signalCode === null,
    );
  }

  commit(child: ChildProcess | true): void {
    if (this.child === child) {
      return;
    }
    this.child = child;
    if (child !== true) {
      this.closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
    }
  }

  async observeReadiness(
    child: ChildProcess,
    params: {
      port?: number;
      host?: string;
      foreground: boolean;
      beforeWait: () => void;
      isCurrent: () => boolean;
    },
  ): Promise<boolean> {
    const updateSentinel = params.foreground
      ? null
      : await this.lifecycle.readRestartSentinelReadOnly();
    params.beforeWait();
    const health =
      typeof params.port === "number"
        ? await this.lifecycle.waitForGatewayHealthyRestart({
            port: params.port,
            child,
            probeHosts: [params.host ?? "127.0.0.1"],
            requireRunningService: true,
            requirePluginHealth: false,
          })
        : undefined;
    if (
      this.stopRequested ||
      (health?.waitOutcome !== "healthy" && health?.waitOutcome !== "still-starting")
    ) {
      return false;
    }
    this.commit(child);
    if (health.waitOutcome === "still-starting") {
      this.logger.warn("update respawn is still starting; leaving the replacement process running");
      if (
        params.isCurrent() &&
        updateSentinel?.payload.kind === "update" &&
        updateSentinel.payload.status !== "error"
      ) {
        await this.lifecycle
          .writeRestartSentinelIfUnchanged({
            payload: {
              ...updateSentinel.payload,
              status: "skipped",
              continuation: null,
              stats: { ...updateSentinel.payload.stats, reason: "still-starting" },
            },
            expectedRevision: updateSentinel.revision,
            isCurrent: params.isCurrent,
          })
          .catch((error: unknown) =>
            this.logger.warn(
              `failed to record pending update readiness: ${formatErrorMessage(error)}`,
            ),
          );
      }
    }
    return true;
  }

  stop(signal: "SIGINT" | "SIGTERM"): void {
    if (this.stopRequested) {
      return;
    }
    this.stopRequested = true;
    this.logger.info(`received ${signal}; stopping after foreground update settlement`);
    if (this.child && this.child !== true && this.running) {
      try {
        this.child.kill(signal);
      } catch (error) {
        this.logger.warn(`fresh Gateway stop signal failed: ${formatErrorMessage(error)}`);
      }
    }
  }

  async cancel(): Promise<void> {
    const child = this.child;
    if (child && child !== true && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      try {
        child.kill("SIGKILL");
        await exited;
      } catch {}
    }
  }

  async exit(code: number, exitProcess: (code: number) => void): Promise<void> {
    if (this.stopRequested) {
      await this.closed;
    }
    const exitCode = code === 0 && !this.stopRequested && !this.running ? 1 : code;
    if (exitCode !== code) {
      this.logger.error("fresh Gateway stopped before handoff completed; check its startup logs");
    }
    exitProcess(exitCode);
  }
}
