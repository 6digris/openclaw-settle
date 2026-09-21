import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import type { QuestionDraft } from "../../../app/question-prompt.ts";
import { t } from "../../../i18n/index.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import { questionDraftValues } from "./chat-question-answer-controls.ts";
import type { QuestionPanelOptions, QuestionPanelProps } from "./chat-question-card.ts";

export type AsyncQuestions = {
  itemId: string;
  questions: { title: string; options?: string[] }[];
};

export type AsyncQuestionDraft = {
  answers: Map<string, QuestionDraft>;
  status?: "submitting" | "submitted" | "skipped";
  error?: string;
};

export type AsyncQuestionPresentation = {
  scope: string;
  pending: AsyncQuestions[];
  drafts: Map<string, AsyncQuestionDraft>;
  resolved?: Map<string, AsyncQuestionDraft>;
  onChange: () => void;
  submit?: (message: string) => Promise<boolean>;
};

export function createAsyncQuestionPresentation(
  state: {
    asyncQuestionScope?: string;
    asyncQuestionDrafts: Map<string, AsyncQuestionDraft>;
    asyncQuestionRevision: number;
    transcriptRenderContext: { onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"] };
  },
  props: {
    messages?: readonly unknown[];
    sessionKey: string;
    currentAgentId?: string;
    connectionEpoch?: number;
    onAsyncQuestionSubmit?: AsyncQuestionPresentation["submit"];
    onRequestUpdate?: () => void;
  },
): AsyncQuestionPresentation {
  const scope = JSON.stringify([props.sessionKey, props.currentAgentId, props.connectionEpoch]);
  if (state.asyncQuestionScope !== scope) {
    state.asyncQuestionScope = scope;
    state.asyncQuestionDrafts = new Map();
  }
  const drafts = state.asyncQuestionDrafts;
  const isCurrent = () =>
    state.asyncQuestionScope === scope && state.asyncQuestionDrafts === drafts;
  const questions = new Map<string, AsyncQuestions>();
  const resolved = new Map<string, AsyncQuestionDraft>();
  for (const message of props.messages ?? []) {
    const question = readAsyncQuestions(message);
    if (question) {
      questions.set(question.itemId, question);
      continue;
    }
    const identity = readSessionMessageIdentity(message);
    if (
      identity?.role !== "user" ||
      !identity.id ||
      identity.sequence === null ||
      identity.isImported
    ) {
      continue;
    }
    const text = extractTextCached(message);
    if (!text) {
      continue;
    }
    // Match only the generated answer format, and do not guess between duplicate titles.
    const matches = [...questions.values()]
      .filter((entry) => !resolved.has(entry.itemId))
      .map((entry) => ({ entry, answers: parseGeneratedAsyncAnswer(entry, text) }))
      .filter((match) => match.answers !== null);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match?.answers) {
      resolved.set(match.entry.itemId, { status: "submitted", answers: match.answers });
    }
  }
  return {
    scope,
    pending: [...questions.values()].filter((question) => {
      const status = resolved.get(question.itemId)?.status ?? drafts.get(question.itemId)?.status;
      return status !== "submitted" && status !== "skipped";
    }),
    drafts,
    resolved,
    onChange: () => {
      if (isCurrent()) {
        state.asyncQuestionRevision += 1;
        props.onRequestUpdate?.();
      }
    },
    submit: props.onAsyncQuestionSubmit
      ? async (message) => {
          if (!isCurrent()) {
            return false;
          }
          return (await state.transcriptRenderContext.onAsyncQuestionSubmit?.(message)) === true;
        }
      : undefined,
  };
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0;
}

export function readAsyncQuestions(message: unknown): AsyncQuestions | null {
  if (!isRecord(message) || message.role !== "assistant") {
    return null;
  }
  const metadata = message.openclawAsyncDelivery;
  if (
    !isRecord(metadata) ||
    !boundedText(metadata.itemId, 256) ||
    !Array.isArray(metadata.questions) ||
    metadata.questions.length === 0 ||
    metadata.questions.length > 12
  ) {
    return null;
  }
  const questions: AsyncQuestions["questions"] = [];
  for (const question of metadata.questions) {
    if (
      !isRecord(question) ||
      !boundedText(question.title, 4096) ||
      (question.options !== undefined &&
        (!Array.isArray(question.options) ||
          question.options.length === 0 ||
          question.options.length > 4 ||
          !question.options.every((option) => boundedText(option, 256))))
    ) {
      return null;
    }
    questions.push({ title: question.title, options: question.options });
  }
  return { itemId: metadata.itemId, questions };
}

function draftForAnswer(
  question: AsyncQuestions["questions"][number],
  answer: string,
): QuestionDraft {
  const values = answer ? answer.split(", ") : [];
  const selected =
    values.length > 0 &&
    values.every((value) => question.options?.includes(value)) &&
    values.join(", ") === answer
      ? new Set(values)
      : new Set<string>();
  return { selected, freeText: selected.size > 0 ? "" : answer };
}

