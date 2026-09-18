import { retainCommandProcessCleanup } from "../../process/exec-spawn.js";
import { spawnProcess } from "../../process/spawn-utils.js";

/** Probe PATH tools through the scoped process transport without changing their environment. */
export async function commandExists(command: string): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      const child = spawnProcess(command, ["--version"], { stdio: "pipe" });
      // A bounded probe result does not release a late child's cleanup obligation.
      retainCommandProcessCleanup(
        new Promise<void>((resolveClose) => child.once("close", () => resolveClose())),
      );
      let settled = false;
      let outputBytes = 0;
      const finish = (available: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(available);
      };
      const stop = () => {
        if (!settled) {
          child.kill("SIGKILL");
          finish(false);
        }
      };
      const timer = setTimeout(stop, 5_000);
      child.on("error", () => finish(false));
      // A broken installed binary must still permit the download fallback.
      child.once("close", (code) => finish(code === 0));
      child.once("spawn", () => {
        child.stdin?.on("error", stop);
        child.stdin?.end();
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("error", stop);
          stream?.on("data", (chunk: Buffer) => {
            outputBytes += chunk.length;
            // Preserve spawnSync's combined stdout/stderr byte cap.
            if (outputBytes > 1024 * 1024) {
              stop();
            }
          });
        }
      });
    });
  } catch {
    return false;
  }
}
