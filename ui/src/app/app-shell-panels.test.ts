/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalPanelLayout } from "../components/dock-panel-layout.ts";
import { ShellPanelOwner, type ShellPanelHost } from "./app-shell-panels.ts";
import type { ApplicationContext } from "./context.ts";
import {
  LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";

const storageKey = "openclaw.terminal.panel.v1";
let previousLayout: string | null;
let tagId = 0;

beforeEach(() => {
  previousLayout = localStorage.getItem(storageKey);
});

afterEach(() => {
  if (previousLayout === null) {
    localStorage.removeItem(storageKey);
  } else {
    localStorage.setItem(storageKey, previousLayout);
  }
});

function restoredTerminal(open: boolean) {
  terminalPanelLayout.save({ ...terminalPanelLayout.defaults, open });
  let resolveImport!: () => void;
  let rejectImport!: (error: Error) => void;
  const imported = new Promise<void>((resolve, reject) => {
    resolveImport = resolve;
    rejectImport = reject;
  });
  const terminal: OptionalCustomElement = {
    tagName: `test-restored-terminal-${++tagId}`,
    label: "Terminal",
    loadModule: vi.fn(async () => {
      await imported;
      customElements.define(terminal.tagName, class extends HTMLElement {});
    }),
  };
  const unavailablePanel = (name: string): OptionalCustomElement => ({
    tagName: `test-unavailable-${name}-${tagId}`,
    label: name,
    loadModule: vi.fn(async () => {}),
  });
  const requests = new LazyCustomElementRequestController({ requestUpdate: vi.fn() });
  const host: ShellPanelHost = {
    context: {
      config: { current: { terminalEnabled: true } },
      gateway: {
        connection: { gatewayUrl: "ws://localhost:18789" },
        snapshot: {
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["terminal.open"] },
          },
        },
      },
    } as ApplicationContext,
    custodianMinimizeRequestId: 0,
    lazyCustomElements: requests,
    terminalPanelElement: terminal,
    browserPanelElement: unavailablePanel("browser"),
    desktopPanelElement: unavailablePanel("desktop"),
    assistantPanelElement: unavailablePanel("assistant"),
    routeState: { routeId: "chat" } as ShellPanelHost["routeState"],
  };
  const owner = new ShellPanelOwner(host, vi.fn());
  return { owner, host, requests, terminal, resolveImport, rejectImport };
}

describe("restored panel composition", () => {
  it("reserves the saved terminal when availability settles before its module", async () => {
    const { owner, host, terminal, resolveImport } = restoredTerminal(true);
    const config = host.context!.config.current;
    const reservation = () =>
      document.documentElement.style.getPropertyValue("--oc-terminal-reserve-bottom");
    try {
      owner.prepareReservations();
      expect(reservation()).toBe("320px");
      config.terminalEnabled = false;
      owner.restore();
      expect(reservation()).toBe("0px");

      config.terminalEnabled = true;
      owner.prepareReservations();
      owner.restore();
      await vi.waitFor(() => expect(terminal.loadModule).toHaveBeenCalledOnce());
      expect(reservation()).toBe("320px");
      expect(customElements.get(terminal.tagName)).toBeUndefined();
      expect(owner.panelRestorationPending).toBe(true);
    } finally {
      resolveImport();
      await vi.waitFor(() => expect(owner.panelRestorationPending).toBe(false));
      owner.reset();
    }
  });

  it("keeps composition pending until the restored terminal module registers", async () => {
    const { owner, terminal, resolveImport } = restoredTerminal(true);
    owner.restore();
    await vi.waitFor(() => expect(terminal.loadModule).toHaveBeenCalledOnce());
    expect(customElements.get(terminal.tagName)).toBeUndefined();
    expect(owner.panelRestorationPending).toBe(true);

    resolveImport();
    await vi.waitFor(() => expect(owner.panelRestorationPending).toBe(false));
    expect(customElements.get(terminal.tagName)).toBeDefined();
    expect(terminalPanelLayout.load().open).toBe(true);
  });

  it("does not import or gate a terminal saved as closed", async () => {
    const { owner, terminal } = restoredTerminal(false);
    owner.restore();
    await Promise.resolve();
    expect(owner.panelRestorationPending).toBe(false);
    expect(terminal.loadModule).not.toHaveBeenCalled();
    expect(terminalPanelLayout.load().open).toBe(false);
  });

  it("releases composition on import failure and preserves the visible retry error", async () => {
    const { owner, requests, terminal, rejectImport } = restoredTerminal(true);
    owner.restore();
    await vi.waitFor(() => expect(terminal.loadModule).toHaveBeenCalledOnce());
    expect(owner.panelRestorationPending).toBe(true);

    const error = new Error("Terminal module unavailable");
    rejectImport(error);
    await vi.waitFor(() => expect(owner.panelRestorationPending).toBe(false));
    expect(requests.visibleState).toMatchObject({ status: "error", element: terminal, error });
    expect(terminalPanelLayout.load().open).toBe(true);
  });
});
