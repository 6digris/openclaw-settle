import { afterEach, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import "./base.css";
import "./chat/text.css";

let root: HTMLDivElement;
afterEach(() => root?.remove());

it.each(["chat-text", "chat-thinking"])(
  "keeps one bullet per unordered item in %s without removing ordered markers or checkboxes",
  (className) => {
    root = document.createElement("div");
    root.className = className;
    root.style.width = "400px";
    root.innerHTML = toSanitizedMarkdownHtml(
      [
        "- Ordinary bullet",
        "  - Nested bullet",
        "  - [ ] Nested task",
        "- [ ] Pending task",
        "- [x] Completed task",
        "- Another ordinary bullet",
        "",
        "1. Numbered item",
        "   - Bullet inside a numbered item",
        "2. Another numbered item",
      ].join("\n"),
    );
    document.body.append(root);

    const bullets = root.querySelectorAll("ul > li:not(.task-list-item)");
    expect(bullets).toHaveLength(4);
    for (const bullet of bullets) {
      // Safari ignores empty ::marker content. Suppress the native list style
      // itself so it cannot paint alongside our custom ::before bullet.
      expect(getComputedStyle(bullet).listStyleType).toBe("none");
      expect(getComputedStyle(bullet, "::before").content).toBe('"•"');
    }

    const numberedItems = root.querySelectorAll("ol > li");
    expect(numberedItems).toHaveLength(2);
    for (const item of numberedItems) {
      expect(getComputedStyle(item).listStyleType).toBe("decimal");
      expect(getComputedStyle(item, "::before").content).toBe("none");
    }

    const tasks = root.querySelectorAll(".task-list-item");
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(getComputedStyle(task).listStyleType).toBe("none");
      expect(getComputedStyle(task, "::before").content).toBe("none");
      expect(task.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
    }
  },
);
