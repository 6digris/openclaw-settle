import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCreatedSessionCategory } from "./session-create-category.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../session-groups.js", () => ({ ensureSessionGroupRegistered: vi.fn() }));
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));
vi.mock("./sessions-shared.js", () => ({ sessionLog: { warn: vi.fn() } }));

beforeEach(() => vi.resetAllMocks());

describe("created session category owner", () => {
  it("registers and invalidates the committed session owner, including same-name groups", () => {
    const context = {} as GatewayRequestContext;
    vi.mocked(ensureSessionGroupRegistered).mockReturnValue(true);
    registerCreatedSessionCategory("alpha", "Shared", context);
    registerCreatedSessionCategory("beta", "Shared", context);
    expect(vi.mocked(ensureSessionGroupRegistered).mock.calls).toEqual([
      ["alpha", "Shared"],
      ["beta", "Shared"],
    ]);
    expect(emitSessionsChanged).toHaveBeenCalledWith(context, {
      reason: "groups",
      agentId: "alpha",
    });
    expect(emitSessionsChanged).toHaveBeenCalledWith(context, {
      reason: "groups",
      agentId: "beta",
    });
  });

  it("does not register an absent category or invalidate an already registered group", () => {
    const context = {} as GatewayRequestContext;
    registerCreatedSessionCategory("beta", undefined, context);
    expect(ensureSessionGroupRegistered).not.toHaveBeenCalled();
    vi.mocked(ensureSessionGroupRegistered).mockReturnValue(false);
    registerCreatedSessionCategory("beta", "Shared", context);
    expect(emitSessionsChanged).not.toHaveBeenCalled();
  });

  it("does not turn a durable create into a failure when owner catalog bookkeeping fails", () => {
    vi.mocked(ensureSessionGroupRegistered).mockImplementation(() => {
      throw new Error("catalog unavailable");
    });
    expect(() =>
      registerCreatedSessionCategory("beta", "Shared", {} as GatewayRequestContext),
    ).not.toThrow();
    expect(sessionLog.warn).toHaveBeenCalledWith(expect.stringContaining("catalog unavailable"));
  });
});
