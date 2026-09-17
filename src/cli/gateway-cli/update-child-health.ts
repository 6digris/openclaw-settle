import type { ChildProcess } from "node:child_process";
import net from "node:net";

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

export function isRunningGatewayChild(child: ChildProcess | true | null | undefined): boolean {
  return Boolean(
    child && child !== true && child.pid && child.exitCode === null && child.signalCode === null,
  );
}
