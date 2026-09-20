const SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
function mimeTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Owns only the open-original link and its temporary blob, never gallery selection. */
export class ImageLightboxOriginal {
  url = "";
  busy = false;
  private blobUrl = "";
  private generation = 0;
  constructor(private readonly notify: () => void) {}

  dispose() {
    this.generation += 1;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = "";
    }
    this.url = "";
    this.busy = false;
  }

  async resolve(input: string) {
    this.dispose();
    const generation = this.generation;
    const source = input.trim();
    const prefix = source.slice(0, 5).toLowerCase();
    const data = prefix === "data:";
    const blob = prefix === "blob:";
    if (!data && !blob) {
      this.url = source;
      this.notify();
      return;
    }
    const mediaType = /^data:([^,]*)/i.exec(source)?.[1];
    // Active formats must never gain a top-level same-origin blob navigation.
    if (data && (!mediaType || !SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES.has(mimeTypeEssence(mediaType)))) {
      this.notify();
      return;
    }
    this.busy = true;
    this.notify();
    try {
      const response = await fetch(source);
      const contents = await response.blob();
      if (
        generation !== this.generation ||
        !SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES.has(mimeTypeEssence(contents.type))
      ) {
        return;
      }
      if (blob) {
        this.url = source;
      } else {
        this.blobUrl = URL.createObjectURL(contents);
        this.url = this.blobUrl;
      }
    } catch {
      // Inline media remains usable; omit an unavailable original link.
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.notify();
      }
    }
  }
}
