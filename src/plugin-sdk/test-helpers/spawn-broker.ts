import type { SpawnBrokerHost } from "../../process/spawn-broker/host.js";

/** Run plugin process tests inside a disposable, ready spawn broker scope. */
export async function withTestSpawnBroker<T>(
  run: (fixture: {
    broker: Pick<SpawnBrokerHost, "spawn" | "spawnExeca">;
    pid: number;
  }) => Promise<T>,
): Promise<T> {
  const [{ createSpawnBrokerHost }, { runWithSpawnBroker }] = await Promise.all([
    import("../../process/spawn-broker/host.js"),
    import("../../process/spawn-broker/context.js"),
  ]);
  const broker = createSpawnBrokerHost();
  try {
    await broker.ready();
    const pid = broker.pid;
    if (pid === undefined) {
      throw new Error("Test spawn broker became ready without a process ID");
    }
    return await runWithSpawnBroker(broker, () => run({ broker, pid }));
  } finally {
    await broker.close();
  }
}
