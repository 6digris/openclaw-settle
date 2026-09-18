import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import {
  createNativeChromeSetupCapability,
  type NativeChromeSetupCapability,
  type NativeChromeExtensionSetupAction,
  type NativeChromeExtensionSetupResult,
} from "../app/native-chrome-setup.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { renderChromeSetupStatus } from "./chrome-setup-status.ts";
import "./native-chrome-setup.css";

class NativeChromeSetup extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;
  @state() private running = false;
  @state() private failed = false;
  @state() private result: NativeChromeExtensionSetupResult | null = null;
  private desktopCapability: NativeChromeSetupCapability | null = null;
  private generation = 0;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.nativeDeviceSettings,
      (capability, notify) => capability.subscribe(notify),
    )
    .effect(
      () => this.context?.nativeDeviceSettings,
      () => () => this.reset(),
    );

  override connectedCallback() {
    this.desktopCapability = createNativeChromeSetupCapability();
    super.connectedCallback();
  }
  override disconnectedCallback() {
    this.reset();
    this.desktopCapability?.dispose();
    this.desktopCapability = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }
  private get capability() {
    // The Mac app's existing context owns its device-settings transport.
    const mac = this.context?.nativeDeviceSettings;
    return mac?.snapshot?.device.platform === "macos" ? mac : this.desktopCapability;
  }
  private reset() {
    this.generation += 1;
    this.running = false;
    this.failed = false;
    this.result = null;
  }
  private async setup(action: NativeChromeExtensionSetupAction) {
    const capability = this.capability;
    if (!this.isConnected || !capability || this.running) {
      return;
    }
    const generation = ++this.generation;
    const isCurrent = () =>
      this.isConnected && this.capability === capability && this.generation === generation;
    this.running = true;
    this.failed = false;
    this.result = null;
    try {
      const result = await capability.setupChromeExtension(action);
      if (isCurrent()) {
        this.result = result;
      }
    } catch {
      if (isCurrent()) {
        this.failed = true;
      }
    } finally {
      if (isCurrent()) {
        this.running = false;
      }
    }
  }
  override render() {
    if (!this.capability) {
      return nothing;
    }
    return html`
      <div class="native-chrome-setup">
        <p>${t("configPage.deviceSettings.chromeExtensionHint")}</p>
        <div class="native-chrome-setup__actions">
          ${(
            [
              ["install", "chromeExtensionSetup"],
              ["inspect", "chromeExtensionRefresh"],
              ["verify", "chromeExtensionVerify"],
            ] as const
          ).map(
            ([action, label]) => html`
              <button
                type="button"
                class="btn"
                ?disabled=${this.running}
                @click=${() => this.setup(action)}
              >
                ${t(`configPage.deviceSettings.${label}`)}
              </button>
            `,
          )}
        </div>
        ${renderChromeSetupStatus({ result: this.result, running: this.running, failed: this.failed })}
      </div>
    `;
  }
}
if (!customElements.get("openclaw-native-chrome-setup")) {
  customElements.define("openclaw-native-chrome-setup", NativeChromeSetup);
}
