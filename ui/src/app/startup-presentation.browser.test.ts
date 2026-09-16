import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderStartupSidebarSkeleton } from "../components/startup-sidebar-skeleton.ts";
import { StartupPresentationController } from "./startup-presentation.ts";
import "../styles/startup-skeletons.css";

let fixture: HTMLDivElement | undefined;
let controller: StartupPresentationController | undefined;

afterEach(() => {
  controller?.dispose();
  controller = undefined;
  fixture?.remove();
  fixture = undefined;
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe.runIf("__vitest_browser__" in globalThis)(
  "startup presentation timing and visibility",
  () => {
    it("keeps early content usable when the delayed sidebar placeholder appears", async () => {
      const { page, userEvent } = await import("vitest/browser");
      // Control the presentation owner's clock, not app boot or native pointer events.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      fixture = document.createElement("div");
      fixture.className = "shell";
      fixture.setAttribute("data-startup-managed", "");
      fixture.style.cssText = "--startup-mask-transition: none; width: 640px; padding: 16px;";
      // This isolates the controller/CSS boundary. The full startup-priority E2E
      // covers real pane admission, inert ownership, drafts and roster responses.
      fixture.innerHTML = `
      <aside class="shell-nav" style="position: relative; height: 48px"></aside>
      <div class="chat-thread"><p>Conversation ready before the sidebar.</p></div>
      <textarea aria-label="Early conversation draft"></textarea>
    `;
      document.body.append(fixture);
      const shell = fixture;
      render(renderStartupSidebarSkeleton(undefined), shell.querySelector(".shell-nav")!);
      const transcript = shell.querySelector<HTMLElement>(".chat-thread")!;
      const placeholder = shell.querySelector<HTMLElement>(".startup-sidebar-skeleton")!;
      const paragraph = transcript.querySelector("p")!;
      const text = paragraph.textContent!;
      controller = new StartupPresentationController((snapshot) => {
        shell.dataset.startupStage = snapshot.stage;
        shell.dataset.startupPlaceholder = String(snapshot.placeholderVisible);
      });
      controller.start();
      expect(getComputedStyle(paragraph).visibility).toBe("hidden");
      expect(getComputedStyle(placeholder).opacity).toBe("0");

      await vi.advanceTimersByTimeAsync(149);
      controller.update(false, true);
      const expectReadable = async () => {
        expect(getComputedStyle(paragraph).visibility).toBe("visible");
        expect(getComputedStyle(transcript).pointerEvents).not.toBe("none");
        window.getSelection()?.removeAllRanges();
        await userEvent.tripleClick(paragraph);
        expect(window.getSelection()?.toString().trim()).toBe(text);
      };
      await expectReadable();
      expect(getComputedStyle(placeholder).opacity).toBe("0");
      await page.getByRole("textbox", { name: "Early conversation draft" }).fill("Early draft");

      await vi.advanceTimersByTimeAsync(1);
      expect(getComputedStyle(placeholder).opacity).toBe("1");
      await expectReadable();
      await page
        .getByRole("textbox", { name: "Early conversation draft" })
        .fill("Early draft continued");

      // The sidebar settles after its placeholder appeared. Its minimum dwell
      // must not hide the already readable conversation again.
      controller.update(true, true);
      await vi.advanceTimersByTimeAsync(299);
      expect(getComputedStyle(placeholder).opacity).toBe("1");
      await expectReadable();
      await vi.advanceTimersByTimeAsync(1);
      expect(getComputedStyle(placeholder).opacity).toBe("0");
      await expectReadable();
      expect(shell.querySelector("textarea")!.value).toBe("Early draft continued");
    });
  },
);
