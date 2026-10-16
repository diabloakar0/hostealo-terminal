import { create } from "zustand";

import { sshPromptReply, type PromptReply, type SshEvent } from "../lib/ipc";

type PromptEvent = Extract<SshEvent, { type: "hostKey" } | { type: "certificate" } | { type: "prompt" }>;

/** A question from an SSH session waiting for the user. */
export type PendingPrompt = PromptEvent & { tabId: string; hostId: string };

interface PromptsStore {
  /** Shown one at a time, oldest first. */
  queue: PendingPrompt[];
  enqueue: (prompt: PendingPrompt) => void;
  answer: (requestId: number, reply: PromptReply) => void;
  /** Cancels everything a tab was asking (the tab closed or its session ended). */
  dropForTab: (tabId: string) => void;
}

export const usePrompts = create<PromptsStore>((set, get) => ({
  queue: [],

  enqueue: (prompt) => set((s) => ({ queue: [...s.queue, prompt] })),

  answer: (requestId, reply) => {
    set((s) => ({ queue: s.queue.filter((p) => p.requestId !== requestId) }));
    sshPromptReply(requestId, reply).catch(() => {
      // The session already ended; nothing is waiting for this answer.
    });
  },

  dropForTab: (tabId) => {
    const dropped = get().queue.filter((p) => p.tabId === tabId);
    if (dropped.length === 0) return;
    set((s) => ({ queue: s.queue.filter((p) => p.tabId !== tabId) }));
    for (const prompt of dropped) void sshPromptReply(prompt.requestId, { type: "cancel" }).catch(() => {});
  },
}));
