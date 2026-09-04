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

  it("folds a turn's tool calls under a count", async () => {
    renderThread([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "list_actions",
            args: { query: "slack" },
          },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "add_node",
            args: { label: "Notify" },
            result: "Added Notify as abc.",
          },
          { type: "text", text: "Added the step." },
        ],
      },
    ]);

    // The answer reads without opening anything; what the agent did is behind
    // one count.
    expect(await screen.findByText("Added the step.")).toBeTruthy();
    expect(screen.queryByText(/Searched actions/)).toBeNull();

    fireEvent.click(screen.getByText("2 tool calls"));
    expect(await screen.findByText(/Searched actions for/)).toBeTruthy();
    expect(screen.getByText(/Added Notify/)).toBeTruthy();
  });

  it("names a read call by what it asked for, since it answers no sentence", async () => {
    renderThread([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "list_actions",
            args: { query: "slack" },
          },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "list_actions",
            args: { query: "email" },
          },
        ],
      },
    ]);

    // Two calls to one tool read as two different lines, which is the whole
    // point of naming a call by its arguments.
    fireEvent.click(await screen.findByText("2 tool calls"));
    expect(
      await screen.findByText(/Searched actions for “slack”/)
    ).toBeTruthy();
    expect(screen.getByText(/Searched actions for “email”/)).toBeTruthy();
  });

  it("reads reasoning as the steps the model went through", async () => {
    renderThread([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "**Reading the workflow**\n\nIt has no Slack step yet.",
          },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "describe_action",
            args: { actionId: "slack.post" },
          },
          { type: "reasoning", text: "No heading on this one." },
          { type: "text", text: "Added the step." },
        ],
      },
    ]);

    // A summary arrives as a bold heading over a paragraph, which is a step's
    // title and its body. One without a heading keeps its whole text.
    expect(await screen.findByText("Added the step.")).toBeTruthy();
    fireEvent.click(screen.getByText("Thinking"));
    expect(await screen.findByText("Reading the workflow")).toBeTruthy();
    expect(screen.getByText("It has no Slack step yet.")).toBeTruthy();
    expect(screen.getByText("No heading on this one.")).toBeTruthy();
  });

  it("keeps the tool calls under a count of their own", async () => {
    renderThread([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "**Reading the workflow**" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "describe_action",
            args: { actionId: "slack.post" },
          },
          { type: "text", text: "Added the step." },
        ],
      },
    ]);

    expect(await screen.findByText("Added the step.")).toBeTruthy();
    expect(screen.queryByText(/Read the slack.post action/)).toBeNull();

    fireEvent.click(screen.getByText("1 tool call"));
    expect(await screen.findByText(/Read the slack.post action/)).toBeTruthy();
  });

  it("offers a way to send, and a way to stop once a turn is running", async () => {
    renderThread([]);

    expect(await screen.findByLabelText("Send")).toBeTruthy();
    expect(screen.queryByLabelText("Stop")).toBeNull();
  });
});
