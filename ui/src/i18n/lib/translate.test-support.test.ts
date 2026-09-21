/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./translate.test-support.ts";
import { i18n } from "./translate.ts";

let restoreI18n: () => Promise<void>;

beforeEach(async () => {
  restoreI18n = captureI18nStateForTesting();
  vi.stubGlobal("document", document.implementation.createHTMLDocument());
  vi.stubGlobal("localStorage", createStorageMock());
  await i18n.setLocale("en");
});

afterEach(async () => {
  try {
    await restoreI18n();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  {
    name: "existing document attributes and locale preference",
    attributes: { lang: "en-GB", dir: "ltr" },
    preference: "en",
    locale: "ar",
    direction: "rtl",
  },
  {
    name: "absent document attributes and locale preference",
    attributes: null,
    preference: null,
    locale: "de",
    direction: "ltr",
  },
] as const)("restores $name after another manager changes locale", async (fixture) => {
  const manager = createI18nManagerForTesting(async () => ({}));
  await manager.setLocale("en");
  const element = document.documentElement;
  if (fixture.attributes) {
    element.lang = fixture.attributes.lang;
    element.dir = fixture.attributes.dir;
  } else {
    element.removeAttribute("lang");
    element.removeAttribute("dir");
  }
  if (fixture.preference === null) {
    localStorage.removeItem("openclaw.i18n.locale");
  } else {
    localStorage.setItem("openclaw.i18n.locale", fixture.preference);
  }
  const restore = captureI18nStateForTesting();

  await manager.setLocale(fixture.locale);

  expect(i18n.getLocale()).toBe("en");
  expect(element.lang).toBe(fixture.locale);
  expect(element.dir).toBe(fixture.direction);
  expect(localStorage.getItem("openclaw.i18n.locale")).toBe(fixture.locale);

  await restore();

  expect(element.getAttribute("lang")).toBe(fixture.attributes?.lang ?? null);
  expect(element.getAttribute("dir")).toBe(fixture.attributes?.dir ?? null);
  expect(localStorage.getItem("openclaw.i18n.locale")).toBe(fixture.preference);
});
