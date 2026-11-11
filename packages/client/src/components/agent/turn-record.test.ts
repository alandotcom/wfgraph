import { describe, expect, it } from "vitest";
import type { ThreadMessage } from "@assistant-ui/react";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  nodeChanges,
  recordedTools,
  toAgentMessages,
} from "#src/components/agent/turn-record";

function node(id: string, label: string, config = {}): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action", config },
  };
}

function message(
  fields: Pick<ThreadMessage, "role" | "content"> &
    Partial<Pick<ThreadMessage, "status" | "metadata">>
): ThreadMessage {
  // The fixture fills the fields the conversion reads; assistant-ui's own
  // bookkeeping fields are not part of what it sends.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a partial fixture of assistant-ui's message
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(0),
    attachments: [],
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {},
      ...fields.metadata,
    },
    ...fields,
  } as unknown as ThreadMessage;
}

describe("nodeChanges", () => {
  it("names added, changed and removed nodes, and ignores a move", () => {
    const moved = { ...node("kept", "Kept"), position: { x: 40, y: 40 } };
    expect(
      nodeChanges(
        [node("kept", "Kept"), node("edited", "Edited"), node("gone", "Gone")],
        [
          moved,
          node("edited", "Edited", { channel: "#ops" }),
          node("new", "New"),
        ]
      )
    ).toEqual({
      added: [{ id: "new", label: "New" }],
      changed: [{ id: "edited", label: "Edited" }],
      removed: [{ id: "gone", label: "Gone" }],
    });
  });
});

describe("recordedTools", () => {
  it("keeps each settled call with its outcome and skips one in flight", () => {
    expect(
      recordedTools([
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "add_node",
          args: {},
          argsText: "{}",
          result: "Added Notify.",
        },
        {
          type: "tool-call",
          toolCallId: "c2",
          toolName: "update_node",
          args: {},
          argsText: "{}",
          result: "Unknown field.",
          isError: true,
        },
        {
          type: "tool-call",
          toolCallId: "c3",
          toolName: "read_workflow",
          args: {},
          argsText: "{}",
          result: null,
        },
        {
          type: "tool-call",
          toolCallId: "c4",
          toolName: "list_actions",
          args: {},
          argsText: "{}",
        },
      ])
    ).toEqual([
      { name: "add_node", failed: false, summary: "Added Notify." },
      { name: "update_node", failed: true, summary: "Unknown field." },
      { name: "read_workflow", failed: false },
    ]);
  });
});

describe("toAgentMessages", () => {
  it("sends a stopped turn that wrote nothing as a stopped assistant turn", () => {
    expect(
      toAgentMessages([
        message({
          role: "user",
          content: [{ type: "text", text: "Build it" }],
        }),
        message({
          role: "assistant",
          content: [],
          status: { type: "incomplete", reason: "cancelled" },
        }),
        message({ role: "user", content: [{ type: "text", text: "Go on" }] }),
      ])
    ).toEqual([
      { role: "user", content: "Build it" },
      { role: "assistant", content: "", record: { stopped: true } },
      { role: "user", content: "Go on" },
    ]);
  });

  it("carries the record a turn stored and the error it ended on", () => {
    const record = {
      tools: [{ name: "add_node", failed: false, summary: "Added Notify." }],
    };
    expect(
      toAgentMessages([
        message({
          role: "assistant",
          content: [{ type: "text", text: "Partly done." }],
          status: {
            type: "incomplete",
            reason: "error",
            error: "Rate limited",
          },
          metadata: { custom: { record } },
        }),
      ])
    ).toEqual([
      {
        role: "assistant",
        content: "Partly done.",
        record: { ...record, error: "Rate limited" },
      },
    ]);
  });
});
