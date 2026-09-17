import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("external Markdown destinations", () => {
  it.each([
    { kind: "complete", renderMarkdown: toSanitizedMarkdownHtml },
    {
      kind: "streaming",
      renderMarkdown: (text: string) => toStreamingMarkdownParts(text).join(""),
    },
  ])(
    "marks external destinations without changing $kind message copy or image-only labels",
    ({ renderMarkdown }) => {
      const fragment = htmlFragment(
        renderMarkdown(
          "[Read **the guide**](https://example.test/guide) and [Settings](/settings/about).\n\n[![Build status](data:image/png;base64,x)](https://example.test/build)",
        ),
      );
      const external = fragment.querySelector('a[href="https://example.test/guide"]');
      expect(external?.querySelectorAll("openclaw-external-link")).toHaveLength(1);
      expect(external?.textContent).toBe("Read the guide");
      expect(external?.querySelector("strong")?.textContent).toBe("the guide");
      const internal = fragment.querySelector('a[href="/settings/about"]');
      expect(internal).not.toBeNull();
      expect(internal?.querySelector("openclaw-external-link")).toBeNull();
      const imageLink = fragment.querySelector('a[href="https://example.test/build"]');
      expect(imageLink?.getAttribute("aria-label")).toBe("Build status (opens in a new tab)");
      expect(
        imageLink?.querySelector("openclaw-external-link")?.hasAttribute("data-icon-only"),
      ).toBe(true);
      expect(imageLink?.querySelector("img")?.getAttribute("alt")).toBe("Build status");
    },
  );
  it.each([
    {
      input:
        '[![Build status](data:image/png;base64,x)![Passing](data:image/png;base64,x)](https://example.test/build "Build details")',
      name: "Build status Passing",
      imageOnly: true,
    },
    {
      input:
        "[![](data:image/png;base64,x)![Build status](data:image/png;base64,x)](https://example.test/build)",
      name: "image Build status",
      imageOnly: true,
    },
    {
      input: '[](https://example.test/details "Build details")',
      name: "Build details",
      imageOnly: false,
    },
    {
      input: '[](https://github.com/openclaw/openclaw/issues/150454 "Issue details")',
      name: "Issue details",
      imageOnly: false,
    },
  ])("preserves the generated link name $name", ({ input, name, imageOnly }) => {
    for (const html of [toSanitizedMarkdownHtml(input), toStreamingMarkdownParts(input).join("")]) {
      const link = htmlFragment(html).querySelector("a");
      expect(link?.getAttribute("aria-label")).toBe(`${name} (opens in a new tab)`);
      expect(link?.querySelectorAll("openclaw-external-link")).toHaveLength(1);
      expect(link?.querySelector("openclaw-external-link")?.hasAttribute("data-icon-only")).toBe(
        imageOnly,
      );
      expect(link?.textContent).toBe("");
    }
  });
  it.each([
    ["absolute href", `[Open session](${location.origin}/chat/roboclaw/d0effac9)`],
    ["bare URL", `${location.origin}/chat/roboclaw/d0effac9`],
    ["relative href", "[Open session](/chat/roboclaw/d0effac9)"],
    ["literal with a file extension", "[Open session](/chat/roboclaw/d0effac9.md)"],
    ["inline URL", `\`${location.origin}/chat/roboclaw/d0effac9\``],
    ["inline relative URL", "`/chat/roboclaw/d0effac9`"],
  ])("decorates host-local session URLs in %s", (_kind, input) => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(input, { sessionLinks: true, fileLinks: true }),
    );
    const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-session-link");
    expect(link?.getAttribute("href")).toContain("/chat/roboclaw/d0effac9");
    expect(link?.hasAttribute("target")).toBe(false);
    expect(link?.querySelector("openclaw-external-link")).toBeNull();
    expect(link?.hasAttribute("data-file-path")).toBe(false);
    expect(link?.hasAttribute("data-session-key")).toBe(false);
    expect(fragment.querySelector("a a")).toBeNull();
  });
});
