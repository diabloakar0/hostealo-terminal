import { describe, expect, it } from "vitest";

import { detectLanguage, isEditableName, loadLanguage } from "./editorLanguages";

describe("editor languages", () => {
  it("goes by extension and well-known names", () => {
    expect(detectLanguage("/srv/app/main.py")).toBe("python");
    expect(detectLanguage("/srv/app/index.tsx")).toBe("typescript");
    expect(detectLanguage("/etc/netplan/50-cloud-init.yaml")).toBe("yaml");
    expect(detectLanguage("/home/ana/.bashrc")).toBe("shell");
    expect(detectLanguage("C:\\deploy\\Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("/etc/systemd/system/app.service")).toBe("ini");
    expect(detectLanguage("/var/www/notes.txt")).toBe("plain");
  });

  it("looks inside .conf files to tell nginx from INI and Apache", () => {
    const nginx = "server {\n    listen 80;\n    server_name example.com;\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}\n";
    expect(detectLanguage("/etc/nginx/conf.d/site_saribal.conf", nginx)).toBe("nginx");
    expect(detectLanguage("/etc/nginx/sites-available/default", nginx)).toBe("nginx");
    expect(detectLanguage("/etc/mysql/my.conf", "[mysqld]\nbind-address = 127.0.0.1\n")).toBe("ini");
    expect(detectLanguage("/etc/apache2/sites-available/site.conf", "<VirtualHost *:80>\n  ServerName example.com\n</VirtualHost>\n")).toBe("shell");
  });

  it("reads the #! line of files without an extension", () => {
    expect(detectLanguage("/usr/local/bin/backup", "#!/usr/bin/env bash\nset -e\n")).toBe("shell");
    expect(detectLanguage("/opt/tools/report", "#!/usr/bin/python3\nprint(1)\n")).toBe("python");
    expect(detectLanguage("/opt/tools/data", "just words")).toBe("plain");
  });

  it("opens every file on double click except plainly binary ones", () => {
    expect(isEditableName("site_saribal.conf")).toBe(true);
    expect(isEditableName(".env")).toBe(true);
    expect(isEditableName("Dockerfile")).toBe(true);
    expect(isEditableName("README")).toBe(true);
    // Unknown formats get a try: the editor refuses them if they turn out to be binary.
    expect(isEditableName("panel.tpl")).toBe(true);
    expect(isEditableName("access.log.1")).toBe(true);
    expect(isEditableName("backup.tar.gz")).toBe(false);
    expect(isEditableName("photo.JPG")).toBe(false);
    expect(isEditableName("setup.exe")).toBe(false);
  });

  it("recognises the text of files with unknown extensions", () => {
    expect(detectLanguage("/srv/app/settings.tpl", '{\n  "debug": false,\n  "port": 8080\n}\n')).toBe("json");
    expect(detectLanguage("/srv/app/layout.tmpl", '<?xml version="1.0"?>\n<root/>\n')).toBe("xml");
    expect(detectLanguage("/srv/app/page.tmpl", "<!DOCTYPE html>\n<html></html>\n")).toBe("html");
    expect(detectLanguage("/srv/app/index.inc", "<?php echo 1;\n")).toBe("php");
    expect(detectLanguage("/etc/app/compose.dist", "services:\n  web:\n    image: nginx\n    ports:\n      - 80:80\n")).toBe("yaml");
    expect(detectLanguage("/etc/app/app.local", "host=127.0.0.1\nport=5432\n")).toBe("ini");
    expect(detectLanguage("/etc/app/rules.v4", "# Generated\n# by iptables-save\n*filter\n")).toBe("shell");
    expect(detectLanguage("/var/log/app.log.1", "2026-10-30 started\n2026-10-30 ready\n")).toBe("plain");
  });

  it("loads every language's highlighting", async () => {
    for (const id of ["python", "nginx", "ini", "shell", "yaml", "php", "dockerfile", "powershell", "plain"] as const) {
      await expect(loadLanguage(id)).resolves.toBeDefined();
    }
  });
});
