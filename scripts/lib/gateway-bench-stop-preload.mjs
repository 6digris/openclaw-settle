// The benchmark owns this IPC channel; Gateway's existing SIGINT handler owns cleanup.
const owner = new URL(import.meta.url);
if (
  process.send &&
  process.ppid === Number(owner.searchParams.get("parentPid")) &&
  process.argv[1] === owner.searchParams.get("entry")
) {
  process.on("message", function stop(message) {
    if (message !== "openclaw-startup-benchmark:stop") {
      return;
    }
    process.off("message", stop);
    process.channel?.ref();
    const accepted = process.listenerCount("SIGINT") > 0;
    void import("node:module").then(({ getCompileCacheDir }) => {
      process.send(
        {
          type: "openclaw-startup-benchmark:stopping",
          accepted,
          compileCacheDir: getCompileCacheDir() ?? null,
        },
        () => {
          process.channel?.unref();
          if (accepted) {
            if (owner.searchParams.get("signalListeners") === "1") {
              try {
                const { createHash } = process.getBuiltinModule("node:crypto");
                const listeners = process.listeners("SIGINT");
                const rawListeners = process.rawListeners("SIGINT");
                process.send(
                  {
                    type: "openclaw-startup-benchmark:signal-listeners",
                    signal: "SIGINT",
                    pid: process.pid,
                    listenerCount: listeners.length,
                    truncated: listeners.length > 64,
                    listeners: listeners.slice(0, 64).map((listener, index) => ({
                      index,
                      name: listener.name.slice(0, 128),
                      once: rawListeners[index] !== listener,
                      sha256: createHash("sha256")
                        .update(Function.prototype.toString.call(listener))
                        .digest("hex"),
                    })),
                  },
                  () => {},
                );
              } catch {
                // Missing diagnostic delivery stays unknown; it must not prevent normal dispatch.
              }
            }
            process.emit("SIGINT");
          }
        },
      );
    });
  });
  process.channel?.unref();
}
