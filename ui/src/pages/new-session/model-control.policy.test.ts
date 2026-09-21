/* @vitest-environment jsdom */

import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

const models = [{ id: "permitted", name: "Permitted model", provider: "fixture", available: true }];
const restricted: ModelCatalogResult = {
  models,
  modelSelectionPolicy: { restricted: true, defaultModel: "fixture/permitted" },
};
const agent = { id: "main", model: { primary: "fixture/forbidden-default" } };
const scope = { agentId: "main", timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS };

describe("New Session policy presentation", () => {
  it.each([
    { source: "url", policy: restricted.modelSelectionPolicy },
    { source: "preference", policy: restricted.modelSelectionPolicy },
    { source: "url", policy: { restricted: true as const, defaultModel: null } },
    { source: "url", policy: undefined },
  ])("confirms $source model intent with policy $policy", async ({ source, policy }) => {
    const { context, request } = contextWith(models);
    const wire = createDeferred<ModelCatalogResult>();
    request.mockReturnValue(wire.promise);
    const ready = createDeferred<void>();
    const control = new NewSessionModelControl(() => {
      if (
        renderControl(control, context, "main", agent).querySelector(
          '[data-chat-model-option="fixture/permitted"]',
        )
      ) {
        ready.resolve();
      }
    });
    try {
      control.load(context, "main", true, {
        agent,
        ...(source === "url"
          ? { initialModel: "fixture/forbidden" }
          : { preference: { model: "fixture/forbidden" } }),
      });
      expect(control.modelForSubmission()).toBe("");
      const published = loadModelCatalog(context.gateway.snapshot.client!, scope);
      wire.resolve({ models, modelSelectionPolicy: policy });
      await published;
      await ready.promise;
      expect(control.modelForSubmission()).toBe(policy ? "" : "fixture/forbidden");
      const container = renderControl(control, context, "main", agent);
      if (policy) {
        expect(container.textContent).not.toContain("forbidden");
        expect(control.resolveAgentRuntime()).toBeUndefined();
        if (policy.defaultModel === null) {
          expect(control.modelSelectionBlockedReason(agent)).toBe("Choose a model");
        }
      }
      container
        .querySelector<HTMLButtonElement>('[data-chat-model-option="fixture/permitted"]')
        ?.click();
      expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
    } finally {
      control.reset();
    }
  });

  it.each([
    { event: "config.changed" as const, payload: {}, clearsChoices: true },
    {
      event: "chat.metadata.changed" as const,
      payload: { modelSelectionChanged: true },
      clearsChoices: true,
    },
    { event: "chat.metadata.changed" as const, payload: {}, clearsChoices: false },
  ])(
    "handles $event while replacement fails (clears: $clearsChoices)",
    async ({ event, payload, clearsChoices }) => {
      const { context, request, emitCatalogChanged } = contextWith(models);
      const ready = createDeferred<void>();
      const failed = createDeferred<void>();
      const control = new NewSessionModelControl(() => {
        const container = renderControl(control, context, "main", agent);
        if (container.querySelector('[data-chat-model-option="fixture/permitted"]')) {
          ready.resolve();
        }
        if (container.querySelector('[data-chat-model-catalog-state="error"]')) {
          failed.resolve();
        }
      });
      try {
        control.load(context, "main", true, { agent });
        await loadModelCatalog(context.gateway.snapshot.client!, scope);
        await ready.promise;
        expect(
          renderControl(control, context, "main", agent).querySelector("[data-chat-model-option]"),
        ).not.toBeNull();
        const wire = createDeferred<ModelCatalogResult>();
        request.mockReturnValueOnce(wire.promise);
        emitCatalogChanged(event, payload);
        const container = renderControl(control, context, "main", agent);
        expect(Boolean(container.querySelector("[data-chat-model-option]"))).toBe(!clearsChoices);
        if (clearsChoices) {
          expect(container.textContent).not.toContain("forbidden-default");
          expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
        }
        const published = loadModelCatalog(context.gateway.snapshot.client!, scope);
        wire.reject(new Error("Catalog unavailable"));
        await expect(published).rejects.toThrow("Catalog unavailable");
        await failed.promise;
        expect(
          Boolean(
            renderControl(control, context, "main", agent).querySelector(
              "[data-chat-model-option]",
            ),
          ),
        ).toBe(!clearsChoices);
        expect(control.modelSelectionBlockedReason(agent)).toBe(
          clearsChoices ? "Models unavailable" : undefined,
        );
      } finally {
        control.reset();
      }
    },
  );
});
