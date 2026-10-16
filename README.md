# Hostealo Terminal

Open-source SSH, SFTP, FTP and RDP client for Windows, macOS, Linux and iOS, with the look of the
[Hostealo](https://hostealo.es) client panel.

> Status: early development (v0.1.0). Working today: local shells, SSH, SFTP, FTP/FTPS and RDP (remote
> desktop), a live resource monitor, per-host colours, operating system logos (detected on connection), host folders, import from MobaXterm, Royal TS, PuTTY, FileZilla and OpenSSH, SSH key management and a known
> hosts cleaner. RDP includes a shared clipboard (text, images and files), remote audio and a shared
> folder drive. An AI assistant (bring your own Claude, OpenAI or Ollama) answers with the
> terminal in context and suggests commands you insert or run with a click; in agent mode it runs the steps itself, each one
> approved by you. Connecting a Hostealo account adds your VPS and dedicated servers automatically.
>
> Leer en español: [README.es.md](README.es.md)

## Planned features

- **Protocols:** SSH (jump hosts, agent, keys, port forwarding), SFTP, FTP/FTPS, RDP, local shell.
- **Resource monitor:** a status bar under every session with CPU, RAM, disk, network, load and
  uptime. Remote hosts need no agent: the app reads `/proc` over a second SSH channel.
- **AI assistant:** bring your own provider (Claude, OpenAI, local models via Ollama). It can read
  the session context and suggest commands, and nothing runs without your approval.
- **Per-host colours:** a session to a coloured host tints the terminal (red for production...).
- **SSH keys and known hosts:** generate and copy keys; find and forget old host keys after a
  server reinstall, in the app and in `~/.ssh/known_hosts` (a backup is kept).
- **Hostealo integration (optional):** sign in to list your Hostealo servers and control them.
  The app is fully usable without an account.
- **Import:** bring hosts and folders from MobaXterm, Royal TS/TSX, PuTTY, FileZilla, OpenSSH
  `~/.ssh/config` and `.rdp` files.
- **Device sync, no cloud:** sync hosts between your own devices over the local network
  (Bonjour/mDNS discovery, or pair with a QR code / link when the network hides them), end-to-end
  encrypted (X25519, ChaCha20-Poly1305) and verified with a code or the QR secret. Saved passwords
  only when you tick it. For a new computer, an encrypted backup file (Argon2id passphrase).
- **Quick commands:** saved commands typed or run in the active terminal with one click (⌘P); they sync with your other devices.
- **Status and alerts:** a live view of every server with an open session (CPU, memory, disks, network), with alerts for full disks, sustained high memory or CPU and lost connections, in the app and as system notifications.
- **Search (⌘K):** jump to any server, tab, quick command or action.
- **Docker:** a server's containers grouped by Compose project, with stats, start/stop/restart, logs and a shell inside, over plain SSH (`sudo -n` when the user needs it).
- **Virtual machines:** on a Proxmox VE node (its whole cluster, through `pvesh`) or a KVM host with libvirt such as a SolusVM 2 node (through `virsh`): state, CPU, memory, disk, start, clean shutdown, reboot, force off and a console. No API keys: over SSH, with `sudo -n` when needed.
- **Languages:** English and Spanish.

## Architecture

| Part | Technology |
| --- | --- |
| App shell | [Tauri 2](https://tauri.app) (one codebase for desktop and iOS) |
| Core | Rust: `russh` (SSH), `portable-pty` (local shell), `sysinfo` (local monitor), `keyring` (OS keychain); `russh-sftp` (SFTP), `suppaftp` + `rustls` (FTP/FTPS), `IronRDP` (RDP) |
| UI | React 19, TypeScript, Tailwind CSS 4, xterm.js, i18next |
| Design | `packages/ui`: tokens, fonts and terminal themes mirroring the Hostealo panel v2 |

```
apps/desktop/            Tauri app
  src/                   React UI
  src-tauri/src/         Rust core
    ssh/                 SSH sessions, SFTP, auth, host key checks, remote monitor
    known_hosts_admin.rs known hosts listing and cleaning
    ssh_keys.rs          ~/.ssh key listing and generation
    hosts.rs, secrets.rs saved hosts (JSON) and their secrets (OS keychain)
    pty.rs, monitor.rs   local shell and local resource monitor
packages/ui/             @hostealo/ui design tokens, fonts, terminal themes, logo
```

## Development

Requirements: Node.js 20+, Rust (stable), and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run dev      # starts the app with hot reload
npm run build    # builds installers for the current OS
```

Tests:

```sh
cargo test                      # unit tests
# SSH end-to-end tests against a throwaway OpenSSH container (see src-tauri/src/ssh/tests.rs)
HT_TEST_SSH_PORT=2222 HT_TEST_SSH_PASSWORD=secret cargo test -- --ignored ssh::tests
# FTP/FTPS end-to-end tests against a Pure-FTPd container (see src-tauri/src/ftp.rs)
HT_TEST_FTP_PORT=2121 HT_TEST_FTP_PASSWORD=secret cargo test -- --ignored ftp::tests
# RDP end-to-end test against an xrdp container (see src-tauri/src/rdp.rs)
HT_TEST_RDP_PORT=3390 HT_TEST_RDP_USER=abc HT_TEST_RDP_PASSWORD=abc cargo test -- --ignored rdp::tests
npm test -w @hostealo-terminal/desktop   # frontend unit tests (vitest)
```

UI preview without a backend: with `npm run dev` running, open
`http://localhost:1420/preview.html` (see `apps/desktop/src/dev/preview.ts`).

Website demo: the same UI on a pretend backend with a simulated shell
(`apps/desktop/src/dev/demo.ts` and `shell.ts`), served at `/terminal/demo/` on hostealo.es.
`npm run build:demo -w @hostealo-terminal/desktop` builds it into
`website/terminal/public/terminal/demo/`; in development, open `http://localhost:1420/demo.html`.

Shortcuts: new tab `⌘T` / `Ctrl+Shift+T`, close tab `⌘W` / `Ctrl+Shift+W`,
go to tab `⌘1…9` / `Ctrl+Shift+1…9`, settings `⌘,` / `Ctrl+Shift+,`.

## Security

- Passwords and key passphrases are stored only in the OS keychain, never on disk or in the UI.
- Host keys are verified on every connection (trust on first use). A changed key is flagged as a
  possible man-in-the-middle and is never accepted silently. Keys already in `~/.ssh/known_hosts`
  are trusted; that file is read, never modified.

## License

Code: [Functional Source License 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2). The source is
public: you can read, audit, modify and use it, for yourself or your company, for anything except
building a product that competes with Hostealo Terminal. Each version becomes Apache License 2.0
two years after its release. The Hostealo name and logo are trademarks and are not covered by the
license; see [TRADEMARKS.md](TRADEMARKS.md).
