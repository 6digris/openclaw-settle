import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import type { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";

export type ChatAttachmentControlsProps = {
  /** Decoded-size ceilings from hello policy; absent means no client-side cap. */
  attachmentLimits?: { maxBytes: number; maxImageBytes: number };
  attachmentReads?: ChatAttachmentReadLifecycle;
  attachments?: ChatAttachment[];
  disabled?: boolean;
  getAttachments?: () => ChatAttachment[];
  draft?: string;
  getDraft?: () => string;
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onRemoveAttachment?: (attachment: ChatAttachment) => void;
  onDraftChange?: (next: string) => void;
  onPendingReadsChange?: (delta: 1 | -1) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onRequestUpdate?: () => void;
  readSignal?: AbortSignal;
};
