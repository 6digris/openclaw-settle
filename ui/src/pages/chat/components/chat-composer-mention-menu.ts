import type { UsersMentionableParams, UsersMentionableResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import {
  handleComposerMenuKeydown,
  renderComposerMenu,
  renderComposerMenuOption,
} from "../../../components/composer-menu.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { MAX_HUMAN_MENTIONS, updateHumanMentions } from "../../../lib/chat/human-mentions.ts";
import "../../../styles/chat/mention-menu.css";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { paneDomId } from "./chat-composer-dom.ts";

export type HumanMentionDirectory = {
  client: GatewayBrowserClient;
  ownerKey: string;
  params: UsersMentionableParams;
};

export type HumanMentionMenuHost = {
  paneId: string;
  getDraft: () => string;
  getMentions: () => readonly HumanMention[];
  getTextarea: () => HTMLTextAreaElement | null;
  commitDraft: (value: string, mentions: readonly HumanMention[]) => void;
};

type MentionOption =
  | UsersMentionableResult["users"][number]
  | { kind: "everyone"; recipientCount: number };

function optionKey(option: MentionOption): string {
  return "profileId" in option ? `profile:${option.profileId}` : "everyone";
}

function optionLabel(option: MentionOption): string {
  return "profileId" in option ? option.displayName : "@everyone";
}

type MentionTarget = { start: number; end: number; query: string; allowEveryone: boolean };
type MentionSearch =
  | { kind: "loading" }
  | { kind: "ready"; result: UsersMentionableResult }
  | { kind: "error" };

function findMentionTarget(value: string, caret: number): MentionTarget | null {
  if (value.trimStart().startsWith("/")) {
    return null;
  }
  const beforeCaret = value.slice(0, caret);
  const line = beforeCaret.slice(beforeCaret.lastIndexOf("\n") + 1);
  // Code and quoted examples are text, never people-picker invocations.
  if (
    /^\s*>/u.test(line) ||
    (beforeCaret.match(/```/gu)?.length ?? 0) % 2 !== 0 ||
    (line.match(/`/gu)?.length ?? 0) % 2 !== 0
  ) {
    return null;
  }
  // Spaces belong to a typed full-name query, but never continue it onto another line.
  const match = /(?:^|[\s([{])@([\p{L}\p{N}\p{M}_. -]{0,128})$/u.exec(beforeCaret);
  if (!match) {
    return null;
  }
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  let end = caret;
  // Replace the rest of the current word, not later words that may be ordinary prose.
  while (end < value.length && /[\p{L}\p{N}\p{M}_.-]/u.test(value[end] ?? "")) {
    end += 1;
  }
  // A second bare @ is for adding people; an explicit search may still choose everyone.
  const allowEveryone = query.trim().length > 0 || value.indexOf("@") === value.lastIndexOf("@");
  return { start, end, query, allowEveryone };
}

/** One bounded suggestion lifecycle shared by existing- and new-session composers. */
export class HumanMentionMenu {
  private directory?: HumanMentionDirectory;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private target: MentionTarget | null = null;
  private search: MentionSearch | null = null;
  private index = 0;
  private selectedKey: string | undefined;
  private readonly selectedAvatars = new Map<string, string>();
  private results = new Map<string, UsersMentionableResult>();

  get open(): boolean {
    return this.target !== null;
  }

  syncDirectory(directory: HumanMentionDirectory | undefined) {
    // Results are query snapshots: unrelated session/presence traffic must not cancel typing.
    // Owner changes fence them here; admission rechecks current recipient visibility.
    if (
      this.directory?.client === directory?.client &&
      this.directory?.ownerKey === directory?.ownerKey &&
      JSON.stringify(this.directory?.params) === JSON.stringify(directory?.params)
    ) {
      return;
    }
    this.close();
    this.selectedAvatars.clear();
    this.directory = directory;
  }

  private cancelSearch() {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  close() {
    this.cancelSearch();
    this.results.clear();
    this.target = null;
    this.search = null;
    this.index = 0;
    this.selectedKey = undefined;
  }

  dispose() {
    this.close();
    this.selectedAvatars.clear();
    this.directory = undefined;
  }

  update(value: string, caret: number, requestUpdate: () => void, typedAtSign = false) {
    const target = this.directory ? findMentionTarget(value, caret) : null;
    if (!target || (!this.open && !typedAtSign)) {
      if (this.open) {
        this.close();
        requestUpdate();
      }
      return;
    }
    if (
      this.target?.start === target.start &&
      this.target.query === target.query &&
      this.target.allowEveryone === target.allowEveryone
    ) {
      return;
    }
    if (this.target?.start !== target.start) {
      this.results.clear();
      this.selectedKey = undefined;
    }
    this.target = target;
    this.searchPeople(requestUpdate);
  }

  private get options(): MentionOption[] {
    if (this.search?.kind !== "ready") {
      return [];
    }
    const { users, everyone } = this.search.result;
    // People stay first so opening the picker does not default to a broad ping.
    return [
      ...users,
      ...(everyone && this.target?.allowEveryone
        ? [{ kind: "everyone" as const, ...everyone }]
        : []),
    ];
  }

  private showResults(result: UsersMentionableResult) {
    this.search = { kind: "ready", result };
    const options = this.options;
    this.index = Math.max(
      0,
      options.findIndex((option) => optionKey(option) === this.selectedKey),
    );
    this.selectedKey = options[this.index] ? optionKey(options[this.index]!) : undefined;
  }

  private searchPeople(requestUpdate: () => void) {
    const target = this.target;
    const directory = this.directory;
    if (!target || !directory) {
      return;
    }
    this.cancelSearch();
    const query = target.query;
    // Only the Gateway knows every searchable identity field and its matching rules.
    // Reuse exact snapshots; display-name filtering would lose verified-login matches.
    const cached = this.results.get(query);
    if (cached) {
      this.showResults(cached);
      requestUpdate();
      return;
    }
    this.search = { kind: "loading" };
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void directory.client
        .request<UsersMentionableResult>("users.mentionable", {
          ...directory.params,
          query: target.query,
        })
        .then(
          (result) => {
            if (generation === this.generation) {
              if (this.results.size === 16) {
                this.results.delete(this.results.keys().next().value!);
              }
              this.results.set(query, result);
              this.showResults(result);
              requestUpdate();
            }
          },
          () => {
            if (generation === this.generation) {
              this.search = { kind: "error" };
              requestUpdate();
            }
          },
        );
    }, 150);
    requestUpdate();
  }

  activeId(paneId: string): string | null {
    return this.options[this.index] ? paneDomId(paneId, `mention-option-${this.index}`) : null;
  }

  activeLabel(): string {
    const option = this.options[this.index];
    return option ? optionLabel(option) : "";
  }

  handleKeydown(event: KeyboardEvent, host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open || event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return false;
    }
    if (this.search?.kind === "error" && event.key === "Tab") {
      return false;
    }
    const users = this.options;
    return handleComposerMenuKeydown(event, {
      count: users.length,
      index: this.index,
      consumeEmpty: true,
      close: () => {
        this.close();
        requestUpdate();
      },
      move: (index) => {
        this.index = index;
        this.selectedKey = users[index] ? optionKey(users[index]!) : undefined;
        requestUpdate();
        return this.activeId(host.paneId);
      },
      select: () => this.select(users[this.index]!, host, requestUpdate),
    });
  }

  private select(person: MentionOption, host: HumanMentionMenuHost, requestUpdate: () => void) {
    const textarea = host.getTextarea();
    const current = textarea?.value ?? host.getDraft();
    const target = findMentionTarget(current, textarea?.selectionStart ?? current.length);
    if (!target || host.getMentions().length >= MAX_HUMAN_MENTIONS) {
      return;
    }
    const label = "profileId" in person ? `@${person.displayName}` : "@everyone";
    const replacement = `${label} `;
    const next = `${current.slice(0, target.start)}${replacement}${current.slice(target.end)}`;
    const selected: HumanMention =
      "profileId" in person
        ? { profileId: person.profileId, start: target.start, end: target.start + label.length }
        : { kind: "everyone", start: target.start, end: target.start + label.length };
    const mentions = [
      ...updateHumanMentions(current, next, host.getMentions(), {
        value: current,
        start: target.start,
        end: target.end,
        inputType: "insertReplacementText",
      }),
      selected,
    ].toSorted((a, b) => a.start - b.start);
    // Preserve only selected presentation URLs, so the shared loader reuses the
    // exact image already requested by the picker. Recipient metadata stays unchanged.
    for (const profileId of this.selectedAvatars.keys()) {
      if (!mentions.some((mention) => "profileId" in mention && mention.profileId === profileId)) {
        this.selectedAvatars.delete(profileId);
      }
    }
    if ("profileId" in person) {
      if (person.avatarUrl) {
        this.selectedAvatars.set(person.profileId, person.avatarUrl);
      } else {
        this.selectedAvatars.delete(person.profileId);
      }
    }
    host.commitDraft(next, mentions);
    this.close();
    requestUpdate();
    queueMicrotask(() => {
      const currentTextarea = host.getTextarea();
      currentTextarea?.focus({ preventScroll: true });
      currentTextarea?.setSelectionRange(
        target.start + replacement.length,
        target.start + replacement.length,
      );
    });
  }

  get selectedAvatarUrls(): ReadonlyMap<string, string> {
    return this.selectedAvatars;
  }

  render(host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open) {
      return nothing;
    }
    const result = this.search?.kind === "ready" ? this.search.result : undefined;
    const limited = host.getMentions().length >= MAX_HUMAN_MENTIONS;
    const loading = this.search?.kind === "loading";
    const message = limited
      ? t("chat.mentions.limit")
      : this.search?.kind === "error"
        ? t("chat.mentions.unavailable")
        : !loading && !this.options.length
          ? t("chat.mentions.empty")
          : null;
    return renderComposerMenu({
      id: paneDomId(host.paneId, "mention-menu-listbox"),
      className: "mention-menu",
      label: t("chat.mentions.menu"),
      trackScroll: false,
      activeId: this.activeId(host.paneId),
      content: html` <div class="slash-menu-group" aria-busy=${loading}>
        <div class="slash-menu-group__label" role="status">
          ${message ?? t("chat.mentions.menu")}
        </div>
        ${
          this.search?.kind === "error" && !limited
            ? html`<button
                type="button"
                class="btn btn--sm mention-menu__retry"
                @click=${() => {
                  this.searchPeople(requestUpdate);
                  host.getTextarea()?.focus({ preventScroll: true });
                }}
              >
                ${t("common.retry")}
              </button>`
            : nothing
        }
        ${
          message
            ? nothing
            : loading
              ? [0, 1, 2].map(
                  () => html`<div class="slash-menu-item mention-menu__loading" aria-hidden="true">
                    <span class="slash-menu-icon"
                      ><span class="skeleton mention-menu__avatar"></span
                    ></span>
                    <span class="skeleton skeleton-line skeleton-line--medium"></span>
                  </div>`,
                )
              : this.options.map((person, index) => {
                  const description =
                    "profileId" in person
                      ? person.online
                        ? t("chat.mentions.online")
                        : nothing
                      : t("chat.mentions.everyoneDescription", {
                          count: String(person.recipientCount),
                        });
                  return renderComposerMenuOption({
                    id: paneDomId(host.paneId, `mention-option-${index}`),
                    active: index === this.index,
                    select: () => this.select(person, host, requestUpdate),
                    hover: () => {
                      this.index = index;
                      this.selectedKey = optionKey(person);
                      requestUpdate();
                    },
                    icon:
                      "profileId" in person
                        ? renderChatAuthorAvatar({
                            id: person.profileId,
                            name: person.displayName,
                            identity: { type: "profile", id: person.profileId },
                            profileAvatarUrl: person.avatarUrl,
                          })
                        : html`<span class="mention-everyone-icon">${icons.users}</span>`,
                    iconHidden: true,
                    name: optionLabel(person),
                    description,
                  });
                })
        }
        ${
          result?.truncated
            ? html`<div class="slash-menu-group__label">${t("chat.mentions.truncated")}</div>`
            : nothing
        }
      </div>`,
    });
  }
}
