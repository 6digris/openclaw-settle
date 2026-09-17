import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { MediaFact } from "../../../media/media-facts.js";
import { ensureStagedInputDirectory } from "../../../media/staged-inputs.js";
import { materializeProviderContext } from "./images.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
  "base64",
);
const MP4 = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");
const DIRECTORY = "media/inbound/openclaw-staged-11111111-1111-4111-8111-111111111111";

describe("relocated staged media at provider context materialization", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);

  async function fixture(kind: "image" | "video" = "image") {
    const root = directories.make("openclaw-media-relocation-");
    const workspaceDir = path.join(root, "current");
    const oldWorkspace = path.join(root, "old");
    await fs.mkdir(workspaceDir);
    await ensureStagedInputDirectory(workspaceDir, DIRECTORY);
    const relative = `${DIRECTORY}/input-attachment.${kind === "image" ? "png" : "mp4"}`;
    const currentPath = path.join(workspaceDir, relative);
    const sourcePath = path.join(oldWorkspace, relative);
    const bytes = kind === "image" ? PNG : MP4;
    await fs.writeFile(currentPath, bytes);
    const fact: MediaFact = {
      kind,
      path: sourcePath,
      url: sourcePath,
      workspaceDir: oldWorkspace,
      contentType: kind === "image" ? "image/png" : "video/mp4",
    };
    const render = async (localRoots = [workspaceDir]) => {
      const message = {
        role: "user" as const,
        content: "preserved user message",
        timestamp: 1,
        __openclaw: { media: [fact] },
      };
      const original = structuredClone(message);
      const result = await materializeProviderContext({
        context: { messages: [message] },
        workspaceDir,
        localRoots,
      });
      expect(message).toEqual(original);
      return result.messages.flatMap((entry) =>
        entry.role === "user" && Array.isArray(entry.content)
          ? entry.content.filter((block) => block.type === "image" || block.type === "video")
          : [],
      );
    };
    return { root, workspaceDir, oldWorkspace, currentPath, sourcePath, fact, bytes, render };
  }

  it.each(["image", "video"] as const)(
    "reads the exact copied %s without changing facts",
    async (kind) => {
      const input = await fixture(kind);
      expect(await input.render()).toEqual([
        { type: kind, data: input.bytes.toString("base64"), mimeType: input.fact.contentType },
      ]);
    },
  );

  it("keeps a present original ahead of a changed copy", async () => {
    const input = await fixture();
    await fs.mkdir(path.dirname(input.sourcePath), { recursive: true });
    await fs.writeFile(input.sourcePath, PNG);
    await fs.writeFile(input.currentPath, "changed copy is not an image");
    expect(await input.render([input.workspaceDir, input.oldWorkspace])).toEqual([
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
    ]);
    expect(await input.render()).toEqual([]);
  });

  it("does not turn a denied original into permission to read the copy", async () => {
    const input = await fixture();
    const original = fs.lstat;
    const denied = Object.assign(new Error("denied original"), { code: "EACCES" });
    const lstat = vi
      .spyOn(fs, "lstat")
      .mockImplementation((candidate, ...options) =>
        candidate === input.sourcePath ? Promise.reject(denied) : original(candidate, ...options),
      );
    try {
      expect(await input.render()).toEqual([]);
      expect(lstat).toHaveBeenCalledWith(input.sourcePath);
    } finally {
      lstat.mockRestore();
    }
  });

  it.each(["missing", "altered", "symlink", "hardlink"])(
    "rejects a %s ownership marker",
    async (kind) => {
      const input = await fixture();
      const marker = path.join(path.dirname(input.currentPath), ".gitignore");
      const preserved = path.join(input.root, "marker");
      await fs.rename(marker, preserved);
      if (kind === "altered") await fs.writeFile(marker, "*\n");
      if (kind === "symlink") await fs.symlink(preserved, marker);
      if (kind === "hardlink") await fs.link(preserved, marker);
      expect(await input.render()).toEqual([]);
    },
  );

  it("does not search another staged identity for a matching basename", async () => {
    const input = await fixture();
    input.fact.path = input.sourcePath.replace(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
    input.fact.url = input.fact.path;
    expect(await input.render()).toEqual([]);
  });

  it.each(["missing-workspace", "plain-path", "traversal", "suppressed", "media-uri"])(
    "does not rebase %s facts",
    async (kind) => {
      const input = await fixture();
      if (kind === "missing-workspace") delete input.fact.workspaceDir;
      if (kind === "plain-path")
        input.fact.path = path.join(input.oldWorkspace, "input-attachment.png");
      if (kind === "traversal")
        input.fact.path = `${path.dirname(input.sourcePath)}/../${path.basename(path.dirname(input.sourcePath))}/input-attachment.png`;
      if (kind === "suppressed") input.fact.hydrationSuppressed = true;
      input.fact.url = kind === "media-uri" ? "media://inbound/unavailable.png" : input.fact.path;
      expect(await input.render()).toEqual([]);
    },
  );

  it("keeps the current root boundary after finding a copied input", async () => {
    const input = await fixture();
    const other = path.join(input.root, "other");
    await fs.mkdir(other);
    expect(await input.render([other])).toEqual([]);
    const outside = path.join(other, "outside.png");
    await fs.writeFile(outside, PNG);
    await fs.unlink(input.currentPath);
    await fs.symlink(outside, input.currentPath);
    expect(await input.render()).toEqual([]);
  });

  it("preserves the current workspace's allowed hardlink reads", async () => {
    const input = await fixture();
    const outside = path.join(input.root, "outside.png");
    await fs.writeFile(outside, PNG);
    await fs.unlink(input.currentPath);
    await fs.link(outside, input.currentPath);
    expect(await input.render()).toEqual([
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("rejects a linked staging directory inside the current workspace", async () => {
    const input = await fixture();
    const stage = path.dirname(input.currentPath);
    const moved = path.join(input.workspaceDir, "other-stage");
    await fs.rename(stage, moved);
    await fs.symlink(moved, stage, "junction");
    expect(await input.render()).toEqual([]);
  });
});
