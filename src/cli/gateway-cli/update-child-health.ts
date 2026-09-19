import type { ChildProcess } from "node:child_process";
import net from "node:net";
import { formatErrorMessage } from "../../infra/errors.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";

const UPDATE_RESPAWN_HEALTH_TIMEOUT_MS = 10_000;
const UPDATE_RESPAWN_HEALTH_POLL_MS = 200;

async function waitForGatewayPortReady(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(UPDATE_RESPAWN_HEALTH_POLL_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function waitForHealthyGatewayChild(
  port: number,
  _pid?: number,
  host = "127.0.0.1",
  timeoutMs = UPDATE_RESPAWN_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await waitForGatewayPortReady(host, port)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, UPDATE_RESPAWN_HEALTH_POLL_MS);
    });
  }
  return false;
}

export class GatewayUpdateSuccessor {
  private child: ChildProcess | true | null = null;
  private closed: Promise<void> | undefined;
  stopRequested = false;

  constructor(private readonly logger: Pick<SubsystemLogger, "info" | "warn" | "error">) {}

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
