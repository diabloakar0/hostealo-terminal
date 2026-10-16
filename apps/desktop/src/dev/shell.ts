// A pretend shell for the website demo: enough commands, files and output to try the terminal
// without a server. Nothing here runs anything; every answer is canned.

export interface ShellSystem {
  hostname: string;
  user: string;
  /** "Ubuntu 24.04.1 LTS", "macOS 15.6"... */
  osName: string;
  /** Local terminal (zsh on a Mac) or a server (bash). */
  local: boolean;
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  boldGreen: "\x1b[01;32m",
  boldBlue: "\x1b[01;34m",
};

type Node = { dir: true; children: Record<string, Node> } | { dir: false; content: string; mode?: string };

const dir = (children: Record<string, Node> = {}): Node => ({ dir: true, children });
const file = (content: string, mode?: string): Node => ({ dir: false, content, mode });

const NGINX_SITE = `server {
    listen 80;
    listen [::]:80;
    server_name example.com www.example.com;
    root /var/www/html;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}`;

const DEPLOY = `#!/usr/bin/env bash
set -euo pipefail
cd /var/www/app
git pull --ff-only
npm ci --omit=dev
systemctl reload nginx
echo "Desplegado $(git rev-parse --short HEAD)"`;

function serverTree(system: ShellSystem): Node {
  const home = system.user === "root" ? "root" : "home";
  const tree = dir({
    etc: dir({
      hostname: file(system.hostname),
      hosts: file(`127.0.0.1 localhost\n127.0.1.1 ${system.hostname}\n::1 localhost ip6-localhost ip6-loopback`),
      "os-release": file(osRelease(system.osName)),
      nginx: dir({ "nginx.conf": file("user www-data;\nworker_processes auto;\ninclude /etc/nginx/sites-enabled/*;"), "sites-enabled": dir({ default: file(NGINX_SITE) }) }),
      ssh: dir({ sshd_config: file("Port 22\nPermitRootLogin prohibit-password\nPasswordAuthentication no") }),
    }),
    var: dir({
      www: dir({ html: dir({ "index.html": file("<!doctype html>\n<h1>¡Funciona!</h1>") }) }),
      log: dir({
        "auth.log": file(
          `Oct 15 12:39:58 ${system.hostname} sshd[20311]: Failed password for root from 192.0.2.66 port 41022 ssh2\nOct 15 12:40:31 ${system.hostname} sshd[20340]: Accepted publickey for root from 192.0.2.44 port 51522 ssh2`,
        ),
        nginx: dir({ "access.log": file('192.0.2.44 - - [15/Oct/2026:12:41:07 +0200] "GET / HTTP/2.0" 200 612 "-" "Mozilla/5.0"') }),
      }),
    }),
    tmp: dir(),
    home: dir({ deploy: dir({ ".bashrc": file("# ~/.bashrc") }) }),
    root: dir(),
  });
  const homeDir = dir({
    ".bashrc": file("# ~/.bashrc: executed by bash(1) for non-login shells.\nexport HISTSIZE=10000\nalias ll='ls -alF'"),
    "backup-2026-10-14.tar.gz": file("\x1f\x8b binary"),
    "deploy.sh": file(DEPLOY, "-rwxr-xr-x"),
    "notas.txt": file("- renovar certificado de acme.example antes del 30\n- revisar los intentos de login de 192.0.2.66"),
  });
  if (home === "root" && tree.dir) tree.children.root = homeDir;
  else if (tree.dir && tree.children.home.dir) tree.children.home.children[system.user] = homeDir;
  return tree;
}

function localTree(system: ShellSystem): Node {
  return dir({
    Users: dir({
      [system.user]: dir({
        Desktop: dir({ "captura.png": file("PNG") }),
        Documents: dir({ "presupuesto-acme.pdf": file("PDF") }),
        Downloads: dir({ "hostealo-terminal.dmg": file("DMG") }),
        Projects: dir({ web: dir({ "README.md": file("# web\n\nLa web de la empresa.") }) }),
        ".zshrc": file("export PATH=/opt/homebrew/bin:$PATH"),
      }),
    }),
    etc: dir({ hosts: file("127.0.0.1 localhost") }),
    tmp: dir(),
  });
}

