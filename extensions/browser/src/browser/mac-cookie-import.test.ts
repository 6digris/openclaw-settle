import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runMacCookieImport } from "./mac-cookie-import.js";

const profile = { browser: "chrome" as const, id: "Default", name: "Synthetic", hasCookies: true };
const cookie = {
  name: "session",
  value: "synthetic-private-cookie",
  domain: "example.test",
  path: "/",
  secure: true,
  httpOnly: true,
};
async function request(body: unknown, fail = false) {
  const input = new PassThrough();
  const write = vi.fn(async (_data: string) => {});
  const read = vi.fn(async () => {
    if (fail) {
      throw new Error(cookie.value);
    }
    return {
      browser: "chrome" as const,
      systemProfile: "Default",
      cookies: [cookie],
      counts: { total: 1, imported: 1, skipped: 0, failed: 0 },
      domains: ["example.test"],
    };
  });
  input.end(JSON.stringify(body));
  await runMacCookieImport(
    { input, write, signal: new AbortController().signal },
    {
      assertPlatform: () => {},
      list: () => [profile],
      read,
    },
  );
  const frame = write.mock.calls.at(0)?.[0];
  if (!frame) {
    throw new Error("Expected a private reply");
  }
  return { read, result: JSON.parse(frame) };
}
const base = { version: 1, nonce: "00000000-0000-4000-8000-000000000001" };
describe("private Mac cookie import adapter", () => {
  it("discovers through the shared producer without reading credentials", async () => {
    const { result, read } = await request({ ...base, action: "list" });
    expect(result.profiles).toEqual([profile]);
    expect(JSON.stringify(result)).not.toContain(cookie.value);
    expect(read).not.toHaveBeenCalled();
  });
  it("reads only the explicitly selected discovered profile through the shared producer", async () => {
    const { result, read } = await request({
      ...base,
      action: "read",
      browser: "chrome",
      profile: "Default",
    });
    expect(read).toHaveBeenCalledWith({
      browser: "chrome",
      systemProfile: "Default",
      signal: expect.any(AbortSignal),
    });
    expect(result.batch.cookies).toEqual([cookie]);
    expect(result.nonce).toBe(base.nonce);
  });
  it.each(["../Default", "/tmp/Cookies", "Missing"])(
    "rejects undiscovered profile %s before reading",
    async (id) => {
      const { result, read } = await request({
        ...base,
        action: "read",
        browser: "chrome",
        profile: id,
      });
      expect(result.ok).toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("never returns underlying errors containing credentials", async () => {
    const { result } = await request(
      { ...base, action: "read", browser: "chrome", profile: "Default" },
      true,
    );
    expect(result).toEqual({
      version: 1,
      nonce: base.nonce,
      ok: false,
      error: "import-unavailable",
    });
  });
  it("rejects unexpected fields rather than accepting a caller-specified path or destination", async () => {
    const { result, read } = await request({
      ...base,
      action: "read",
      browser: "chrome",
      profile: "Default",
      url: "https://remote.invalid",
    });
    expect(result.ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
