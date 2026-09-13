// OpenResponses file-content boundary helper.
// Marks uploaded/read file text as untrusted external model input.
import type { ExtraSystemPromptContext } from "../agents/extra-system-prompt-context.js";
import { renderFileContextBlock } from "../media/file-context.js";
import { wrapExternalContent } from "../security/external-content.js";

/** Keeps file identity and trust frames whole when its body needs an excerpt. */
export function renderUntrustedFileContext(params: {
  filename?: string;
  content: string;
}): ExtraSystemPromptContext {
  const wrapped = wrapExternalContent(params.content, {
    source: "unknown",
    includeWarning: false,
  });
  const prefix = wrapped.slice(0, wrapped.indexOf("\n---\n") + 5);
  const suffix = wrapped.slice(wrapped.lastIndexOf("\n"));
  const text = renderFileContextBlock({
    filename: params.filename,
    content: wrapped,
  });
  // File escaping may expand the body. These exact, generated marker frames
  // survive it unchanged; spoofed markers were sanitized by the wrapper owner.
  const start = text.indexOf(prefix) + prefix.length;
  const end = text.lastIndexOf(suffix);
  return { text, reducibleRanges: start < end ? [{ start, end }] : [] };
}
