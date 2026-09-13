export type ExtraSystemPromptContext = {
  text: string;
  reducibleRanges: { start: number; end: number }[];
};

type ExtraSystemPromptContextOwner = BoundContextOwner & { extraSystemPrompt?: string };
type ExtraSystemPromptContextPart =
  | { text: string | undefined; reducible: boolean }
  | ExtraSystemPromptContext;

// Enumerable symbols survive in-process option spreads but cannot become RPC fields.
const contextKey = Symbol.for("openclaw.extraSystemPromptContext");
type BoundContextOwner = { [contextKey]?: ExtraSystemPromptContext };

export function composeExtraSystemPromptContext(
  parts: readonly ExtraSystemPromptContextPart[],
  separator = "\n\n",
): ExtraSystemPromptContext {
  let text = "";
  const reducibleRanges: ExtraSystemPromptContext["reducibleRanges"] = [];
  const appendRange = (start: number, end: number, adjacentStart = start) => {
    const previous = reducibleRanges.at(-1);
    if (previous && (previous.end === start || previous.end === adjacentStart)) {
      previous.end = end;
    } else {
      reducibleRanges.push({ start, end });
    }
  };
  for (const part of parts) {
    if (!part.text) {
      continue;
    }
    const previousEnd = text.length;
    if (text) {
      text += separator;
    }
    const start = text.length;
    text += part.text;
    if ("reducibleRanges" in part) {
      for (const range of part.reducibleRanges) {
        appendRange(
          start + range.start,
          start + range.end,
          range.start === 0 ? previousEnd : start + range.start,
        );
      }
    } else if (part.reducible) {
      appendRange(start, text.length, previousEnd);
    }
  }
  return { text, reducibleRanges };
}

export function bindExtraSystemPromptContext<T extends object>(
  owner: T & BoundContextOwner,
  context: ExtraSystemPromptContext | undefined,
): T {
  if (context) {
    owner[contextKey] = context;
  } else {
    delete owner[contextKey];
  }
  return owner;
}

function sliceContext(
  context: ExtraSystemPromptContext,
  start: number,
  end: number,
): ExtraSystemPromptContext {
  return {
    text: context.text.slice(start, end),
    reducibleRanges: context.reducibleRanges.flatMap((range) => {
      const rangeStart = Math.max(start, range.start);
      const rangeEnd = Math.min(end, range.end);
      return rangeStart < rangeEnd ? [{ start: rangeStart - start, end: rangeEnd - start }] : [];
    }),
  };
}

function reconcileContext(
  context: ExtraSystemPromptContext,
  text: string,
): ExtraSystemPromptContext {
  if (context.text === text) {
    return context;
  }
  if (text.startsWith(context.text)) {
    return {
      text,
      reducibleRanges: [
        ...context.reducibleRanges,
        { start: context.text.length, end: text.length },
      ],
    };
  }
  if (text.endsWith(context.text)) {
    const start = text.length - context.text.length;
    return {
      text,
      reducibleRanges: [
        { start: 0, end: start },
        ...context.reducibleRanges.map((range) => ({
          start: range.start + start,
          end: range.end + start,
        })),
      ],
    };
  }
  const trimmed = context.text.trim();
  if (trimmed !== context.text && text.startsWith(trimmed)) {
    const start = context.text.length - context.text.trimStart().length;
    return reconcileContext(sliceContext(context, start, start + trimmed.length), text);
  }
  if (text.trim() === context.text) {
    const start = text.length - text.trimStart().length;
    return {
      text,
      reducibleRanges: [
        ...(start ? [{ start: 0, end: start }] : []),
        ...context.reducibleRanges.map((range) => ({
          start: range.start + start,
          end: range.end + start,
        })),
        ...(start + context.text.length < text.length
          ? [{ start: start + context.text.length, end: text.length }]
          : []),
      ],
    };
  }

  // Replacements are explicit producer operations. An unrelated replacement
  // cannot inherit exemptions from a different source.
  return { text, reducibleRanges: [{ start: 0, end: text.length }] };
}

export function readExtraSystemPromptContext(
  owner: ExtraSystemPromptContextOwner,
): ExtraSystemPromptContext | undefined {
  const text = owner.extraSystemPrompt;
  if (!text) {
    return undefined;
  }
  const context = owner[contextKey];
  return context
    ? reconcileContext(context, text)
    : { text, reducibleRanges: [{ start: 0, end: text.length }] };
}

export function copyExtraSystemPromptContext<T extends object>(
  source: ExtraSystemPromptContextOwner,
  target: T & BoundContextOwner,
): T {
  return bindExtraSystemPromptContext(target, readExtraSystemPromptContext(source));
}

export function replaceExtraSystemPromptContextRange(
  owner: ExtraSystemPromptContextOwner,
  replacement: { start: number; end: number; text: string; reducible: boolean },
): void {
  const context = readExtraSystemPromptContext(owner);
  if (!context) {
    return;
  }
  const before = sliceContext(context, 0, replacement.start);
  const after = sliceContext(context, replacement.end, context.text.length);
  const afterStart = before.text.length + replacement.text.length;
  const next = {
    text: before.text + replacement.text + after.text,
    reducibleRanges: [
      ...before.reducibleRanges,
      ...(replacement.reducible && replacement.text
        ? [{ start: before.text.length, end: afterStart }]
        : []),
      ...after.reducibleRanges.map((range) => ({
        start: range.start + afterStart,
        end: range.end + afterStart,
      })),
    ],
  };
  owner.extraSystemPrompt = next.text || undefined;
  bindExtraSystemPromptContext(owner, next);
}

export function appendExtraSystemPromptContext(
  owner: ExtraSystemPromptContextOwner,
  suffix: string | undefined,
  options: { reducible: boolean },
): void {
  if (!suffix) {
    return;
  }
  const existing = readExtraSystemPromptContext(owner);
  if (!existing) {
    owner.extraSystemPrompt = suffix;
    bindExtraSystemPromptContext(
      owner,
      composeExtraSystemPromptContext([{ text: suffix, reducible: options.reducible }]),
    );
    return;
  }
  replaceExtraSystemPromptContextRange(owner, {
    start: existing.text.length,
    end: existing.text.length,
    text: `\n\n${suffix}`,
    reducible: options.reducible,
  });
}
