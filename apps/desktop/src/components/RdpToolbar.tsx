import { useState } from "react";
import { useTranslation } from "react-i18next";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, FolderOpen, FolderSymlink, Keyboard, Volume2, VolumeOff, VolumeX, X } from "lucide-react";
import { cn } from "@hostealo/ui/cn";

import { isIOS, isMac } from "../lib/format";
import { getRdp, useRdpAudio } from "../lib/rdpSessions";
import { useRdpKeyboard } from "../lib/rdpTouch";
import { hostById, useHosts } from "../store/hosts";
import type { Tab } from "../store/tabs";
import { Button } from "./ui/Button";
import { Menu, type MenuAnchor } from "./ui/Menu";

/** `~/x` → an absolute path, for showing the folder in Finder or Explorer. */
async function absolutePath(path: string): Promise<string> {
  if (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\")) return path;
  return join(await homeDir(), path.slice(2));
}

/**
 * A remote desktop's controls, in the tab bar: never over the remote screen, where they would
 * cover what is under them (the close buttons of Windows windows sit at the top right).
 */
export function RdpToolbar({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const host = useHosts((s) => s.hosts.find((h) => h.id === tab.hostId));
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  /** Shares another folder (or none) and reconnects so the server sees the change. */
  const setSharedFolder = async (folder: string | null) => {
    const current = hostById(tab.hostId);
    if (!current) return;
    await useHosts.getState().save({ ...current, rdpSharedFolder: folder }, { action: "keep" }, { action: "keep" });
    getRdp(tab.id)?.reconnect();
  };

  const chooseSharedFolder = async () => {
    const folder = await open({ directory: true, multiple: false, defaultPath: await homeDir() });
    if (typeof folder === "string") await setSharedFolder(folder);
  };

  const connected = tab.status === "connected";
  const audio = useRdpAudio((s) => s.byTab[tab.id]) ?? { state: "waiting" as const };
  const keyboardOpen = useRdpKeyboard((s) => s.tabId === tab.id);
  return (
    <>
      {connected && (
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-btn",
            audio.state === "playing" ? "text-green" : audio.state === "failed" ? "text-red" : "text-fg-muted",
          )}
          title={audio.state === "playing" ? t("rdp.audioPlaying") : audio.state === "failed" ? t("rdp.audioFailed", { error: audio.error }) : t("rdp.audioWaiting")}
          aria-label={audio.state === "playing" ? t("rdp.audioPlaying") : audio.state === "failed" ? t("rdp.audioFailed", { error: audio.error }) : t("rdp.audioWaiting")}
        >
          {audio.state === "playing" ? <Volume2 className="size-4" /> : audio.state === "failed" ? <VolumeX className="size-4" /> : <VolumeOff className="size-4" />}
        </span>
      )}
      {/* iPhone and iPad: the device keyboard on demand (Ctrl+Alt+Supr is in its key row). */}
      {isIOS && (
        <Button
          size="sm"
          variant={keyboardOpen ? "secondary" : "ghost"}
          disabled={!connected}
          // Focus in the tap itself, or iOS keeps its keyboard down.
          onClick={() => (keyboardOpen ? getRdp(tab.id)?.closeKeyboard() : getRdp(tab.id)?.openKeyboard())}
          title={t("rdp.keyboard")}
          aria-pressed={keyboardOpen}
        >
          <Keyboard className="size-3.5" />
          <span className="compact:hidden">{t("rdp.keyboard")}</span>
        </Button>
      )}
      {/* iOS has no folder to share with the server: its apps keep their files to themselves. */}
      {!isIOS && (
        <Button
          size="sm"
          variant={menu ? "secondary" : "ghost"}
          onClick={(e) => setMenu({ rect: e.currentTarget.getBoundingClientRect(), placement: "below" })}
          title={host?.rdpSharedFolder ? t("rdp.sharedFolderTitle", { path: host.rdpSharedFolder }) : t("rdp.noSharedFolder")}
        >
          <FolderSymlink className="size-3.5" />
          {t("rdp.sharedFolderShort")}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      )}
      {!isIOS && (
        <Button size="sm" variant="ghost" disabled={!connected} onClick={() => getRdp(tab.id)?.sendCtrlAltDel()} title={t("rdp.ctrlAltDel")}>
          <Keyboard className="size-3.5" />
          {t("rdp.ctrlAltDelLabel")}
        </Button>
      )}

      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          className="max-w-80"
          entries={
            host?.rdpSharedFolder
              ? [
                  { heading: t("rdp.sharedFolderHeading") },
                  { content: <p className="truncate px-2 pb-1.5 font-mono text-xs text-fg-secondary">{host.rdpSharedFolder}</p> },
                  {
                    label: isMac ? t("rdp.openInFinder") : t("rdp.openInExplorer"),
                    icon: <FolderOpen />,
                    onSelect: () => void absolutePath(host.rdpSharedFolder!).then((path) => revealItemInDir(path)),
                  },
                  { label: t("rdp.changeSharedFolder"), icon: <FolderSymlink />, hint: t("rdp.reconnects"), onSelect: () => void chooseSharedFolder() },
                  { separator: true },
                  { label: t("rdp.stopSharing"), icon: <X />, hint: t("rdp.reconnects"), onSelect: () => void setSharedFolder(null) },
                ]
              : [
                  { content: <p className="px-2 py-1.5 text-xs leading-relaxed text-fg-muted">{t("rdp.sharedFolderExplain")}</p> },
                  { label: t("rdp.shareFolder"), icon: <FolderSymlink />, hint: t("rdp.reconnects"), onSelect: () => void chooseSharedFolder() },
                ]
          }
        />
      )}
    </>
  );
}
