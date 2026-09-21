import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";
import "./viewer-facepile.ts";

registerSidebarAttentionEnglish();

class MentionNotifications extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) watchedSessionKey: string | null = null;

  private readonly pending = new Map<
    string,
    { mention: MentionInboxItem; abort: AbortController }
  >();
  private reconcile = () => {};
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context,
    (context) => {
      const mentions = context.sidebarAttention.activate(SidebarAttentionStoreController);
      this.reconcile = () => {
        const visible = new Set(mentions.snapshot.items.map((item) => item.id));
        for (const [id, entry] of this.pending) {
          if (!visible.has(id) || this.isWatching(entry.mention)) {
            entry.abort.abort();
          }
        }
      };
      const stopState = mentions.subscribe(this.reconcile);
      const stopArrivals = mentions.subscribeArrivals((arrivals) => {
        for (const mention of arrivals) {
          if (this.isWatching(mention)) {
            continue;
          }
          const abort = new AbortController();
          this.pending.set(mention.id, { mention, abort });
          showToast({
            icon: html`<span class="mention-toast__avatar">
              <openclaw-viewer-avatar
                .user=${{ id: mention.senderProfileId, identity: { type: "profile", id: mention.senderProfileId }, name: mention.senderLabel, avatarUrl: mention.senderAvatarUrl, watchedSessions: [] }}
                .markAsViewer=${false}
                variant="footer"
              ></openclaw-viewer-avatar>
            </span>`,
            title: html`<span class="mention-toast__sender-line">
              <bdi class="mention-toast__name" title=${mention.senderLabel}
                >${mention.senderLabel}</bdi
              >
              <span class="mention-toast__reason">${t("attention.mentions.mentionedYou")}</span>
            </span>`,
            message: html`
              <span class="mention-toast__session" title=${mention.sessionTitle} dir="auto"
                >${mention.sessionTitle}</span
              >
              <span class="mention-toast__excerpt" title=${mention.excerpt ?? ""} dir="auto"
                >${mention.excerpt ?? t("attention.mentions.noExcerpt")}</span
              >
            `,
            actionLabel: t("attention.mentions.viewSession"),
            onAction: () => {
              const target = sessionNavigationTarget({
                face: "chat",
                sessionKey: mention.sessionKey,
                fallbackAgentId: mention.agentId,
                basePath: context.basePath,
                row: { key: mention.sessionKey, displayName: mention.sessionTitle },
                exactKey: true,
              });
              context.navigate("chat", target.options);
            },
            // Closing this transient surface never dismisses the shared Inbox entry.
            onDismiss: () => this.pending.delete(mention.id),
            signal: abort.signal,
            durationMs: 5_000,
            fifo: true,
          });
        }
      });
      return () => {
        stopArrivals();
        stopState();
        for (const entry of this.pending.values()) {
          entry.abort.abort();
        }
        this.pending.clear();
        this.reconcile = () => {};
      };
    },
  );

  private isWatching(mention: MentionInboxItem) {
    return (
      this.watchedSessionKey !== null &&
      areUiSessionKeysEquivalent(this.watchedSessionKey, mention.sessionKey)
    );
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("watchedSessionKey")) {
      this.reconcile();
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override render() {
    return nothing;
  }
}

customElements.define("openclaw-mention-notifications", MentionNotifications);
