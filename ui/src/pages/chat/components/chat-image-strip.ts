import { html, nothing } from "lit";
import { AsyncDirective, directive, type ElementPart } from "lit/async-directive.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

// Image strips own their local scrolling; the transcript still owns vertical
// position. Observe the track as well as its viewport for late image decoding.
class ImageStripDirective extends AsyncDirective {
  private root: HTMLElement | undefined;
  private observer: ResizeObserver | undefined;
  private viewport: HTMLElement | undefined;
  private pending = false;

  render() {
    return nothing;
  }

  override update(part: ElementPart) {
    this.root = part.element instanceof HTMLElement ? part.element : undefined;
    this.schedule();
    return nothing;
  }

  private readonly schedule = () => {
    if (this.pending || !this.isConnected) {
      return;
    }
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (!this.isConnected || !this.root?.isConnected) {
        return;
      }
      const viewport = this.root.querySelector<HTMLElement>(".chat-image-carousel__viewport");
      const track = this.root.querySelector<HTMLElement>(".chat-image-carousel__track");
      if (!viewport || !track) {
        return;
      }
      if (this.viewport !== viewport) {
        this.viewport?.removeEventListener("scroll", this.measure);
        this.viewport = viewport;
        viewport.addEventListener("scroll", this.measure, { passive: true });
      }
      if (!this.observer && typeof ResizeObserver === "function") {
        this.observer = new ResizeObserver(this.measure);
        this.observer.observe(viewport);
        this.observer.observe(track);
      }
      this.measure();
    });
  };

  private readonly measure = () => {
    const root = this.root;
    const viewport = root?.querySelector<HTMLElement>(".chat-image-carousel__viewport");
    const track = root?.querySelector<HTMLElement>(".chat-image-carousel__track");
    if (!root || !viewport || !track || !this.isConnected) {
      return;
    }
    const rtl = getComputedStyle(viewport).direction === "rtl";
    const bounds = viewport.getBoundingClientRect();
    const content = track.getBoundingClientRect();
    // Physical edges avoid scrollLeft's different RTL origin and sign.
    const left = bounds.left - content.left > 1;
    const right = content.right - bounds.right > 1;
    root.toggleAttribute("data-scroll-left", left);
    root.toggleAttribute("data-scroll-right", right);
    viewport.tabIndex = left || right ? 0 : -1;
    for (const [side, available] of [
      ["left", left],
      ["right", right],
    ] as const) {
      const button = root.querySelector<HTMLButtonElement>(`.chat-image-carousel__arrow--${side}`);
      if (button) {
        const next = side === (rtl ? "left" : "right");
        button.setAttribute(
          "aria-label",
          t(next ? "chat.imageGallery.next" : "chat.imageGallery.previous"),
        );
        // A keyboard-activated end arrow must not strand focus in hidden DOM.
        if (!available && button === document.activeElement) {
          viewport.focus({ preventScroll: true });
        }
        button.hidden = !available;
      }
    }
  };

  protected override disconnected() {
    this.viewport?.removeEventListener("scroll", this.measure);
    this.viewport = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
  }

  protected override reconnected() {
    this.schedule();
  }
}

const imageStrip = directive(ImageStripDirective);

function scrollImages(event: Event, direction: -1 | 1, edge = false) {
  const root =
    event.currentTarget instanceof Element
      ? event.currentTarget.closest(".chat-image-carousel")
      : null;
  const viewport = root?.querySelector<HTMLElement>(".chat-image-carousel__viewport");
  if (viewport) {
    // Arrow keys follow physical edges; Home/End follow logical reading order.
    const offset = edge && getComputedStyle(viewport).direction === "rtl" ? -direction : direction;
    viewport.scrollBy({
      left: offset * (edge ? viewport.scrollWidth : viewport.clientWidth * 0.8),
      // Home/End jump directly even in very large galleries; page steps may animate.
      behavior:
        edge || window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
    });
  }
}

export function renderImageStrip(content: unknown, active = true) {
  return html`<div
    class="chat-image-carousel ${active ? "chat-image-carousel--gallery" : ""}"
    role="group"
    aria-label=${t("chat.imageGallery.label")}
    ${imageStrip()}
  >
    <div
      class="chat-image-carousel__viewport"
      role="group"
      aria-label=${t("chat.imageGallery.label")}
      @keydown=${(event: KeyboardEvent) => {
        if (
          event.target !== event.currentTarget ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        ) {
          return;
        }
        const direction =
          event.key === "ArrowLeft" || event.key === "Home"
            ? -1
            : event.key === "ArrowRight" || event.key === "End"
              ? 1
              : 0;
        if (direction) {
          event.preventDefault();
          event.stopPropagation();
          scrollImages(event, direction, event.key === "Home" || event.key === "End");
        }
      }}
    >
      <div class="chat-image-carousel__track">${content}</div>
    </div>
    <button
      type="button"
      class="chat-image-carousel__arrow chat-image-carousel__arrow--left"
      hidden
      aria-label=${t("chat.imageGallery.previous")}
      @click=${(event: MouseEvent) => scrollImages(event, -1)}
    >
      ${icons.chevronLeft}
    </button>
    <button
      type="button"
      class="chat-image-carousel__arrow chat-image-carousel__arrow--right"
      hidden
      aria-label=${t("chat.imageGallery.next")}
      @click=${(event: MouseEvent) => scrollImages(event, 1)}
    >
      ${icons.chevronRight}
    </button>
  </div>`;
}
