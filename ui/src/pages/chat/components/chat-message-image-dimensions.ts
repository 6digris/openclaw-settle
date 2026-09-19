import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { readTranscriptMediaEntries } from "../../../lib/chat/message-extract.ts";
import { isImageMediaPath, isSvgImageMediaPath } from "../../../lib/media-file-extension.ts";
import type { ImageBlock } from "./chat-message-media.ts";

export function applyTranscriptImageDimensions(
  images: ImageBlock[],
  mediaEntries: ReturnType<typeof readTranscriptMediaEntries>,
): void {
  const imageFacts = mediaEntries.filter(
    (entry) =>
      isImageMediaPath(entry.path, entry.mediaType) &&
      !isSvgImageMediaPath(entry.path, entry.mediaType),
  );
  for (const image of images) {
    if (asPositiveFiniteNumber(image.width) && asPositiveFiniteNumber(image.height)) {
      continue;
    }
    const matches = imageFacts.filter((entry) =>
      image.factIndex !== undefined
        ? entry.factIndex === image.factIndex
        : entry.path === image.url,
    );
    const dimensions = matches[0];
    if (
      dimensions?.width !== undefined &&
      dimensions.height !== undefined &&
      matches.every(
        (entry) => entry.width === dimensions.width && entry.height === dimensions.height,
      )
    ) {
      image.width = dimensions.width;
      image.height = dimensions.height;
    }
  }
}
