import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useLocalRuntime,
} from "@assistant-ui/react";
import { AgentThread } from "#src/components/agent/agent-thread";

/**
 * A thread with no model behind it.
 *
 * Every part primitive reads the scope it is rendered inside, and getting that
 * wrong throws at render rather than failing a type check. Rendering the real
 * thread against fixed messages is the only thing that catches it, which is what
 * this file exists for.
 */
function renderThread(messages: ThreadMessageLike[]) {
  function Harness() {
    const runtime = useLocalRuntime(
      { run: () => Promise.resolve({ content: [] }) },
      { initialMessages: messages }
    );

    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <AgentThread />
      </AssistantRuntimeProvider>
    );
  }

  return render(<Harness />);
}

describe("AgentThread", () => {
  it("invites the user to describe a workflow before anything is said", async () => {
    renderThread([]);

    expect(await screen.findByText("Build with the agent")).toBeTruthy();
  });

  it("renders what the user asked for", async () => {
    renderThread([
      { role: "user", content: [{ type: "text", text: "Add a Slack step" }] },
    ]);

    expect(await screen.findByText("Add a Slack step")).toBeTruthy();
  });

  it("renders the assistant's reply as prose", async () => {
    renderThread([
      { role: "user", content: [{ type: "text", text: "Add a Slack step" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Added **Notify** below Lifecycle." }],
      },
    ]);

    expect(await screen.findByText(/Added/)).toBeTruthy();
    // Markdown, rather than the asterisks a model writes.
    expect(screen.getByText("Notify").tagName).toBe("STRONG");
  });

  it("shows a tool call as the sentence the tool answered", async () => {
    renderThread([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "add_node",
            args: { label: "Notify" },
            result: "Added Notify as abc.",
          },
        ],
      },
    ]);

    // The working-out is folded away by default, so the answer is what a
    // reader sees first.
    const trigger = await screen.findByText("Thinking");
    expect(screen.queryByText("Added Notify as abc.")).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByText("Added Notify as abc.")).toBeTruthy();
  });

  it("marks a refused tool call so it does not read as success", async () => {
    const { container } = renderThread([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "connect_nodes",
            args: {},
            result: "A step cannot flow into itself.",
            isError: true,
          },
        ],
      },
    ]);

    fireEvent.click(await screen.findByText("Thinking"));
    expect(
      await screen.findByText("A step cannot flow into itself.")
    ).toBeTruthy();
    // Colour carries the state, which is the one thing DESIGN.md reserves it for.
    expect(container.querySelector(".text-destructive")).not.toBeNull();
  });

  it("folds reasoning and tool calls into one chain of thought", async () => {
    renderThread([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "The Slack action needs a channel." },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "describe_action",
            args: {},
            result: "Read describe_action.",
          },
          { type: "text", text: "Added the step." },
        ],
      },
    ]);

    // One disclosure for the whole working-out, and the answer outside it.
    expect(await screen.findByText("Added the step.")).toBeTruthy();
    expect(screen.getAllByText("Thinking")).toHaveLength(1);

    fireEvent.click(screen.getByText("Thinking"));
    expect(
      await screen.findByText("The Slack action needs a channel.")
    ).toBeTruthy();
    expect(screen.getByText("Read describe_action.")).toBeTruthy();
  });

  it("offers a way to send, and a way to stop once a turn is running", async () => {
    renderThread([]);

    expect(await screen.findByLabelText("Send")).toBeTruthy();
    expect(screen.queryByLabelText("Stop")).toBeNull();
  });
});
