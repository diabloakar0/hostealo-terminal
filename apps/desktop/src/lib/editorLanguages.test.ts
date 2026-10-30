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

  it("opens text files on double click and leaves the rest to download", () => {
    expect(isEditableName("site_saribal.conf")).toBe(true);
    expect(isEditableName(".env")).toBe(true);
    expect(isEditableName("Dockerfile")).toBe(true);
    expect(isEditableName("backup.tar.gz")).toBe(false);
    expect(isEditableName("photo.jpg")).toBe(false);
    expect(isEditableName("README")).toBe(false);
  });

  it("loads every language's highlighting", async () => {
    for (const id of ["python", "nginx", "ini", "shell", "yaml", "php", "dockerfile", "powershell", "plain"] as const) {
      await expect(loadLanguage(id)).resolves.toBeDefined();
    }
  });
});
