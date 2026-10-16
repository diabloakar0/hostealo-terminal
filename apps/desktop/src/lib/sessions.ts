// What a terminal tab is connected to. TerminalView only talks to this interface, so local
// shells, SSH (and later serial-like protocols) share the same view.
import i18n from "../i18n";
import { hostById, useHosts } from "../store/hosts";
import { LOCAL_MONITOR, useMonitors } from "../store/monitor";
import { usePrompts } from "../store/prompts";
import { useTabs, type Tab } from "../store/tabs";
import { localExec, ptyKill, ptyResize, ptySpawn, ptyWrite, sshClose, sshConnect, sshExec, sshResize, sshWrite, type ExecOutput, type SshEvent } from "./ipc";

export interface SessionExit {
  code: number | null;
  error: string | null;
}

export interface SessionCallbacks {
  onData: (data: Uint8Array) => void;
  /** Status line written dimmed into the terminal ("Connecting to…"). */
  onInfo: (message: string) => void;
  onExit: (exit: SessionExit) => void;
}

export interface SessionBackend {
  /** Starts (or restarts after an exit) the session. */
  start: (cols: number, rows: number, callbacks: SessionCallbacks) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  dispose: () => void;
  /** Key of this session's entry in the monitor store. */
  monitorKey: string;
  /** Runs a command to completion outside the interactive shell (the assistant's agent mode). */
  exec: (command: string, timeoutSecs: number) => Promise<ExecOutput>;
}

export function createBackend(tab: Tab): SessionBackend {
  return tab.kind === "ssh" && tab.hostId ? sshBackend(tab.id, tab.hostId) : localBackend();
}

function localBackend(): SessionBackend {
  let id: number | null = null;
  let disposed = false;

  return {
    monitorKey: LOCAL_MONITOR,
    exec: (command, timeoutSecs) => localExec(command, timeoutSecs),
    start: (cols, rows, callbacks) => {
      ptySpawn(cols, rows, {
        onData: callbacks.onData,
        onExit: (code) => {
          id = null;
          if (!disposed) callbacks.onExit({ code, error: null });
        },
      })
        .then((spawned) => {
          if (disposed) void ptyKill(spawned);
          else id = spawned;
        })
        .catch((error) => callbacks.onExit({ code: null, error: String(error) }));
    },
    write: (data) => {
      if (id !== null) void ptyWrite(id, data);
    },
    resize: (cols, rows) => {
      if (id !== null) void ptyResize(id, cols, rows);
    },
    dispose: () => {
      disposed = true;
      if (id !== null) void ptyKill(id);
    },
  };
}

function sshBackend(tabId: string, hostId: string): SessionBackend {
  let id: number | null = null;
  let disposed = false;
  const tabs = useTabs.getState();

  const handleEvent = (event: SshEvent, callbacks: SessionCallbacks) => {
    if (disposed) return;
    switch (event.type) {
      case "status": {
        tabs.setStatus(tabId, event.stage);
        // A tab opened to run something (`docker exec` into a container): type it once the
        // shell is up.
        const input = useTabs.getState().tabs.find((t) => t.id === tabId)?.initialInput;
        if (event.stage === "connected" && input) {
          setTimeout(() => {
            if (id !== null && !disposed) void sshWrite(id, `${input}\r`);
          }, 400);
        }
        if (event.stage === "connecting") {
          const host = hostById(hostId);
          const target = host ? `${host.username}@${host.hostname}${host.port === 22 ? "" : `:${host.port}`}` : "";
          callbacks.onInfo(i18n.t("ssh.connecting", { target }));
        }
        return;
      }
      case "hostKey":
      case "certificate":
      case "prompt":
        usePrompts.getState().enqueue({ ...event, tabId, hostId });
        return;
      case "banner":
        callbacks.onInfo(event.message.trimEnd());
        return;
      case "os":
        void useHosts.getState().setOs(hostId, event.os);
        return;
      case "closed":
        id = null;
        usePrompts.getState().dropForTab(tabId);
        useMonitors.getState().remove(tabId);
        tabs.setStatus(tabId, event.error ? "failed" : "closed");
        callbacks.onExit({ code: event.exitCode, error: event.error });
        return;
    }
  };

  return {
    monitorKey: tabId,
    exec: (command, timeoutSecs) => (id === null ? Promise.reject(new Error(i18n.t("ai.agent.notConnected"))) : sshExec(id, command, timeoutSecs)),
    start: (cols, rows, callbacks) => {
      tabs.setStatus(tabId, "connecting");
      sshConnect(hostId, cols, rows, {
        onEvent: (event) => handleEvent(event, callbacks),
        onData: callbacks.onData,
        onMonitor: (event) => {
          if (disposed) return;
          if (event.type === "snapshot") useMonitors.getState().push(tabId, event.snapshot);
          else useMonitors.getState().setUnsupported(tabId);
        },
      })
        .then((connected) => {
          if (disposed) void sshClose(connected);
          else id = connected;
        })
        .catch((error) => {
          tabs.setStatus(tabId, "failed");
          callbacks.onExit({ code: null, error: String(error) });
        });
    },
    write: (data) => {
      if (id !== null) void sshWrite(id, data);
    },
    resize: (cols, rows) => {
      if (id !== null) void sshResize(id, cols, rows);
    },
    dispose: () => {
      disposed = true;
      usePrompts.getState().dropForTab(tabId);
      useMonitors.getState().remove(tabId);
      if (id !== null) void sshClose(id);
    },
  };
}
