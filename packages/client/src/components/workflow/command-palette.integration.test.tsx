import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolbarActions } from "#src/components/workflow/workflow-toolbar-chrome";
import { renderChrome } from "#src/components/workflow/workflow-toolbar-chrome.test-support";
import {
  currentWorkflowDraftRevisionAtom,
  currentWorkflowIdAtom,
} from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  canUndoAtom,
  displayEdgesAtom,
  displayNodesAtom,
  edgesAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  toPersistedEdge,
  toPersistedNode,
} from "#src/lib/workflow-graph-types";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";

/**
 * The command palette is mounted by `ToolbarActions`, so what is exercised here
 * is the wiring: the key that opens it, the box in the bar that opens it, the
 * two conditions that refuse it, and the Actions menu item that skips its root
 * page. The page stack itself is pure and lives in `command-palette.test.ts`.
 */
const ONE_ACTION_CATALOG: ExtensionCatalog = {
  events: [],
  integrations: [],
  actions: [
    {
      id: "Wait",
      label: "Wait",
      description: "Delay execution",
      category: "System",
      configFields: [],
      outputFields: [],
    },
  ],
};

const SEARCH_GRAPH: WorkflowNode[] = [
  {
    id: "lifecycle_1",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Lifecycle", type: "lifecycle" },
  },
  {
    id: "group_1",
    type: "group",
    position: { x: 400, y: 120 },
    data: { label: "Customer updates", type: "group" },
  },
  {
    id: "notify_customer",
    parentId: "group_1",
    type: "action",
    position: { x: 24, y: 48 },
    data: { label: "Notify customer", type: "action" },
  },
];

const SELECTED_SEARCH_EDGE: WorkflowEdge = {
  id: "lifecycle-to-group",
  source: "lifecycle_1",
  target: "group_1",
  selected: true,
};

/** The palette's own search box, which is the only textbox in this tree. */
function paletteInput(container: HTMLElement | Document = document) {
  return container.querySelector<HTMLInputElement>("[role='combobox']");
}

function pressCommandK(target: Document | Element = document) {
  fireEvent.keyDown(target, { key: "k", metaKey: true });
}

function persistedDraft(input: ReturnType<typeof renderChrome>["store"]) {
  return createSerializedWorkflowGraph({
    nodes: input.get(nodesAtom).map(toPersistedNode),
    edges: input.get(edgesAtom).map(toPersistedEdge),
  });
}

