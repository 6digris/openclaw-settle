import { describe, expect, it } from "vitest";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import {
  createHarness,
  deliverFinalAnswer,
  expectSentPayload,
} from "./lane-delivery.test-support.js";

describe("createLaneTextDeliverer recovered final payload", () => {
  it("routes a freshly recovered final payload with its media and reply fields", async () => {
    const truncatedFinal = "A recovered final answer includes a voice note after this opening...";
    const fullAnswer =
      "A recovered final answer includes a voice note after this opening paragraph with the remaining explanation and its attachment.";
    const harness = createHarness({
      answerMessageId: 999,
      resolveFinalPayloadCandidate: async ({ payload }) => ({
        ...payload,
        text: fullAnswer,
        mediaUrl: "https://example.invalid/note.ogg",
        audioAsVoice: true,
        replyToId: "321",
        replyToTag: true,
      }),
    });

    const result = await deliverFinalAnswer(harness, truncatedFinal);

    expect(result.kind).toBe("sent");
    expect(harness.answer?.update).not.toHaveBeenCalled();
    expectSentPayload(
      harness,
      {
        text: fullAnswer,
        mediaUrl: "https://example.invalid/note.ogg",
        audioAsVoice: true,
        replyToId: "321",
        replyToTag: true,
      },
      true,
    );
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("sends a recovered text final separately when its explicit reply target changes", async () => {
    const truncatedFinal = "The final answer continues after this sufficiently long opening...";
    const fullAnswer =
      "The final answer continues after this sufficiently long opening paragraph and replies to the selected message.";
    let deliveredText = truncatedFinal;
    const answer = createTestDraftStream({
      messageId: 999,
      onStop: () => {
        deliveredText = fullAnswer;
      },
    });
    answer.lastDeliveredText.mockImplementation(() => deliveredText);
    answer.currentMessageSnapshot.mockReturnValue({ text: fullAnswer, sourceText: fullAnswer });
    const harness = createHarness({
      answerStream: answer,
      resolveFinalPayloadCandidate: async ({ payload }) => ({
        ...payload,
        text: fullAnswer,
        replyToId: "321",
        replyToTag: true,
      }),
    });
    harness.lanes.answer.lastPartialText = truncatedFinal;
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: truncatedFinal,
      payload: { text: truncatedFinal, replyToCurrent: true },
      infoKind: "final",
    });

    expect(result.kind).toBe("sent");
    expect(answer.update).not.toHaveBeenCalled();
    expect(harness.clearDraftLane).toHaveBeenCalledTimes(1);
    expectSentPayload(
      harness,
      { text: fullAnswer, replyToId: "321", replyToTag: true, replyToCurrent: true },
      true,
    );
  });
});
