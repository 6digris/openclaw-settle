import { html, nothing, type TemplateResult } from "lit";

export type SettingsSectionProps = {
  title?: unknown;
  description?: unknown;
  /** Right-aligned inline actions next to the heading (e.g. an Add button). */
  actions?: TemplateResult;
  /** Section notice above the group, keeping bordered callouts outside the card. */
  notice?: TemplateResult | typeof nothing;
  /** Extra count shown next to the heading. */
  count?: number;
  /** Marks the group surface as a danger zone. */
  danger?: boolean;
  /** Opts this section into the shared Carapace settings contract. */
  carapace?: boolean;
};

/** Section = plain text heading + one group surface containing rows. */
export function renderSettingsSection(props: SettingsSectionProps, rows: unknown): TemplateResult {
  const description = props.description
    ? html`<p class="settings-section__desc">${props.description}</p>`
    : nothing;
  const copy =
    props.title || props.description
      ? html`
          <div
            class="settings-section__copy ${props.carapace ? "oc-settings-section-heading" : ""}"
          >
            ${
              props.title
                ? html`
                    <h2
                      class="settings-section__heading ${
                        props.carapace ? "oc-settings-section-title" : ""
                      }"
                    >
                      ${props.title}${
                        props.count !== undefined
                          ? html` <span class="settings-count">${props.count}</span>`
                          : nothing
                      }
                    </h2>
                  `
                : nothing
            }
            ${description}
          </div>
        `
      : nothing;
  const header =
    copy || props.actions
      ? html`
          <div
            class="settings-section__header ${props.carapace ? "oc-settings-section-header" : ""}"
          >
            ${copy}
            ${
              props.actions
                ? html`<div class="settings-section__actions">${props.actions}</div>`
                : nothing
            }
          </div>
        `
      : nothing;
  const groupClass = [
    "settings-group",
    props.danger ? "settings-group--danger" : "",
    props.carapace ? "oc-settings-group" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <section class="settings-section ${props.carapace ? "oc-settings-section" : ""}">
      ${header} ${props.notice ?? nothing}
      <div class=${groupClass}>${rows}</div>
    </section>
  `;
}
