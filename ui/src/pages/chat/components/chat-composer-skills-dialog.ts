import WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import WaSwitch from "@awesome.me/webawesome/dist/components/switch/switch.js";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { OpenClawModalDialog } from "../../../components/modal-dialog.ts";
import { t } from "../../../i18n/index.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import { nextBooleanToolOverrides } from "../../../lib/sessions/tool-overrides.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import {
  handleComposerLibrarySelection,
  renderComposerLibraryMenu,
} from "./chat-composer-library-menu.ts";
import type {
  ChatComposerMenuSkill,
  ChatComposerCapabilityMenuProps,
} from "./chat-composer-plus-menu.ts";
import "../../../styles/chat/skills-dialog.css";

/** Presentation only. The composer host owns availability, permissions and serialized writes. */
class ChatComposerSkillsDialog extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) capabilities!: ChatComposerCapabilityMenuProps;
  @property({ attribute: false }) overrides: SessionToolOverrides | null | undefined;
  @property({ attribute: false }) onClose: () => void = () => {};
  @state() private query = "";
  @state() private selectedKey: string | null = null;
  @state() private saveError: string | null = null;
  @state() private saveWarning: string | null = null;
  @state() private libraryView: string | undefined;

  protected override firstUpdated() {
    // The keyed chooser is recreated after reconnects; its closed dropdown
    // cannot refresh a retired catalog through wa-show. The host deduplicates.
    this.capabilities.onLoadSkills();
  }

  private reason(skill: ChatComposerMenuSkill) {
    return skill.missingDeps
      ? t("chat.composer.menu.depsMissing")
      : skill.blocked
        ? t("chat.composer.menu.skillBlocked")
        : this.capabilities.mutationBlockedReason;
  }

  private async setEnabled(skill: ChatComposerMenuSkill, enabled: boolean) {
    if (this.reason(skill) || skill.enabled === enabled) {
      return;
    }
    const owner = this.capabilities.scopeKey;
    this.saveError = null;
    this.saveWarning = null;
    const result = await this.capabilities.onPatchToolOverrides(
      nextBooleanToolOverrides(this.overrides, "skills", skill.key, enabled, skill.baseEnabled),
    );
    if (this.isConnected && this.capabilities.scopeKey === owner && result) {
      if (result.ok) {
        this.saveWarning = result.warning ?? null;
      } else {
        this.saveError = result.error;
      }
    }
  }

  private select(key: string) {
    this.selectedKey = key;
  }

  private move(event: KeyboardEvent, rows: readonly ChatComposerMenuSkill[], index: number) {
    const next =
      event.key === "ArrowDown"
        ? Math.min(index + 1, rows.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : null;
    if (next === null) {
      return;
    }
    event.preventDefault();
    const skill = rows[next];
    if (!skill) {
      return;
    }
    this.select(skill.key);
    void this.updateComplete.then(() => {
      const button = this.querySelectorAll<HTMLButtonElement>(".session-skills__select")[next];
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: "nearest" });
    });
  }

  override render() {
    const props = this.capabilities;
    const libraryMenu = renderComposerLibraryMenu(props.library, this.libraryView);
    const query = this.query.trim().toLocaleLowerCase();
    const rows = (props.skills ?? []).filter(
      (skill) =>
        !query ||
        skill.name.toLocaleLowerCase().includes(query) ||
        skill.key.toLocaleLowerCase().includes(query) ||
        skill.description.toLocaleLowerCase().includes(query),
    );
    const selected = rows.find((skill) => skill.key === this.selectedKey) ?? rows[0];
    const loading = props.skillsLoading;
    const blocked = selected ? this.reason(selected) : null;
    return html`
      <openclaw-modal-dialog
        class="session-skills-dialog"
        label=${t("chat.composer.menu.skills")}
        description=${t("chat.composer.menu.skillsScope")}
        ${ref((el) => {
          if (el instanceof OpenClawModalDialog) {
            el.setReturnFocusTarget(
              this.previousElementSibling?.querySelector<HTMLButtonElement>(
                'button[slot="trigger"]',
              ) ?? null,
            );
          }
        })}
        @modal-cancel=${(event: Event) => {
          if (event.target === event.currentTarget) {
            this.onClose();
          }
        }}
      >
        <section class="exec-approval-card skill-reader-dialog session-skills">
          <header class="exec-approval-header">
            <div>
              <h2 class="exec-approval-title">${t("chat.composer.menu.skills")}</h2>
              <p class="exec-approval-sub">${t("chat.composer.menu.skillsScope")}</p>
            </div>
            <button
              class="btn btn--icon btn--ghost"
              type="button"
              aria-label=${t("common.close")}
              @click=${this.onClose}
            >
              ${icons.x}
            </button>
          </header>
          <div class="session-skills__search">
            <input
              class="settings-input"
              type="search"
              autofocus
              aria-label=${t("chat.composer.menu.searchSkills")}
              placeholder=${t("chat.composer.menu.searchSkills")}
              .value=${this.query}
              @input=${(event: Event) => {
                const input = event.currentTarget;
                if (input instanceof HTMLInputElement) {
                  this.query = input.value;
                }
              }}
            />
            ${
              !loading && !props.skillsError
                ? html`
                    <span class="muted" role="status"
                      >${t("chat.composer.menu.skillsSummary", { count: String(rows.length), enabled: String(rows.filter((skill) => skill.enabled).length) })}</span
                    >
                  `
                : nothing
            }
          </div>
          ${this.saveError ? html`<div class="callout danger session-skills__notice" role="alert">${this.saveError}</div>` : nothing}
          ${this.saveWarning ? html`<div class="callout session-skills__notice" role="status">${this.saveWarning}</div>` : nothing}
          ${props.mutationBlockedReason ? html`<p class="muted session-skills__notice" role="status">${props.mutationBlockedReason}</p>` : nothing}
          <div class="session-skills__body">
            <div class="session-skills__list" aria-label=${t("chat.composer.menu.skills")}>
              ${
                loading || props.skillsError || rows.length === 0
                  ? html`<p
                        class="session-skills__empty"
                        role=${props.skillsError ? "alert" : "status"}
                      >
                        ${t(loading ? "chat.composer.menu.loadingSkills" : props.skillsError ? "chat.composer.menu.skillsLoadFailed" : query ? "chat.composer.menu.noSkillMatches" : "chat.composer.menu.noSkills")}
                      </p>
                      ${props.skillsError ? html`<button type="button" class="btn" @click=${props.onLoadSkills}>${t("common.retry")}</button>` : nothing}`
                  : repeat(
                      rows,
                      (skill) => skill.key,
                      (skill, index) => html` <div
                        class="session-skills__row"
                        data-selected=${String(selected?.key === skill.key)}
                      >
                        <button
                          class="session-menu__item session-skills__select"
                          type="button"
                          aria-pressed=${String(selected?.key === skill.key)}
                          tabindex=${selected?.key === skill.key ? 0 : -1}
                          @click=${() => this.select(skill.key)}
                          @focus=${() => this.select(skill.key)}
                          @keydown=${(event: KeyboardEvent) => this.move(event, rows, index)}
                        >
                          <span class="session-skills__name">${skill.name}</span>
                          ${skill.missingDeps || skill.blocked ? html`<span class="session-skills__unavailable" aria-label=${this.reason(skill) ?? ""}>${icons.alertTriangle}</span>` : nothing}
                        </button>
                        <wa-switch
                          size="s"
                          .checked=${live(skill.enabled)}
                          ?disabled=${Boolean(this.reason(skill))}
                          @change=${(event: Event) => {
                            const toggle = event.currentTarget;
                            if (!(toggle instanceof WaSwitch)) {
                              return;
                            }
                            const enabled = toggle.checked;
                            toggle.checked = skill.enabled;
                            void this.setEnabled(skill, enabled);
                          }}
                          ><span class="sr-only"
                            >${t("chat.composer.menu.skillEnabledLabel", { name: skill.name })}</span
                          ></wa-switch
                        >
                      </div>`,
                    )
              }
            </div>
            <section
              class="session-skills__detail"
              aria-label=${t("chat.composer.menu.skillDetails")}
            >
              ${
                selected && !loading && !props.skillsError
                  ? html`
                      <h3>${selected.name}</h3>
                      ${selected.key !== selected.name ? html`<p><code>${selected.key}</code></p>` : nothing}
                      <p class="session-skills__description">${selected.description}</p>
                      <p class="muted">
                        ${blocked ?? t(selected.enabled ? "common.enabled" : "common.disabled")}
                      </p>
                      <p class="muted">
                        ${selected.missingDeps || selected.blocked ? nothing : t(selected.enabled === selected.baseEnabled ? "chat.composer.menu.skillInherited" : "chat.composer.menu.skillOverridden")}
                      </p>
                      ${selected.enabled !== selected.baseEnabled && !selected.missingDeps && !selected.blocked ? html`<button type="button" class="btn btn--ghost" ?disabled=${Boolean(blocked)} @click=${() => void this.setEnabled(selected, selected.baseEnabled)}>${t("chat.composer.menu.skillReset")}</button>` : nothing}
                    `
                  : nothing
              }
            </section>
          </div>
          <footer class="session-skills__footer">
            ${
              libraryMenu !== nothing
                ? html`<wa-dropdown
                    class="agent-chat__capability-menu session-menu"
                    placement="top-start"
                    @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                      event.preventDefault();
                      const value = event.detail.item.value ?? "";
                      const menu = event.currentTarget;
                      if (!(menu instanceof WaDropdown)) {
                        return;
                      }
                      if (value.startsWith("library-read:")) {
                        menu.open = false;
                        menu.querySelector<HTMLButtonElement>('button[slot="trigger"]')?.focus();
                      }
                      const changeView = (view: "skills" | `library:${string}`) => {
                        this.libraryView =
                          view === "skills" ? undefined : view.slice("library:".length);
                        requestAnimationFrame(() =>
                          menu
                            .querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")
                            ?.focus(),
                        );
                      };
                      if (value === "back") {
                        changeView("skills");
                      } else {
                        handleComposerLibrarySelection(value, props.library, changeView);
                      }
                    }}
                    ><button slot="trigger" class="btn btn--ghost" type="button">
                      ${t("chat.composer.menu.skillLibrary")}</button
                    >${libraryMenu}</wa-dropdown
                  >`
                : nothing
            }
            <button
              type="button"
              class="btn btn--ghost"
              @click=${() => {
                this.onClose();
                props.onNavigate("skills");
              }}
            >
              ${t("chat.composer.menu.manageSkills")}
            </button>
          </footer>
        </section>
      </openclaw-modal-dialog>
    `;
  }
}
customElements.define("openclaw-session-skills", ChatComposerSkillsDialog);
