import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import es from "./es.json";
import type { LanguagePreference } from "../store/settings";

export const SUPPORTED_LANGUAGES = ["en", "es"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export function resolveLanguage(preference: LanguagePreference): Language {
  if (preference !== "system") return preference;
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
