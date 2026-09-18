import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { PluginsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";

type SourceArgs = readonly [
  ApplicationContext["gateway"] | null,
  GatewayBrowserClient | null,
  number,
  number,
  boolean,
];
type SourceResult = {
  gateway: ApplicationContext["gateway"];
  client: GatewayBrowserClient;
  epoch: number;
  accessRevision: number;
  installedIds: Set<string>;
};

export class SessionSourcePluginsController implements ReactiveController {
  private accessRevision = 0;
  private readonly task: Task<SourceArgs, SourceResult | null>;

  constructor(
    host: ReactiveControllerHost,
    private readonly connection: GatewayPageController,
    active: () => boolean,
  ) {
    this.task = new Task(host, {
      args: () =>
        [
          connection.gateway,
          this.readClient(),
          connection.epoch,
          this.accessRevision,
          active(),
        ] as const,
      task: async ([gateway, client, epoch, accessRevision, visible], { signal }) => {
        if (!gateway || !client) {
          return null;
        }
        // Leaving Appearance retires its read, but not the same-connection result.
        if (!visible) {
          return initialState;
        }
        const result = await client.request<PluginsListResult>("plugins.list", {}, { signal });
        return {
          gateway,
          client,
          epoch,
          accessRevision,
          installedIds: new Set(
            result.plugins.filter((plugin) => plugin.installed).map((plugin) => plugin.id),
          ),
        };
      },
    });
    host.addController(this);
  }

  get installedIds(): ReadonlySet<string> | null {
    const value = this.task.value;
    return value &&
      value.accessRevision === this.accessRevision &&
      value.gateway === this.connection.gateway &&
      value.client === this.readClient() &&
      this.connection.isCurrent(value)
      ? value.installedIds
      : null;
  }

  get loading(): boolean {
    return this.task.status === TaskStatus.PENDING;
  }

  synchronizeAccess() {
    // Capability loss must retire a read even if access returns before the next render.
    if (!this.readClient()) {
      this.accessRevision += 1;
      void this.task.run([null, null, this.connection.epoch, this.accessRevision, false]);
    }
  }

  hostDisconnected() {
    void this.task.run([null, null, this.connection.epoch, this.accessRevision, false]);
  }

  private readClient(): GatewayBrowserClient | null {
    return canCallGatewayMethod(this.connection.snapshot, "plugins.list", "operator.read")
      ? this.connection.client
      : null;
  }
}
