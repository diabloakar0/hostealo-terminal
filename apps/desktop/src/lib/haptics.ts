import { isIOS } from "./format";

/**
 * A light tap under the finger, for the touch key bars (iPhone and iPad). Nothing elsewhere,
 * and never an error: feedback is a nicety.
 */
export function tap(): void {
  if (!isIOS) return;
  void import("@tauri-apps/plugin-haptics")
    .then(({ selectionFeedback }) => selectionFeedback())
    .catch(() => {});
}
