// Control UI tests cover markdown behavior.
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("toSanitizedMarkdownHtml", () => {
  describe("code blocks", () => {
    const jsonBlock = (lineCount: number) => {
      const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
      values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
      return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
    };

    it("separates cached GitHub references by repository and absent context", () => {
      const source = "PR #141270";
      for (const githubRepo of [
        { owner: "first", repo: "one" },
        { owner: "second", repo: "one" },
        { owner: "second", repo: "two" },
        null,
      ]) {
        const fragment = htmlFragment(toSanitizedMarkdownHtml(source, { githubRepo }));
        expect(fragment.querySelector("a")?.getAttribute("href") ?? null).toBe(
          githubRepo
            ? `https://github.com/${githubRepo.owner}/${githubRepo.repo}/pull/141270`
            : null,
        );
      }
    });

    it("keeps the no-chrome code-block cache separate from copy-enabled rendering", () => {
      const markdown = "```\ncode\n```";
      const plain = toSanitizedMarkdownHtml(markdown, { codeBlockChrome: "none" });
      const copyable = toSanitizedMarkdownHtml(markdown);

      expect(htmlFragment(plain).querySelector(".code-block-copy")).toBeNull();
      expect(htmlFragment(copyable).querySelector(".code-block-copy")).toBeInstanceOf(
        HTMLButtonElement,
      );
    });

    it("keeps the interactive code-block cache separate from static rendering", () => {
      const markdown = jsonBlock(41);
      const staticHtml = toSanitizedMarkdownHtml(markdown);
      const interactiveHtml = toSanitizedMarkdownHtml(markdown, {
        codeBlockInteraction: "interactive",
      });

      expect(htmlFragment(staticHtml).querySelector(".code-block-expand")).toBeNull();
      expect(htmlFragment(interactiveHtml).querySelector(".code-block-expand")).toBeInstanceOf(
        HTMLButtonElement,
      );
    });
  });

  describe("large text handling", () => {
    it("does not build cache keys for replies larger than the cache limit", () => {
      const locale = vi.spyOn(i18n, "getLocale");

      expect(toSanitizedMarkdownHtml("x".repeat(50_001))).toContain("x".repeat(100));
      expect(locale).not.toHaveBeenCalled();
      locale.mockRestore();
    });

    it("uses plain text fallback for oversized content", () => {
      // MARKDOWN_PARSE_LIMIT is 40_000 chars
      const input = Array.from(
        { length: 220 },
        (_, i) =>
          `Paragraph ${i + 1}: ${Array.from({ length: 8 }, () => "Long plain-text reply.").join(
            " ",
          )}`,
      ).join("\n\n");
      const html = toSanitizedMarkdownHtml(input);
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.tagName).toBe("DIV");
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(input);
    });

    it("preserves indentation in plain text fallback", () => {
      const input = `${"Header line\n".repeat(3400)}\n    indented log line\n        deeper indent`;
      const html = toSanitizedMarkdownHtml(input);
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(input);
    });

    it.each([false, true])(
      "preserves literal markup and text normalization with role headers %s",
      (assistantTranscriptRoleHeaders) => {
        const padding = "x".repeat(40_001);
        const input = `&lt;b&gt;<img src=x onerror=alert(1)> "' \u00a0\0\r\n\u2028${padding}`;
        const escaped = `&amp;lt;b&amp;gt;&lt;img src=x onerror=alert(1)&gt; "' &nbsp;\n\n${padding}`;
        const translate = vi.spyOn(i18n, "t").mockReturnValue("Helper &\0\r\n<");

        try {
          const html = toSanitizedMarkdownHtml(input, { assistantTranscriptRoleHeaders });
          expect(html).toBe(
            assistantTranscriptRoleHeaders
              ? `<div class="markdown-plain-text-fallback"><code class="assistant-transcript-role">Helper &amp;\n&lt;:</code>\n<span class="markdown-plain-text-source">${escaped}</span></div>`
              : `<div class="markdown-plain-text-fallback">${escaped}</div>`,
          );
          expect(htmlFragment(html).querySelector("img")).toBeNull();
        } finally {
          translate.mockRestore();
        }
      },
    );

    it("caches oversized fallback results", () => {
      const input =
        Array.from({ length: 240 }, (_, i) => `P${i}`).join("\n\n") + "x".repeat(45_000);
      const first = toSanitizedMarkdownHtml(input);
      const second = toSanitizedMarkdownHtml(input);
      expect(input.length).toBeGreaterThan(40_000);
      expect(htmlFragment(first).firstElementChild?.className).toBe("markdown-plain-text-fallback");
      expect(second).toBe(first);
    });
  });
});
