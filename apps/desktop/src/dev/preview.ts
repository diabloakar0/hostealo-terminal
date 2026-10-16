// UI preview: the real app running in a plain browser on a mocked backend, so the interface can be
// designed and screenshotted without Tauri or real servers. Dev only (`preview.html` is not part
// of the production build).
//
//   http://localhost:1420/preview.html                 dark theme, SSH session open
//   http://localhost:1420/preview.html?theme=light     light theme
//   http://localhost:1420/preview.html?page=keys       keys / knownHosts / sftp / ftp page
//   http://localhost:1420/preview.html?page=ftp&prompt=certificate   FTPS certificate question

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import type { Snippet } from "../lib/ipc";

const params = new URLSearchParams(location.search);

import {
  AI_REPLY,
  bytes,
  fakeDesktop,
  FOLDERS,
  HOSTS,
  KEYS,
  KNOWN,
  later,
  LOCAL,
  send,
  SFTP,
  snapshot,
  SNIPPETS,
  snippetStore,
  SYSTEMS,
  TCPDUMP,
  dockerExec,
  proxmoxExec,
} from "./fixtures";

const snippets = snippetStore(params.has("nosnippets") ? [] : SNIPPETS);

// ?brand: no colour tags, so the logos show in their own colours.
if (params.has("brand")) for (const h of HOSTS) h.color = null;

/** The display channel of the RDP session, for clipboard notices sent later. */
let rdpDisplay: unknown = null;
let rdpFrame: unknown = null;
const dockerState = new Map<string, string>();
let syncEvents: unknown = null;

