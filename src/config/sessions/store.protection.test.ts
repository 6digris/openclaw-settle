import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function isProtectedSessionMaintenanceEntry(key: string, entry: SessionEntry | undefined): boolean {
  return shouldPreserveMaintenanceEntry({ key, entry });
}

describe("isProtectedSessionMaintenanceEntry", () => {
  it.each([
    ["agent:main:main", true],
    ["agent:worker:main", true],
    ["global", true],
    ["agent:main:global", true],
    ["agent:main:opaque", false],
  ])("classifies primary session key %s as protected=%s", (key, expected) => {
    expect(isProtectedSessionMaintenanceEntry(key, makeEntry(Date.now()))).toBe(expected);
  });

  it("treats generated ACP bridge sessions as disposable", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:acp-bridge:session-1", {
        ...makeEntry(Date.now()),
        chatType: "group",
      }),
    ).toBe(false);
  });

  it("does not protect synthetic sessions just because they carry group metadata", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:subagent:worker", {
        ...makeEntry(Date.now()),
        chatType: "group",
      }),
    ).toBe(false);
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:cron:job:run:123", {
        ...makeEntry(Date.now()),
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "group:test" },
          origin: { chatType: "group" },
        }),
      }),
    ).toBe(false);
  });

  it("protects metadata-less Telegram topic keys without treating every :topic: id as a thread", () => {
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:telegram:group:-100123:topic:77",
        makeEntry(Date.now()),
      ),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:opaque:topic:om_topic_root:sender:ou_topic_user",
        makeEntry(Date.now()),
      ),
    ).toBe(false);
  });

  it("protects metadata-less channel session keys and channel chat metadata", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:slack:channel:C123", makeEntry(Date.now())),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:custom:channel:room-one:with:colon",
        makeEntry(Date.now()),
      ),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:opaque", {
        ...makeEntry(Date.now()),
        chatType: "channel",
      }),
    ).toBe(true);
  });
});
