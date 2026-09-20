import { expect, test, vi } from "vitest";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  type setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

/** These cases share the creating suite's Gateway, mocks, and per-test cleanup. */
export function registerSessionCreateInitialInputCases(params: {
  createSessionStoreDir: ReturnType<
    typeof setupGatewaySessionsTestHarness
  >["createSessionStoreDir"];
  chatSendOwner: typeof import("./server-methods/chat-send-external-entry.js");
}): void {
  const { createSessionStoreDir, chatSendOwner } = params;
  test("sessions.create forwards an attachment-only first turn", async () => {
    await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "main", default: true }] };
    const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
    chatSend.mockImplementation(async ({ respond }) => {
      respond(true, { runId: "attachment-run", status: "started" });
    });
    const attachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "pixel.png",
      content:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
    };

    try {
      const created = await directSessionReq<{ runStarted?: boolean; runId?: string }>(
        "sessions.create",
        { agentId: "main", message: "", attachments: [attachment] },
      );

      expect(created.ok).toBe(true);
      expect(created.payload).toMatchObject({ runStarted: true, runId: "attachment-run" });
      expect(chatSend.mock.calls[0]?.[0].params).toMatchObject({
        message: "",
        attachments: [attachment],
      });
    } finally {
      chatSend.mockRestore();
    }
  });

  test("sessions.create rejects unusable attachment-only input before creating a session", async () => {
    await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "main", default: true }] };

    const created = await directSessionReq("sessions.create", {
      agentId: "main",
      attachments: [null],
    });

    expect(created.ok).toBe(false);
    expect(created.error?.message).toContain("must be object");
    const listed = await directSessionReq<{ sessions?: unknown[] }>("sessions.list", {});
    expect(listed.payload?.sessions).toEqual([]);
  });

  test("sessions.create rejects replacing its parent key", async () => {
    await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "main", default: true }] };
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-parent-task") } });

    const created = await directSessionReq("sessions.create", {
      key: "main",
      parentSessionKey: "agent:main:main",
      emitCommandHooks: true,
      task: "hello after replacing parent",
    });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "sessions.create key must differ from parentSessionKey",
    });
  });
}
