import { useSyncExternalStore } from "react";

// Phone-sized screens (an iPhone, or a very narrow window): the sidebar becomes a drawer and
// side panels take the whole screen. iPad and desktop keep the full layout.
const query = window.matchMedia("(max-width: 767px)");

export function useCompact(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => query.matches,
  );
}
