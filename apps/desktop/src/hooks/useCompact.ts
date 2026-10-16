import { useSyncExternalStore } from "react";

// Phone-sized screens, portrait or landscape (an iPhone, or a very small window): the sidebar
// becomes a drawer and side panels take the whole screen. iPad and desktop keep the full
// layout. The same query is the `compact` variant in styles.css.
const compact = window.matchMedia("(max-width: 767px), (max-height: 500px)");
// A phone on its side: remote desktops go full screen there, as in Microsoft's app.
const phoneLandscape = window.matchMedia("(max-height: 500px) and (orientation: landscape)");

const useMedia = (query: MediaQueryList) =>
  useSyncExternalStore(
    (onChange) => {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => query.matches,
  );

export const useCompact = (): boolean => useMedia(compact);
export const usePhoneLandscape = (): boolean => useMedia(phoneLandscape);
