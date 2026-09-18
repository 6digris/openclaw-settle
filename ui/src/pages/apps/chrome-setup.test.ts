/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createChromeExtensionSetupResult } from "../../test-helpers/chrome-extension-setup.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { renderApps } from "./view.ts";

type SetupElement = HTMLElement & { updateComplete: Promise<boolean> };
const result = createChromeExtensionSetupResult;
function bridge(postMessage: (message: { action: string }) => Promise<unknown>) {
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: { messageHandlers: { openclawChromeSetup: { postMessage } } },
  });
}
async function mount(nativeDeviceSettings: ApplicationContext["nativeDeviceSettings"] = null) {
  const host = createApplicationContextProvider({ nativeDeviceSettings } as ApplicationContext);
  render(renderApps({ onNavigate: vi.fn() }), host);
  document.body.append(host);
  const setup = host.querySelector<SetupElement>("openclaw-native-chrome-setup")!;
  await setup.updateComplete;
  return { host, setup, card: setup.closest(".apps-card")! };
}
function click(setup: HTMLElement, label: string) {
  const button = [...setup.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button!.click();
}
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "webkit");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_DEVICE_SETTINGS__");
  vi.restoreAllMocks();
});

describe("Apps local Chrome setup", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "uses explicit native actions and canonical %s replies",
    async (platform) => {
      const post = vi.fn(async ({ action }: { action: string }) =>
        result({
          action: action as "inspect" | "install" | "verify",
          target: {
            kind: "local-host",
            platform,
            hostname: "Example desktop",
            profile: "chrome",
            relayPort: 18792,
          },
          ...(action === "verify"
            ? ({ phase: "ready", connection: { state: "connected" }, nextAction: "none" } as const)
            : {}),
        }),
      );
      bridge(post);
      const { setup, card } = await mount();
      window.dispatchEvent(new Event("focus"));
      expect(post).not.toHaveBeenCalled();
      expect(card.textContent).toContain("This does not install on a remote Gateway");
      click(setup, "Refresh setup status");
      await vi.waitFor(() => expect(setup.textContent).toContain("Setup required on this device."));
      expect(post.mock.calls).toEqual([[{ action: "inspect" }]]);
      click(setup, "Set up Chrome on this device");
      await setup.updateComplete;
      await vi.waitFor(() => expect(setup.querySelector("button")!.disabled).toBe(false));
      click(setup, "Verify connection");
      await vi.waitFor(() =>
        expect(setup.textContent).toContain("Extension connected on this device."),
      );
      expect(setup.textContent).toContain("Example desktop");
      expect(setup.textContent).toContain("does not mean eligible tabs");
      expect(post.mock.calls).toEqual(
        ["inspect", "install", "verify"].map((action) => [{ action }]),
      );
    },
  );
  it("keeps only Store and docs in an ordinary browser", async () => {
    const { card, setup } = await mount();
    expect(setup.querySelector("button")).toBeNull();
    expect([...card.querySelectorAll("a")].map((a) => a.href)).toEqual([
      "https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig",
      "https://docs.openclaw.ai/tools/chrome-extension",
    ]);
  });
  it("uses the existing Mac device-settings context without a desktop handler", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    const post = vi.fn(async (message: { type: string; action?: string }) =>
      message.type === "chrome-extension-setup" ? result({ action: "inspect" }) : snapshot,
    );
    Object.assign(window, { __OPENCLAW_NATIVE_DEVICE_SETTINGS__: snapshot });
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { openclawDeviceSettings: { postMessage: post } } },
    });
    const capability = createNativeDeviceSettingsCapability()!;
    try {
      const { setup } = await mount(capability);
      expect(post.mock.calls.filter(([m]) => m.type === "chrome-extension-setup")).toEqual([]);
      click(setup, "Refresh setup status");
      await vi.waitFor(() => expect(setup.textContent).toContain("Example Mac"));
      expect(post).toHaveBeenCalledWith({ type: "chrome-extension-setup", action: "inspect" });
    } finally {
      capability.dispose();
    }
  });
  it("discards a pending reply after detach/remount and preserves newer intent", async () => {
    const old = createDeferred<unknown>();
    const post = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(
        result({
          action: "verify",
          phase: "ready",
          connection: { state: "connected" },
          nextAction: "none",
        }),
      );
    bridge(post);
    const { setup } = await mount();
    const parent = setup.parentElement!;
    click(setup, "Refresh setup status");
    setup.remove();
    parent.append(setup);
    await setup.updateComplete;
    click(setup, "Verify connection");
    await vi.waitFor(() =>
      expect(setup.textContent).toContain("Extension connected on this device."),
    );
    old.resolve(result());
    await old.promise;
    await setup.updateComplete;
    expect(setup.textContent).toContain("Extension connected on this device.");
    expect(setup.textContent).not.toContain("Setup required");
  });
  it("rejects replies from a replaced native handler", async () => {
    const pending = createDeferred<unknown>();
    bridge(() => pending.promise);
    const { setup } = await mount();
    click(setup, "Refresh setup status");
    const replacement = vi.fn();
    bridge(replacement);
    pending.resolve(result());
    await vi.waitFor(() => expect(setup.textContent).toContain("Setup could not finish"));
    expect(setup.textContent).not.toContain("Example Mac");
    click(setup, "Set up Chrome on this device");
    await setup.updateComplete;
    await vi.waitFor(() => expect(setup.querySelector("button")!.disabled).toBe(false));
    expect(replacement).not.toHaveBeenCalled();
  });
  it.each([
    { action: "verify" },
    {
      target: {
        kind: "local-host",
        platform: "android",
        hostname: "Example",
        profile: "chrome",
        relayPort: 18792,
      },
    },
    {
      target: {
        kind: "local-host",
        platform: "linux",
        hostname: "Example",
        profile: "other",
        relayPort: 18792,
      },
    },
    {
      target: {
        kind: "local-host",
        platform: "linux",
        hostname: "Example",
        profile: "chrome",
        relayPort: 0,
      },
    },
    { phase: "unknown" },
    { connection: { state: "unknown" } },
  ])("rejects malformed or mismatched replies %j", async (patch) => {
    bridge(async () => ({ ...result(), ...patch }));
    const { setup } = await mount();
    click(setup, "Refresh setup status");
    await vi.waitFor(() => expect(setup.textContent).toContain("Setup could not finish"));
    expect(setup.textContent).not.toContain("Host:");
  });
});
