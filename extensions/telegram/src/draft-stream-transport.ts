import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import { escapeTelegramHtml } from "./format.js";
import {
  withTelegramPlainFallback,
  warnTelegramRichBlocksDegradations,
} from "./rich-plain-fallback.js";
import type { TelegramTextDeliveryPage } from "./telegram-text-delivery.js";

export type TelegramDraftMessageSnapshot = {
  text: string;
  sourceText: string;
  sourceTextMode?: "html" | "markdown";
};

export type TelegramDraftTransportReceipt = {
  message: Message;
  snapshot: TelegramDraftMessageSnapshot;
};

type TelegramDraftSendMessageParams = NonNullable<Parameters<Bot["api"]["sendMessage"]>[2]>;

type TelegramDraftTransport = {
  send: (
    page: TelegramTextDeliveryPage,
    sendMessageParams: TelegramDraftSendMessageParams,
    assertPlatformSendAuthorized?: () => void,
  ) => Promise<TelegramDraftTransportReceipt>;
  edit: (
    page: TelegramTextDeliveryPage,
    messageId: number,
    assertPlatformSendAuthorized?: () => void,
  ) => Promise<TelegramDraftMessageSnapshot>;
};

export function toDraftSnapshot(page: TelegramTextDeliveryPage): TelegramDraftMessageSnapshot {
  return {
    text: page.plainText,
    sourceText: page.sourceText,
    sourceTextMode: page.sourceTextMode,
  };
}

function fallbackSnapshot(plainText: string): TelegramDraftMessageSnapshot {
  return {
    text: plainText,
    sourceText: escapeTelegramHtml(plainText),
    sourceTextMode: "html",
  };
}

export function createTelegramDraftTransport(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  linkPreview?: boolean;
  warn?: (message: string) => void;
}): TelegramDraftTransport {
  const { api, chatId } = params;
  // Telegram re-enables previews when an edit omits this field. Carry it on
  // sends and edits; finalization may reuse an already-correct preview.
  const linkPreviewParams =
    params.linkPreview === false ? ({ link_preview_options: { is_disabled: true } } as const) : {};
  const editMessageTextWithPreview = async (
    messageId: number,
    text: string,
    other?: NonNullable<Parameters<Bot["api"]["editMessageText"]>[3]>,
  ) => {
    const merged = other ? { ...other, ...linkPreviewParams } : linkPreviewParams;
    // Keep the call arity unchanged when no preview options apply.
    return Object.keys(merged).length > 0
      ? await api.editMessageText(chatId, messageId, text, merged)
      : await api.editMessageText(chatId, messageId, text);
  };

  return {
    async send(page, sendMessageParams, assertPlatformSendAuthorized) {
      assertPlatformSendAuthorized?.();
      if (page.richMessage) {
        const richMessage = page.richMessage;
        warnTelegramRichBlocksDegradations({
          context: "stream preview",
          reasons: page.degradationReasons ?? [],
          warn: (message) => params.warn?.(message),
        });
        return await withTelegramPlainFallback<TelegramDraftTransportReceipt>({
          kind: "rich",
          context: "stream preview",
          plainText: page.plainText,
          warn: (message) => params.warn?.(message),
          sendFormatted: async () => ({
            message: await api.raw.sendRichMessage({
              chat_id: chatId,
              rich_message: richMessage,
              ...sendMessageParams,
            }),
            snapshot: toDraftSnapshot(page),
          }),
          sendPlain: async (plan) => {
            assertPlatformSendAuthorized?.();
            return {
              message: await api.sendMessage(chatId, plan.plainText, {
                ...sendMessageParams,
                ...linkPreviewParams,
              }),
              snapshot: fallbackSnapshot(plan.plainText),
            };
          },
        });
      }
      if (page.sourceTextMode !== "html") {
        return {
          message: await api.sendMessage(chatId, page.plainText, {
            ...sendMessageParams,
            ...linkPreviewParams,
          }),
          snapshot: toDraftSnapshot(page),
        };
      }
      return await withTelegramPlainFallback<TelegramDraftTransportReceipt>({
        kind: "html",
        context: "stream preview",
        plainText: page.plainText,
        warn: (message) => params.warn?.(message),
        sendFormatted: async () => ({
          message: await api.sendMessage(chatId, page.htmlText ?? page.sourceText, {
            parse_mode: "HTML" as const,
            ...sendMessageParams,
            ...linkPreviewParams,
          }),
          snapshot: toDraftSnapshot(page),
        }),
        sendPlain: async (plan) => {
          assertPlatformSendAuthorized?.();
          return {
            message: await api.sendMessage(chatId, plan.plainText, {
              ...sendMessageParams,
              ...linkPreviewParams,
            }),
            snapshot: fallbackSnapshot(plan.plainText),
          };
        },
      });
    },
    async edit(page, messageId, assertPlatformSendAuthorized) {
      assertPlatformSendAuthorized?.();
      if (page.richMessage) {
        const richMessage = page.richMessage;
        warnTelegramRichBlocksDegradations({
          context: "stream preview edit",
          reasons: page.degradationReasons ?? [],
          warn: (message) => params.warn?.(message),
        });
        return await withTelegramPlainFallback<TelegramDraftMessageSnapshot>({
          kind: "rich",
          context: "stream preview edit",
          plainText: page.plainText,
          warn: (message) => params.warn?.(message),
          sendFormatted: async () => {
            await api.raw.editMessageText({
              chat_id: chatId,
              message_id: messageId,
              rich_message: richMessage,
            });
            return toDraftSnapshot(page);
          },
          sendPlain: async (plan) => {
            assertPlatformSendAuthorized?.();
            await editMessageTextWithPreview(messageId, plan.plainText);
            return fallbackSnapshot(plan.plainText);
          },
        });
      }
      if (page.sourceTextMode === "html") {
        return await withTelegramPlainFallback<TelegramDraftMessageSnapshot>({
          kind: "html",
          context: "stream preview edit",
          plainText: page.plainText,
          warn: (message) => params.warn?.(message),
          sendFormatted: async () => {
            await editMessageTextWithPreview(messageId, page.htmlText ?? page.sourceText, {
              parse_mode: "HTML" as const,
            });
            return toDraftSnapshot(page);
          },
          sendPlain: async (plan) => {
            assertPlatformSendAuthorized?.();
            await editMessageTextWithPreview(messageId, plan.plainText);
            return fallbackSnapshot(plan.plainText);
          },
        });
      }
      await editMessageTextWithPreview(messageId, page.sourceText);
      return toDraftSnapshot(page);
    },
  };
}
