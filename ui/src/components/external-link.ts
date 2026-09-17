import { html, nothing, unsafeCSS, type AttributePart } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { t } from "../i18n/index.ts";
import {
  externalLinkOpensInPanel,
  subscribeExternalLinkPresentation,
} from "../lib/external-link-presentation.ts";
import { isExternalLinkHref } from "../lib/external-link.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { renderExternalLinkIndicator } from "./external-link-indicator.ts";
import indicatorStyles from "./external-link-indicator.css?inline";

class ExternalLinkIndicator extends OpenClawLitElement {
  private unsubscribe?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = subscribeExternalLinkPresentation(() => this.requestUpdate());
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    super.disconnectedCallback();
  }

  static override styles = unsafeCSS(indicatorStyles);

  protected override render() {
    const anchor = this.closest("a");
    const panel = anchor && externalLinkOpensInPanel(anchor);
    const label = this.getAttribute("data-label");
    // Sanitized Markdown has no Lit attribute binding; its indicator owns this name projection.
    if (anchor && label !== null) {
      anchor.setAttribute("aria-label", panel ? label : renderExternalLinkAccessibleName(label));
    }
    if (panel || this.hasAttribute("data-icon-only")) {
      return nothing;
    }
    return renderExternalLinkIndicator();
  }
}

if (!customElements.get("openclaw-external-link")) {
  customElements.define("openclaw-external-link", ExternalLinkIndicator);
}

export function renderExternalLinkLabel(label: unknown, href?: string, announce = true): unknown {
  return href !== undefined && !isExternalLinkHref(href)
    ? label
    : html`<span class="external-link-label"
        >${label}<openclaw-external-link
          aria-hidden=${announce ? "false" : "true"}
        ></openclaw-external-link
      ></span>`;
}

export function renderExternalLinkAccessibleName(label: string): string {
  return `${label} (${t("common.opensInNewTab")})`;
}

class ExternalLinkAriaLabel extends AsyncDirective {
  private anchor?: HTMLAnchorElement;
  private label = "";
  private unsubscribe?: () => void;

  override update(part: AttributePart, [label]: [string]) {
    this.anchor = part.element instanceof HTMLAnchorElement ? part.element : undefined;
    this.label = label;
    if (this.isConnected && !this.unsubscribe) {
      this.reconnected();
    }
    return this.render(label);
  }

  render(label: string) {
    return this.anchor && externalLinkOpensInPanel(this.anchor)
      ? label
      : renderExternalLinkAccessibleName(label);
  }

  protected override disconnected() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  protected override reconnected() {
    this.unsubscribe = subscribeExternalLinkPresentation(() =>
      this.setValue(this.render(this.label)),
    );
    this.setValue(this.render(this.label));
  }
}

export const externalLinkAriaLabel = directive(ExternalLinkAriaLabel);
