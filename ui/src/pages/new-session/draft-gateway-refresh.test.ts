import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

describe("draft catalog refresh ownership", () => {
  it.each(["inventory", "cloud"] as const)(
    "coalesces %s and retires its queued refresh on disconnect",
    async (kind) => {
      const first = createDeferred<{ environments: []; profiles: [] }>();
      const trailing = createDeferred<{ environments: []; profiles: [] }>();
      let count = 0;
      const fixture = createDraftFixture({
        methods: ["environments.list"],
        scopes: ["operator.admin", "operator.read", "operator.write"],
        request: async (method) => {
          if (method !== "environments.list") {
            return {};
          }
          count += 1;
          return count === 1 ? first.promise : trailing.promise;
        },
      });
      const refresh = () =>
        kind === "inventory"
          ? fixture.gateway.refreshEnvironments()
          : fixture.gateway.refreshCloudProfiles();
      try {
        const active = refresh();
        const queued = Array.from({ length: 32 }, refresh);
        expect(count).toBe(1);
        first.resolve({ environments: [], profiles: [] });
        await active;
        await Promise.resolve();
        expect(count).toBe(2);
        // Lit retires taskComplete without settling it on initialState; callers fire-and-forget.
        for (let index = 0; index < 8; index += 1) {
          void refresh();
        }
        fixture.gateway.disconnect();
        trailing.resolve({ environments: [], profiles: [] });
        await Promise.all(queued);
        await Promise.resolve();
        expect(count).toBe(2);
        expect(fixture.gateway.connected).toBe(false);
        expect(fixture.gateway.cloudProfilesReady).toBe(kind === "cloud");
        expect(fixture.gateway.deviceCatalogDisabledReason).toBeDefined();
      } finally {
        first.resolve({ environments: [], profiles: [] });
        trailing.resolve({ environments: [], profiles: [] });
        fixture.gateway.disconnect();
      }
    },
  );
});
