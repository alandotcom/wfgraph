import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_COMPOSER_PLACEHOLDER,
  WorkflowAgentView,
} from "#src/components/agent/workflow-agent";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { openReviewPageAtom } from "#src/lib/workflow-review-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  savedWorkflow,
  unreadableDraft,
} from "#src/lib/workflow-save-test-support";
import {
  activeAgentTurnIdAtom,
  agentConversationOpenAtom,
  agentHiddenAtom,
  focusAgentComposerAtom,
} from "#src/lib/workflow-ui-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { appStore } from "#src/lib/app-store";
import { revealPlacementRequestAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

/** The bodies of the chat requests sent, read as text. */
let sentBodies: string[] = [];

beforeEach(() => {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  sentBodies = [];
  // A chat request that never answers, so the agent stays at work.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(String(init?.body ?? ""));
      return new Promise<Response>(() => {});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
  localStorage.clear();
});

const SEND_NODE = {
  id: "send",
  type: "action",
  position: { x: 0, y: 0 },
  data: { label: "Send 24-hour reminder", type: "action" as const, config: {} },
};

function renderAgent(variant: "canvas" | "phone" = "canvas") {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, {
    nodes: [
      {
        id: "send",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Send 24-hour reminder",
          type: "action",
          config: {},
        },
      },
    ],
    edges: [],
  });
  showWorkspaceRoute(store, {});
  const { unmount } = render(
    <JotaiProvider store={store}>
      <ExtensionCatalogProvider value={emptyExtensionCatalog}>
        <WorkflowAgentView variant={variant} workflowId="workflow_1" />
      </ExtensionCatalogProvider>
    </JotaiProvider>
  );
  const field = () => screen.getByPlaceholderText(AGENT_COMPOSER_PLACEHOLDER);
  const conversation = () =>
    screen.queryByRole("region", { name: "Agent conversation" });
  const type = (text: string) =>
    fireEvent.change(field(), { target: { value: text } });
  const lineState = () =>
    document
      .querySelector('[data-slot="agent-prompt-line"]')
      ?.getAttribute("data-state");
  return { store, field, conversation, type, lineState, unmount };
}

/** The input the line holds, or null while the box is hidden. */
function queryField() {
  return screen.queryByPlaceholderText(AGENT_COMPOSER_PLACEHOLDER);
}

/** Cmd+J, pressed wherever focus is. */
function pressAgentChord() {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "j",
    metaKey: true,
  });
}

/**
 * Lets the runtime load the stored thread, which it reads after mounting.
 * Focus opens the conversation only once the thread holds messages.
 */
async function threadLoaded() {
  await act(async () => {});
}

function storeThread(text: string) {
  localStorage.setItem(
    "wfgraph:agent-thread:workflow_1",
    JSON.stringify({
      version: 1,
      messages: [
        {
          parentId: null,
          message: {
            id: "m1",
            role: "user",
            createdAt: "2026-11-11T10:00:00.000Z",
            content: [{ type: "text", text }],
            attachments: [],
            metadata: { custom: {} },
          },
        },
      ],
    })
  );
}

