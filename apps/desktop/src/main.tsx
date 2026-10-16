import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";
import "./i18n";
import App from "./App";
import { ptyKillAll, sshCloseAll } from "./lib/ipc";

// Sessions left over from a previous load of this webview (e.g. a reload) have no tab any more.
void Promise.all([ptyKillAll(), sshCloseAll()])
  .catch((error) => console.error("session cleanup failed", error))
  .finally(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
