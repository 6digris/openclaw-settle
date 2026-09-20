import { fstatSync } from "node:fs";
import { runMacCookieImport } from "./src/browser/mac-cookie-import.js";

async function main() {
  // Transport guard, not caller authentication: this unprivileged local Node
  // entry uses the same OS-user/Keychain boundary as the existing producer.
  // The app supplies private pipes; never create a listener or terminal/file export.
  if (!fstatSync(0).isFIFO() || !fstatSync(1).isFIFO() || process.platform !== "darwin") {
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    process.stdin.destroy();
  };
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const deadline = setTimeout(abort, 120_000);
  try {
    await runMacCookieImport({
      input: process.stdin,
      signal: controller.signal,
      write: (data) =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(data, (error) => (error ? reject(error) : resolve()));
        }),
    });
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}
void main().catch(() => {
  process.exitCode = 1;
});