describe("WorkflowAgentView", () => {
  it("rests as a pill, grows on focus, and returns to the pill on blur while empty", () => {
    const { field, conversation, lineState, type } = renderAgent();
    expect(lineState()).toBe("pill");

    act(() => {
      field().focus();
    });
    expect(lineState()).toBe("grown");
    // An empty thread has nothing to show, so focus opens no conversation.
    expect(conversation()).toBeNull();

    act(() => {
      field().blur();
    });
    expect(lineState()).toBe("pill");

    // Text keeps the line grown after it loses focus.
    act(() => {
      field().focus();
    });
    type("Add a Wait");
    act(() => {
      field().blur();
    });
    expect(lineState()).toBe("grown");
  });

  it("opens the empty conversation's suggestions on Enter in the empty line", async () => {
    const { field, conversation, lineState } = renderAgent();
    act(() => {
      field().focus();
    });
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(
      await within(conversation() as HTMLElement).findByText(
        "Explain this workflow"
      )
    ).toBeTruthy();
    // An open conversation keeps the line grown without focus.
    act(() => {
      field().blur();
    });
    expect(lineState()).toBe("grown");
  });

  it("hides the selection chip at rest and shows it once grown", () => {
    const { store, field } = renderAgent();
    act(() => {
      store.set(selectOnlyNodeAtom, "send");
    });
    const offer = () =>
      screen.queryByRole("button", {
        name: /^Attach .*Send 24-hour reminder$/,
      });
    expect(offer()).toBeNull();

    act(() => {
      field().focus();
    });
    expect(offer()).not.toBeNull();
  });

  it("returns an empty grown line to the pill on Escape and gives up focus", () => {
    const { store, field, lineState } = renderAgent();
    act(() => {
      store.set(selectOnlyNodeAtom, "send");
      field().focus();
    });
    expect(lineState()).toBe("grown");

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.activeElement).not.toBe(field());
    expect(lineState()).toBe("pill");
  });

  it("keeps the line grown on Escape while it holds text", () => {
    const { field, lineState, type } = renderAgent();
    act(() => {
      field().focus();
    });
    type("Add a Wait");

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.activeElement).toBe(field());
    expect(lineState()).toBe("grown");
  });

  it("collapses on Escape and on its close control, keeping the conversation", async () => {
    storeThread("Add a Slack step");
    const { field, conversation } = renderAgent();
    await threadLoaded();
    act(() => {
      field().focus();
    });
    expect(await screen.findByText("Add a Slack step")).toBeTruthy();

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(conversation()).toBeNull();
    expect(document.activeElement).toBe(field());

    fireEvent.click(field());
    act(() => {
      field().blur();
      field().focus();
    });
    expect(conversation()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
    expect(conversation()).toBeNull();

    act(() => {
      field().blur();
      field().focus();
    });
    expect(screen.getByText("Add a Slack step")).toBeTruthy();
  });

  it("reopens a collapsed conversation from the line that kept focus", async () => {
    storeThread("Add a Slack step");
    const { field, conversation, type } = renderAgent();
    await threadLoaded();
    act(() => {
      field().focus();
    });
    const collapse = () => {
      fireEvent.keyDown(field(), { key: "Escape" });
      expect(conversation()).toBeNull();
      expect(document.activeElement).toBe(field());
    };

    collapse();
    fireEvent.click(field());
    expect(conversation()).not.toBeNull();

    collapse();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(conversation()).not.toBeNull();

    collapse();
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(conversation()).not.toBeNull();

    // With text in the line, Down moves the caret and leaves it closed.
    collapse();
    type("Add a Wait");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(conversation()).toBeNull();
  });

  it("shows the reply from the dot the line keeps after a collapsed turn", async () => {
    const { field, conversation, type } = renderAgent();
    type("What does this workflow do?");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(sentBodies).toHaveLength(1));
    fireEvent.keyDown(field(), { key: "Escape" });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "The agent is working. Show the conversation",
      })
    );
    expect(conversation()).not.toBeNull();
  });

  it("marks the line while the agent works with the conversation collapsed", async () => {
    const { field, conversation, type } = renderAgent();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    type("What does this workflow do?");
    fireEvent.keyDown(field(), { key: "Enter" });

    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(conversation()).not.toBeNull();
    expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "The agent is working. Show the conversation",
      })
    ).toBeNull();

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(
      await screen.findByRole("button", {
        name: "The agent is working. Show the conversation",
      })
    ).toBeTruthy();
  });

  it("offers the selected step as a chip, sends it only once attached, and lets it be removed", async () => {
    const { store, field, type } = renderAgent();
    act(() => {
      store.set(selectOnlyNodeAtom, "send");
      field().focus();
    });
    const offer = await screen.findByRole("button", {
      name: /^Attach .*Send 24-hour reminder$/,
    });

    fireEvent.click(offer);
    const chip = screen.getByText(/Send 24-hour reminder/, {
      selector: '[data-slot="agent-attached-step"]',
    });
    expect(chip).toBeTruthy();
    // The pressed chip leaves with its row, and focus returns to the line.
    expect(document.activeElement).toBe(field());
    fireEvent.click(
      screen.getByRole("button", { name: /^Remove .*Send 24-hour reminder$/ })
    );
    expect(
      document.querySelector('[data-slot="agent-attached-step"]')
    ).toBeNull();

    // Sent with nothing attached, the request names no step.
    type("Explain this step");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]).toContain('"selectedNodeIds":[]');
  });

  it("sends an attached step with the message and shows it in the thread", async () => {
    const { store, field, type, conversation } = renderAgent();
    act(() => {
      store.set(selectOnlyNodeAtom, "send");
      field().focus();
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Attach .*Send 24-hour reminder$/,
      })
    );
    type("Shorten this message");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]).toContain('"selectedNodeIds":["send"]');
    const sent = within(conversation() as HTMLElement).getByRole("list", {
      name: "Attached steps",
    });
    expect(sent.textContent).toContain("Send 24-hour reminder");
    expect(
      document.querySelector('[data-slot="agent-attached-step"]')
    ).toBeNull();
  });

  it("takes the cursor, and the text an entry point brings, when asked", async () => {
    const { store, field, conversation } = renderAgent();
    act(() => {
      store.set(focusAgentComposerAtom, "Add a reminder the day before");
    });

    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect((field() as HTMLTextAreaElement).value).toBe(
      "Add a reminder the day before"
    );
    expect(store.get(agentConversationOpenAtom)).toBe(true);
    expect(conversation()).not.toBeNull();
  });

  it("hides while the review sheet is open", () => {
    const { store } = renderAgent();
    const agent = document.querySelector<HTMLElement>(
      '[data-slot="workflow-agent"]'
    );
    expect(agent?.className).not.toContain("hidden");

    act(() => {
      store.set(openReviewPageAtom, {
        workflowId: "workflow_1",
        page: { kind: "history" },
      });
    });
    expect(agent?.className).toContain("hidden");
  });

  it("hides from its corner control and shows again from the control left in its place", async () => {
    const { field } = renderAgent();
    act(() => {
      field().focus();
    });
    fireEvent.click(screen.getByRole("button", { name: "Hide agent" }));

    expect(queryField()).toBeNull();
    expect(document.querySelector('[data-slot="agent-composer"]')).toBeNull();
    const show = screen.getByRole("button", { name: "Show agent" });
    // Focus was inside the box, so it stays on the control that replaced it.
    expect(document.activeElement).toBe(show);

    fireEvent.click(show);
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(screen.queryByRole("button", { name: "Show agent" })).toBeNull();
  });

  it("hides and shows on Cmd+J, putting the cursor in the line as it comes back", async () => {
    const { field, store } = renderAgent();
    pressAgentChord();
    expect(queryField()).toBeNull();
    expect(store.get(agentHiddenAtom)).toBe(true);

    pressAgentChord();
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(store.get(agentHiddenAtom)).toBe(false);

    // The chord works from the agent's own field too.
    pressAgentChord();
    expect(queryField()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show agent" })
    );
  });

  it("keeps the box hidden across a remount, as a preference this browser stores", () => {
    const first = renderAgent();
    pressAgentChord();
    expect(localStorage.getItem("wfgraph:agent-hidden")).toBe("true");
    first.unmount();

    renderAgent();
    expect(queryField()).toBeNull();
    expect(screen.getByRole("button", { name: "Show agent" })).toBeTruthy();
  });

  it("marks the Show agent control while a turn runs with the box hidden", async () => {
    const { field, type } = renderAgent();
    type("What does this workflow do?");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(sentBodies).toHaveLength(1));

    pressAgentChord();
    expect(
      await screen.findByRole("button", {
        name: "Show agent. The agent is working",
      })
    ).toBeTruthy();
  });

  it("shows a hidden box again when an entry point asks for the line", async () => {
    const { store, field } = renderAgent();
    pressAgentChord();
    act(() => {
      store.set(focusAgentComposerAtom, "Why did the last run fail?");
    });
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect((field() as HTMLTextAreaElement).value).toBe(
      "Why did the last run fail?"
    );
  });

  it("keeps a phone's line, which has no hide control and ignores Cmd+J", () => {
    renderAgent("phone");
    expect(screen.queryByRole("button", { name: "Hide agent" })).toBeNull();
    pressAgentChord();
    expect(queryField()).not.toBeNull();
  });

  it("clears the thread and its stored copy on New conversation", async () => {
    storeThread("Add a Slack step");
    const { field } = renderAgent();
    await threadLoaded();
    act(() => {
      field().focus();
    });
    await screen.findByText("Add a Slack step");

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() => {
      expect(screen.queryByText("Add a Slack step")).toBeNull();
    });
    expect(localStorage.getItem("wfgraph:agent-thread:workflow_1")).toBeNull();
  });

  it("covers the whole screen with a phone's open conversation, with Back", async () => {
    const { field, conversation, lineState } = renderAgent("phone");
    // A phone keeps the full line below its main view.
    expect(lineState()).toBe("grown");
    const agent = () =>
      document.querySelector<HTMLElement>('[data-slot="workflow-agent"]');
    expect(agent()?.className).not.toContain("fixed");

    act(() => {
      field().focus();
    });
    expect(conversation()).not.toBeNull();
    expect(agent()?.className).toContain("fixed inset-0");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(conversation()).toBeNull();
    expect(agent()?.className).not.toContain("fixed");
    expect(document.activeElement).toBe(field());

    // A phone's line has no pill to return to, so Escape in the empty line
    // keeps focus there and leaves the conversation closed.
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.activeElement).toBe(field());
    expect(conversation()).toBeNull();
    expect(lineState()).toBe("grown");
  });

  it("collapses to the working line when the agent's edit lands, and shows the changed step", async () => {
    const encoder = new TextEncoder();
    const event = (data: unknown, name = "message") =>
      encoder.encode(
        `event: ${name}\ndata: ${JSON.stringify({ json: data })}\n\n`
      );
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        // Only the chat streams. The draft save the agent's edit asks for is
        // answered as refused, which this test does not read.
        if (
          !String(input instanceof Request ? input.url : input).includes(
            "agent"
          )
        ) {
          return new Response("{}", { status: 404 });
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      })
    );
    // The agent's runtime writes to the application's store, which every test
    // file in this worker shares. The agent's edit queues a draft save there,
    // so this case saves through its own API under its own workflow id, and
    // gives the store back empty once that save has answered.
    const store = appStore;
    const workflowId = "workflow_agent_edit";
    const sharedApi = store.get(workflowApiAtom);
    const sharedAutosaveDelay = store.get(autosaveDelayAtom);
    store.set(workflowApiAtom, {
      update: vi.fn(() => Promise.resolve(savedWorkflow(workflowId))) as never,
      read: unreadableDraft,
    });
    store.set(autosaveDelayAtom, 0);
    store.set(currentWorkflowIdAtom, workflowId);
    store.set(loadWorkflowGraphAtom, { nodes: [SEND_NODE], edges: [] });
    showWorkspaceRoute(store, {});
    render(
      <JotaiProvider store={store}>
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <WorkflowAgentView variant="canvas" workflowId={workflowId} />
        </ExtensionCatalogProvider>
      </JotaiProvider>
    );
    try {
      const field = screen.getByPlaceholderText(AGENT_COMPOSER_PLACEHOLDER);
      fireEvent.change(field, { target: { value: "Add a wait" } });
      fireEvent.keyDown(field, { key: "Enter" });
      await waitFor(() => expect(stream).toBeDefined());
      expect(store.get(agentConversationOpenAtom)).toBe(true);

      await act(async () => {
        stream?.enqueue(
          event({
            type: "graph",
            graph: createSerializedWorkflowGraph({
              nodes: [
                SEND_NODE,
                {
                  id: "wait_new",
                  type: "action",
                  position: { x: 0, y: 200 },
                  data: { label: "Wait a day", type: "action", config: {} },
                },
              ],
              edges: [],
            }),
          })
        );
      });

      await waitFor(() =>
        expect(store.get(agentConversationOpenAtom)).toBe(false)
      );
      expect(
        screen.queryByRole("region", { name: "Agent conversation" })
      ).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "The agent is working. Show the conversation",
        })
      ).toBeTruthy();

      await act(async () => {
        stream?.enqueue(event(null, "close"));
      });
      await waitFor(() =>
        expect(store.get(revealPlacementRequestAtom)?.nodeIds).toEqual([
          "wait_new",
        ])
      );
    } finally {
      store.set(agentConversationOpenAtom, false);
      store.set(activeAgentTurnIdAtom, null);
      await waitFor(() => expect(store.get(hasUnsavedChangesAtom)).toBe(false));
      store.set(currentWorkflowIdAtom, null);
      store.set(loadWorkflowGraphAtom, { nodes: [], edges: [] });
      store.set(workflowApiAtom, sharedApi);
      store.set(autosaveDelayAtom, sharedAutosaveDelay);
    }
  });
});
