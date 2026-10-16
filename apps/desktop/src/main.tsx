import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";
import "./i18n";
import App from "./App";
import { hasLocalShell, isIOS } from "./lib/format";
import { ptyKillAll, sshCloseAll } from "./lib/ipc";
import { installLongPress } from "./lib/longPress";

// iOS lays the on-screen keyboard over the page: the app takes the height it leaves free, so the
// terminal prompt and the key bar stay in sight while typing.
if (isIOS && window.visualViewport) {
  const viewport = window.visualViewport;
  const fit = () => {
    document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
    window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", fit);
  // Focusing a field makes iOS scroll the whole page to it; the app never scrolls as a page.
  window.addEventListener("scroll", () => window.scrollY && window.scrollTo(0, 0));
  fit();
}

// iOS text size (Settings › Display & Brightness › Text Size): the root font follows it, and with
// it every text in the app (font sizes are in rem, see remFontSizes.ts). The default size, 17pt,
// is the app's 16px; very large sizes are capped so the layout still fits.
if (isIOS) {
  const followTextSize = () => {
    const probe = document.createElement("span");
    probe.style.cssText = "font: -apple-system-body; position: absolute; visibility: hidden";
    document.body.append(probe);
    const body = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    if (body > 0) document.documentElement.style.fontSize = `${(16 * Math.min(1.5, Math.max(0.85, body / 17))).toFixed(2)}px`;
  };
  followTextSize();
  // Changed in Settings while the app was in the background.
  document.addEventListener("visibilitychange", () => !document.hidden && followTextSize());
}

// Touch screens: holding a finger on something opens its menu, like a right click.
if (window.matchMedia("(hover: none)").matches) installLongPress();

// Sessions left over from a previous load of this webview (e.g. a reload) have no tab any more.
void Promise.all([hasLocalShell ? ptyKillAll() : Promise.resolve(), sshCloseAll()])
  .catch((error) => console.error("session cleanup failed", error))
  .finally(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
