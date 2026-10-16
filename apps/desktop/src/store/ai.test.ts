import { describe, expect, it } from "vitest";

import { commandIn, describeOutput, stepsSinceUser, toChatMessages, type AiMessage } from "./ai";

describe("agent mode", () => {
  it("finds the command a reply asks to run", () => {
    expect(commandIn("Instalo nginx:\n\n```run\napt-get install -y nginx\n```")).toBe("apt-get install -y nginx");
    expect(commandIn("```bash\nls\n```\nY luego:\n```run\nsystemctl status nginx --no-pager\n```")).toBe("systemctl status nginx --no-pager");
    expect(commandIn("Listo, nginx responde en el puerto 80.")).toBeNull();
    // Still streaming: the block is not closed yet.
    expect(commandIn("```run\napt-get ins")).toBeNull();
  });

  it("describes outputs for the model", () => {
    const text = describeOutput("nginx -v", { stdout: "", stderr: "nginx version: nginx/1.24.0\n", exitCode: 0, timedOut: false });
    expect(text).toBe('<command_output exit_code="0">\n$ nginx -v\nstderr:\nnginx version: nginx/1.24.0\n</command_output>');
    expect(describeOutput("sleep 999", { stdout: "", stderr: "", exitCode: null, timedOut: true })).toContain('exit_code="timeout"');
  });

  it("sends results but not the action cards, and counts steps since the user wrote", () => {
    const messages: AiMessage[] = [
      { id: "1", role: "user", text: "instala nginx" },
      { id: "2", role: "assistant", text: "```run\napt-get install -y nginx\n```", state: "done" },
      { id: "3", role: "action", text: "apt-get install -y nginx", actionState: "done" },
      { id: "4", role: "user", hidden: true, text: "<command_output exit_code=\"0\">…</command_output>" },
    ];
    expect(toChatMessages(messages).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(stepsSinceUser(messages)).toBe(1);
    expect(stepsSinceUser([...messages, { id: "5", role: "user", text: "gracias" }])).toBe(0);
  });
});
