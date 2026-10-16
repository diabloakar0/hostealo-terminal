import { useEffect, useSyncExternalStore } from "react";

import i18n, { resolveLanguage } from "../i18n";
import { useSettings } from "../store/settings";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function subscribeToSystemTheme(onChange: () => void) {
  darkQuery.addEventListener("change", onChange);
  return () => darkQuery.removeEventListener("change", onChange);
}

/** The theme actually in use, with "system" resolved against the OS setting. */
export function useResolvedTheme(): "dark" | "light" {
  const preference = useSettings((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, () => darkQuery.matches);
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Applies theme and language to the document. Mount once, at the root. */
export function useApplyPreferences() {
  const theme = useResolvedTheme();
  const languagePreference = useSettings((s) => s.language);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const language = resolveLanguage(languagePreference);
    document.documentElement.lang = language;
    void i18n.changeLanguage(language);
  }, [languagePreference]);
}
