import { getSafeLocalStorage } from "../../local-storage.ts";
import { i18n } from "./translate.ts";
import type { Locale, TranslationMap } from "./types.ts";

type LocaleTranslationLoader = (locale: Locale) => Promise<TranslationMap | null>;
type TranslateTestApi = {
  createI18nManager(loadLocaleTranslation: LocaleTranslationLoader): typeof i18n;
};

function getTestApi(): TranslateTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.i18nManagerTestApi")
  ];
  if (!api) {
    throw new Error("i18n manager test API is unavailable");
  }
  return api as TranslateTestApi;
}

export function createI18nManagerForTesting(
  loadLocaleTranslation: LocaleTranslationLoader,
): typeof i18n {
  return getTestApi().createI18nManager(loadLocaleTranslation);
}

/** Restores locale state, persisted preference, and document metadata after a shared-worker test. */
export function captureI18nStateForTesting(): () => Promise<void> {
  const previousLocale = i18n.getLocale();
  const storage = getSafeLocalStorage();
  const previousPreference = storage?.getItem("openclaw.i18n.locale") ?? null;
  const documentElement = typeof document === "undefined" ? undefined : document.documentElement;
  const previousDocumentLocale = documentElement && {
    lang: documentElement.getAttribute("lang"),
    dir: documentElement.getAttribute("dir"),
  };

  return async () => {
    await i18n.setLocale(previousLocale);
    // A separate manager can change the document while this manager's locale stays the same.
    if (documentElement && previousDocumentLocale) {
      for (const [attribute, value] of Object.entries(previousDocumentLocale)) {
        if (value === null) {
          documentElement.removeAttribute(attribute);
        } else {
          documentElement.setAttribute(attribute, value);
        }
      }
    }
    if (previousPreference === null) {
      storage?.removeItem("openclaw.i18n.locale");
    } else {
      storage?.setItem("openclaw.i18n.locale", previousPreference);
    }
  };
}
