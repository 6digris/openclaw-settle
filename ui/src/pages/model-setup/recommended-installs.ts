import { html, nothing } from "lit";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { renderExternalLinkLabel } from "../../components/external-link.ts";
import { t } from "../../i18n/index.ts";
import { renderProviderIcon } from "./model-setup-icon-loader.ts";

export function renderRecommendedInstalls(
  props: Parameters<typeof renderProviderIcon>[0],
  result: SystemAgentSetupDetectResult,
) {
  const installs = result.recommendedInstalls ?? [];
  if (
    result.candidates.length > 0 ||
    (result.authOptions?.length ?? 0) > 0 ||
    installs.length === 0
  ) {
    return nothing;
  }
  return html`
    <section class="settings-section model-setup__empty">
      <div class="settings-section__header">
        <h2>${t("modelSetup.empty.title")}</h2>
      </div>
      <p class="muted">${t("modelSetup.empty.intro")}</p>
      <div class="model-setup__recommendations">
        ${installs.map(
          (install) => html`
            <div class="model-setup__recommendation" data-recommended-install=${install.id}>
              ${renderProviderIcon(props, install, "model-setup__icon--recommendation")}
              <div class="model-setup__row-main">
                <strong>${install.label}</strong>
                <div class="muted">${install.hint}</div>
                <a href=${install.website} target="_blank" rel="noopener"
                  >${renderExternalLinkLabel(install.website, install.website)}</a
                >
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}
