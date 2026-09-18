/**
 * Splits streamed embedded-agent replies into Markdown-safe message chunks.
 */

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { FenceSpan } from "../../packages/markdown-core/src/fences.js";
import {
  findFenceSpanAt,
  isSafeFenceBreak,
  scanFenceSpans,
} from "../../packages/markdown-core/src/fences.js";
import {
  protectBreakIndex,
  scanUnbreakableSpans,
  type UnbreakableSpan,
} from "./embedded-agent-link-spans.js";

export type BlockReplyChunking = {
  /** Preferred minimum chunk size; clamped to the absolute ceiling when provided. */
  minChars: number;
  /** Preferred maximum chunk size; protected links may exceed it up to hardMaxChars. */
  maxChars: number;
  /** Absolute transport ceiling. Defaults to maxChars for legacy callers. */
  hardMaxChars?: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
  /** When true, prefer \n\n paragraph boundaries once minChars has been satisfied. */
  flushOnParagraph?: boolean;
};

type FenceSplit = {
  closeFenceLine: string;
  reopenFenceLine: string;
  fence: FenceSpan;
};

type BreakResult = {
  index: number;
  fenceSplit?: FenceSplit;
};

function normalizeChunkLimits(params: {
  minChars: number;
  maxChars: number;
  hardMaxChars?: number;
}): { minChars: number; maxChars: number; hardMaxChars: number } {
  const requestedMinChars = Math.max(1, Math.floor(params.minChars));
  const requestedMaxChars = Math.max(requestedMinChars, Math.floor(params.maxChars));
  const hardMaxChars = Math.max(1, Math.floor(params.hardMaxChars ?? requestedMaxChars));
  const maxChars = Math.min(requestedMaxChars, hardMaxChars);
  return {
    minChars: Math.min(requestedMinChars, maxChars),
    maxChars,
    hardMaxChars,
  };
}

type ParagraphBreak = {
  index: number;
  length: number;
};

function findSafeSentenceBreakIndex(
  text: string,
  fenceSpans: FenceSpan[],
  minChars: number,
  offset = 0,
  openFence?: FenceSpan,
): number {
  const matches = text.matchAll(/[.!?](?=\s|$)/g);
  let sentenceIdx = -1;
  for (const match of matches) {
    const at = match.index ?? -1;
    if (at < minChars) {
      continue;
    }
    const candidate = at + 1;
    if (offset + candidate !== openFence?.end && isSafeFenceBreak(fenceSpans, offset + candidate)) {
      sentenceIdx = candidate;
    }
  }
  return sentenceIdx >= minChars ? sentenceIdx : -1;
}

function findSafeParagraphBreakIndex(params: {
  text: string;
  fenceSpans: FenceSpan[];
  minChars: number;
  reverse: boolean;
  offset?: number;
}): number {
  const { text, fenceSpans, minChars, reverse, offset = 0 } = params;
  let paragraphIdx = reverse ? text.lastIndexOf("\n\n") : text.indexOf("\n\n");
  while (reverse ? paragraphIdx >= minChars : paragraphIdx !== -1) {
    const candidates = [paragraphIdx, paragraphIdx + 1];
    for (const candidate of candidates) {
      if (candidate < minChars) {
        continue;
      }
      if (candidate < 0 || candidate >= text.length) {
        continue;
      }
      if (isSafeFenceBreak(fenceSpans, offset + candidate)) {
        return candidate;
      }
    }
    paragraphIdx = reverse
      ? text.lastIndexOf("\n\n", paragraphIdx - 1)
      : text.indexOf("\n\n", paragraphIdx + 2);
  }
  return -1;
}

function findSafeNewlineBreakIndex(params: {
  text: string;
  fenceSpans: FenceSpan[];
  minChars: number;
  reverse: boolean;
  offset?: number;
}): number {
  const { text, fenceSpans, minChars, reverse, offset = 0 } = params;
  let newlineIdx = reverse ? text.lastIndexOf("\n") : text.indexOf("\n");
  while (reverse ? newlineIdx >= minChars : newlineIdx !== -1) {
    if (newlineIdx >= minChars && isSafeFenceBreak(fenceSpans, offset + newlineIdx)) {
      return newlineIdx;
    }
    newlineIdx = reverse
      ? text.lastIndexOf("\n", newlineIdx - 1)
      : text.indexOf("\n", newlineIdx + 1);
  }
  return -1;
}

