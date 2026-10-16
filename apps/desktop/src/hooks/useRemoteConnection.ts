import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { remoteClose, remoteExec, remoteOpen, type ExecOutput } from "../lib/ipc";
import { usePrompts } from "../store/prompts";
import { useTabs, type Tab } from "../store/tabs";

export interface RemoteConnection {
  /** Usable once connected (`null` while connecting or after it failed). */
  connection: number | null;
  /** Why it could not connect (shown with a "reconnect" button). */
  connectError: string | null;
  reconnect: () => void;
  /** Runs a command on the server over the tab's own connection. */
  run: (command: string, timeoutSecs?: number) => Promise<ExecOutput>;
}

/**
 * The SSH connection of a tool tab (Docker, virtual machines): no terminal, just commands. Host
 * key and password questions go to the usual dialogs; the tab's status dot follows it.
 */
export function useRemoteConnection(tab: Tab): RemoteConnection {
  const { t } = useTranslation();
  const [connection, setConnection] = useState<number | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const tabs = useTabs.getState();
    let id: number | null = null;
    let disposed = false;
    setConnection(null);
    setConnectError(null);
    tabs.setStatus(tab.id, "connecting");
    void remoteOpen(tab.hostId!, (event) => {
      if (disposed) return;
      switch (event.type) {
        case "status":
          tabs.setStatus(tab.id, event.stage);
          if (event.stage === "connected" && id !== null) setConnection(id);
          return;
        case "hostKey":
        case "certificate":
        case "prompt":
          usePrompts.getState().enqueue({ ...event, tabId: tab.id, hostId: tab.hostId! });
          return;
        case "closed":
          usePrompts.getState().dropForTab(tab.id);
          tabs.setStatus(tab.id, event.error ? "failed" : "closed");
          setConnectError(event.error ?? t("remote.cancelled"));
          return;
      }
    })
      .then((opened) => {
        if (disposed) void remoteClose(opened);
        else {
          id = opened;
          // `connected` may have come first.
          if (useTabs.getState().tabs.find((x) => x.id === tab.id)?.status === "connected") setConnection(opened);
        }
      })
      .catch((e) => setConnectError(String(e)));
    return () => {
      disposed = true;
      usePrompts.getState().dropForTab(tab.id);
      if (id !== null) void remoteClose(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.hostId, attempt]);

  const run = useCallback(
    async (command: string, timeoutSecs = 60) => {
      if (connection === null) throw new Error(t("remote.notConnected"));
      return remoteExec(connection, command, timeoutSecs);
    },
    [connection, t],
  );

  return { connection, connectError, reconnect: () => setAttempt((n) => n + 1), run };
}
