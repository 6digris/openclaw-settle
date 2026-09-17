import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import { createToolProbeNonce, hasExpectedToolNonce } from "./live-tool-probe.test-helpers.js";

const fixture = vi.hoisted(() => ({
  uuid: "81ec0f76-1bcb-41d5-91fc-ff88c022d50b",
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => fixture.uuid,
}));

function persistedText(text: string): string {
  const message = { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
  const persisted = redactTranscriptMessage(message, { logging: { redactSensitive: "tools" } });
  return (persisted as { content: Array<{ text: string }> }).content[0].text;
}

describe("live tool probe nonce persistence", () => {
  it("reproduces the credential-shaped UUID collision without relaxing redaction", () => {
    const marker = `tool-read-beta-${fixture.uuid}`;
    expect(persistedText(marker)).toBe("tool-read-beta-81ec0f76-1bcb-41d5-91***");
    expect(persistedText("fc-ff88c022d50b")).toBe("***");
  });

  it("preserves complete probe markers through real transcript redaction", () => {
    const nonce = createToolProbeNonce();
    expect(nonce).toBe("81ec0f761bcb41d591fcff88c022d50b");
    const alpha = `tool-read-alpha-${nonce}`;
    const beta = `tool-read-beta-${nonce}`;
    const persisted = persistedText(`${alpha} ${beta}`);
    expect(hasExpectedToolNonce(persisted, alpha, beta)).toBe(true);
    expect(persistedText(nonce)).toBe(nonce);
    expect(hasExpectedToolNonce(persistedText(alpha), alpha, beta)).toBe(false);
  });
});