function findFenceCloseLineStart(buffer: string, fence: FenceSpan, offset = 0): number {
  const relativeFenceEnd = Math.min(buffer.length, Math.max(0, fence.end - offset));
  if (relativeFenceEnd <= 0) {
    return -1;
  }
  const lastNewline = buffer.lastIndexOf("\n", relativeFenceEnd - 1);
  if (lastNewline < 0) {
    return -1;
  }
  // Open spans also end at the buffer boundary; consuming their final content
  // line as a closing marker would silently drop streamed code.
  const closingMarker = buffer
    .slice(lastNewline + 1, relativeFenceEnd)
    .match(/^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/)?.[1];
  return closingMarker &&
    closingMarker.charAt(0) === fence.marker.charAt(0) &&
    closingMarker.length >= fence.marker.length
    ? lastNewline + 1
    : -1;
}

function resolveFenceReopenLine(fence: FenceSpan, maxChars: number): string | undefined {
  const bareMarker = `${fence.indent}${fence.marker}`;
  if (bareMarker.length * 2 + 3 > maxChars) {
    return undefined;
  }
  return fence.openLine.length + bareMarker.length + 3 <= maxChars ? fence.openLine : bareMarker;
}

export class EmbeddedBlockChunker {
  #buffer = "";
  #reopenPrefix = "";
  #consumedLength = 0;
  #bufferStartsAtLineStart = true;
  readonly #chunking?: BlockReplyChunking;

  constructor(chunking?: BlockReplyChunking) {
    this.#chunking = chunking;
  }

  /** Add streamed text to the pending chunk buffer. */
  append(text: string) {
    if (!text) {
      return;
    }
    this.#buffer += text;
  }

  /** Start a new source scope without emitting pending text. */
  reset() {
    this.#buffer = "";
    this.#reopenPrefix = "";
    this.#consumedLength = 0;
    this.#bufferStartsAtLineStart = true;
  }

  /** UTF-16 source positions exclude synthetic fences and include skipped whitespace. */
  get consumedLength() {
    return this.#consumedLength;
  }

  get sourceLength() {
    return this.#consumedLength + this.#buffer.length;
  }

