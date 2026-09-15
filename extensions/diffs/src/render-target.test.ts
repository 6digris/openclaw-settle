// Diffs tests cover render target plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { preloadDiffHTMLMock } = vi.hoisted(() => ({
  preloadDiffHTMLMock: vi.fn(async () => "<div>mock diff</div>"),
}));

vi.mock("@pierre/diffs/ssr", () => ({
  preloadDiffHTML: preloadDiffHTMLMock,
}));

afterAll(() => {
  vi.doUnmock("@pierre/diffs/ssr");
  vi.resetModules();
});

import { resolveDiffImageRenderOptions, resolveDiffsPluginDefaults } from "./config.js";
import { renderDiffDocument } from "./render.js";

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);

function createRenderOptions() {
  return {
    presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
    image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
    expandUnchanged: false,
  };
}

describe("renderDiffDocument render targets", () => {
  beforeEach(() => {
    preloadDiffHTMLMock.mockClear();
  });

  it.each([
    { kind: "before_after", target: "viewer", keys: ["html"] },
    { kind: "before_after", target: "image", keys: ["imageHtml"] },
    { kind: "before_after", target: "both", keys: ["html", "imageHtml"] },
    { kind: "patch", target: "viewer", keys: ["html"] },
    { kind: "patch", target: "image", keys: ["imageHtml"] },
    { kind: "patch", target: "both", keys: ["html", "imageHtml"] },
  ] as const)(
    "keeps the $kind/$target envelope and escaped payload",
    async ({ kind, target, keys }) => {
      const title = "Title & <tag> \"quoted\" 'single'";
      const input =
        kind === "before_after"
          ? { kind, title, before: "old\n", after: "</script>\n", path: "sample.txt" }
          : {
              kind,
              title,
              patch: [
                "diff --git a/sample.txt b/sample.txt",
                "--- a/sample.txt",
                "+++ b/sample.txt",
                "@@ -1 +1 @@",
                "-old",
                "+</script>",
              ].join("\n"),
            };
      const rendered = await renderDiffDocument(input, createRenderOptions(), target);

      expect(Object.keys(rendered)).toEqual([
        ...keys,
        "title",
        "fileCount",
        "inputKind",
        "viewerRuntime",
      ]);
      expect(rendered).toMatchObject({
        title,
        fileCount: 1,
        inputKind: kind,
        viewerRuntime: "base",
      });
      for (const key of keys) {
        const html = rendered[key];
        expect(html).toContain(
          "<title>Title &amp; &lt;tag&gt; &quot;quoted&quot; &#39;single&#39;</title>",
        );
        expect(html).toContain(`data-render-mode="${key === "html" ? "viewer" : "image"}"`);
        expect(html).toContain('<script type="module" src="../../assets/viewer.js"></script>');
        expect(html).toContain('<template shadowrootmode="open"><div>mock diff</div></template>');
        expect(html).toContain("\\u003c/script>");
      }
      expect(preloadDiffHTMLMock).toHaveBeenCalledTimes(1);
    },
  );

  it("renders only the viewer variant for before/after viewer mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "one\n",
        after: "two\n",
      },
      createRenderOptions(),
      "viewer",
    );

    expect(rendered.html).toContain("mock diff");
    expect(rendered.imageHtml).toBeUndefined();
    expect(preloadDiffHTMLMock).toHaveBeenCalledTimes(1);
  });

  it("renders both variants for before/after both mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "one\n",
        after: "two\n",
      },
      createRenderOptions(),
      "both",
    );

    expect(rendered.html).toContain("mock diff");
    expect(rendered.imageHtml).toContain("mock diff");
    expect(preloadDiffHTMLMock).toHaveBeenCalledTimes(1);
  });

  it("renders only the image variant for patch image mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "patch",
        patch: [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      },
      createRenderOptions(),
      "image",
    );

    expect(rendered.html).toBeUndefined();
    expect(rendered.imageHtml).toContain("mock diff");
    expect(preloadDiffHTMLMock).toHaveBeenCalledTimes(1);
  });
});
