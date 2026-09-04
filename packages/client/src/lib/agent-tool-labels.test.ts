import { describe, expect, it } from "vitest";
import { agentToolLabel } from "#src/lib/agent-tool-labels";

describe("agentToolLabel", () => {
  it("names what a catalog search looked for, so repeats read apart", () => {
    expect(
      agentToolLabel({ toolName: "list_actions", args: { query: "slack" } })
    ).toBe("Searched actions for “slack”");
    expect(
      agentToolLabel({ toolName: "list_actions", args: { query: "email" } })
    ).toBe("Searched actions for “email”");
  });

  it("prefers the query, then the category, then the integration", () => {
    expect(
      agentToolLabel({
        toolName: "list_actions",
        args: { query: "post", category: "Messaging", integration: "slack" },
      })
    ).toBe("Searched actions for “post”");
    expect(
      agentToolLabel({
        toolName: "list_actions",
        args: { category: "Messaging", integration: "slack" },
      })
    ).toBe("Listed Messaging actions");
    expect(
      agentToolLabel({
        toolName: "list_actions",
        args: { integration: "slack" },
      })
    ).toBe("Listed slack actions");
    expect(agentToolLabel({ toolName: "list_actions", args: {} })).toBe(
      "Listed the actions"
    );
  });

  it("counts what a call asked for, and does not say '1 steps'", () => {
    expect(
      agentToolLabel({ toolName: "read_nodes", args: { nodeIds: ["a"] } })
    ).toBe("Read 1 step");
    expect(
      agentToolLabel({ toolName: "read_nodes", args: { nodeIds: ["a", "b"] } })
    ).toBe("Read 2 steps");
  });

  it("names a write in flight, before the server's sentence arrives", () => {
    expect(
      agentToolLabel({
        toolName: "add_node",
        args: { actionId: "slack.post", label: "Notify" },
      })
    ).toBe("Adding Notify");
    expect(agentToolLabel({ toolName: "connect_nodes", args: {} })).toBe(
      "Connecting two steps"
    );
  });

  it("cuts a long value rather than wrapping the row", () => {
    const label = agentToolLabel({
      toolName: "list_events",
      args: {
        query:
          "a signup event that also carries the plan the customer picked at checkout",
      },
    });

    expect(label).toBe(
      "Searched Events for “a signup event that also carries the pla…”"
    );
  });

  it("falls back to a phrase the arguments do not carry", () => {
    // The model may leave an optional argument out, or write a blank one.
    expect(
      agentToolLabel({ toolName: "add_node", args: { label: "  " } })
    ).toBe("Adding a step");
    expect(agentToolLabel({ toolName: "describe_action", args: {} })).toBe(
      "Read an action"
    );
  });

  it("does not trust the arguments to be an object at all", () => {
    expect(agentToolLabel({ toolName: "read_nodes", args: undefined })).toBe(
      "Read the steps"
    );
    expect(agentToolLabel({ toolName: "update_node", args: "node_1" })).toBe(
      "Updating a step"
    );
  });

  it("reads a tool it has never heard of, rather than drawing a blank row", () => {
    expect(agentToolLabel({ toolName: "inspect_bindings", args: {} })).toBe(
      "Inspect bindings"
    );
  });
});