  /** Replace a suffix in the original input projection; never replay drained source. */
  replace(text: string, sourceOffset = 0): boolean {
    const pendingOffset = sourceOffset - this.#consumedLength;
    const next =
      this.#buffer.slice(0, Math.max(0, pendingOffset)) + text.slice(Math.max(0, -pendingOffset));
    const changed = next !== this.#buffer;
    this.#buffer = next;
    const consumedLength = Math.min(this.#consumedLength, sourceOffset + text.length);
    if (consumedLength === 0) {
      this.#bufferStartsAtLineStart = true;
    } else if (consumedLength > sourceOffset) {
      this.#bufferStartsAtLineStart = text.charAt(consumedLength - sourceOffset - 1) === "\n";
    } else if (consumedLength < this.#consumedLength) {
      // A withdrawn, already-delivered prefix cannot establish a new fence boundary.
      this.#bufferStartsAtLineStart = false;
    }
    this.#consumedLength = consumedLength;
    return changed;
  }

  /** Return the currently buffered text for tests and flush logic. */
  get bufferedText() {
    return this.#buffer ? `${this.#reopenPrefix}${this.#buffer}` : "";
  }

  /** Return true when there is pending text to drain. */
  hasBuffered(): boolean {
    return this.#buffer.length > 0;
  }

  /** Emit safe chunks according to size and Markdown fence constraints. */
  drain(params: {
    force: boolean;
    emit: (chunk: string, options?: { sourceText: string; startsAtLineStart: boolean }) => void;
  }) {
    // KNOWN: We cannot split inside fenced code blocks (Markdown breaks + UI glitches).
    // When forced (maxChars), we close + reopen the fence to keep Markdown valid.
    const { force, emit } = params;
    const chunking = this.#chunking;
    if (!this.#buffer || (!force && !chunking)) {
      return;
    }
    const { minChars, maxChars, hardMaxChars } = normalizeChunkLimits({
      minChars: chunking?.minChars ?? 1,
      maxChars: chunking?.maxChars ?? Infinity,
      hardMaxChars: chunking?.hardMaxChars,
    });
    let source = this.bufferedText;
    const startsAtLineStart = Boolean(this.#reopenPrefix) || this.#bufferStartsAtLineStart;

    if (source.length < minChars && !force) {
      return;
    }

    if (!chunking || (force && source.length <= maxChars && !this.#reopenPrefix)) {
      if (!chunking || source.trim().length > 0) {
        emit(source, { sourceText: this.#buffer, startsAtLineStart });
      }
      this.#bufferStartsAtLineStart = this.#buffer.endsWith("\n");
      this.#consumedLength += this.#buffer.length;
      this.#buffer = "";
      this.#reopenPrefix = "";
      return;
    }

    // Keep original source text so shortened language hints and synthetic
    // fences cannot move the source cursor during checkpoint reconciliation.
    const { spans: fenceSpans, state: fenceState } = scanFenceSpans(source, {
      atLineStart: startsAtLineStart,
    });
    const openFence = fenceState.open ? fenceSpans.at(-1) : undefined;
    const removedFenceInfo: Array<{ at: number; length: number }> = [];
    let removedFenceInfoLength = 0;
    for (const fence of fenceSpans) {
      fence.start -= removedFenceInfoLength;
      fence.end -= removedFenceInfoLength;
      const reopenFenceLine = resolveFenceReopenLine(fence, maxChars);
      if (
        !reopenFenceLine ||
        reopenFenceLine === fence.openLine ||
        fence.end - fence.start <= maxChars
      ) {
        continue;
      }
      // A language hint that cannot fit with its balanced fence must degrade
      // as metadata; splitting the hint would leak it into visible code.
      source =
        source.slice(0, fence.start) +
        reopenFenceLine +
        source.slice(fence.start + fence.openLine.length);
      const removedLength = fence.openLine.length - reopenFenceLine.length;
      removedFenceInfo.push({ at: fence.start + reopenFenceLine.length, length: removedLength });
      fence.openLine = reopenFenceLine;
      fence.end -= removedLength;
      removedFenceInfoLength += removedLength;
    }
    const unbreakableSpans = scanUnbreakableSpans(source, fenceSpans, hardMaxChars);
    const sourceOffset = (index: number) =>
      Math.max(
        0,
        removedFenceInfo.reduce(
          (offset, removed) => offset + (removed.at <= index ? removed.length : 0),
          index,
        ) - this.#reopenPrefix.length,
      );
    let start = 0;
    let reopenFence: FenceSplit | undefined;
    const emitSourceChunk = (chunk: string, from: number, to: number) =>
      emit(chunk, {
        sourceText: this.#buffer.slice(sourceOffset(from), sourceOffset(to)),
        startsAtLineStart:
          Boolean(reopenFence) ||
          (from === 0 ? startsAtLineStart : source.charAt(from - 1) === "\n"),
      });
    const resumedFence = this.#reopenPrefix ? fenceSpans[0] : undefined;
    if (resumedFence) {
      const closeStart = findFenceCloseLineStart(source, resumedFence);
      if (
        closeStart >= this.#reopenPrefix.length &&
        !source.slice(this.#reopenPrefix.length, closeStart).trim()
      ) {
        // A checkpoint can withdraw the remaining body while retaining its
        // source closer. Earlier chunks already carried a synthetic closer.
        start = skipLeadingNewlines(source, resumedFence.end);
      }
    }

    while (start < source.length) {
      const reopenPrefix = reopenFence ? `${reopenFence.reopenFenceLine}\n` : "";
      const remainingLength = reopenPrefix.length + (source.length - start);

      if (!force && remainingLength < minChars) {
        break;
      }

      if (chunking.flushOnParagraph && !force) {
        const paragraphBreak = findNextParagraphBreak(source, fenceSpans, start, minChars);
        const paragraphLimit = Math.max(1, maxChars - reopenPrefix.length);
        if (paragraphBreak && paragraphBreak.index - start <= paragraphLimit) {
          const chunk = `${reopenPrefix}${source.slice(start, paragraphBreak.index)}`;
          const nextStart = skipLeadingNewlines(
            source,
            paragraphBreak.index + paragraphBreak.length,
          );
          if (chunk.trim().length > 0) {
            emitSourceChunk(chunk, start, nextStart);
          }
          start = nextStart;
          reopenFence = undefined;
          continue;
        }
        if (remainingLength < maxChars) {
          break;
        }
      }

      const view = source.slice(start);
      const breakResult =
        force && remainingLength <= maxChars
          ? this.#pickPreferredBreakIndex(
              view,
              fenceSpans,
              unbreakableSpans,
              chunking,
              true,
              false,
              1,
              start,
              openFence,
            )
          : this.#pickBreakIndex(
              view,
              fenceSpans,
              unbreakableSpans,
              chunking,
              force,
              force ? 1 : undefined,
              start,
              maxChars - reopenPrefix.length,
              hardMaxChars - reopenPrefix.length,
              openFence,
            );
      if (breakResult.index <= 0) {
        if (force) {
          emitSourceChunk(`${reopenPrefix}${source.slice(start)}`, start, source.length);
          start = source.length;
          reopenFence = undefined;
        }
        break;
      }

      const consumed = this.#resolveBreakResult({
        breakResult,
        reopenPrefix,
        source,
        start,
      });
      if (consumed === null) {
        continue;
      }
      if (consumed.chunk) {
        emitSourceChunk(consumed.chunk, start, consumed.start);
      }
      start = consumed.start;
      reopenFence = consumed.reopenFence;

      const nextLength =
        (reopenFence ? `${reopenFence.reopenFenceLine}\n`.length : 0) + (source.length - start);
      if (nextLength < minChars && !force) {
        break;
      }
      if (nextLength < maxChars && !force && !chunking.flushOnParagraph) {
        break;
      }
    }
    if (!reopenFence) {
      start = skipLeadingNewlines(source, start);
    }
    if (start === 0) {
      return;
    }
    const consumed = sourceOffset(start);
    if (consumed > 0) {
      this.#bufferStartsAtLineStart = this.#buffer.charAt(consumed - 1) === "\n";
    }
    this.#consumedLength += consumed;
    this.#buffer = this.#buffer.slice(consumed);
    this.#reopenPrefix = reopenFence ? `${reopenFence.reopenFenceLine}\n` : "";
  }

  #resolveBreakResult(params: {
    breakResult: BreakResult;
    reopenPrefix: string;
    source: string;
    start: number;
  }): { chunk?: string; start: number; reopenFence?: FenceSplit } | null {
    const { breakResult, reopenPrefix, source, start } = params;
    const breakIdx = breakResult.index;
    if (breakIdx <= 0) {
      return null;
    }

    const absoluteBreakIdx = start + breakIdx;
    let rawChunk = `${reopenPrefix}${source.slice(start, absoluteBreakIdx)}`;
    if (rawChunk.trim().length === 0) {
      return { start: skipLeadingNewlines(source, absoluteBreakIdx), reopenFence: undefined };
    }

    const fenceSplit = breakResult.fenceSplit;
    if (fenceSplit) {
      const closeFence = rawChunk.endsWith("\n")
        ? fenceSplit.closeFenceLine
        : `\n${fenceSplit.closeFenceLine}`;
      rawChunk = `${rawChunk}${closeFence}`;
    }

    if (fenceSplit) {
      const closeFenceStart = findFenceCloseLineStart(source, fenceSplit.fence);
      if (absoluteBreakIdx === closeFenceStart) {
        // The synthetic closer already owns this boundary; replaying the source
        // closer after reopening would publish an empty fenced-code message.
        return { chunk: rawChunk, start: skipLeadingNewlines(source, fenceSplit.fence.end) };
      }
      return { chunk: rawChunk, start: absoluteBreakIdx, reopenFence: fenceSplit };
    }

    const nextStart =
      absoluteBreakIdx < source.length && /\s/.test(source.charAt(absoluteBreakIdx))
        ? absoluteBreakIdx + 1
        : absoluteBreakIdx;
    return {
      chunk: rawChunk,
      start: skipLeadingNewlines(source, nextStart),
      reopenFence: undefined,
    };
  }