function parseGeneratedAsyncAnswer(
  question: AsyncQuestions,
  message: string,
): Map<string, QuestionDraft> | null {
  let offset = 0;
  const answers: string[] = [];
  for (let index = 0; index < question.questions.length; index += 1) {
    const current = question.questions[index];
    if (!current) {
      return null;
    }
    const prefix = `${quoteQuestion(current.title)}\n\n`;
    if (!message.startsWith(prefix, offset)) {
      return null;
    }
    offset += prefix.length;
    if (index === question.questions.length - 1) {
      answers.push(message.slice(offset));
      offset = message.length;
      break;
    }
    const next = question.questions[index + 1];
    if (!next) {
      return null;
    }
    const separator = `\n\n${quoteQuestion(next.title)}\n\n`;
    const answerEnd = message.indexOf(separator, offset);
    // Free text can contain quoted headings. Do not guess a section boundary.
    if (answerEnd < offset || message.includes(separator, answerEnd + separator.length)) {
      return null;
    }
    answers.push(message.slice(offset, answerEnd));
    offset = answerEnd + 2;
  }
  if (offset !== message.length || answers.length !== question.questions.length) {
    return null;
  }
  return new Map(
    question.questions.map((entry, index) => [
      String(index),
      draftForAnswer(entry, answers[index] ?? ""),
    ]),
  );
}

function quoteQuestion(title: string): string {
  const encoder = new TextEncoder();
  let quote = "";
  let bytes = 0;
  for (const character of title) {
    bytes += encoder.encode(character).length;
    if (bytes > 512) {
      break;
    }
    quote += character;
  }
  return `> ${quote.replace(/[\r\n]/g, " ")}`;
}

function getQuestionDraft(questions: AsyncQuestions, presentation: AsyncQuestionPresentation) {
  let draft = presentation.drafts.get(questions.itemId);
  if (!draft) {
    draft = {
      answers: new Map(
        questions.questions.map((question, index) => [
          String(index),
          { selected: new Set(question.options?.slice(0, 1)), freeText: "" },
        ]),
      ),
    };
    presentation.drafts.set(questions.itemId, draft);
  }
  return draft;
}

export function createAsyncQuestionPanelProps(
  questions: AsyncQuestions,
  presentation: AsyncQuestionPresentation,
  options: QuestionPanelOptions,
): QuestionPanelProps {
  const draft = getQuestionDraft(questions, presentation);
  const count = presentation.pending.reduce(
    (total, request) => total + request.questions.length,
    0,
  );
  return {
    model: {
      requestKey: JSON.stringify([presentation.scope, questions.itemId]),
      title: t("chat.asyncQuestions.title"),
      questions: questions.questions.map((question, index) => ({
        questionId: String(index),
        header: question.options ? question.title : t("chat.questions.answer"),
        question: question.title,
        options: (question.options ?? []).map((label) => ({ label })),
        isOther: true,
      })),
      autoFocus: false,
      nonBlocking: true,
      collapsed: options.collapsed ?? false,
      collapsedLabel: t(
        count === 1 ? "chat.asyncQuestions.pendingOne" : "chat.asyncQuestions.pendingMany",
        { count: String(count) },
      ),
      disabled: !presentation.submit,
      submitting: draft.status === "submitting",
      drafts: draft.answers,
      error: draft.error,
      requestPosition: options.requestPosition,
    },
    onChange: presentation.onChange,
    onCollapsedChange: options.onCollapsedChange,
    onPreviousRequest: options.onPreviousRequest,
    onNextRequest: options.onNextRequest,
    onSkip: () => {
      draft.status = "skipped";
      presentation.onChange();
    },
    onSubmit: async (answers: Record<string, string[]>) => {
      if (draft.status) {
        return;
      }
      draft.status = "submitting";
      draft.error = undefined;
      presentation.onChange();
      const message = questions.questions
        .map(
          (question, index) =>
            `${quoteQuestion(question.title)}\n\n${answers[String(index)]?.join(", ") ?? ""}`,
        )
        .join("\n\n");
      try {
        if (!(await presentation.submit?.(message))) {
          throw new Error(t("chat.asyncQuestions.sendFailed"));
        }
        draft.status = "submitted";
      } catch (error) {
        draft.status = undefined;
        draft.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        presentation.onChange();
      }
    },
  };
}

export function renderAsyncQuestionSummary(
  questions: AsyncQuestions,
  presentation: AsyncQuestionPresentation,
) {
  const draft =
    presentation.resolved?.get(questions.itemId) ?? presentation.drafts.get(questions.itemId);
  return html`<div class="chat-question-summary" role="status">
    ${questions.questions.map(
      (question, index) => html`<div>
        <strong>${question.title}</strong>
        <div>
          ${
            draft?.status === "submitted"
              ? questionDraftValues(draft.answers.get(String(index))).join(", ")
              : t(
                  draft?.status === "skipped"
                    ? "chat.questions.skipped"
                    : "chat.asyncQuestions.inComposer",
                )
          }
        </div>
      </div>`,
    )}
  </div>`;
}
