import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseDeliveryParams,
  createBot,
  createRuntime,
  deliverReplies,
  deliverStructuredReplies,
  firstMockCallArg,
  loadWebMedia,
  mockMediaLoad,
  resetDeliveryMocks,
} from "./delivery.test-support.js";

describe("Telegram reply directive delivery", () => {
  beforeEach(resetDeliveryMocks);

  it.each([
    { name: "raw command", deliver: deliverReplies, voice: true, caption: "Example" },
    {
      name: "prepared stream fragment",
      deliver: deliverStructuredReplies,
      voice: false,
      caption: "[[reply_to:999]] [[audio_as_voice]] Example",
    },
  ])("preserves the $name directive contract through media delivery", async (testCase) => {
    const sendAudio = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    const sendVoice = vi.fn().mockResolvedValue({ message_id: 2, chat: { id: "123" } });
    mockMediaLoad("note.ogg", "audio/ogg", "synthetic audio");

    await testCase.deliver({
      ...baseDeliveryParams,
      replies: [
        {
          text: "[[reply_to:999]] [[audio_as_voice]] Example",
          mediaUrl: "https://example.invalid/note.ogg",
        },
      ],
      replyToMode: "all",
      runtime: createRuntime(),
      bot: createBot({ sendAudio, sendVoice }),
      mediaLoader: loadWebMedia,
    });

    const sent = testCase.voice ? sendVoice : sendAudio;
    expect(sent).toHaveBeenCalledTimes(1);
    expect(testCase.voice ? sendAudio : sendVoice).not.toHaveBeenCalled();
    expect(firstMockCallArg(sent, 2)).toMatchObject({ caption: testCase.caption });
    if (testCase.voice) {
      expect(firstMockCallArg(sent, 2)).toMatchObject({ reply_to_message_id: 999 });
    } else {
      expect(firstMockCallArg(sent, 2)).not.toHaveProperty("reply_to_message_id");
      expect(firstMockCallArg(sent, 2)).not.toHaveProperty("reply_parameters");
    }
  });

  it("preserves prepared voice and reply fields beside literal directives", async () => {
    const sendVoice = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    mockMediaLoad("note.ogg", "audio/ogg", "synthetic audio");

    await deliverStructuredReplies({
      ...baseDeliveryParams,
      replies: [
        {
          text: "[[reply_to:999]] [[audio_as_voice]] Example",
          mediaUrl: "https://example.invalid/note.ogg",
          replyToId: "42",
          audioAsVoice: true,
        },
      ],
      replyToMode: "all",
      runtime: createRuntime(),
      bot: createBot({ sendVoice }),
      mediaLoader: loadWebMedia,
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendVoice, 2)).toMatchObject({
      caption: "[[reply_to:999]] [[audio_as_voice]] Example",
      reply_to_message_id: 42,
    });
  });
});