  // Forced tails take the first paragraph/newline break; capped windows take the last.
  #pickPreferredBreakIndex(
    buffer: string,
    fenceSpans: FenceSpan[],
    unbreakableSpans: UnbreakableSpan[],
    chunking: BlockReplyChunking,
    force: boolean,
    reverse: boolean,
    minCharsOverride?: number,
    offset = 0,
    openFence?: FenceSpan,
  ): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? chunking.minChars));
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const preference = chunking.breakPreference ?? "paragraph";

    if (preference === "paragraph") {
      const paragraphIdx = findSafeParagraphBreakIndex({
        text: buffer,
        fenceSpans,
        minChars,
        reverse,
        offset,
      });
      if (paragraphIdx !== -1) {
        return { index: protectBreakIndex(unbreakableSpans, paragraphIdx, offset, force) };
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      const newlineIdx = findSafeNewlineBreakIndex({
        text: buffer,
        fenceSpans,
        minChars,
        reverse,
        offset,
      });
      if (newlineIdx !== -1) {
        return { index: protectBreakIndex(unbreakableSpans, newlineIdx, offset, force) };
      }
    }

    if (preference !== "newline") {
      const sentenceIdx = findSafeSentenceBreakIndex(
        buffer,
        fenceSpans,
        minChars,
        offset,
        openFence,
      );
      if (sentenceIdx !== -1) {
        return { index: protectBreakIndex(unbreakableSpans, sentenceIdx, offset, force) };
      }
    }

    return { index: -1 };
  }

  #pickBreakIndex(
    buffer: string,
    fenceSpans: FenceSpan[],
    unbreakableSpans: UnbreakableSpan[],
    chunking: BlockReplyChunking,
    force: boolean,
    minCharsOverride?: number,
    offset = 0,
    maxCharsOverride?: number,
    hardMaxCharsOverride?: number,
    openFence?: FenceSpan,
  ): BreakResult {
    const { minChars, maxChars, hardMaxChars } = normalizeChunkLimits({
      minChars: minCharsOverride ?? chunking.minChars,
      maxChars: maxCharsOverride ?? chunking.maxChars,
      hardMaxChars: hardMaxCharsOverride ?? chunking.hardMaxChars,
    });
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const window = buffer.slice(0, Math.min(maxChars, buffer.length));
    const oversizedSpanAtStart = unbreakableSpans.some(
      (span) => span.start <= offset && span.end > offset + hardMaxChars,
    );

    if (!oversizedSpanAtStart) {
      const preferred = this.#pickPreferredBreakIndex(
        window,
        fenceSpans,
        unbreakableSpans,
        chunking,
        force,
        true,
        minChars,
        offset,
        openFence,
      );
      if (preferred.index !== -1) {
        return preferred;
      }

      if (buffer.length < maxChars) {
        return { index: -1 };
      }

      for (let i = window.length - 1; i >= minChars; i--) {
        if (/\s/.test(window.charAt(i)) && isSafeFenceBreak(fenceSpans, offset + i)) {
          return { index: protectBreakIndex(unbreakableSpans, i, offset, force) };
        }
      }
    }

    const forcedLimit = oversizedSpanAtStart ? hardMaxChars : maxChars;
    if (buffer.length >= forcedLimit) {
      const firstCodePointWidth = (buffer.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
      const forcedBreakIndex = sliceUtf16Safe(
        buffer,
        0,
        Math.max(forcedLimit, firstCodePointWidth),
      ).length;
      if (oversizedSpanAtStart) {
        return { index: forcedBreakIndex };
      }
      // An unfinished span ends at the buffer boundary without a source closer.
      const absoluteBreakIndex = offset + forcedBreakIndex;
      const fence =
        findFenceSpanAt(fenceSpans, absoluteBreakIndex) ??
        (openFence?.end === absoluteBreakIndex ? openFence : undefined);
      if (fence) {
        const reopenFenceLine = resolveFenceReopenLine(fence, chunking.maxChars);
        if (!reopenFenceLine) {
          return { index: protectBreakIndex(unbreakableSpans, forcedBreakIndex, offset, force) };
        }
        // Synthetic fence wrappers consume the same transport budget as source
        // text; reserving them here keeps every emitted payload deliverable.
        const closeFenceLine = `${fence.indent}${fence.marker}`;
        const fenceBreakIndex = sliceUtf16Safe(
          buffer,
          0,
          Math.max(1, maxChars - closeFenceLine.length - 1),
        ).length;
        if (fenceBreakIndex <= 0) {
          return { index: protectBreakIndex(unbreakableSpans, forcedBreakIndex, offset, force) };
        }
        const closeFenceStart = findFenceCloseLineStart(buffer, fence, offset);
        return {
          index:
            closeFenceStart >= minChars && closeFenceStart <= fenceBreakIndex
              ? closeFenceStart
              : fenceBreakIndex,
          fenceSplit: { closeFenceLine, reopenFenceLine, fence },
        };
      }
      return { index: protectBreakIndex(unbreakableSpans, forcedBreakIndex, offset, force) };
    }

    return { index: -1 };
  }
}

function skipLeadingNewlines(value: string, start = 0): number {
  let i = start;
  while (i < value.length && value[i] === "\n") {
    i++;
  }
  return i;
}

function findNextParagraphBreak(
  buffer: string,
  fenceSpans: FenceSpan[],
  startIndex = 0,
  minCharsFromStart = 1,
): ParagraphBreak | null {
  if (startIndex < 0) {
    return null;
  }
  const re = /\n[\t ]*\n+/g;
  re.lastIndex = startIndex;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    if (index - startIndex < minCharsFromStart) {
      continue;
    }
    const fence = findFenceSpanAt(fenceSpans, index);
    if (fence) {
      re.lastIndex = fence.end;
      continue;
    }
    return { index, length: match[0].length };
  }
  return null;
}
