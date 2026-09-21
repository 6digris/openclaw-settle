import { writeFile } from "node:fs/promises";
import type { Locator } from "playwright";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import type { createChatFlowE2eSuite } from "./chat-flow.test-support.ts";

export async function createReasoningProofPage(
  suite: ReturnType<typeof createChatFlowE2eSuite>,
  scope: string,
) {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  const artifactDir = parent ? createControlUiE2eArtifactDir(scope, parent) : undefined;
  const viewport = { height: 900, width: 1280 };
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
  });
  const page = await context.newPage();
  const capture = async (fileName: string, surface: Locator, content: Locator) => {
    if (artifactDir) {
      await writeFile(
        `${artifactDir}/${fileName}.png`,
        await takeControlUiViewportScreenshot(page, surface, [content]),
      );
    }
  };
  return { context, page, capture };
}