mockWindows("main");
mockIPC(
  (cmd, args = {}) => {
    const a = args as Record<string, unknown>;
    switch (cmd) {
      case "hosts_list":
        return { hosts: HOSTS, folders: FOLDERS, snippets: snippets.list() };
      case "snippets_save":
        return snippets.save(a.snippet as Snippet);
      case "snippets_delete":
        return snippets.remove(String(a.id));
      case "hosts_reveal_secret":
        return new Promise((resolve) => later(500, () => resolve("Pr0d-w3b-01!2026")));
      // Face ID / Touch ID: the demo has no owner to ask.
      case "device_unlock":
        return new Promise((resolve) => later(400, () => resolve(null)));
      case "share_files":
        return null;
      case "rdp_resize":
        if (params.has("rdpsize")) return false;
        send(rdpDisplay, { type: "size", width: a.width, height: a.height });
        later(50, () => rdpFrame && send(rdpFrame, fakeDesktop(Number(a.width), Number(a.height))));
        return true;
      case "remote_open":
        later(400, () => send(a.onEvent, { type: "status", stage: "connected" }));
        return 31;
      case "remote_exec":
        return new Promise((resolve) => later(String(a.command).includes(" stats ") ? 600 : 150, () => resolve(proxmoxExec(String(a.command)) ?? dockerExec(String(a.command), dockerState))));
      case "remote_close":
        return null;
      case "hostealo_reset_password":
        return new Promise((resolve) => later(800, () => resolve(null)));
      case "monitor_local":
        return snapshot(false);
      case "pty_spawn":
        later(50, () => send(a.onData, bytes(LOCAL)));
        return 1;
      case "ssh_connect": {
        send(a.onEvent, { type: "status", stage: "connecting" });
        later(150, () => send(a.onEvent, { type: "status", stage: "authenticating" }));
        later(300, () => {
          send(a.onEvent, { type: "status", stage: "connected" });
          send(a.onData, bytes(TCPDUMP));
          const tick = () => {
            const snap = snapshot(true);
            const system = SYSTEMS[String(a.hostId)];
            if (system) snap.os = system[1];
            snap.hostname = HOSTS.find((h) => h.id === a.hostId)?.name ?? snap.hostname;
            // ?fulldisk: web-01's database disk nearly full, to see the alert.
            if (params.has("fulldisk") && a.hostId === "web") snap.disks[1].used = 187 * 2 ** 30;
            send(a.onMonitor, { type: "snapshot", snapshot: snap });
          };
          tick();
          setInterval(tick, 2000);
        });
        return 7;
      }
      case "rdp_connect": {
        // The size asked for, as a server with live resizing gives it (?rdpsize=1280x720 forces one).
        const forced = params.get("rdpsize")?.split("x").map(Number);
        const [width, height] = forced ?? [Number(a.width), Number(a.height)];
        later(150, () => {
          send(a.onEvent, { type: "status", stage: "connected" });
          send(a.onDisplay, { type: "size", width, height });
          send(a.onFrame, fakeDesktop(width, height));
          // ?audio: the server is sending sound (green speaker in the tab bar).
          if (params.has("audio")) send(a.onDisplay, { type: "audio", playing: true, error: null });
        });
        // ?clip=files|progress|saved: the clipboard bar.
        const clip = params.get("clip");
        const notices: Record<string, unknown> = {
          files: { kind: "remoteFiles", names: ["informe-Q3.xlsx", "capturas", "backup.sql"], count: 14, bytes: 48_300_000 },
          progress: { kind: "progress", done: 19_600_000, total: 48_300_000 },
          saved: { kind: "saved", paths: ["/Users/demo/Downloads/informe-Q3.xlsx"] },
        };
        rdpDisplay = a.onDisplay;
        rdpFrame = a.onFrame;
        const clipDelay = Number(params.get("clipdelay") ?? 300);
        if (clip && notices[clip]) later(clipDelay, () => send(a.onDisplay, { type: "clipboard", notice: notices[clip] }));
        return 9;
      }
      // ?ai=open|chat|setup: the assistant panel (configured, mid-conversation, or not set up).
      case "ai_settings_get":
        return {
          settings: { provider: "anthropic", model: params.get("ai") === "setup" ? "" : "claude-opus-5-5", baseUrl: "", effort: "medium" },
          hasKey: params.get("ai") !== "setup",
          defaultBaseUrl: "https://api.anthropic.com",
          saved: params.get("ai") !== "setup",
          claudeCode: "/opt/homebrew/bin/claude",
        };
      case "ai_settings_save":
        return { settings: a.settings, hasKey: true, defaultBaseUrl: "https://api.anthropic.com", saved: true, claudeCode: "/opt/homebrew/bin/claude" };
      case "ai_models":
        if ((a.settings as { provider: string }).provider === "claudeCode") return ["opus", "sonnet", "haiku"];
        return ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
      case "ai_cancel":
        return null;
      case "ssh_exec":
        return new Promise((resolve) =>
          later(900, () =>
            resolve(
              String(a.command).includes("apt-get")
                ? { stdout: "Reading package lists...\nBuilding dependency tree...\nThe following NEW packages will be installed:\n  nginx nginx-common\nSetting up nginx (1.24.0-2ubuntu7) ...\n", stderr: "", exitCode: 0, timedOut: false }
                : { stdout: "HTTP/1.1 200 OK\nServer: nginx/1.24.0 (Ubuntu)\n", stderr: "", exitCode: 0, timedOut: false },
            ),
          ),
        );
      case "ai_chat": {
        if (a.agent) {
          const turn = (a.messages as unknown[]).length;
          const reply =
            turn === 1
              ? "Es Ubuntu 24.04, así que lo instalo con apt sin preguntas interactivas:\n\n```run\nDEBIAN_FRONTEND=noninteractive apt-get install -y nginx\n```"
              : turn === 3
                ? "Instalado. Compruebo que responde en el puerto 80:\n\n```run\ncurl -sI http://localhost | head -2\n```"
                : "Listo: **nginx 1.24** está instalado y responde con `200 OK` en el puerto 80. El sitio por defecto está en `/var/www/html`.";
          const words = reply.split(/(?<=\s)/);
          later(100, () => send(a.onEvent, { type: "model", model: "claude-opus-5-5" }));
          words.forEach((word, i) => later(400 + i * 15, () => send(a.onEvent, { type: "text", text: word })));
          later(500 + words.length * 15, () => send(a.onEvent, { type: "done", stopReason: "end_turn" }));
          return 2;
        }
        const words = AI_REPLY.split(/(?<=\s)/);
        later(100, () => send(a.onEvent, { type: "model", model: "claude-opus-5-5" }));
        later(150, () => send(a.onEvent, { type: "thinking" }));
        words.forEach((word, i) => later(700 + i * 12, () => send(a.onEvent, { type: "text", text: word })));
        later(800 + words.length * 12, () => send(a.onEvent, { type: "done", stopReason: "end_turn" }));
        return 1;
      }
      // ?hostealo=connect|connected: the account dialog.
      case "hostealo_account":
        return params.get("hostealo") === "connected" ? { name: "Hostealo SL", email: "admin@example.com" } : null;
      case "hostealo_connect":
        return { name: "Hostealo SL", email: "admin@example.com" };
      case "hostealo_sync":
        return { added: 3, updated: 1, unchanged: 5, pending: 1, data: { hosts: HOSTS, folders: FOLDERS } };
      case "hostealo_power":
        return "ok";
      // ?import=pick|review: the import dialog.
      case "import_detect":
        return [
          { format: "sshConfig", path: "/Users/demo/.ssh/config", count: 6 },
          { format: "fileZilla", path: "/Users/demo/.config/filezilla/sitemanager.xml", count: 14 },
        ];
      case "import_read":
        return {
          token: 1,
          format: "mobaXterm",
          source: "/Users/demo/Downloads/MobaXterm Sessions.mxtsessions",
          hosts: [
            { name: "web-01", hostname: "203.0.113.10", port: 22, username: "root", protocol: "ssh", folder: "Producción", keyPath: null, color: null, hasPassword: false, duplicate: true },
            { name: "web-02", hostname: "203.0.113.12", port: 22, username: "root", protocol: "ssh", folder: "Producción", keyPath: "C:\\keys\\prod.pem", color: null, hasPassword: false, duplicate: false },
            { name: "dc-01", hostname: "10.0.0.5", port: 3389, username: "ACME\\admin", protocol: "rdp", folder: "Clientes/Acme", keyPath: null, color: null, hasPassword: false, duplicate: false },
            { name: "acme-ftp", hostname: "ftp.acme.example", port: 21, username: "acme", protocol: "ftp", folder: "Clientes/Acme", keyPath: null, color: null, hasPassword: false, duplicate: false },
            { name: "backup", hostname: "192.0.2.80", port: 2222, username: "backup", protocol: "ssh", folder: null, keyPath: null, color: null, hasPassword: false, duplicate: false },
          ],
          warnings: ["router: Telnet sessions are not supported", "nas: VNC sessions are not supported"],
        };
      case "import_apply":
        return { hosts: HOSTS, folders: FOLDERS };
      case "rdp_clipboard_save": {
        const total = 48_300_000;
        const stepMs = Number(params.get("clipstep") ?? 250);
        for (let step = 0; step <= 10; step++) {
          later(step * stepMs, () =>
            send(rdpDisplay, { type: "clipboard", notice: step < 10 ? { kind: "progress", done: (total * step) / 10, total } : { kind: "saved", paths: ["/Users/demo/Downloads/informe-Q3.xlsx"] } }),
          );
        }
        return null;
      }
      // ?sync: the device sync window (a phone appears, then the code).
      case "sync_listen":
        later(150, () => send(a.onEvent, { type: "listening", device: "MacBook-Pro-de-Ana", addresses: ["192.168.1.34:53211"], pairing: "hostealo-terminal://sync?a=192.168.1.34:53211&t=q7Zk2cP9vXn4LmR8sT1wYg" }));
        return 41;
      case "sync_browse":
        later(900, () => send(a.onEvent, { type: "found", id: "iphone", name: "iPhone de Ana", address: "192.168.1.52:60412" }));
        later(1300, () => send(a.onEvent, { type: "found", id: "pc", name: "PC-Oficina", address: "192.168.1.20:51800" }));
        return 42;
      case "sync_connect":
        syncEvents = a.onEvent;
        later(500, () => {
          const verified = String(a.address).startsWith("hostealo-terminal://");
          send(a.onEvent, { type: "code", peer: verified ? "PC-Oficina" : "iPhone de Ana", code: "482 913", verified });
        });
        return 43;
      case "sync_confirm":
        later(400, () => send(syncEvents, { type: "syncing" }));
        later(1300, () => send(syncEvents, { type: "done", summary: { added: 3, updated: 1, deleted: 0, secrets: a.includeSecrets ? 4 : 0 } }));
        return null;
      case "sync_cancel":
        return null;
      case "sync_export":
        return new Promise((resolve) => later(900, () => resolve({ hosts: HOSTS.length, secrets: a.includeSecrets ? 4 : 0 })));
      case "sync_import":
        return new Promise((resolve) => later(900, () => resolve({ added: 9, updated: 0, deleted: 0, secrets: 4 })));
      case "local_home":
        return "/Users/demo";
      case "local_list": {
        const path = String(a.path);
        const now = Math.floor(Date.now() / 1000);
        const file = (name: string, size: number, age: number) => ({ name, path: `${path}/${name}`, isDir: false, isSymlink: false, size, modified: now - age, permissions: 0o644, owner: null });
        const dir = (name: string, age: number) => ({ name, path: `${path}/${name}`, isDir: true, isSymlink: false, size: 0, modified: now - age, permissions: 0o755, owner: null });
        return {
          path,
          parent: path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/",
          entries: [dir("Desktop", 3600), dir("Documents", 86400), dir("Downloads", 600), dir("proyectos", 7200), file("backup.sql.gz", 48_300_000, 1800), file("nginx.conf", 2_210, 5400), file("deploy.sh", 980, 9000)],
        };
      }
      case "sftp_open":
        later(200, () => send(a.onEvent, { type: "status", stage: "connected" }));
        return 3;
      case "ftp_open":
        if (params.get("prompt") === "certificate") {
          send(a.onEvent, {
            type: "certificate",
            requestId: 1,
            fingerprint: "3F:A2:9C:01:7B:44:E8:D0:5C:6A:21:9F:B3:70:0E:4D:88:12:C5:6B:2A:F9:13:7E:D4:06:91:BB:5F:3C:A7:E2",
            reason: "invalid peer certificate: certificate not valid for name \"ftp.acme.example\"; certificate is only valid for \"server12.hosting-provider.net\"",
            changed: false,
          });
        } else {
          later(200, () => send(a.onEvent, { type: "status", stage: "connected" }));
        }
        return 4;
      case "sftp_realpath":
      case "ftp_realpath":
        return "/root";
      case "sftp_list":
      case "ftp_list":
        return SFTP;
      case "ssh_keys_list":
        return KEYS;
      case "known_hosts_list":
        return KNOWN;
      case "ssh_keys_default_comment":
        return "demo@macbook";
      // Backup files (the only dialogs that filter on .hostealo).
      case "plugin:dialog|save":
      case "plugin:dialog|open":
        if (!JSON.stringify(a).includes("hostealo")) return null;
        return cmd.endsWith("save") ? "/Users/demo/Documents/hostealo-terminal-2026-10-15.hostealo" : "/Users/demo/Downloads/hostealo-terminal-2026-10-15.hostealo";
      default:
        // Writes, resizes, closes, plugins...: nothing to do.
        return null;
    }
  },
  { shouldMockEvents: true },
);