function osRelease(name: string): string {
  const id = name.split(" ")[0].toLowerCase();
  return `PRETTY_NAME="${name}"\nNAME="${name.replace(/ [\d.]+.*$/, "")}"\nID=${id}\nHOME_URL="https://www.${id}.com/"`;
}

/** Lines to print over time (ms after the previous one), for commands that take a moment. */
type Timed = [number, string][];

export class FakeShell {
  private cwd: string;
  private readonly home: string;
  private readonly root: Node;
  private line = "";
  private history: string[] = [];
  private historyIndex = 0;
  private busy: ReturnType<typeof setTimeout>[] = [];
  /** What was typed or pasted while a command was busy: it runs after, like in a real shell. */
  private queued = "";
  private installed = new Set<string>(["nginx", "docker"]);
  private hinted = false;

  constructor(
    private readonly system: ShellSystem,
    private readonly write: (text: string) => void,
  ) {
    this.home = system.local ? `/Users/${system.user}` : system.user === "root" ? "/root" : `/home/${system.user}`;
    this.cwd = this.home;
    this.root = system.local ? localTree(system) : serverTree(system);
  }

  /** The greeting and the first prompt. */
  start(): void {
    if (this.system.local) {
      this.write(`${C.dim}Last login: ${new Date().toDateString()} on ttys001${C.reset}\r\n`);
      this.write(`${C.dim}Demo: escribe ${C.reset}${C.bold}help${C.reset}${C.dim} para ver qué puedes probar.${C.reset}\r\n`);
    } else {
      this.write(
        [
          `Welcome to ${this.system.osName} (GNU/Linux 6.8.0-45-generic x86_64)`,
          "",
          `  System load:  0.42               Processes:             161`,
          `  Usage of /:   38.2% of 78.62GB   Users logged in:       1`,
          `  Memory usage: 38%                IPv4 address for eth0: 203.0.113.10`,
          "",
          `${C.cyan}Esta es la demo de Hostealo Terminal: el servidor es simulado.${C.reset}`,
          `${C.cyan}Prueba ${C.bold}help${C.reset}${C.cyan}, ${C.bold}ls -la${C.reset}${C.cyan}, ${C.bold}df -h${C.reset}${C.cyan}, ${C.bold}docker ps${C.reset}${C.cyan} o pídeselo al asistente (botón IA).${C.reset}`,
          "",
        ].join("\r\n") + "\r\n",
      );
    }
    this.prompt();
  }

  private prompt(): void {
    const where = this.cwd === this.home ? "~" : this.cwd.startsWith(this.home + "/") ? "~" + this.cwd.slice(this.home.length) : this.cwd;
    if (this.system.local) {
      this.write(`${C.bold}${C.magenta}➜${C.reset}  ${C.cyan}${where === "~" ? "~" : where.split("/").pop()}${C.reset} `);
    } else {
      const sign = this.system.user === "root" ? "#" : "$";
      this.write(`${C.boldGreen}${this.system.user}@${this.system.hostname}${C.reset}:${C.boldBlue}${where}${C.reset}${sign} `);
    }
  }

