import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeShell } from "./shell";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function shell() {
  let output = "";
  const sh = new FakeShell({ hostname: "web-01", user: "root", osName: "Ubuntu 24.04.1 LTS", local: false }, (text) => (output += text));
  sh.start();
  return {
    type: (text: string) => sh.input(text),
    take: () => {
      const out = plain(output);
      output = "";
      return out;
    },
  };
}

describe("the demo shell", () => {
  afterEach(() => vi.useRealTimers());

  it("echoes keys, runs commands on Enter and moves between folders", () => {
    const sh = shell();
    expect(sh.take()).toContain("root@web-01:~# ");
    sh.type("cd /etc/nginx\r");
    sh.type("pwd\r");
    expect(sh.take()).toContain("/etc/nginx\r\nroot@web-01:/etc/nginx# ");
    sh.type("cat sites-enabled/default\r");
    expect(sh.take()).toContain("server_name example.com");
    sh.type("cd nope\r");
    expect(sh.take()).toContain("cd: nope: No such file or directory");
  });

  it("handles backspace, history and tab completion", () => {
    const sh = shell();
    sh.type("whoamx\x7fi\r");
    expect(sh.take()).toContain("i\r\nroot\r\n");
    sh.type("\x1b[A");
    expect(sh.take()).toContain("whoami");
    sh.type("\x03");
    sh.take();
    sh.type("cat /etc/os-r\t");
    expect(sh.take()).toContain("os-release");
  });

  it("files made in the session stay there", () => {
    const sh = shell();
    sh.type("mkdir proyectos\rtouch proyectos/app.js\rls proyectos\r");
    expect(sh.take()).toContain("app.js");
  });

  it("slow commands print over time and Ctrl+C stops them", () => {
    vi.useFakeTimers();
    const sh = shell();
    sh.take();
    sh.type("apt install redis\r");
    sh.type("ls\r"); // ignored while busy
    vi.advanceTimersByTime(800);
    expect(sh.take()).toContain("Reading package lists");
    sh.type("\x03");
    expect(sh.take()).toContain("^C\r\nroot@web-01:~# ");
    vi.advanceTimersByTime(10_000);
    expect(sh.take()).toBe("");
  });

  it("lines pasted after a slow command run once it finishes", () => {
    vi.useFakeTimers();
    const sh = shell();
    sh.take();
    sh.type("apt update\rwhoami\r");
    vi.advanceTimersByTime(5_000);
    const out = sh.take();
    expect(out).toContain("Reading package lists... Done");
    expect(out.indexOf("whoami")).toBeGreaterThan(out.indexOf("Reading package lists"));
    expect(out).toContain("whoami\r\nroot\r\n");
  });

  it("unknown commands fail like bash, with a hint once", () => {
    const sh = shell();
    sh.take();
    sh.type("foo\rbar\r");
    const out = sh.take();
    expect(out).toContain("bash: foo: command not found");
    expect(out.match(/escribe help/g)).toHaveLength(1);
  });
});
