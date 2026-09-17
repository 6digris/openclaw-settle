import { html } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export function renderExternalLinkIndicator() {
  return html`<span class="external-link-indicator"
    ><span role="img" aria-label=${t("common.opensInNewTab")}>${icons.arrowUpRight}</span></span
  >`;
}