// Preferences for the scene, before the app reads them.
try {
  localStorage.setItem(
    "hostealo-terminal:settings",
    JSON.stringify({ theme: params.get("theme") ?? "dark", language: params.get("lang") ?? "es", collapsedFolders: ["Clientes/Beta"] }),
  );
} catch {
  // Private mode: defaults apply.
}

await import("../main");
const { useTabs } = await import("../store/tabs");
const { useHosts } = await import("../store/hosts");
await useHosts.getState().load();

const tabs = useTabs.getState();
tabs.openSsh("acme-web");
tabs.openSsh("web");
const page = params.get("page");
if (page === "keys" || page === "knownHosts" || page === "status") tabs.openPage(page);
if (page === "sftp") tabs.openSftp("web");
if (page === "ftp") tabs.openFtp("acme-ftp");
if (page === "rdp") tabs.openRdp("win");
if (page === "docker") tabs.openDocker("web");
if (page === "vms") tabs.openVms("beta");

if (params.get("import")) {
  const { ImportDialog } = await import("../components/ImportDialog");
  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.body.appendChild(document.createElement("div"));
  createRoot(host).render(createElement(ImportDialog, { onClose: () => host.remove() }));
}

// ?snippets: the quick commands panel (?nosnippets: empty).
if (params.has("snippets") || params.has("nosnippets")) {
  const { useQuickCommands } = await import("../components/QuickCommands");
  setTimeout(() => useQuickCommands.getState().setOpen(true), 500);
}

if (params.get("hostealo")) {
  const { useHostealo } = await import("../store/hostealo");
  setTimeout(() => useHostealo.getState().setDialogOpen(true), 400);
}

const ai = params.get("ai");
if (ai) {
  const { useAi } = await import("../store/ai");
  useAi.getState().setOpen(true);
  if (ai === "agent") {
    useAi.getState().setAgentMode(true);
    setTimeout(() => void useAi.getState().send(useTabs.getState().activeId!, "Instala nginx y comprueba que responde", { text: "", label: "Con la salida de web-01" }), 600);
    if (params.has("approve")) {
      const approveNext = () => {
        const key = useTabs.getState().activeId!;
        const pending = useAi.getState().conversations[key]?.messages.find((m) => m.actionState === "pending");
        if (pending) void useAi.getState().approve(key, pending.id);
      };
      setTimeout(approveNext, 2600);
      setTimeout(approveNext, 5200);
    }
  }
  if (ai === "chat") setTimeout(() => void useAi.getState().send(useTabs.getState().activeId!, "¿Qué está pasando con el tráfico?", { text: "", label: "Con la salida de web-01" }), 600);
}
