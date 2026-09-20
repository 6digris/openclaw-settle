type ImageResizeAnchor = {
  viewport: HTMLElement;
  frame: Element;
  edge: "top" | "bottom";
  top: number;
  width: number;
};

// Geometry only: the transcript virtualizer owns input, scheduling, and scrolling.
export class TranscriptImageResizeAnchor {
  private anchor: ImageResizeAnchor | null = null;
  private resizing = false;

  clear(): void {
    this.anchor = null;
    this.resizing = false;
  }

  resized(): void {
    this.resizing = this.anchor !== null;
  }

  capture(viewport: HTMLElement | null, enabled: boolean): void {
    if (!enabled || !viewport?.isConnected) {
      this.clear();
      return;
    }
    // A render can precede the viewport observer. Keep the last pre-reflow
    // position until its measured sizer commits instead of sampling the loss.
    if (
      this.anchor?.viewport === viewport &&
      (this.resizing || this.anchor.width !== viewport.clientWidth)
    ) {
      return;
    }
    this.clear();
    const groups = viewport.querySelectorAll<HTMLElement>(
      ".chat-group.assistant .chat-message-images",
    );
    // Text-only transcripts perform no extra layout reads or per-row work.
    if (
      groups.length === 0 ||
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1
    ) {
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    let preceding: ImageResizeAnchor | null = null;
    for (const group of groups) {
      const groupBounds = group.getBoundingClientRect();
      if (groupBounds.bottom <= bounds.top) {
        // Text following images can share the same fold-spanning virtual row.
        // Its last preceding image run owns the added reflow displacement;
        // fully above-fold virtual rows already belong to TanStack compensation.
        const row = group.closest(".chat-virtual-row");
        if (row && row.getBoundingClientRect().bottom > bounds.top) {
          preceding = {
            viewport,
            frame: group,
            edge: "bottom",
            top: groupBounds.bottom - bounds.top,
            width: viewport.clientWidth,
          };
        }
        continue;
      }
      // An image below the reader must not take the anchor from preceding text.
      if (groupBounds.top >= bounds.top) {
        continue;
      }
      const frames = group.children;
      // Find the flex rows at the fold with logarithmic layout reads, even
      // in a single very long image message.
      let low = 0;
      let high = frames.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (frames[middle]!.getBoundingClientRect().top < bounds.top) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      const nextRowTop = frames[low]?.getBoundingClientRect().top;
      const previousRowTop = frames[low - 1]?.getBoundingClientRect().top;
      while (low > 0 && frames[low - 1]!.getBoundingClientRect().top === previousRowTop) {
        low -= 1;
      }
      // A tall preview cut by the fold can still occupy more of the reading
      // area than the following row. Compare just these two rows; ties keep
      // document order, rather than jumping to a right-hand neighbor.
      let frame: Element | undefined;
      let visibleHeight = 0;
      let top = 0;
      for (let index = low; index < frames.length; index += 1) {
        const candidate = frames[index]!;
        const rect = candidate.getBoundingClientRect();
        if (rect.top >= bounds.bottom || (nextRowTop !== undefined && rect.top > nextRowTop)) {
          break;
        }
        const visible = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
        if (visible > visibleHeight) {
          frame = candidate;
          visibleHeight = visible;
          top = rect.top;
        }
      }
      if (!frame) {
        continue;
      }
      this.anchor = {
        viewport,
        frame,
        edge: "top",
        top: top - bounds.top,
        width: viewport.clientWidth,
      };
      return;
    }
    this.anchor = preceding;
  }

  restore(viewport: HTMLElement | null, enabled: boolean): number | null {
    const anchor = this.anchor;
    if (
      !enabled ||
      !viewport?.isConnected ||
      !anchor?.frame.isConnected ||
      anchor.viewport !== viewport ||
      !viewport.contains(anchor.frame)
    ) {
      this.clear();
      return null;
    }
    if (!this.resizing) {
      return null;
    }
    this.resizing = false;
    anchor.width = viewport.clientWidth;
    const delta =
      anchor.frame.getBoundingClientRect()[anchor.edge] -
      viewport.getBoundingClientRect().top -
      anchor.top;
    return Math.abs(delta) > 0.5 ? viewport.scrollTop + delta : null;
  }
}
