/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  createAsyncQuestionPresentation,
  createAsyncQuestionPanelProps,
  renderAsyncQuestionSummary,
  type AsyncQuestionDraft,
} from "./chat-async-question.ts";
import "./chat-question-card.ts";

const container = document.createElement("div");
afterEach(() => {
  render(nothing, container);
  container.remove();
});

it.each(["answered", "failed"] as const)(
  "keeps a remounted async question locked until its original send is %s",
  async (outcome) => {
    document.body.append(container);
    const pending = createDeferred<boolean>();
    const submit = vi.fn(() => pending.promise);
    const state = {
      asyncQuestionDrafts: new Map<string, AsyncQuestionDraft>(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: { onAsyncQuestionSubmit: submit },
    };
    const questions = {
      itemId: "question-1",
      questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
    };
    const draw = () => {
      const presentation = createAsyncQuestionPresentation(state, {
        sessionKey: "agent:main:main",
        onAsyncQuestionSubmit: submit,
        onRequestUpdate: draw,
      });
      render(
        state.asyncQuestionDrafts.get(questions.itemId)?.status === "submitted"
          ? renderAsyncQuestionSummary(questions, presentation)
          : html`<openclaw-chat-question-panel
              .props=${createAsyncQuestionPanelProps(questions, presentation, {})}
            ></openclaw-chat-question-panel>`,
        container,
      );
    };
    draw();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-question-panel__advance")).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.click();
    expect(submit).toHaveBeenCalledExactlyOnceWith("> Which audience?\n\nEngineers");

    render(nothing, container);
    draw();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-question-panel__advance")).not.toBeNull(),
    );
    expect(
      container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".chat-question-panel__skip")!.disabled).toBe(
      true,
    );

    if (outcome === "answered") {
      pending.resolve(true);
      await vi.waitFor(() =>
        expect(container.querySelector('[role="status"]')?.textContent).toContain("Engineers"),
      );
    } else {
      pending.reject(new Error("Synthetic send failure"));
      await vi.waitFor(() => expect(container.textContent).toContain("Synthetic send failure"));
      expect(
        container.querySelector<HTMLButtonElement>(".chat-question-panel__advance")!.disabled,
      ).toBe(false);
    }
    expect(submit).toHaveBeenCalledTimes(1);
  },
);

const historicalQuestion = (itemId = "old-question") => ({
  role: "assistant",
  openclawAsyncDelivery: {
    itemId,
    questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
  },
});
const historicalAnswer = {
  role: "user",
  content: "> Which audience?\n\nEveryone",
  __openclaw: { id: "saved-answer", seq: 2 },
};
function historyPresentation(messages: unknown[], connectionEpoch = 1) {
  return createAsyncQuestionPresentation(
    {
      asyncQuestionDrafts: new Map(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: {},
    },
    { sessionKey: "agent:main:main", connectionEpoch, messages },
  );
}

it("keeps a persisted answer resolved across remount and reconnect and displays the answer", () => {
  for (const epoch of [1, 2]) {
    const presentation = historyPresentation([historicalQuestion(), historicalAnswer], epoch);
    expect(presentation.pending).toEqual([]);
    render(
      renderAsyncQuestionSummary(historicalQuestion().openclawAsyncDelivery, presentation),
      container,
    );
    expect(container.textContent).toContain("Everyone");
  }
});

it.each([
  { role: "user", content: historicalAnswer.content },
  { ...historicalAnswer, content: "Everyone" },
  { ...historicalAnswer, content: "An unrelated later message" },
])("does not treat an unsaved or unrelated reply as an answer: %j", (reply) => {
  expect(historyPresentation([historicalQuestion(), reply]).pending).toHaveLength(1);
});

it("keeps a new same-title question pending after an earlier question was answered", () => {
  expect(
    historyPresentation([
      historicalQuestion(),
      historicalAnswer,
      historicalQuestion("new-question"),
    ]).pending.map((entry) => entry.itemId),
  ).toEqual(["new-question"]);
});

it("does not guess which duplicate question an ambiguous answer belongs to", () => {
  expect(
    historyPresentation([historicalQuestion(), historicalQuestion("duplicate"), historicalAnswer])
      .pending,
  ).toHaveLength(2);
});

it("does not retain derived completion after authoritative history replaces the answer", () => {
  const state = {
    asyncQuestionDrafts: new Map<string, AsyncQuestionDraft>(),
    asyncQuestionRevision: 0,
    transcriptRenderContext: {},
  };
  const props = { sessionKey: "agent:main:main" };
  expect(
    createAsyncQuestionPresentation(state, {
      ...props,
      messages: [historicalQuestion(), historicalAnswer],
    }).pending,
  ).toHaveLength(0);
  expect(
    createAsyncQuestionPresentation(state, { ...props, messages: [historicalQuestion()] }).pending,
  ).toHaveLength(1);
});

it("restores every answer in a multi-question submission with UTF-8-bounded quoted titles", () => {
  const question = {
    role: "assistant",
    openclawAsyncDelivery: {
      itemId: "multiple-questions",
      questions: [
        { title: "界".repeat(180), options: ["One", "Two"] },
        { title: "Any\nother details?" },
      ],
    },
  };
  const answer = {
    ...historicalAnswer,
    content: [
      {
        type: "text",
        text: `> ${"界".repeat(170)}\n\nTwo\n\n> Any other details?\n\nFirst line\nSecond line`,
      },
    ],
  };
  const presentation = historyPresentation([question, answer]);
  expect(presentation.pending).toHaveLength(0);
  render(renderAsyncQuestionSummary(question.openclawAsyncDelivery, presentation), container);
  expect(container.textContent).toContain("Two");
  expect(container.textContent).toContain("First line\nSecond line");
  expect(
    historyPresentation([
      question,
      { ...historicalAnswer, content: `> ${"界".repeat(170)}\n\nTwo` },
    ]).pending,
  ).toHaveLength(1);
});

it("leaves an answer with ambiguous embedded question headings pending", () => {
  const question = {
    role: "assistant",
    openclawAsyncDelivery: {
      itemId: "ambiguous-multiline",
      questions: [{ title: "First?" }, { title: "Second?" }],
    },
  };
  const answer = {
    ...historicalAnswer,
    content:
      "> First?\n\nQuote this:\n\n> Second?\n\nStill the first answer\n\n> Second?\n\nThe second answer",
  };
  expect(historyPresentation([question, answer]).pending).toHaveLength(1);
});