  /** Keystrokes from the terminal. */
  input(data: string): void {
    if (this.busy.length) {
      if (data.includes("\x03")) {
        this.busy.forEach(clearTimeout);
        this.busy = [];
        this.queued = "";
        this.write("^C\r\n");
        this.prompt();
      } else {
        this.queued += data;
      }
      return;
    }
    // Pasted text arrives in one piece: handle it key by key.
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === "\x1b") {
        const seq = data.slice(i, i + 3);
        if (seq === "\x1b[A" || seq === "\x1b[B") this.recall(seq === "\x1b[A" ? -1 : 1);
        i += 2;
        continue;
      }
      if (ch === "\r") {
        this.write("\r\n");
        const command = this.line;
        this.line = "";
        if (command.trim()) {
          this.history.push(command);
        }
        this.historyIndex = this.history.length;
        this.run(command.trim());
        // A command that takes a while: the rest of a paste waits for it.
        if (this.busy.length) {
          this.queued = data.slice(i + 1) + this.queued;
          return;
        }
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line) {
          this.line = [...this.line].slice(0, -1).join("");
          this.write("\b \b");
        }
      } else if (ch === "\x03") {
        this.write("^C\r\n");
        this.line = "";
        this.prompt();
      } else if (ch === "\x0c") {
        this.write("\x1b[2J\x1b[H");
        this.prompt();
        this.write(this.line);
      } else if (ch === "\t") {
        this.complete();
      } else if (ch >= " ") {
        this.line += ch;
        this.write(ch);
      }
    }
  }

  private recall(step: number): void {
    const next = Math.max(0, Math.min(this.history.length, this.historyIndex + step));
    if (next === this.historyIndex && step < 0 && next === 0 && !this.history.length) return;
    this.historyIndex = next;
    const text = this.history[next] ?? "";
    this.write("\b \b".repeat([...this.line].length) + text);
    this.line = text;
  }

  private complete(): void {
    const words = this.line.split(" ");
    const last = words[words.length - 1];
    if (words.length === 1) {
      const match = COMMANDS.filter((c) => c.startsWith(last));
      if (match.length === 1) this.append(match[0].slice(last.length) + " ");
      return;
    }
    const slash = last.lastIndexOf("/");
    const base = slash >= 0 ? last.slice(0, slash + 1) : "";
    const node = this.resolve(base || ".");
    if (!node?.dir) return;
    const match = Object.keys(node.children).filter((n) => n.startsWith(last.slice(base.length)));
    if (match.length === 1) {
      const child = node.children[match[0]];
      this.append(match[0].slice(last.length - base.length) + (child.dir ? "/" : " "));
    }
  }

  private append(text: string): void {
    this.line += text;
    this.write(text);
  }

  // ── Paths ────────────────────────────────────────────────

  private absolute(path: string): string {
    const full = path.startsWith("/") ? path : path === "~" || path.startsWith("~/") ? this.home + path.slice(1) : `${this.cwd}/${path}`;
    const parts: string[] = [];
    for (const part of full.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return "/" + parts.join("/");
  }

  private resolve(path: string): Node | null {
    let node: Node = this.root;
    for (const part of this.absolute(path).split("/").filter(Boolean)) {
      if (!node.dir || !node.children[part]) return null;
      node = node.children[part];
    }
    return node;
  }

  // ── Commands ─────────────────────────────────────────────

  private out(text: string): void {
    this.write(text.replace(/\r?\n/g, "\r\n") + "\r\n");
  }

  /** Prints lines over time, then the prompt. */
  private timed(lines: Timed): void {
    let at = 0;
    lines.forEach(([delay, text], index) => {
      at += delay;
      const timer = setTimeout(() => {
        this.out(text);
        if (index === lines.length - 1) {
          this.busy = [];
          this.prompt();
          const queued = this.queued;
          this.queued = "";
          if (queued) this.input(queued);
        }
      }, at);
      this.busy.push(timer);
    });
  }

  run(command: string): void {
    if (!command) return this.prompt();
    // Pipes and && are accepted; only the first command is simulated.
    const first = command.split(/\s*(?:&&|\|\||;|\|)\s*/)[0];
    let [name, ...args] = first.split(/\s+/);
    if (name === "sudo" && args.length) [name, ...args] = args;
    const handler = this.commands[name];
    if (handler) {
      const result = handler(args, command);
      if (result === "async") return;
      if (result !== undefined) this.out(result);
    } else if (/^(vim?|nano|htop|top|less|more|mc|tmux|screen)$/.test(name)) {
      this.out(`${C.yellow}${name}: los programas a pantalla completa no están en la demo. En la app funcionan como en cualquier terminal.${C.reset}`);
    } else {
      this.out(`${this.system.local ? "zsh" : "bash"}: ${name}: command not found`);
      if (!this.hinted) {
        this.hinted = true;
        this.out(`${C.dim}(demo: escribe help para ver los comandos simulados)${C.reset}`);
      }
    }
    this.prompt();
  }

  private readonly commands: Record<string, (args: string[], line: string) => string | void | "async"> = {
    help: () =>
      [
        `${C.bold}Comandos simulados en esta demo${C.reset}`,
        "  ls [-la]   cd   pwd   cat   echo   whoami   hostname   uname -a   date   clear   history",
        "  uptime   df -h   free -h   ip a   ping   curl -I   systemctl status <servicio>",
        "  docker ps   apt install <paquete>   tail <log>   journalctl -u ssh   neofetch",
        "",
        `${C.cyan}Además: abre el asistente (IA) y pídele algo como "instala nginx" en modo agente.${C.reset}`,
      ].join("\n"),
    pwd: () => this.cwd,
    whoami: () => this.system.user,
    hostname: () => this.system.hostname,
    id: () => (this.system.user === "root" ? "uid=0(root) gid=0(root) groups=0(root)" : `uid=1000(${this.system.user}) gid=1000(${this.system.user}) groups=1000(${this.system.user}),27(sudo)`),
    echo: (args) => args.join(" ").replace(/^["']|["']$/g, "").replace(/\$USER/g, this.system.user).replace(/\$HOME/g, this.home),
    date: () => new Date().toString().replace(/ \(.*\)$/, ""),
    clear: () => this.write("\x1b[2J\x1b[H"),
    history: () => this.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join("\n"),
    exit: () => `${C.dim}En la demo la sesión se queda abierta: cierra la pestaña con la ✕.${C.reset}`,
    logout: () => this.commands.exit([], ""),
    ssh: () => `${C.yellow}En la demo no hay conexiones reales: elige un servidor en la barra lateral.${C.reset}`,
    uname: (args) =>
      this.system.local
        ? args.includes("-a")
          ? "Darwin MacBook-Pro.local 25.3.0 Darwin Kernel Version 25.3.0 arm64"
          : "Darwin"
        : args.includes("-a")
          ? `Linux ${this.system.hostname} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`
          : "Linux",
    uptime: () => ` ${new Date().toTimeString().slice(0, 8)} up 12 days,  4:02,  1 user,  load average: 0.42, 0.38, 0.35`,
    cd: (args) => {
      const target = args[0] ?? "~";
      const node = this.resolve(target);
      if (!node) return `cd: ${target}: No such file or directory`;
      if (!node.dir) return `cd: ${target}: Not a directory`;
      this.cwd = this.absolute(target);
    },
    ls: (args) => {
      const flags = args.filter((a) => a.startsWith("-")).join("");
      const target = args.find((a) => !a.startsWith("-")) ?? ".";
      const node = this.resolve(target);
      if (!node) return `ls: cannot access '${target}': No such file or directory`;
      if (!node.dir) return target;
      const all = flags.includes("a");
      const names = Object.keys(node.children)
        .filter((n) => all || !n.startsWith("."))
        .sort((a, b) => a.replace(/^\./, "").localeCompare(b.replace(/^\./, "")));
      const paint = (n: string) => {
        const child = node.children[n];
        if (child.dir) return `${C.boldBlue}${n}${C.reset}`;
        if (child.mode?.includes("x")) return `${C.boldGreen}${n}${C.reset}`;
        if (/\.(gz|tar|zip|dmg)$/.test(n)) return `${C.red}${C.bold}${n}${C.reset}`;
        return n;
      };
      if (flags.includes("l")) {
        const owner = this.system.local ? `${this.system.user}  staff` : `${this.system.user} ${this.system.user}`;
        const rows = names.map((n) => {
          const child = node.children[n];
          const size = child.dir ? 4096 : n.endsWith(".tar.gz") ? 1932735283 : child.content.length;
          const mode = child.dir ? "drwxr-xr-x" : (child.mode ?? "-rw-r--r--");
          return `${mode} 1 ${owner} ${String(size).padStart(10)} Oct 14 22:10 ${paint(n)}`;
        });
        return [`total ${names.length * 4}`, ...rows].join("\n");
      }
      return names.map(paint).join("   ");
    },
    cat: (args) => {
      if (!args.length) return;
      return args
        .map((path) => {
          const node = this.resolve(path);
          if (!node) return `cat: ${path}: No such file or directory`;
          if (node.dir) return `cat: ${path}: Is a directory`;
          return node.content.startsWith("\x1f") ? `${C.dim}(archivo binario)${C.reset}` : node.content;
        })
        .join("\n");
    },
    tail: (args) => this.commands.cat(args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a)), ""),
    head: (args) => this.commands.cat(args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a)), ""),
    mkdir: (args) => {
      for (const path of args.filter((a) => !a.startsWith("-"))) {
        const parent = this.resolve(path.includes("/") ? path.replace(/\/[^/]+\/?$/, "") || "/" : ".");
        const name = path.replace(/\/$/, "").split("/").pop()!;
        if (parent?.dir) parent.children[name] ??= dir();
      }
    },
    touch: (args) => {
      for (const path of args) {
        const parent = this.resolve(path.includes("/") ? path.replace(/\/[^/]+$/, "") || "/" : ".");
        if (parent?.dir) parent.children[path.split("/").pop()!] ??= file("");
      }
    },
    rm: (args) => {
      const paths = args.filter((a) => !a.startsWith("-"));
      if (paths.some((p) => p === "/" || p === "/*")) return `${C.red}rm: mejor no 😉 (y en la demo tampoco haría nada)${C.reset}`;
      for (const path of paths) {
        const parent = this.resolve(path.includes("/") ? path.replace(/\/[^/]+\/?$/, "") || "/" : ".");
        if (parent?.dir) delete parent.children[path.replace(/\/$/, "").split("/").pop()!];
      }
    },
    df: () =>
      [
        "Filesystem      Size  Used Avail Use% Mounted on",
        "/dev/vda1        79G   30G   46G  38% /",
        "tmpfs           3.9G     0  3.9G   0% /dev/shm",
        "/dev/vda15      105M  6.1M   99M   6% /boot/efi",
      ].join("\n"),
    free: () =>
      [
        "               total        used        free      shared  buff/cache   available",
        "Mem:           7.8Gi       2.9Gi       1.2Gi        92Mi       3.7Gi       4.6Gi",
        "Swap:          2.0Gi          0B       2.0Gi",
      ].join("\n"),
    ip: () =>
      [
        "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN",
        "    inet 127.0.0.1/8 scope host lo",
        "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP",
        "    link/ether 52:54:00:1a:2b:3c brd ff:ff:ff:ff:ff:ff",
        "    inet 203.0.113.10/24 brd 203.0.113.255 scope global eth0",
      ].join("\n"),
    neofetch: () =>
      [
        `${C.boldGreen}${this.system.user}@${this.system.hostname}${C.reset}`,
        "-----------------",
        `${C.bold}OS${C.reset}: ${this.system.osName} x86_64`,
        `${C.bold}Kernel${C.reset}: 6.8.0-45-generic`,
        `${C.bold}Uptime${C.reset}: 12 days, 4 hours`,
        `${C.bold}CPU${C.reset}: AMD Ryzen 9 9950X (4) @ 4.30GHz`,
        `${C.bold}Memory${C.reset}: 2961MiB / 7953MiB`,
      ].join("\n"),
    ping: (args) => {
      const target = args.find((a) => !a.startsWith("-")) ?? "hostealo.es";
      const lines: Timed = [[0, `PING ${target} (203.0.113.80) 56(84) bytes of data.`]];
      for (let i = 1; i <= 4; i++) lines.push([1000, `64 bytes from 203.0.113.80: icmp_seq=${i} ttl=57 time=${(8 + Math.random() * 3).toFixed(1)} ms`]);
      lines.push([300, `\n--- ${target} ping statistics ---\n4 packets transmitted, 4 received, 0% packet loss, time 3004ms`]);
      this.timed(lines);
      return "async";
    },
    curl: (args) => {
      const url = args.find((a) => !a.startsWith("-")) ?? "http://localhost";
      if (!args.some((a) => a.startsWith("-") && a.includes("I"))) return this.installed.has("nginx") ? "<!doctype html>\n<h1>¡Funciona!</h1>" : `curl: (7) Failed to connect to ${url} port 80`;
      return ["HTTP/1.1 200 OK", "Server: nginx/1.24.0 (Ubuntu)", `Date: ${new Date().toUTCString()}`, "Content-Type: text/html", "Connection: keep-alive"].join("\n");
    },
    systemctl: (args) => {
      const service = (args.find((a) => !a.startsWith("-") && a !== "status") ?? "nginx").replace(/\.service$/, "");
      const action = args.find((a) => !a.startsWith("-")) ?? "status";
      if (action !== "status") return;
      if (!["nginx", "ssh", "sshd", "docker", "cron", "mysql", "mariadb", "postgresql"].includes(service) || (service === "nginx" && !this.installed.has("nginx"))) {
        return `Unit ${service}.service could not be found.`;
      }
      return [
        `${C.green}●${C.reset} ${service}.service - ${service === "nginx" ? "A high performance web server and a reverse proxy server" : service}`,
        `     Loaded: loaded (/usr/lib/systemd/system/${service}.service; ${C.green}enabled${C.reset}; preset: ${C.green}enabled${C.reset})`,
        `     Active: ${C.green}active (running)${C.reset} since Fri 2026-10-03 09:12:44 CEST; 1 week 5 days ago`,
        `   Main PID: 1042 (${service})`,
        "      Tasks: 5 (limit: 9387)",
        "     Memory: 11.2M (peak: 14.8M)",
      ].join("\n");
    },
    journalctl: () => this.commands.cat(["/var/log/auth.log"], ""),
    docker: (args) => {
      if (args[0] !== "ps") return "Usage:  docker [OPTIONS] COMMAND   (en la demo: docker ps)";
      return [
        "CONTAINER ID   IMAGE                COMMAND                  STATUS        PORTS                    NAMES",
        'a3f9c1e2b7d4   postgres:17          "docker-entrypoint.s…"   Up 12 days    5432/tcp                 db',
        'b81d0c4e9a12   redis:7-alpine       "docker-entrypoint.s…"   Up 12 days    6379/tcp                 cache',
        'c4e2a9f1d3b8   ghcr.io/acme/app:2.4 "node server.js"         Up 3 hours    0.0.0.0:3000->3000/tcp   app',
      ].join("\n");
    },
    apt: (args, line) => this.install(args, line),
    "apt-get": (args, line) => this.install(args, line),
    dnf: (args, line) => this.install(args, line),
    yum: (args, line) => this.install(args, line),
    brew: () => `${C.dim}(demo) Homebrew está, pero aquí no instala nada.${C.reset}`,
    nginx: (args) =>
      args.includes("-t")
        ? "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful"
        : "nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)",
    reboot: () => `${C.yellow}(demo) Aquí no se reinicia nada: en un servidor de verdad, la sesión se cortaría.${C.reset}`,
    shutdown: () => this.commands.reboot([], ""),
  };

  private install(args: string[], line: string): string | "async" {
    const verb = args.find((a) => !a.startsWith("-"));
    if (verb === "update") {
      this.timed([
        [300, "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease"],
        [400, "Get:2 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]"],
        [500, "Fetched 126 kB in 1s (210 kB/s)"],
        [200, "Reading package lists... Done"],
      ]);
      return "async";
    }
    if (verb !== "install") return `${C.dim}(demo) Prueba: ${line.split(" ")[0]} install nginx${C.reset}`;
    const packages = args.filter((a) => !a.startsWith("-") && a !== "install");
    if (!packages.length) return "E: No packages specified";
    const list = packages.join(" ");
    const already = packages.every((p) => this.installed.has(p));
    packages.forEach((p) => this.installed.add(p));
    this.timed(
      already
        ? [
            [300, "Reading package lists... Done"],
            [200, "Building dependency tree... Done"],
            [200, `${list} is already the newest version.\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`],
          ]
        : [
            [300, "Reading package lists... Done"],
            [300, "Building dependency tree... Done"],
            [300, `The following NEW packages will be installed:\n  ${list}`],
            [400, `0 upgraded, ${packages.length} newly installed, 0 to remove and 0 not upgraded.`],
            ...packages.map((p): [number, string] => [700, `Get:1 http://archive.ubuntu.com/ubuntu noble/main amd64 ${p} amd64 [${(Math.random() * 900 + 100).toFixed(0)} kB]`]),
            ...packages.map((p): [number, string] => [600, `Setting up ${p} ...`]),
            [400, "Processing triggers for man-db (2.12.0-4build2) ..."],
          ],
    );
    return "async";
  }
}

const COMMANDS = [
  "apt",
  "cat",
  "cd",
  "clear",
  "curl",
  "date",
  "df",
  "docker",
  "echo",
  "free",
  "help",
  "history",
  "hostname",
  "ip",
  "journalctl",
  "ls",
  "mkdir",
  "neofetch",
  "ping",
  "pwd",
  "rm",
  "systemctl",
  "tail",
  "touch",
  "uname",
  "uptime",
  "whoami",
];
