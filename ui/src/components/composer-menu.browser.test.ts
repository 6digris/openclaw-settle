import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderComposerMenu, renderComposerMenuOption } from "./composer-menu.ts";

const host = document.createElement("div");

afterEach(() => {
  render(html``, host);
  host.remove();
});

function mountMenu() {
  document.body.append(host);
  let active = 0;
  let updates = 0;
  const selections: number[] = [];
  const draw = () =>
    render(
      renderComposerMenu({
        id: "pointer-intent-menu",
        label: "Suggestions",
        content: [0, 1].map((index) =>
          renderComposerMenuOption({
            id: `suggestion-${index}`,
            active: active === index,
            hover: () => {
              active = index;
              updates += 1;
              draw();
            },
            select: () => selections.push(index),
            icon: nothing,
            name: `Suggestion ${index}`,
            description: "",
          }),
        ),
      }),
      host,
    );
  draw();
  const option = host.querySelector<HTMLElement>("#suggestion-1")!;
  return { option, updates: () => updates, selections };
}

describe("composer suggestion pointer intent", () => {
  it.each(["mouse", "pen"])(
    "selects once on %s movement and ignores boundary entries",
    (pointerType) => {
      const { option, updates } = mountMenu();
      option.dispatchEvent(new MouseEvent("mouseenter"));
      option.dispatchEvent(new PointerEvent("pointerenter", { pointerType }));
      expect(option.getAttribute("aria-selected")).toBe("false");
      expect(updates()).toBe(0);

      // The first movement after a pointer enters the viewport can have zero deltas.
      option.dispatchEvent(new PointerEvent("pointermove", { pointerType, bubbles: true }));
      expect(option.getAttribute("aria-selected")).toBe("true");
      for (let index = 0; index < 20; index += 1) {
        option.dispatchEvent(
          new PointerEvent("pointermove", { pointerType, movementX: 1, bubbles: true }),
        );
      }
      expect(option.getAttribute("aria-selected")).toBe("true");
      expect(updates()).toBe(1);
    },
  );

  it("leaves touch scrolling unselected and allows a direct click without prior movement", () => {
    const { option, updates, selections } = mountMenu();
    option.dispatchEvent(
      new PointerEvent("pointermove", { pointerType: "touch", movementY: 10, bubbles: true }),
    );
    expect(option.getAttribute("aria-selected")).toBe("false");
    expect(updates()).toBe(0);
    option.click();
    expect(selections).toEqual([1]);
  });
});
