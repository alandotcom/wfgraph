import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  agentThreadHistory,
  forgetAgentThread,
} from "#src/components/agent/thread-storage";

function message(id: string, text: string): ThreadMessage {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture of assistant-ui's message
  return {
    id,
    role: "user",
    createdAt: new Date("2026-11-11T10:00:00.000Z"),
    content: [{ type: "text", text }],
    attachments: [],
    metadata: { custom: {} },
  } as unknown as ThreadMessage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("agentThreadHistory", () => {
  it("loads back what it stored, per workflow, with dates restored", async () => {
    const history = agentThreadHistory("workflow_1");
    await history.append({ parentId: null, message: message("m1", "Hello") });
    await history.append({ parentId: "m1", message: message("m2", "Again") });
    await history.update?.({
      parentId: "m1",
      message: message("m2", "Edited"),
    });

    const loaded = await agentThreadHistory("workflow_1").load();

    expect(loaded.headId).toBe("m2");
    expect(loaded.messages.map((item) => item.message.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(loaded.messages[1]?.message.content).toEqual([
      { type: "text", text: "Edited" },
    ]);
    expect(loaded.messages[0]?.message.createdAt).toBeInstanceOf(Date);
    expect((await agentThreadHistory("workflow_2").load()).messages).toEqual(
      []
    );
  });

  it("forgets a workflow's thread for a new conversation", async () => {
    const history = agentThreadHistory("workflow_1");
    await history.append({ parentId: null, message: message("m1", "Hello") });

    forgetAgentThread("workflow_1");

    expect((await history.load()).messages).toEqual([]);
  });

  it("reads an entry it cannot decode as an empty thread", async () => {
    localStorage.setItem("wfgraph:agent-thread:workflow_1", "{not json");

    expect((await agentThreadHistory("workflow_1").load()).messages).toEqual(
      []
    );
  });

  it("keeps working when storage refuses every access", async () => {
    const refuse = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", {
      getItem: refuse,
      setItem: refuse,
      removeItem: refuse,
    });
    const history = agentThreadHistory("workflow_1");

    await expect(
      history.append({ parentId: null, message: message("m1", "Hello") })
    ).resolves.toBeUndefined();
    expect((await history.load()).messages).toEqual([]);
    expect(() => forgetAgentThread("workflow_1")).not.toThrow();
  });
});
