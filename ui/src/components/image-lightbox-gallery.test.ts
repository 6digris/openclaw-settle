import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ImageLightboxGalleryController } from "./image-lightbox-gallery.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";

function imageItem(title: string) {
  return { src: `https://example.com/${title}.png`, title, release: vi.fn() };
}

let decode: ReturnType<typeof vi.fn<() => Promise<void>>>;
let controller: ImageLightboxGalleryController;

beforeEach(() => {
  decode = vi.fn(async () => {});
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
  controller = new ImageLightboxGalleryController(vi.fn());
});

afterEach(() => {
  controller.dispose();
  vi.unstubAllGlobals();
});

describe("image lightbox gallery resource lifecycle", () => {
  it.each(
    (["close", "reset"] as const).flatMap((action) =>
      (["initial", "neighbor"] as const).map((loading) => ({ action, loading })),
    ),
  )(
    "releases a late $loading image once after $action without replacing the current selection",
    async ({ action, loading }) => {
      const initial: ImageLightboxItem = imageItem("initial");
      const late = imageItem("late");
      const replacement = imageItem("replacement");
      const pending = createDeferred<ImageLightboxItem | null>();
      const load = vi.fn(() => pending.promise);
      if (loading === "initial") {
        initial.loadOriginal = load;
      }
      controller.reset({ index: 0, items: [async () => initial, load] }, initial);
      const moving = loading === "neighbor" ? controller.move(1) : undefined;
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      expect(controller.current).toBe(initial);
      expect(controller.busy).toBe(true);

      if (action === "reset") {
        controller.reset(undefined, replacement);
      } else {
        controller.dispose();
      }
      pending.resolve(late);

      if (moving) {
        expect(await moving).toBe(false);
      }
      await vi.waitFor(() => expect(late.release).toHaveBeenCalledOnce());
      expect(controller.current).toBe(action === "reset" ? replacement : undefined);
      expect(controller.busy).toBe(false);
      expect(controller.failed).toBe(false);
      controller.dispose();
      await Promise.resolve();
      expect(late.release).toHaveBeenCalledOnce();
      expect(initial.release).not.toHaveBeenCalled();
      expect(replacement.release).not.toHaveBeenCalled();
    },
  );

  it("keeps the preview until its original decodes and owns the replacement lease", async () => {
    const response = createDeferred<ImageLightboxItem | null>();
    const decoded = createDeferred();
    decode.mockImplementation(() => decoded.promise);
    const preview = { ...imageItem("preview"), loadOriginal: () => response.promise };
    const original = imageItem("original");
    controller.reset(undefined, preview);
    expect(controller.current).toBe(preview);
    expect(controller.busy).toBe(true);
    response.resolve(original);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(controller.current).toBe(preview);
    decoded.resolve();
    await vi.waitFor(() => expect(controller.current).toBe(original));
    expect(controller.busy).toBe(false);
    expect(controller.failed).toBe(false);
    controller.dispose();
    await vi.waitFor(() => expect(original.release).toHaveBeenCalledOnce());
    expect(preview.release).not.toHaveBeenCalled();
  });

  it("keeps the current image after a failed neighbor load and retries on navigation", async () => {
    const initial = imageItem("initial");
    const broken = imageItem("broken");
    const recovered = imageItem("recovered");
    const load = vi
      .fn<() => Promise<ImageLightboxItem | null>>()
      .mockResolvedValueOnce(broken)
      .mockRejectedValueOnce(new Error("Image temporarily unavailable"))
      .mockResolvedValue(recovered);
    decode.mockRejectedValueOnce(new Error("Image decode failed"));
    controller.reset({ index: 0, items: [async () => initial, load] }, initial);
    await vi.waitFor(() => expect(broken.release).toHaveBeenCalledOnce());
    // A failed speculative preload does not replace the visible image with an error.
    expect(controller.current).toBe(initial);
    expect(controller.failed).toBe(false);

    expect(await controller.move(1)).toBe(false);
    expect(controller.current).toBe(initial);
    expect(controller.index).toBe(0);
    expect(controller.failed).toBe(true);
    expect(controller.busy).toBe(false);

    expect(await controller.move(1)).toBe(true);
    expect(controller.current).toBe(recovered);
    expect(controller.index).toBe(1);
    expect(controller.failed).toBe(false);
    controller.dispose();
    await vi.waitFor(() => expect(recovered.release).toHaveBeenCalledOnce());
    expect(broken.release).toHaveBeenCalledOnce();
    expect(initial.release).not.toHaveBeenCalled();
  });

  it("preloads only adjacent images and releases evicted leases before closing", async () => {
    const previous = imageItem("previous");
    const initial = imageItem("initial");
    const next = imageItem("next");
    const beyond = imageItem("beyond");
    const farthest = imageItem("farthest");
    const images = [previous, initial, next, beyond, farthest];
    const loads = images.map((item) => vi.fn(async () => item));
    controller.reset({ index: 1, items: loads }, initial);
    await vi.waitFor(() => {
      expect(loads[0]).toHaveBeenCalledOnce();
      expect(loads[2]).toHaveBeenCalledOnce();
    });
    expect(loads[1]).not.toHaveBeenCalled();
    expect(loads[3]).not.toHaveBeenCalled();
    expect(loads[4]).not.toHaveBeenCalled();

    expect(await controller.move(1)).toBe(true);
    expect(controller.current).toBe(images[2]);
    await vi.waitFor(() => expect(previous.release).toHaveBeenCalledOnce());
    expect(next.release).not.toHaveBeenCalled();
    expect(await controller.move(1)).toBe(true);
    expect(controller.current).toBe(images[3]);
    await vi.waitFor(() => expect(loads[4]).toHaveBeenCalledOnce());
    expect(initial.release).not.toHaveBeenCalled();

    controller.dispose();
    await vi.waitFor(() => {
      for (const image of [previous, next, beyond, farthest]) {
        expect(image.release).toHaveBeenCalledOnce();
      }
    });
    expect(initial.release).not.toHaveBeenCalled();
  });
});
