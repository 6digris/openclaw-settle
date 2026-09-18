import { html } from "lit";
import { t } from "../../i18n/index.ts";

export function renderUsageEmptyState(onRefresh: () => void, loading: boolean) {
  return html`
    <section class="settings-group usage-panel usage-empty-state">
      <div class="usage-empty-state__title">${t("usage.empty.title")}</div>
      <div class="card-sub usage-empty-state__subtitle">${t("usage.empty.subtitle")}</div>
      <div class="usage-empty-state__features">
        <span class="usage-empty-state__feature">${t("usage.empty.featureOverview")}</span>
        <span class="usage-empty-state__feature">${t("usage.empty.featureSessions")}</span>
        <span class="usage-empty-state__feature">${t("usage.empty.featureTimeline")}</span>
      </div>
      <div class="usage-empty-state__actions">
        <button class="btn primary" @click=${onRefresh} ?disabled=${loading}>
          ${t("common.refresh")}
        </button>
      </div>
    </section>
  `;
}
