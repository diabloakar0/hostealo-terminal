import { describe, expect, it } from "vitest";

import { isDangerousCommand } from "./danger";
import { isShellLanguage, parseInline, parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("splits text, lists and code blocks", () => {
    const blocks = parseMarkdown(
      "## Disco\nEl disco está lleno.\nMira qué ocupa:\n\n```bash\ndu -sh /var/* | sort -h\n```\n\n- uno\n- dos\n  sigue\n1. paso",
    );
    expect(blocks).toEqual([
      { type: "heading", text: "Disco" },
      { type: "paragraph", text: "El disco está lleno.\nMira qué ocupa:" },
      { type: "code", lang: "bash", code: "du -sh /var/* | sort -h", complete: true },
      { type: "list", ordered: false, items: ["uno", "dos sigue"] },
      { type: "list", ordered: true, items: ["paso"] },
    ]);
  });

  it("marks a code block still streaming as incomplete", () => {
    expect(parseMarkdown("Prueba:\n```sh\nsystemctl status ng")).toEqual([
      { type: "paragraph", text: "Prueba:" },
      { type: "code", lang: "sh", code: "systemctl status ng", complete: false },
    ]);
  });

  it("finds inline code and bold text", () => {
    expect(parseInline("Usa `df -h` y **no** borres")).toEqual([
      { type: "text", text: "Usa " },
      { type: "code", text: "df -h" },
      { type: "text", text: " y " },
      { type: "bold", text: "no" },
      { type: "text", text: " borres" },
    ]);
    expect(isShellLanguage("bash") && isShellLanguage("") && !isShellLanguage("json")).toBe(true);
  });
});

describe("isDangerousCommand", () => {
  it("flags destructive commands", () => {
    for (const command of [
      "rm -rf /var/www/old",
      "sudo rm -r build",
      "mkfs.ext4 /dev/sdb1",
      "dd if=/dev/zero of=/dev/sda bs=1M",
      "sudo reboot",
      "systemctl stop nginx",
      "iptables -F",
      "ufw enable",
      "apt purge mysql-server",
      "mysql -e 'DROP DATABASE shop'",
      "DELETE FROM users;",
      "git push --force origin main",
      "Remove-Item C:\\temp -Recurse -Force",
    ]) {
      expect(isDangerousCommand(command), command).toBe(true);
    }
  });

  it("lets everyday commands through", () => {
    for (const command of [
      "df -h",
      "ls -la /var/log",
      "systemctl status nginx",
      "journalctl -u nginx --since today",
      "rm notes.txt",
      "DELETE FROM sessions WHERE expires < NOW();",
      "tail -f /var/log/syslog",
      "apt update && apt list --upgradable",
    ]) {
      expect(isDangerousCommand(command), command).toBe(false);
    }
  });
});
