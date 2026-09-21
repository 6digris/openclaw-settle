import { describe, expect, it } from "vitest";
import { renderTelegramMiniAppPage } from "./page.js";

describe("renderTelegramMiniAppPage", () => {
  it("escapes the nonce for its quoted HTML attribute", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: `&<>"'` });

    expect(html).toContain('nonce="&amp;&lt;&gt;&quot;&#39;"');
  });
});
