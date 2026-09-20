import { html, nothing } from "lit";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { renderCompactAttachmentCard } from "./chat-attachment-card.ts";
import {
  isCrossOriginHttpSource,
  safeAttachmentHref,
  safePlainTextAttachmentHref,
  safeMediaAttachmentHref,
} from "./chat-attachment-href.ts";
import "./chat-audio-player.ts";
import "./chat-svg-attachment.ts";
import "./chat-video-player.ts";
import { resolveAttachmentSource } from "./chat-attachment-source.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";
import { isManagedOutgoingMediaSource } from "./chat-message-attachment-availability.ts";
import {
  attachmentFailureReason,
  renderAssistantAttachmentStatusCard,
} from "./chat-message-attachment-status.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { isLocalAssistantAttachmentSource } from "./chat-message-local-media.ts";
import {
  releaseChatMediaResourceSubscriber,
  observeChatMediaResourceSubscriber,
  resolveAttachmentImageKind,
  type AttachmentItem,
  type AssistantAttachmentItem,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import { renderMessageVideoPreview } from "./chat-message-video-preview.ts";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";
import { isSentCommentAttachment } from "./chat-sent-comments.ts";
import type { AttachmentSidebarState } from "./chat-sidebar-content-types.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

type OmittedMediaItem = Extract<MessageContentItem, { type: "omitted_media" }>;

export function renderOmittedMedia(items: OmittedMediaItem[]) {
  if (items.length === 0) {
    return nothing;
  }
  return html`${items.map((item) => {
    const reason =
      item.media.sizeBytes === undefined
        ? t("chat.attachments.omittedFromHistory")
        : t("chat.attachments.omittedFromHistoryWithSize", {
            size: formatBytes(item.media.sizeBytes),
          });
    return renderAssistantAttachmentStatusCard({
      label: t("chat.attachments.image"),
      badge: t("chat.attachments.history"),
      reason,
    });
  })}`;
}

/** The gallery owns selection; existing attachment/source owners own authorization and playback. */
function videoLightboxItem(
  attachment: AttachmentItem["attachment"],
  options: ImageRenderOptions,
): ImageLightboxItem {
  return {
    kind: "video",
    // Never put an unchecked local path or expired ticket into the player. The
    // selected item's connection resolves its live source before assigning src.
    src: "",
    title: attachment.label,
    connectVideo: (media, notify, retryFailed = false) => {
      const controller = new ChatMediaSourceController();
      let active = true;
      let retryPending = retryFailed;
      const report = () => {
        if (active) {
          notify(controller.readiness === "idle" ? "preparing" : controller.readiness);
        }
      };
      const refresh = () => {
        if (!active) {
          return;
        }
        const resolved = resolveAttachmentSource(attachment, {
          ...options,
          onRequestUpdate: refresh,
        });
        if (resolved.status !== "available") {
          if (resolved.status === "unavailable" && retryPending && resolved.onRetry) {
            retryPending = false;
            resolved.onRetry();
            return;
          }
          // Expired/revoked authority cannot keep an old player resource alive.
          controller.cancel();
          controller.reset(media);
          notify(
            resolved.status === "checking" ? "preparing" : "unavailable",
            Boolean(resolved.onRetry),
          );
          return;
        }
        const src = safeMediaAttachmentHref(resolved.source.src, "video");
        if (!src) {
          controller.cancel();
          controller.reset(media);
          notify("unavailable", false);
          return;
        }
        const pending = controller.sync(
          media,
          src,
          attachment.url,
          resolved.source.playback,
          resolved.source.authToken,
        );
        report();
        void pending?.then(report);
      };
      if (options.onRequestUpdate) {
        observeChatMediaResourceSubscriber(options.onRequestUpdate, refresh);
      }
      const metadata = () => controller.handleLoadedMetadata(media, () => active);
      const adopt = () => {
        controller.applyPendingSource(media);
        report();
      };
      const ended = () => {
        controller.handleEnded(media);
        report();
      };
      const error = () => {
        controller.handleError(media);
        report();
      };
      media.addEventListener("loadedmetadata", metadata);
      media.addEventListener("play", adopt);
      media.addEventListener("seeking", adopt);
      media.addEventListener("ended", ended);
      media.addEventListener("error", error);
      refresh();
      return () => {
        active = false;
        media.removeEventListener("loadedmetadata", metadata);
        media.removeEventListener("play", adopt);
        media.removeEventListener("seeking", adopt);
        media.removeEventListener("ended", ended);
        media.removeEventListener("error", error);
        controller.cancel();
        controller.reset(media);
        releaseChatMediaResourceSubscriber(refresh);
      };
    },
  };
}

export function renderAssistantAttachments(
  attachments: AssistantAttachmentItem[],
  options: ImageRenderOptions,
  onOpenSidebar?: (content: SidebarContent) => void,
  onAssistantAttachmentLoaded?: () => void,
  inlinePlayback = true,
) {
  if (attachments.length === 0) {
    return nothing;
  }
  const comments = inlinePlayback ? [] : attachments.filter(isSentCommentAttachment);
  const files = attachments.filter((item) => inlinePlayback || !isSentCommentAttachment(item));
  const sources = comments.map((item) => {
    const resolved = resolveAttachmentSource(item.attachment, options);
    return {
      identity: item.attachment.url,
      ...(resolved.status === "available"
        ? {
            src:
              /^data:text\/plain;base64,[a-z0-9+/]*={0,2}$/i.test(resolved.source.src) ||
              (safeAttachmentHref(resolved.source.src) &&
                !isCrossOriginHttpSource(resolved.source.src))
                ? resolved.source.src
                : undefined,
            sizeBytes: resolved.source.sizeBytes,
          }
        : { pending: resolved.status === "checking" }),
      fallback: renderMessageAttachment(
        item,
        options,
        onOpenSidebar,
        onAssistantAttachmentLoaded,
        "card",
      ),
    };
  });
  const hasPreviewChips =
    !inlinePlayback && (comments.length > 0 || files.some(isSentPastedTextAttachment));
  return html`<div
    class="chat-assistant-attachments ${hasPreviewChips ? "chat-assistant-attachments--preview-chips" : ""}"
  >
    ${
      comments.length
        ? html`<openclaw-chat-sent-comments
            .sources=${sources}
            .scope=${JSON.stringify([options.sessionKey, options.agentId, options.connectionEpoch, options.resourceBasePath, options.authToken, options.policyKey])}
          ></openclaw-chat-sent-comments>`
        : nothing
    }
    ${files.map((item) =>
      renderMessageAttachment(
        item,
        options,
        onOpenSidebar,
        onAssistantAttachmentLoaded,
        inlinePlayback ? "inline" : "card",
      ),
    )}
  </div>`;
}

export function renderMessageAttachment(
  item: AssistantAttachmentItem,
  options: ImageRenderOptions,
  onOpenSidebar?: (content: SidebarContent) => void,
  onAssistantAttachmentLoaded?: () => void,
  presentation: "inline" | "card" | "preview" = "inline",
) {
  const { onRequestOpenImage, onOpenImage, resolveArtifactDownload } = options;
  if (item.type === "attachment_error") {
    const { attachment } = item;
    return renderAssistantAttachmentStatusCard({
      label: attachment.label,
      mimeType: attachment.mimeType,
      badge: t("chat.attachments.notSent"),
      reason: attachmentFailureReason(attachment.code),
    });
  }
  const { attachment } = item;
  const pastedText = presentation === "card" && isSentPastedTextAttachment(item);
  const imageAttachment = resolveAttachmentImageKind(attachment) === "svg";
  const resolved = resolveAttachmentSource(attachment, options);
  if (resolved.status !== "available" && !pastedText) {
    return renderAssistantAttachmentStatusCard({
      label: attachment.label,
      mimeType: attachment.mimeType,
      badge: resolved.status === "unavailable" ? t("chat.attachments.unavailable") : "",
      reason: resolved.status === "unavailable" ? resolved.reason : undefined,
      onRetry: resolved.onRetry,
      onAllow: imageAttachment ? resolved.onAllow : undefined,
      path: isLocalAssistantAttachmentSource(attachment.url) ? attachment.url : undefined,
    });
  }
  const media = resolved.status === "available" ? resolved.source : undefined;
  const attachmentUrl = media?.src ?? "";
  const safeAttachmentUrl =
    attachment.kind === "audio" || attachment.kind === "video"
      ? safeMediaAttachmentHref(attachmentUrl, attachment.kind)
      : pastedText
        ? safePlainTextAttachmentHref(attachmentUrl)
        : safeAttachmentHref(attachmentUrl);
  const openVideoOverlay =
    attachment.kind === "video" && onOpenImage && safeAttachmentUrl
      ? (src: string) => {
          const requestVersion = onRequestOpenImage?.();
          const membership = options.galleryVideos?.(item);
          const overlayItem: ImageLightboxItem = {
            ...videoLightboxItem(attachment, options),
            src,
            originalSrc: safeAttachmentUrl,
            ...(membership && membership.index >= 0 && membership.items.length > 1
              ? {
                  gallery: {
                    index: membership.index,
                    items: membership.items.map(
                      ({ attachment: video }) =>
                        async () =>
                          videoLightboxItem(video, options),
                    ),
                  },
                }
              : {}),
          };
          if (requestVersion === undefined) {
            onOpenImage(overlayItem);
          } else {
            onOpenImage(overlayItem, requestVersion);
          }
        }
      : undefined;
  const hasLiveSidebarSource =
    isLocalAssistantAttachmentSource(attachment.url) ||
    (isManagedOutgoingMediaSource(attachment.url) &&
      Boolean(attachment.artifactId && resolveArtifactDownload));
  const openAttachmentSidebar =
    onOpenSidebar && (hasLiveSidebarSource || safeAttachmentUrl || pastedText)
      ? () =>
          onOpenSidebar({
            kind: "attachment",
            attachmentKind: attachment.kind,
            title: attachment.label,
            ...(hasLiveSidebarSource ? {} : { src: safeAttachmentUrl }),
            mimeType: attachment.mimeType,
            ...(pastedText ? { plainText: true } : {}),
            sourceIdentity: attachment.url,
            playback: media?.playback,
            authToken: media?.authToken,
            sizeBytes: media?.sizeBytes,
            durationMs: media?.durationMs,
            width: media?.width,
            height: media?.height,
            voiceNote: attachment.isVoiceNote === true,
            ...(hasLiveSidebarSource
              ? {
                  resolveSource: (sidebarUpdate, runtime): AttachmentSidebarState => {
                    const next = resolveAttachmentSource(attachment, {
                      ...runtime,
                      onRequestUpdate: sidebarUpdate,
                    });
                    if (next.status === "available") {
                      return { status: "ready", ...next.source };
                    }
                    if (next.status === "checking") {
                      return { status: "pending" };
                    }
                    return next.error
                      ? {
                          status: "error",
                          reason: next.reason ?? t("chat.attachments.unavailable"),
                          onRetry: next.onRetry,
                        }
                      : { status: "unavailable", onRetry: next.onRetry };
                  },
                }
              : {}),
          })
      : undefined;
  if (pastedText) {
    return html`<openclaw-chat-pasted-text
      .src=${safeAttachmentUrl && !isCrossOriginHttpSource(safeAttachmentUrl) ? safeAttachmentUrl : undefined}
      .sizeBytes=${media?.sizeBytes ?? attachment.sizeBytes}
      .scope=${JSON.stringify([attachment.url, options.sessionKey, options.agentId, options.connectionEpoch, options.resourceBasePath, options.authToken, options.policyKey])}
      .onOpen=${openAttachmentSidebar}
    ></openclaw-chat-pasted-text>`;
  }
  if (imageAttachment) {
    const title = attachment.label.trim() || t("chat.imageLightbox.untitled");
    return html`<openclaw-chat-svg-attachment
      .src=${attachmentUrl}
      .sourceIdentity=${attachment.url}
      .label=${title}
      .mimeType=${attachment.mimeType ?? "image/svg+xml"}
      .sizeBytes=${media?.sizeBytes}
      .downloadHref=${safeAttachmentHref(attachmentUrl)}
      .onOpen=${(src: string, release: () => void) =>
        openResolvedImage(onOpenImage, src, title, release, onRequestOpenImage?.())}
      .onExpand=${openAttachmentSidebar}
      .onMediaLoaded=${onAssistantAttachmentLoaded}
    ></openclaw-chat-svg-attachment>`;
  }
  if ((attachment.kind === "audio" || attachment.kind === "video") && !safeAttachmentUrl) {
    return renderAssistantAttachmentStatusCard({
      label: attachment.label,
      mimeType: attachment.mimeType,
      badge: t("chat.attachments.unavailable"),
      reason: t("chat.attachments.previewUnavailable"),
    });
  }
  if (presentation === "inline" && attachment.kind === "audio") {
    return html`<openclaw-chat-audio-player
      .src=${safeAttachmentUrl}
      .sourceIdentity=${attachment.url}
      .label=${attachment.label}
      .mimeType=${attachment.mimeType ?? ""}
      .playback=${media?.playback}
      .authToken=${media?.authToken}
      .sizeBytes=${media?.sizeBytes}
      .serverDurationMs=${media?.durationMs}
      .voiceNote=${attachment.isVoiceNote === true}
      .onExpand=${openAttachmentSidebar}
      .onMediaLoaded=${onAssistantAttachmentLoaded}
    ></openclaw-chat-audio-player>`;
  }
  if (presentation === "inline" && attachment.kind === "video") {
    return html`<openclaw-chat-video-player
      .src=${safeAttachmentUrl}
      .sourceIdentity=${attachment.url}
      .label=${attachment.label}
      .mimeType=${attachment.mimeType ?? ""}
      .playback=${media?.playback}
      .authToken=${media?.authToken}
      .sizeBytes=${media?.sizeBytes}
      .mediaWidth=${media?.width}
      .mediaHeight=${media?.height}
      .onExpand=${openVideoOverlay}
      .onFallbackExpand=${openAttachmentSidebar}
      .onMediaLoaded=${onAssistantAttachmentLoaded}
    ></openclaw-chat-video-player>`;
  }
  const card = renderCompactAttachmentCard({
    kind: attachment.kind,
    label: attachment.label,
    mimeType: attachment.mimeType,
    sizeBytes: media?.sizeBytes,
    downloadHref: safeAttachmentUrl,
    onExpand: openAttachmentSidebar,
    voiceNote: attachment.isVoiceNote === true,
  });
  if (
    presentation === "preview" &&
    attachment.kind === "video" &&
    media?.playback === "native" &&
    safeAttachmentUrl &&
    openAttachmentSidebar
  ) {
    return renderMessageVideoPreview({
      key: JSON.stringify([
        options.resourceBasePath ?? "",
        options.authToken?.trim() ?? "",
        options.sessionKey,
        options.agentId,
        options.policyKey,
        options.connectionEpoch ?? 0,
        attachment.url,
        attachment.artifactId,
        safeAttachmentUrl,
        400,
        225,
      ]),
      src: safeAttachmentUrl,
      label: attachment.label,
      onOpen: openAttachmentSidebar,
      fallback: card,
    });
  }
  return card;
}
