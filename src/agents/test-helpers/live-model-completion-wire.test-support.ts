import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../../llm/types.js";

type CompleteProbe = (
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  timeoutMs: number,
  progress: string,
) => Promise<AssistantMessage>;

/** Test the live sweep's own callback without opting into provider network calls. */
export function registerLiveModelCompletionWireTests(completeProbe: CompleteProbe): void {
  describe("live model probe session wire contract", () => {
    it.each(["openai-completions", "anthropic-messages"] as const)(
      "preserves routing, hooks, and timeout aborts through %s",
      async (api) => {
        const { configureAiTransportRuntimeHost } = await import("../ai-transport-runtime-host.js");
        configureAiTransportRuntimeHost();
        const host = getAiTransportHost();
        const nativeFetch = globalThis.fetch;
        const requests: { path: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
        const signals: AbortSignal[] = [];
        const order: string[] = [];
        const expectedPath = `/zen/go/v1/${api === "anthropic-messages" ? "messages" : "chat/completions"}`;
        const fixtureKey = "local-wire-fixture";
        const serverErrors: unknown[] = [];
        const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          order.push("request");
          requests.push({
            path: request.url ?? "",
            headers: request.headers,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          if (!request.headers["x-opencode-session"]) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { type: "MissingSessionID" } }));
            return;
          }
          if (request.headers["x-fixture-hold"] === "1") {
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (api === "openai-completions") {
            response.end(
              `data: ${JSON.stringify({ id: "wire", object: "chat.completion.chunk", model: "wire-model", choices: [{ index: 0, delta: { content: "WIRE_OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            );
          } else {
            for (const event of [
              {
                type: "message_start",
                message: {
                  id: "wire",
                  type: "message",
                  role: "assistant",
                  model: "wire-model",
                  content: [],
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "WIRE_OK" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ]) {
              response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            response.end();
          }
        };
        const server = createServer((request, response) => {
          void handleRequest(request, response).catch((error: unknown) => {
            serverErrors.push(error);
            response.destroy(error instanceof Error ? error : undefined);
          });
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected loopback HTTP address");
          }
          const localFetch: typeof fetch = async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.origin !== "https://opencode.ai" || url.pathname !== expectedPath) {
              throw new Error(`Unexpected fixture target: ${url.origin}${url.pathname}`);
            }
            signals.push(request.signal);
            return await nativeFetch(
              `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
              {
                method: request.method,
                headers: request.headers,
                body: await request.arrayBuffer(),
                signal: request.signal,
              },
            );
          };
          configureAiTransportHost({ ...host, buildModelFetch: () => localFetch });
          vi.stubGlobal("fetch", localFetch);
          const model: Model = {
            id: "wire-model",
            name: "Wire model",
            provider: "opencode-go",
            api,
            baseUrl:
              api === "anthropic-messages"
                ? "https://opencode.ai/zen/go"
                : "https://opencode.ai/zen/go/v1",
            headers: { "X-Model": "preserved" },
            input: ["text"],
            reasoning: false,
            contextWindow: 4096,
            maxTokens: 128,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
          const context: Context = {
            messages: [{ role: "user", content: "Reply WIRE_OK", timestamp: 1 }],
          };
          for (const testCase of [
            { expected: undefined },
            { expected: "conversation-a", sessionId: "conversation-a" },
            { expected: "conversation-b", sessionId: "conversation-b" },
            { expected: "model-owned", modelHeaders: { "X-OpenCode-Session": "model-owned" } },
            {
              expected: "caller-owned",
              modelHeaders: { "X-OpenCode-Session": "model-owned" },
              headers: { "x-OPENCODE-session": "caller-owned" },
            },
          ]) {
            const target = { ...model, headers: { ...model.headers, ...testCase.modelHeaders } };
            const options: SimpleStreamOptions = {
              apiKey: fixtureKey,
              cacheRetention: "none",
              sessionId: testCase.sessionId,
              headers: { "X-Caller": "preserved", ...testCase.headers },
              onPayload: () => {
                order.push("payload");
              },
              onResponse: () => {
                order.push("response");
              },
            };
            const originalOptions = { ...options, headers: { ...options.headers } };
            const originalModel = { ...target, headers: { ...target.headers } };
            const offset = requests.length;
            for (let invocation = 0; invocation < 2; invocation++) {
              const result = await completeProbe(
                target,
                context,
                options,
                10_000,
                "loopback wire probe",
              );
              expect(requests, result.errorMessage).toHaveLength(offset + invocation + 1);
              const request = requests.at(-1)!;
              expect(request.path.split("?")[0]).toBe(expectedPath);
              expect(request.headers["x-opencode-session"], result.errorMessage).toBeTruthy();
              expect(result.stopReason, result.errorMessage).toBe("stop");
              expect(result.content).toContainEqual(
                expect.objectContaining({ type: "text", text: "WIRE_OK" }),
              );
              expect(request.headers["x-model"]).toBe("preserved");
              expect(request.headers["x-caller"]).toBe("preserved");
              expect(
                request.headers[api === "anthropic-messages" ? "x-api-key" : "authorization"],
              ).toBe(api === "anthropic-messages" ? fixtureKey : `Bearer ${fixtureKey}`);
              expect(request.body).toMatchObject({ model: "wire-model", stream: true });
              expect(JSON.stringify(request.body)).toContain("Reply WIRE_OK");
              expect(request.headers["x-opencode-session"]).toEqual(
                testCase.expected ?? expect.any(String),
              );
            }
            if (!testCase.expected) {
              expect(requests[offset]!.headers["x-opencode-session"]).not.toBe(
                requests[offset + 1]!.headers["x-opencode-session"],
              );
              expect(options.sessionId).toBeUndefined();
            }
            expect(options).toEqual(originalOptions);
            expect(target).toEqual(originalModel);
          }
          expect(order).toEqual(
            Array.from({ length: requests.length }, () => [
              "payload",
              "request",
              "response",
            ]).flat(),
          );

          const beforeAbort = requests.length;
          const onResponse = vi.fn();
          const aborted = await completeProbe(
            model,
            context,
            {
              apiKey: fixtureKey,
              sessionId: "timeout-conversation",
              headers: { "X-Fixture-Hold": "1" },
              onResponse,
            },
            1_000,
            "loopback timeout probe",
          ).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          expect(requests).toHaveLength(beforeAbort + 1);
          expect(requests.at(-1)?.headers["x-opencode-session"]).toBe("timeout-conversation");
          expect(signals.at(-1)?.aborted).toBe(true);
          expect(onResponse).not.toHaveBeenCalled();
          if ("result" in aborted) {
            expect(aborted.result.stopReason).toBe("aborted");
          } else {
            expect(aborted.error).toEqual(new Error("model call timed out after 1000ms"));
          }
          expect(serverErrors).toEqual([]);
        } finally {
          configureAiTransportHost(host);
          vi.unstubAllGlobals();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        }
      },
    );
  });
}