describe("the command palette", () => {
  it("opens on Cmd+K, at the root page", async () => {
    const { findByRole } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });

    pressCommandK();

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, steps, or nodes"
    );
    const palette = document.querySelector('[data-slot="dialog-content"]');
    expect(palette?.className).toContain("data-open:animate-in");
    expect(palette?.className).toContain("motion-reduce:animate-none");
  });

  it("offers workflow and canvas actions", async () => {
    const rendered = renderChrome(ToolbarActions, {
      state: {
        publication: {
          isPublished: true,
          hasUnpublishedChanges: true,
          publishedVersionId: "version_1",
          publishedVersion: 1,
          publishedAt: "2026-08-23T15:00:00.000Z",
        },
      },
    });
    await openedPalette(rendered);

    expect(
      rendered.getByRole("option", { name: /^Save workflow/ })
    ).toBeTruthy();
    expect(
      rendered.getByRole("option", { name: "Go to run history" })
    ).toBeTruthy();
    expect(
      rendered.getByRole("option", { name: "Go to version history" })
    ).toBeTruthy();
    expect(
      rendered.getByRole("option", { name: "Publish workflow" })
    ).toBeTruthy();
    for (const label of [
      /^Fit view/,
      /^Copy selection/,
      /^Paste/,
      /^Duplicate selection/,
      /^Group selection/,
    ]) {
      expect(rendered.getByRole("option", { name: label })).toBeTruthy();
    }

    fireEvent.click(rendered.getByRole("option", { name: /^Save workflow/ }));
    expect(rendered.actions.handleSave).toHaveBeenCalledOnce();

    pressCommandK();
    fireEvent.click(rendered.getByRole("option", { name: "Publish workflow" }));
    expect(rendered.actions.handlePublish).toHaveBeenCalledOnce();

    pressCommandK();
    fireEvent.click(
      rendered.getByRole("option", { name: "Go to run history" })
    );
    expect(rendered.store.get(workflowWorkspaceViewAtom)).toBe("runs");
  });

  // The same rule Cmd+Enter follows: a chord is not worth a keystroke taken out
  // of a field somebody is typing in.
  it("leaves Cmd+K alone while a text field has focus", async () => {
    const { findByRole } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });

    const field = document.createElement("input");
    document.body.append(field);
    pressCommandK(field);
    field.remove();

    expect(paletteInput()).toBeNull();
  });

  /**
   * The palette names itself, because none of what it does is legible from a
   * placeholder: that is the weakest source an accessible name can come from,
   * and this one's changes underneath the reader as the page does. The live
   * region is the only signal of that page change that reaches them at all.
   */
  it("names its box, its list, its way out and the page it is on", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const { getByRole, getByText } = rendered;
    await openedPalette(rendered);

    expect(
      getByRole("combobox", { name: "Search commands, step types, and nodes" })
    ).toBeTruthy();
    expect(getByRole("listbox", { name: "Commands and nodes" })).toBeTruthy();
    // Base UI asks for a close inside every modal popup, for the touch screen
    // reader that has no Escape key and cannot reach the backdrop.
    expect(getByRole("button", { name: "Close command palette" })).toBeTruthy();
    expect(getByText("Commands.").getAttribute("aria-live")).toBe("polite");

    chooseAddStep(rendered);

    expect(
      getByRole("combobox", { name: "Search commands, step types, and nodes" })
    ).toBeTruthy();
    expect(getByRole("listbox", { name: "Step types" })).toBeTruthy();
    expect(getByText(/^Add step\. Choose/).getAttribute("aria-live")).toBe(
      "polite"
    );
  });

  // The chord is announced once, by `aria-keyshortcuts`. Inside the accessible
  // name the printed `⌘K` read as part of what the button is called.
  it("keeps the printed chord out of the trigger's name", async () => {
    const { findByRole } = renderChrome(ToolbarActions);

    const trigger = await findByRole("button", {
      name: "Search commands or add a step",
    });

    expect(trigger.getAttribute("aria-keyshortcuts")).toMatch(
      /^(Meta|Control)\+K$/
    );
  });

  it("opens from the box in the bar", async () => {
    const { findByRole } = renderChrome(ToolbarActions);

    fireEvent.click(
      await findByRole("button", { name: /Search commands or add a step/ })
    );

    expect(paletteInput()).not.toBeNull();
  });

  // A step added under a run overlay lands on a draft nobody can see, which is
  // the same reason Publish and every menu item that writes the graph refuse.
  it("opens search but keeps Add step unavailable while a past run pins the canvas", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      overlayActive: true,
    });

    const trigger = await findByRole("button", {
      name: /Search commands or add a step/,
    });
    expect(trigger.hasAttribute("disabled")).toBe(false);

    pressCommandK();

    expect(paletteInput()).not.toBeNull();
    expect(
      (await findByRole("option", { name: /^Add step/ })).getAttribute(
        "data-disabled"
      )
    ).not.toBeNull();
    expect(
      (await findByRole("option", { name: /^Run draft/ })).getAttribute(
        "data-disabled"
      )
    ).not.toBeNull();
  });

  // Generation used to fall between the palette's lock and its items': Cmd+K
  // opened a palette whose every item was disabled, "Add step" included, which
  // the Actions menu refuses outright in the same state.
  it("opens search but keeps Add step unavailable while generation is rewriting the graph", async () => {
    const { findByRole } = renderChrome(ToolbarActions, { generating: true });

    const trigger = await findByRole("button", {
      name: /Search commands or add a step/,
    });
    expect(trigger.hasAttribute("disabled")).toBe(false);

    pressCommandK();

    expect(paletteInput()).not.toBeNull();
    expect(
      (await findByRole("option", { name: /^Add step/ })).getAttribute(
        "data-disabled"
      )
    ).not.toBeNull();
  });

  // Someone who chose "Add step" has already said what they want, so the root
  // page has nothing left to ask them.
  it("sends the Actions menu's Add step straight to the node types", async () => {
    const { findByRole } = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });

    const trigger = await findByRole("button", { name: "Actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });
    fireEvent.click(await findByRole("menuitem", { name: /^Add step/ }));

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search step types"
    );
    expect(await findByRole("option", { name: /^Wait/ })).toBeTruthy();
  });

  it("keeps the palette available and disables edit commands when editing is denied", async () => {
    const { findByRole, findByTestId } = renderChrome(ToolbarActions, {
      state: { canUpdate: false },
    });
    await findByTestId("toolbar-actions-host");

    pressCommandK();

    expect(paletteInput()).not.toBeNull();
    expect(
      (await findByRole("option", { name: /^Add step/ })).getAttribute(
        "data-disabled"
      )
    ).not.toBeNull();
  });

  it("keeps node search read-only in Changes without enabling run commands", async () => {
    const rendered = renderChrome(ToolbarActions);
    act(() => rendered.store.set(workflowWorkspaceViewAtom, "changes"));

    await openedPalette(rendered);

    expect(
      rendered
        .getByRole("option", { name: /^Add step/ })
        .getAttribute("data-disabled")
    ).not.toBeNull();
    expect(
      rendered
        .getByRole("option", { name: /^Run draft/ })
        .getAttribute("data-disabled")
    ).not.toBeNull();
  });

  it("finds and selects displayed Group children in a read-only Draft", async () => {
    const rendered = renderChrome(ToolbarActions, {
      graph: SEARCH_GRAPH,
      state: { canUpdate: false },
    });
    const before = persistedDraft(rendered.store);
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "notify" } });
    const result = rendered.getByRole("option", {
      name: /Notify customer — In Customer updates · notify_customer/,
    });

    fireEvent.click(result);

    expect(rendered.store.get(selectedNodeAtom)).toBe("notify_customer");
    expect(
      rendered.store
        .get(displayNodesAtom)
        .filter((node) => node.selected)
        .map((node) => node.id)
    ).toEqual(["notify_customer"]);
    expect(persistedDraft(rendered.store)).toEqual(before);
    expect(paletteInput()).toBeNull();
  });

  it("makes a searched Draft node the only graph selection without a graph edit", async () => {
    const graph = SEARCH_GRAPH.map((node) => ({
      ...node,
      selected: node.id === "lifecycle_1",
    }));
    const rendered = renderChrome(ToolbarActions, {
      graph,
      edges: [SELECTED_SEARCH_EDGE],
      state: { canUpdate: false },
    });
    const serializedBefore = persistedDraft(rendered.store);
    const revisionBefore = rendered.store.get(currentWorkflowDraftRevisionAtom);
    expect(rendered.store.get(canUndoAtom)).toBe(false);

    const input = await openedPalette(rendered);
    fireEvent.change(input, { target: { value: "notify" } });
    fireEvent.click(rendered.getByRole("option", { name: /Notify customer/ }));

    expect(rendered.store.get(selectedNodeAtom)).toBe("notify_customer");
    expect(rendered.store.get(selectedEdgeAtom)).toBeNull();
    expect(
      rendered.store
        .get(displayNodesAtom)
        .filter((node) => node.selected)
        .map((node) => node.id)
    ).toEqual(["notify_customer"]);
    expect(
      rendered.store.get(displayEdgesAtom).some((edge) => edge.selected)
    ).toBe(false);
    expect(persistedDraft(rendered.store)).toEqual(serializedBefore);
    expect(rendered.store.get(canUndoAtom)).toBe(false);
    expect(rendered.store.get(currentWorkflowDraftRevisionAtom)).toBe(
      revisionBefore
    );
  });

  it("finds a custom-labelled action by its catalog label and action ID", async () => {
    const catalog: ExtensionCatalog = {
      events: [],
      integrations: [],
      actions: [
        {
          id: "twilio/send-sms",
          label: "Send SMS",
          description: "Send a text message",
          category: "Twilio",
          configFields: [],
          outputFields: [],
        },
      ],
    };
    const graph: WorkflowNode[] = [
      {
        id: "notify_customer",
        type: "action",
        position: { x: 24, y: 48 },
        data: {
          label: "Notify customer",
          type: "action",
          config: { actionType: "twilio/send-sms" },
        },
      },
    ];
    const rendered = renderChrome(ToolbarActions, { catalog, graph });
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "Send SMS" } });
    expect(
      rendered.getByRole("option", { name: /Notify customer/ })
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: "twilio/send-sms" } });
    expect(
      rendered.getByRole("option", { name: /Notify customer/ })
    ).toBeTruthy();
  });

  it("finds and selects nodes in the pinned Runs graph without enabling edits", async () => {
    const rendered = renderChrome(ToolbarActions, {
      graph: SEARCH_GRAPH.map((node) => ({
        ...node,
        selected: node.id === "lifecycle_1",
      })),
      edges: [SELECTED_SEARCH_EDGE],
      overlayActive: true,
      overlayGraph: { nodes: SEARCH_GRAPH, edges: [] },
    });
    const draftBefore = persistedDraft(rendered.store);
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "notify" } });
    fireEvent.click(rendered.getByRole("option", { name: /Notify customer/ }));

    expect(rendered.store.get(selectedNodeAtom)).toBe("notify_customer");
    expect(
      rendered.store
        .get(displayNodesAtom)
        .filter((node) => node.selected)
        .map((node) => node.id)
    ).toEqual(["notify_customer"]);
    expect(persistedDraft(rendered.store)).toEqual(draftBefore);
    expect(
      rendered.store
        .get(nodesAtom)
        .filter((node) => node.selected)
        .map((node) => node.id)
    ).toEqual(["lifecycle_1"]);
    expect(
      rendered.store
        .get(edgesAtom)
        .filter((edge) => edge.selected)
        .map((edge) => edge.id)
    ).toEqual(["lifecycle-to-group"]);
    expect(rendered.actions.handleExecute).not.toHaveBeenCalled();
  });

  it("finds Changes nodes without replacing the Draft selection", async () => {
    const comparison: WorkflowComparisonPayload = {
      baseVersion: null,
      proposedVersion: 1,
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [SEARCH_GRAPH[2]],
        edges: [],
      }),
      hasChanges: true,
      nodeChanges: [{ nodeId: "notify_customer", kind: "added", fields: [] }],
      edgeChanges: [],
    };
    const rendered = renderChrome(ToolbarActions, {
      graph: SEARCH_GRAPH.map((node) => ({
        ...node,
        selected: node.id === "lifecycle_1",
      })),
      edges: [SELECTED_SEARCH_EDGE],
      comparison,
    });
    const draftBefore = persistedDraft(rendered.store);
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "notify" } });
    fireEvent.click(rendered.getByRole("option", { name: /Notify customer/ }));

    expect(rendered.store.get(selectedNodeAtom)).toBe("notify_customer");
    expect(
      rendered.store
        .get(displayNodesAtom)
        .filter((node) => node.selected)
        .map((node) => node.id)
    ).toEqual(["notify_customer"]);
    expect(persistedDraft(rendered.store)).toEqual(draftBefore);
    expect(
      rendered.store
        .get(nodesAtom)
        .filter((node) => node.selected)
        .map((node) => node.id)
    ).toEqual(["lifecycle_1"]);
    expect(
      rendered.store
        .get(edgesAtom)
        .filter((edge) => edge.selected)
        .map((edge) => edge.id)
    ).toEqual(["lifecycle-to-group"]);
  });

  // A held palette belongs to the workflow it was opened over. Opening another
  // one throws it away, so returning to the first does not spring it back.
  it("throws the palette away when another workflow opens", async () => {
    const { findByRole, store } = renderChrome(ToolbarActions);
    await findByRole("button", { name: "Publish" });
    act(() => store.set(currentWorkflowIdAtom, "workflow_1"));

    pressCommandK();
    expect(paletteInput()).not.toBeNull();

    act(() => store.set(currentWorkflowIdAtom, "workflow_2"));
    expect(paletteInput()).toBeNull();

    act(() => store.set(currentWorkflowIdAtom, "workflow_1"));
    expect(paletteInput()).toBeNull();
  });

  /**
   * The four paths below are the ones a browser pass walks past. Escape and
   * Backspace already have focus on the input, so they never noticed that the
   * header swaps a `<button>` for an `<svg>` when the last page pops: the
   * element the pointer just acted on unmounts, focus falls to `<body>`, and
   * the dialog's trap parks it on the popup rather than the search box.
   */
  async function openedPalette(
    rendered: Awaited<ReturnType<typeof renderChrome>>
  ) {
    // The name is anchored at both ends, because the Published mode pill also
    // starts with "Publish" and this waits for the write button beside it.
    await rendered.findByRole("button", { name: /^Publish( v\d+)?$/ });
    pressCommandK();
    const input = paletteInput();
    if (!input) {
      throw new Error("the palette did not open");
    }
    return input;
  }

  /** Take the "Add step" item, which is the way to the second page. */
  function chooseAddStep(rendered: ReturnType<typeof renderChrome>) {
    fireEvent.click(rendered.getByRole("option", { name: /^Add step/ }));
  }

  // An empty list is two different facts and the reader is owed the right one.
  // A host that passed no integrations gets an empty catalog and no error, so
  // this is the surface that has to say which of the two happened.
  it("tells an empty catalog apart from a query that matched nothing", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);
    fireEvent.change(paletteInput() ?? input, { target: { value: "zzqq" } });

    expect(rendered.getByText("Nothing matches that.")).toBeTruthy();

    rendered.unmount();

    const empty = renderChrome(ToolbarActions);
    await openedPalette(empty);

    chooseAddStep(empty);

    expect(empty.getByText("No step types are available yet.")).toBeTruthy();
  });

  it("hands focus back to the search box when Back is clicked", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    await openedPalette(rendered);
    chooseAddStep(rendered);

    const back = rendered.getByRole("button", { name: "Back to commands" });
    // A pointer press puts focus on the control before the click lands, which
    // is the state that made the swap drop focus out of the palette.
    back.focus();
    fireEvent.click(back);

    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, steps, or nodes"
    );
    expect(document.activeElement).toBe(paletteInput());
  });

  it("goes back a page on Escape, and closes on the next one", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);

    fireEvent.keyDown(paletteInput() ?? input, { key: "Escape" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, steps, or nodes"
    );

    fireEvent.keyDown(paletteInput() ?? input, { key: "Escape" });
    expect(paletteInput()).toBeNull();
  });

  it("goes back a page on Backspace once the box is empty", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);
    chooseAddStep(rendered);

    const onStepPage = paletteInput() ?? input;
    // A Backspace with something to delete stays on the page.
    fireEvent.change(onStepPage, { target: { value: "wa" } });
    fireEvent.keyDown(onStepPage, { key: "Backspace" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search step types"
    );

    fireEvent.change(paletteInput() ?? input, { target: { value: "" } });
    fireEvent.keyDown(paletteInput() ?? input, { key: "Backspace" });
    expect(paletteInput()?.getAttribute("placeholder")).toBe(
      "Search commands, steps, or nodes"
    );
  });

  /**
   * Disabled rows used to set pointer-events: none. Hover then missed the row
   * and looked like leaving the list, so autoHighlight="always" painted the
   * first item. happy-dom does not deliver the pointer path Base UI's list
   * navigation listens for, so the class is what this locks.
   */
  it("lets a disabled row receive the pointer instead of jumping the highlight to the first row", async () => {
    const rendered = renderChrome(ToolbarActions);
    await openedPalette(rendered);

    const undo = rendered.getByRole("option", { name: /^Undo/ });
    expect(undo.getAttribute("data-disabled")).not.toBeNull();
    expect(undo.className).not.toContain("pointer-events-none");
    expect(undo.className).toContain("not-data-disabled");
  });

  it("does not run a disabled command that is clicked", async () => {
    const undo = vi.fn();
    const rendered = renderChrome(ToolbarActions, { state: { undo } });
    await openedPalette(rendered);

    fireEvent.click(rendered.getByRole("option", { name: /^Undo/ }));

    expect(undo).not.toHaveBeenCalled();
    expect(paletteInput()).not.toBeNull();
  });

  it("still highlights an enabled row from the keyboard", async () => {
    const rendered = renderChrome(ToolbarActions);
    const input = await openedPalette(rendered);

    const addStep = rendered.getByRole("option", { name: /^Add step/ });
    const save = rendered.getByRole("option", { name: /^Save workflow/ });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(save.hasAttribute("data-highlighted")).toBe(true);
    expect(addStep.hasAttribute("data-highlighted")).toBe(false);
  });

  /**
   * A published workflow in Live Published mode, where the run of that version
   * is the one command that reaches real recipients.
   */
  function publishedInLiveMode() {
    return renderChrome(ToolbarActions, {
      state: {
        workflowMode: "live",
        publication: {
          isPublished: true,
          hasUnpublishedChanges: true,
          publishedVersionId: "version_5",
          publishedVersion: 5,
          publishedAt: "2026-08-23T15:00:00.000Z",
        },
      },
    });
  }

  /**
   * Return takes the highlighted row, so a row that reaches real recipients is
   * never highlighted automatically. Plain matches sort ahead of it, and the
   * automatic highlight lands on the first of those.
   */
  it("places the automatic highlight past a row that sends", async () => {
    const rendered = publishedInLiveMode();
    const input = await openedPalette(rendered);

    // Both run commands carry "trigger", and nothing else does.
    fireEvent.change(input, { target: { value: "trigger" } });

    const draft = rendered.getByRole("option", { name: /^Run draft/ });
    const live = rendered.getByRole("option", { name: /^Run v5 · Live/ });
    expect(draft.hasAttribute("data-highlighted")).toBe(true);
    expect(live.hasAttribute("data-highlighted")).toBe(false);
  });

  /**
   * With no plain match left to sort ahead of it, Base UI highlights row zero
   * anyway and offers no way to move that highlight. The row stays unarmed
   * instead: it shows no highlight styling, and Return does nothing until an
   * arrow key arms it.
   */
  it("leaves a row that sends unarmed until an arrow key arms it", async () => {
    const rendered = publishedInLiveMode();
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "published version" } });

    expect(rendered.getAllByRole("option")).toHaveLength(1);
    const live = rendered.getByRole("option", { name: /^Run v5 · Live/ });
    expect(live.className).not.toContain("data-highlighted:");

    // Return before the arrow key is the press this rule rejects.
    fireEvent.keyDown(paletteInput() ?? input, { key: "Enter" });
    expect(rendered.actions.handleExecute).not.toHaveBeenCalled();

    // Base UI moves the highlight off the single row and back onto it.
    fireEvent.keyDown(paletteInput() ?? input, { key: "ArrowDown" });
    fireEvent.keyDown(paletteInput() ?? input, { key: "ArrowDown" });

    const armed = rendered.getByRole("option", { name: /^Run v5 · Live/ });
    expect(armed.hasAttribute("data-highlighted")).toBe(true);
    expect(armed.className).toContain("data-highlighted:");

    fireEvent.click(armed);
    expect(rendered.actions.handleExecute).toHaveBeenCalledWith("published");
  });

  /**
   * The arming rule rejects Return on a row the keyboard has not armed. An
   * armed row must still respond to Return, which is what the palette's hint
   * tells the reader.
   */
  it("takes the armed row on Return", async () => {
    const rendered = publishedInLiveMode();
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "published version" } });
    fireEvent.keyDown(paletteInput() ?? input, { key: "ArrowDown" });
    fireEvent.keyDown(paletteInput() ?? input, { key: "Enter" });

    expect(rendered.actions.handleExecute).toHaveBeenCalledWith("published");
    expect(paletteInput()).toBeNull();
  });

  // The label names the version and the Published mode; the detail says who
  // that mode reaches.
  it("names the recipients each run command reaches", async () => {
    const rendered = publishedInLiveMode();
    await openedPalette(rendered);

    expect(
      rendered.getByRole("option", {
        name: /^Run draft — Test recipients/,
      })
    ).toBeTruthy();
    expect(
      rendered.getByRole("option", {
        name: "Run v5 · Live — Real recipients",
      })
    ).toBeTruthy();
  });

  // The page stack clears the query, and this is that reaching the box the
  // reader is looking at. The pointer is the path: choosing an item is also the
  // moment Base UI would offer the item's own text back as the next value.
  it("empties the box when a page is chosen with the pointer", async () => {
    const rendered = renderChrome(ToolbarActions, {
      catalog: ONE_ACTION_CATALOG,
    });
    const input = await openedPalette(rendered);

    fireEvent.change(input, { target: { value: "add" } });
    expect(paletteInput()?.value).toBe("add");

    chooseAddStep(rendered);

    expect(paletteInput()?.value).toBe("");
  });
});
