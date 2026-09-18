import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

class SessionsLoadingHeightDirective extends AsyncDirective {
  private element?: HTMLElement;
  private hasResult = false;
  private pending = false;

  render(_hasResult: boolean, _pending: boolean) {
    return nothing;
  }

  override update(part: ElementPart, [hasResult, pending]: [boolean, boolean]) {
    if (!(part.element instanceof HTMLElement)) {
      return nothing;
    }
    this.element = part.element;
    if (pending && !this.pending && this.hasResult) {
      // Element directives run before their children change. Retain the whole
      // page footprint (including its pager) while retiring the previous rows.
      this.element.style.minHeight = `${this.element.getBoundingClientRect().height}px`;
    } else if (!pending) {
      this.element.style.removeProperty("min-height");
    }
    this.hasResult = hasResult;
    this.pending = pending;
    return nothing;
  }

  protected override disconnected() {
    this.element?.style.removeProperty("min-height");
    this.hasResult = false;
    this.pending = false;
  }
}

const sessionsLoadingHeight = directive(SessionsLoadingHeightDirective);

export function renderSessionsLoadingLayout(body: unknown, hasResult: boolean, pending: boolean) {
  return html`<div ${sessionsLoadingHeight(hasResult, pending)}>${body}</div>`;
}

const SKELETON_ROW_COUNT = 4;

// Initial load renders shimmer rows instead of flashing the empty state
// before the first sessions.list result arrives.
export function renderSkeletonRows(columnCount: number) {
  return Array.from(
    { length: SKELETON_ROW_COUNT },
    (_, rowIndex) => html`
      <tr class="session-skeleton-row" aria-hidden="true">
        ${Array.from({ length: columnCount }, (_cell, columnIndex) =>
          columnIndex === 0
            ? html`<td class="data-table-checkbox-col"></td>`
            : html`<td>
                <span
                  class="session-skeleton ${columnIndex === 1 ? "session-skeleton--key" : ""}"
                  style=${`animation-delay: ${rowIndex * 120}ms`}
                ></span>
              </td>`,
        )}
      </tr>
    `,
  );
}
