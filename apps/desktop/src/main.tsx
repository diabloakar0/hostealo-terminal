import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";
import "./i18n";
import App from "./App";
import { hasLocalShell, isIOS } from "./lib/format";
import { ptyKillAll, sshCloseAll } from "./lib/ipc";

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
