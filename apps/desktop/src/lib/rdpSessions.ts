/**
 * Open remote desktop sessions by tab id, so controls outside the desktop (the tab bar) can act
 * on them without covering any part of the remote screen.
 */
export interface RdpHandle {
  sendCtrlAltDel: () => void;
  /** Connects again (for example after changing the shared folder). */
  reconnect: () => void;
}

const sessions = new Map<string, RdpHandle>();

export function registerRdp(tabId: string, handle: RdpHandle): () => void {
  sessions.set(tabId, handle);
  return () => {
    if (sessions.get(tabId) === handle) sessions.delete(tabId);
  };
}

export const getRdp = (tabId: string | null | undefined): RdpHandle | undefined => (tabId ? sessions.get(tabId) : undefined);
