import { create } from "zustand";

import { isDangerousCommand } from "../lib/danger";
import { aiCancel, aiChat, aiSettingsGet, type AiChatMessage, type AiSettingsView, type ExecOutput } from "../lib/ipc";
import { getTerminal } from "../lib/terminals";

export type AiMessageState = "thinking" | "streaming" | "done" | "stopped" | "refused" | "error";
export type ActionState = "pending" | "running" | "done" | "declined" | "failed";

export interface AiMessage {
  id: string;
  /** `action`: a command the assistant wants to run (agent mode). */
  role: "user" | "assistant" | "action";
  text: string;
  /** User messages: the terminal context sent along with the question, and what it was. */
  context?: string;
  contextLabel?: string;
  /** User messages the app wrote (command results): sent to the model, not shown as bubbles. */
  hidden?: boolean;
  /** Assistant messages. */
  state?: AiMessageState;
  model?: string;
  error?: string;
  /** Action messages: `text` is the command. */
  actionState?: ActionState;
  output?: ExecOutput;
}

interface Conversation {
  messages: AiMessage[];
  /** The reply streaming right now (-1 while it starts). */
  requestId: number | null;
}

interface AiStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Send the terminal's recent output along with each question. */
  includeOutput: boolean;
  setIncludeOutput: (include: boolean) => void;
  /** The assistant runs commands itself, each one approved. */
  agentMode: boolean;
  setAgentMode: (on: boolean) => void;
  /** In agent mode, run commands that are not dangerous without asking. */
  autoApprove: boolean;
  setAutoApprove: (on: boolean) => void;
  settings: AiSettingsView | null;
  loadSettings: () => Promise<void>;
  setSettings: (settings: AiSettingsView) => void;
  /** One conversation per tab (or "general" when no tab is open). */
  conversations: Record<string, Conversation>;
  send: (key: string, question: string, context?: { text: string; label: string }) => Promise<void>;
  approve: (key: string, actionId: string) => Promise<void>;
  decline: (key: string, actionId: string) => void;
  stop: (key: string) => void;
  clear: (key: string) => void;
}

const EMPTY: Conversation = { messages: [], requestId: null };
/** Commands the agent may run in a row before it has to hand back to the user. */
export const MAX_AGENT_STEPS = 15;
/** How long one command may run. */
const COMMAND_TIMEOUT_SECS = 300;
/** Output sent back to the model per stream (its end). */
const OUTPUT_CHARS = 6000;

let nextId = 0;
const newId = () => `m${++nextId}`;

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not remembered, still applies now.
  }
}

/** The command the assistant asked to run: the last complete ```run block of its reply. */
export function commandIn(reply: string): string | null {
  const blocks = [...reply.matchAll(/```run[^\n]*\n([\s\S]*?)```/g)];
  const command = blocks.at(-1)?.[1].trim();
  return command ? command : null;
}

const tail = (text: string) => (text.length > OUTPUT_CHARS ? `…${text.slice(-OUTPUT_CHARS)}` : text);

/** A command's result, as the model reads it. */
export function describeOutput(command: string, output: ExecOutput): string {
  const parts = [`<command_output exit_code="${output.timedOut ? "timeout" : (output.exitCode ?? "unknown")}">`, `$ ${command}`];
  if (output.stdout.trim()) parts.push(`stdout:\n${tail(output.stdout.trimEnd())}`);
  if (output.stderr.trim()) parts.push(`stderr:\n${tail(output.stderr.trimEnd())}`);
  if (!output.stdout.trim() && !output.stderr.trim()) parts.push("(no output)");
  if (output.timedOut) parts.push(`(stopped after ${COMMAND_TIMEOUT_SECS} s)`);
  parts.push("</command_output>");
  return parts.join("\n");
}

/** What goes to the provider: the conversation so far, with each question's context. */
export function toChatMessages(messages: AiMessage[]): AiChatMessage[] {
  const chat: AiChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = message.context ? `<terminal_context>\n${message.context}\n</terminal_context>\n\n${message.text}` : message.text;
      chat.push({ role: "user", content });
    } else if (message.role === "assistant" && (message.state === "done" || message.state === "stopped") && message.text.trim()) {
      // Failed and declined replies are left out (a declined partial is discarded).
      chat.push({ role: "assistant", content: message.text });
    }
  }
  return chat;
}

/** Commands run since the user last wrote. */
export function stepsSinceUser(messages: AiMessage[]): number {
  let steps = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && !message.hidden) break;
    if (message.role === "action") steps++;
  }
  return steps;
}

