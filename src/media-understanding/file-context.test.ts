import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { renderInboundDocumentContext } from "./file-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("renderInboundDocumentContext", () => {
  it.each([undefined, 13])(
    "renders actual attachment text without mutating input (maxChars=%s)",
    async (maxChars) => {
      const workspaceDir = tempDirs.make("openclaw-document-context-");
      const mediaPath = path.join(workspaceDir, "steer-note.txt");
      const text = "document body for the steered run";
      await fs.writeFile(mediaPath, text);
      const ctx: MsgContext = {
        Body: "see attached",
        media: [{ path: mediaPath, contentType: "text/plain" }],
      };
      const original = structuredClone(ctx);

      const context = await renderInboundDocumentContext({ ctx, cfg: {}, workspaceDir, maxChars });

      expect(context.text).toContain('<file name="steer-note.txt" mime="text/plain">');
      expect(context.text).toContain(text.slice(0, maxChars));
      if (maxChars === undefined) {
        expect(context.text).not.toContain("[Partial document:");
      } else {
        expect(context.text).toContain("[Partial document: text truncated.]");
        expect(context.text).not.toContain("for the steered run");
        expect(context.text.indexOf("[Partial document:")).toBeLessThan(
          context.text.indexOf("<<<EXTERNAL_UNTRUSTED_CONTENT"),
        );
      }
      expect(context.images).toEqual([]);
      // Rejected steering must leave the original input available for normal dispatch.
      expect(ctx).toEqual(original);
    },
  );
});
