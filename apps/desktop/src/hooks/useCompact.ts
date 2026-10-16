import { useSyncExternalStore } from "react";

// Phone-sized screens, portrait or landscape (an iPhone, or a very small window): the sidebar
// becomes a drawer and side panels take the whole screen. iPad and desktop keep the full
// layout. The same query is the `compact` variant in styles.css.
const query = window.matchMedia("(max-width: 767px), (max-height: 500px)");

export function useCompact(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => query.matches,
  );
}
