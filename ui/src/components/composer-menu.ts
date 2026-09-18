import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { scrollState } from "./scroll-state.ts";

export function handleComposerMenuKeydown(
  event: KeyboardEvent,
  menu: {
    count: number;
    index: number;
    consumeEmpty: boolean;
    close: () => void;
    move: (index: number) => string | null;
    select: (key: "Enter" | "Tab") => void;
  },
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    menu.close();
    return true;
  }
  if (
    !["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key) ||
    (menu.count === 0 && !menu.consumeEmpty)
  ) {
    return false;
  }
  event.preventDefault();
  if (menu.count > 0) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const offset = event.key === "ArrowDown" ? 1 : menu.count - 1;
      scrollActiveOptionIntoView(menu.move((menu.index + offset) % menu.count));
    } else if (event.key === "Enter" || event.key === "Tab") {
      menu.select(event.key);
    }
  }
  return true;
}

class RevealActiveOptionDirective extends AsyncDirective {
  private key: string | undefined;
  private pending = false;

  render(_key?: string) {
    return nothing;
  }

  override update(part: ElementPart, [key]: [string?]) {
    if (key !== this.key) {
      this.key = key;
      if (key !== undefined && !this.pending) {
        this.pending = true;
        // Children commit after element directives; reveal the current selection
        // only when the query or results change, preserving deliberate scrolling.
        queueMicrotask(() => {
          this.pending = false;
          if (this.isConnected && part.element.isConnected) {
            scrollActiveOptionInRegion(part.element);
          }
        });
      }
    }
    return nothing;
  }
}

const revealActiveOption = directive(RevealActiveOptionDirective);

export function renderComposerMenu(options: {
  id: string;
  label: string;
  className?: string;
  trackScroll?: boolean;
  activeOptionVisibilityKey?: string;
  content: unknown;
}) {
  return html`<div
    id=${options.id}
    class="slash-menu ${options.className ?? ""}"
    role="listbox"
    aria-label=${options.label}
  >
    <div
      class="slash-menu__scroll"
      ${scrollState(false, options.trackScroll)}
      ${revealActiveOption(options.activeOptionVisibilityKey)}
    >
      ${options.content}
    </div>
  </div>`;
}

export function renderComposerMenuOption(options: {
  id: string;
  active: boolean;
  select: () => void;
  hover: () => void;
  preserveFocus?: boolean;
  icon: unknown;
  iconHidden?: boolean;
  name: unknown;
  description: unknown;
}) {
  return html`<div
    id=${options.id}
    class="slash-menu-item ${options.active ? "slash-menu-item--active" : ""}"
    role="option"
    aria-selected=${options.active}
    @mousedown=${options.preserveFocus === false ? nothing : (event: MouseEvent) => event.preventDefault()}
    @click=${options.select}
    @mouseenter=${options.hover}
  >
    <span class="slash-menu-icon" aria-hidden=${options.iconHidden ? "true" : nothing}
      >${options.icon}</span
    >
    <span class="slash-menu-copy">
      <span class="slash-menu-name">${options.name}</span>
      <span class="slash-menu-desc">${options.description}</span>
    </span>
  </div>`;
}

function scrollActiveOptionIntoView(activeId: string | null): void {
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    scrollActiveOptionInRegion(document.getElementById(activeId)?.closest(".slash-menu__scroll"));
  });
}

function scrollActiveOptionInRegion(scrollRegion: Element | null | undefined): void {
  const activeOption = scrollRegion?.querySelector('[role="option"][aria-selected="true"]');
  if (!activeOption || !scrollRegion) {
    return;
  }
  const menuBounds = scrollRegion.getBoundingClientRect();
  const optionBounds = activeOption.getBoundingClientRect();
  // scrollIntoView also moves the short-landscape composer and page.
  // Round outward because scrollTop can be quantized to whole CSS pixels.
  if (optionBounds.top < menuBounds.top) {
    scrollRegion.scrollTop = Math.floor(scrollRegion.scrollTop + optionBounds.top - menuBounds.top);
  } else if (optionBounds.bottom > menuBounds.bottom) {
    scrollRegion.scrollTop = Math.ceil(
      scrollRegion.scrollTop + optionBounds.bottom - menuBounds.bottom,
    );
  }
}