export const useAi = create<AiStore>((set, get) => {
  const update = (key: string, fn: (conversation: Conversation) => Conversation) =>
    set((state) => ({ conversations: { ...state.conversations, [key]: fn(state.conversations[key] ?? EMPTY) } }));
  // A stopped reply ignores whatever the provider still sends.
  const updateMessage = (key: string, id: string, patch: (message: AiMessage) => Partial<AiMessage>) =>
    update(key, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === id && m.state !== "stopped" ? { ...m, ...patch(m) } : m)),
    }));
  const append = (key: string, ...messages: AiMessage[]) => update(key, (c) => ({ ...c, messages: [...c.messages, ...messages] }));
  const find = (key: string, id: string) => get().conversations[key]?.messages.find((m) => m.id === id);

  /** In agent mode, a finished reply may ask to run a command. */
  const afterReply = (key: string, replyId: string) => {
    const reply = find(key, replyId);
    if (!get().agentMode || reply?.state !== "done") return;
    const command = commandIn(reply.text);
    if (!command || !getTerminal(key)) return;
    const messages = get().conversations[key]?.messages ?? [];
    if (stepsSinceUser(messages) >= MAX_AGENT_STEPS) {
      // Hand back to the user: they say whether to go on.
      return append(key, { id: newId(), role: "action", text: command, actionState: "declined", error: "limit" });
    }
    const action: AiMessage = { id: newId(), role: "action", text: command, actionState: "pending" };
    append(key, action);
    if (get().autoApprove && !isDangerousCommand(command)) void get().approve(key, action.id);
  };

  /** Streams a reply to the conversation as it stands. */
  const request = async (key: string) => {
    const conversation = get().conversations[key] ?? EMPTY;
    const reply: AiMessage = { id: newId(), role: "assistant", text: "", state: "thinking" };
    const history = conversation.messages;
    update(key, () => ({ messages: [...history, reply], requestId: -1 }));
    const finish = () => {
      update(key, (c) => ({ ...c, requestId: null }));
      afterReply(key, reply.id);
    };
    try {
      const requestId = await aiChat(toChatMessages(history), get().agentMode, (event) => {
        switch (event.type) {
          case "model":
            return updateMessage(key, reply.id, () => ({ model: event.model }));
          case "thinking":
            return;
          case "text":
            return updateMessage(key, reply.id, (m) => ({ text: m.text + event.text, state: "streaming" }));
          case "done":
            updateMessage(key, reply.id, () => ({ state: event.stopReason === "refusal" ? "refused" : "done" }));
            return finish();
          case "error":
            updateMessage(key, reply.id, () => ({ state: "error", error: event.message }));
            return finish();
        }
      });
      // The reply may already be over (an immediate error), or stopped before it started.
      if (find(key, reply.id)?.state === "stopped") void aiCancel(requestId);
      else update(key, (c) => (c.requestId === -1 ? { ...c, requestId } : c));
    } catch (e) {
      updateMessage(key, reply.id, () => ({ state: "error", error: String(e) }));
      update(key, (c) => ({ ...c, requestId: null }));
    }
  };

  return {
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set((state) => ({ open: !state.open })),
    includeOutput: readFlag("hostealo-terminal:ai-include-output", true),
    setIncludeOutput: (includeOutput) => {
      set({ includeOutput });
      writeFlag("hostealo-terminal:ai-include-output", includeOutput);
    },
    agentMode: readFlag("hostealo-terminal:ai-agent", false),
    setAgentMode: (agentMode) => {
      set({ agentMode });
      writeFlag("hostealo-terminal:ai-agent", agentMode);
    },
    autoApprove: readFlag("hostealo-terminal:ai-auto-approve", false),
    setAutoApprove: (autoApprove) => {
      set({ autoApprove });
      writeFlag("hostealo-terminal:ai-auto-approve", autoApprove);
    },
    settings: null,
    loadSettings: async () => set({ settings: await aiSettingsGet() }),
    setSettings: (settings) => set({ settings }),
    conversations: {},

    send: async (key, question, context) => {
      const conversation = get().conversations[key] ?? EMPTY;
      if (conversation.requestId !== null) return;
      // A new question leaves any command still waiting for approval unanswered.
      update(key, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.actionState === "pending" ? { ...m, actionState: "declined" } : m)),
      }));
      append(key, { id: newId(), role: "user", text: question, context: context?.text, contextLabel: context?.label });
      await request(key);
    },

    approve: async (key, actionId) => {
      const action = find(key, actionId);
      const terminal = getTerminal(key);
      if (!action || action.actionState !== "pending" || !terminal) return;
      update(key, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === actionId ? { ...m, actionState: "running" } : m)) }));
      let output: ExecOutput;
      try {
        output = await terminal.exec(action.text, COMMAND_TIMEOUT_SECS);
      } catch (e) {
        output = { stdout: "", stderr: String(e), exitCode: null, timedOut: false };
        update(key, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === actionId ? { ...m, actionState: "failed", error: String(e) } : m)) }));
      }
      if (find(key, actionId)?.actionState === "running") {
        update(key, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === actionId ? { ...m, actionState: "done", output } : m)) }));
      }
      append(key, { id: newId(), role: "user", hidden: true, text: describeOutput(action.text, output) });
      await request(key);
    },

    decline: (key, actionId) => {
      const action = find(key, actionId);
      if (!action || action.actionState !== "pending") return;
      update(key, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === actionId ? { ...m, actionState: "declined" } : m)) }));
      append(key, { id: newId(), role: "user", hidden: true, text: `I declined to run \`${action.text}\`.` });
      void request(key);
    },

    stop: (key) => {
      const conversation = get().conversations[key];
      if (!conversation) return;
      if (conversation.requestId !== null && conversation.requestId > 0) void aiCancel(conversation.requestId);
      update(key, (c) => ({
        requestId: null,
        messages: c.messages.map((m) =>
          m.state === "thinking" || m.state === "streaming"
            ? { ...m, state: "stopped" }
            : m.actionState === "pending"
              ? { ...m, actionState: "declined" }
              : m,
        ),
      }));
    },

    clear: (key) => {
      get().stop(key);
      update(key, () => EMPTY);
    },
  };
});
