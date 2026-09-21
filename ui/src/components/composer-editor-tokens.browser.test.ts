import { afterEach, describe, expect, it } from "vitest";
import { ComposerEditor, type ComposerChip } from "./composer-editor.ts";

afterEach(() => document.body.replaceChildren());

const tokens = [
  { kind: "skill" as const, raw: "$weekly_review", label: "Weekly Delivery Readiness Review" },
  { kind: "mention" as const, raw: "@Avery Stone", label: "Avery Stone" },
];
function fixture(token: (typeof tokens)[number], value = `Use ${token.raw} now`) {
  const editor = new ComposerEditor();
  editor.style.cssText = "width: 360px; font: 16px / 24px sans-serif; --accent: rgb(170, 40, 20)";
  editor.value = value;
  editor.resolveChips = (text): ComposerChip[] => {
    const start = text.indexOf(token.raw);
    return start < 0 ? [] : [{ ...token, start, end: start + token.raw.length }];
  };
  document.body.append(editor);
  editor.focus();
  return editor;
}

describe.runIf("__vitest_browser__" in globalThis)("inline atomic tokens", () => {
  it.each(tokens)(
    "treats $kind as one character for arrows, selection, replacement and undo",
    async (token) => {
      const { userEvent } = await import("vitest/browser");
      const editor = fixture(token);
      const start = 4,
        end = start + token.raw.length;
      editor.setSelectionRange(start, start);
      await userEvent.keyboard("{ArrowRight}");
      expect(editor.selectionStart).toBe(end);
      await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([start, end]);
      await userEvent.keyboard("X");
      expect(editor.value).toBe("Use X now");
      await userEvent.keyboard("{Control>}z{/Control}");
      expect(editor.value).toBe(`Use ${token.raw} now`);
      expect(editor.shadowRoot!.querySelectorAll(".composer-chip")).toHaveLength(1);
      editor.setSelectionRange(end, end);
      await userEvent.keyboard("{Backspace}");
      expect(editor.value).toBe("Use  now");
      await userEvent.keyboard("{Control>}z{/Control}");
      editor.setSelectionRange(start, start);
      await userEvent.keyboard("{Delete}");
      expect(editor.value).toBe("Use  now");
    },
  );

  it.each(tokens)(
    "never places a caret inside $kind after clicking its label or icon",
    async (token) => {
      const { page, userEvent } = await import("vitest/browser");
      const editor = fixture(token);
      const start = 4,
        end = start + token.raw.length;
      for (const selector of [".composer-chip__icon", ".composer-chip__label"]) {
        const part = editor.shadowRoot!.querySelector<HTMLElement>(selector)!;
        for (const fraction of [0.1, 0.5, 0.9]) {
          await page
            .elementLocator(part)
            .click({ position: { x: part.clientWidth * fraction, y: part.clientHeight / 2 } });
          expect([start, end]).toContain(editor.selectionStart);
          expect(editor.selectionEnd).toBe(editor.selectionStart);
          expect(editor.shadowRoot!.activeElement).toBe(
            editor.shadowRoot!.querySelector(".cm-content"),
          );
          await userEvent.keyboard("{ArrowLeft}{ArrowRight}");
          expect(editor.selectionStart > start && editor.selectionStart < end).toBe(false);
        }
      }
      const label = editor.shadowRoot!.querySelector<HTMLElement>(".composer-chip__label")!;
      await page.elementLocator(label).dblClick();
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([start, end]);
      await userEvent.keyboard("replacement");
      expect(editor.value).toBe("Use replacement now");
    },
  );

  it.each(tokens)(
    "fits $kind on the text baseline without button chrome or a separate tab stop",
    async (token) => {
      const { userEvent } = await import("vitest/browser");
      const editor = fixture(token);
      const chip = editor.shadowRoot!.querySelector<HTMLElement>(".composer-chip")!;
      const style = getComputedStyle(chip);
      expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(style.borderTopWidth).toBe("0px");
      expect(style.paddingLeft).toBe("0px");
      expect(style.marginLeft).toBe("0px");
      const line = editor.shadowRoot!.querySelector<HTMLElement>(".cm-line")!;
      expect(line.getBoundingClientRect().height).toBe(24);
      const label = chip.querySelector("bdi")!;
      const textRange = document.createRange();
      textRange.selectNodeContents(line.firstChild!);
      const labelRange = document.createRange();
      labelRange.selectNodeContents(label);
      expect(
        Math.abs(
          textRange.getBoundingClientRect().bottom - labelRange.getBoundingClientRect().bottom,
        ),
      ).toBeLessThanOrEqual(0.5);
      const next = document.createElement("button");
      next.textContent = "Next";
      document.body.append(next);
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(next);
    },
  );
  it.each(tokens)(
    "walks and extends across every $kind boundary without hidden caret stops",
    async (token) => {
      const { userEvent } = await import("vitest/browser");
      const editor = fixture(token);
      const end = 4 + token.raw.length;
      const stops = [0, 1, 2, 3, 4, end, end + 1, end + 2, end + 3, end + 4];
      editor.setSelectionRange(0, 0);
      for (const expected of stops.slice(1)) {
        await userEvent.keyboard("{ArrowRight}");
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([expected, expected]);
      }
      for (const expected of stops.slice(0, -1).toReversed()) {
        await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([
          expected,
          editor.value.length,
        ]);
      }
      await userEvent.keyboard("{ArrowRight}");
      expect(editor.selectionStart).toBe(editor.value.length);
    },
  );

  it.each(tokens)(
    "cuts $kind as raw text, undoes, and deletes atomically through mobile input",
    async (token) => {
      const { userEvent } = await import("vitest/browser");
      const editor = fixture(token);
      const content = editor.shadowRoot!.querySelector<HTMLElement>(".cm-content")!;
      const start = 4,
        end = start + token.raw.length;
      editor.setSelectionRange(start + 2, end - 2);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([start, end]);
      const clipboard = new DataTransfer();
      content.dispatchEvent(
        new ClipboardEvent("cut", {
          clipboardData: clipboard,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      expect(clipboard.getData("text/plain")).toBe(token.raw);
      expect(editor.value).toBe("Use  now");
      await userEvent.keyboard("{Control>}z{/Control}");
      expect(editor.shadowRoot!.querySelectorAll(".composer-chip")).toHaveLength(1);
      for (const [inputType, caret] of [
        ["deleteContentBackward", end],
        ["deleteContentForward", start],
      ] as const) {
        editor.setSelectionRange(caret, caret);
        content.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        expect(editor.value).toBe("Use  now");
        await userEvent.keyboard("{Control>}z{/Control}");
        expect(editor.value).toBe(`Use ${token.raw} now`);
        expect(editor.shadowRoot!.querySelectorAll(".composer-chip")).toHaveLength(1);
      }
      editor.setSelectionRange(start, end);
      const paste = new DataTransfer();
      paste.setData("text/plain", "replacement");
      content.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: paste,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      expect(editor.value).toBe("Use replacement now");
    },
  );

  it.each(tokens)(
    "keeps $kind atomic at wrapped line edges and does not enlarge plain text lines",
    async (token) => {
      const { userEvent } = await import("vitest/browser");
      const editor = fixture(token);
      editor.style.width = "180px";
      const start = 4,
        end = start + token.raw.length;
      const chip = editor.shadowRoot!.querySelector<HTMLElement>(".composer-chip")!;
      expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth);
      expect(chip.getBoundingClientRect().height).toBe(24);
      editor.setSelectionRange(end, end);
      for (const key of [
        "{Home}",
        "{End}",
        "{ArrowUp}",
        "{ArrowDown}",
        "{Shift>}{Home}{/Shift}",
        "{Shift>}{End}{/Shift}",
      ]) {
        await userEvent.keyboard(key);
        for (const position of [editor.selectionStart, editor.selectionEnd]) {
          expect(position > start && position < end).toBe(false);
        }
      }
      expect(editor.value).toBe(`Use ${token.raw} now`);
    },
  );
  it.each(tokens)(
    "keeps $kind whole during word selection and RTL cursor movement",
    async (token) => {
      const { userEvent } = await import("vitest/browser");
      const editor = fixture(token);
      const start = 4,
        end = start + token.raw.length;
      editor.setSelectionRange(end, end);
      await userEvent.keyboard("{Control>}{Shift>}{ArrowLeft}{/Shift}{/Control}");
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([start, end]);
      editor.setSelectionRange(start, start);
      await userEvent.keyboard("{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}");
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([start, end]);
      editor.dir = "rtl";
      for (const caret of [start, end]) {
        editor.setSelectionRange(caret, caret);
        for (const key of [
          "{ArrowLeft}",
          "{ArrowRight}",
          "{Shift>}{ArrowLeft}{/Shift}",
          "{Shift>}{ArrowRight}{/Shift}",
        ]) {
          await userEvent.keyboard(key);
          for (const position of [editor.selectionStart, editor.selectionEnd]) {
            expect(position > start && position < end).toBe(false);
          }
        }
      }
    },
  );
  it("undoes and redoes recipient removal without replaying an older text edit", async () => {
    const { userEvent } = await import("vitest/browser");
    const editor = new ComposerEditor();
    let selected = true;
    const provider = (value: string): ComposerChip[] =>
      selected && value === "@Avery Finch "
        ? [{ kind: "mention", profileId: "avery", label: "Avery Finch", start: 0, end: 12 }]
        : [];
    editor.resolveChips = provider;
    editor.value = "@Avery";
    document.body.append(editor);
    editor.value = "@Avery Finch ";
    editor.addEventListener("input", () => {
      if (editor.restoredChips !== undefined) {
        selected = editor.restoredChips.length > 0;
      }
      editor.resolveChips = provider;
    });
    selected = false;
    editor.refreshChips(true);
    editor.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(editor.value).toBe("@Avery Finch ");
    expect(selected).toBe(true);
    await userEvent.keyboard("{Control>}{Shift>}Z{/Shift}{/Control}");
    expect(editor.value).toBe("@Avery Finch ");
    expect(selected).toBe(false);
  });
  it("orders provider groups by document position before atomic navigation and history", async () => {
    const { userEvent } = await import("vitest/browser");
    const editor = new ComposerEditor();
    editor.value = "@Avery Stone $weekly_review";
    editor.resolveChips = (value) =>
      tokens.flatMap((token) => {
        const start = value.indexOf(token.raw);
        return start < 0
          ? []
          : [
              {
                ...token,
                start,
                end: start + token.raw.length,
                ...(token.kind === "mention" ? { profileId: "avery" } : {}),
              },
            ];
      });
    document.body.append(editor);
    expect(
      [...editor.shadowRoot!.querySelectorAll(".composer-chip")].map((chip) =>
        chip.getAttribute("aria-label"),
      ),
    ).toEqual(["mention: Avery Stone", "skill: Weekly Delivery Readiness Review"]);
    editor.focus();
    editor.setSelectionRange(0, 0);
    await userEvent.keyboard("{ArrowRight}");
    expect(editor.selectionStart).toBe(12);
    await userEvent.keyboard("{Backspace}");
    expect(editor.value).toBe(" $weekly_review");
    let restored: readonly ComposerChip[] | undefined;
    editor.addEventListener("input", () => {
      restored = editor.restoredChips;
    });
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(restored?.map(({ profileId, start, end }) => ({ profileId, start, end }))).toEqual([
      { profileId: "avery", start: 0, end: 12 },
    ]);
    expect(editor.value).toBe("@Avery Stone $weekly_review");
  });
});
