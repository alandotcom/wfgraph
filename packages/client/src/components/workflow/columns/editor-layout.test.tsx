import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSelectionAtom,
  endWorkflowEditorLifetimeAtom,
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  openInspectorAtom,
} from "#src/lib/workflow-workspace-navigation";
import { revealPlacementRequestAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import {
  dismissInspectorAtom,
  inspectorCoveredWidthAtom,
  inspectorOpenAtom,
} from "#src/components/workflow/canvas-reveal/canvas-reveal-state";
import { EditorLayout } from "./editor-layout";
import {
  outlineFilterFocusRequestAtom,
  outlineHiddenAtom,
  phoneShowsMapAtom,
} from "./editor-columns-store";
import { useOutlineControls } from "./use-outline-controls";

/**
 * The viewport itself, because the layout is read through media queries that
 * happy-dom answers from its own viewport.
 */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

function renderLayout() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(loadWorkflowGraphAtom, {
    nodes: [
      {
        id: "send",
        type: "action",
        position: { x: 0, y: 0 },
        data: { label: "Send", type: "action", config: {} },
      },
      {
        id: "wait",
        type: "action",
        position: { x: 0, y: 200 },
        data: { label: "Wait", type: "action", config: {} },
      },
    ],
    edges: [],
  });
  showWorkspaceRoute(store, {});
  render(
    <JotaiProvider store={store}>
      <EditorLayout
        canvas={<div data-testid="canvas" />}
        composer={<div data-testid="composer" />}
        details={<span>Details body</span>}
        outline={
          <>
            <span>Outline body</span>
            <input aria-label="Filter steps" type="search" />
          </>
        }
        phone={<div data-testid="phone-sheets" />}
      />
    </JotaiProvider>
  );
  return store;
}

function inspector(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="inspector-card"]');
}

function floatingOutline(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="floating-outline"]');
}

/** Whether the floating outline is on screen; hidden, it stays mounted. */
function outlineShown(): boolean {
  const outline = floatingOutline();
  return outline !== null && !outline.hidden && !outline.inert;
}

function canvasBox(): HTMLElement {
  const box = document.querySelector<HTMLElement>('[data-slot="canvas-box"]');
  if (box === null) {
    throw new Error("the canvas box did not render");
  }
  return box;
}

function pressKey(key: string, target: Element = document.body) {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
}

describe("EditorLayout", () => {
  afterEach(() => {
    setViewportWidth(1024);
  });

  it("fills the editor with the canvas and floats the outline and the Inspector over it", () => {
    setViewportWidth(1440);
    renderLayout();

    const box = canvasBox();
    // Nothing docks beside the canvas: the box is the layout's only column.
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-slot="editor-layout"] > *'
        ),
      ].map((element) => element.dataset.slot)
    ).toEqual(["canvas-box"]);
    expect(box.contains(screen.getByTestId("canvas"))).toBe(true);
    expect(box.contains(floatingOutline())).toBe(true);
    expect(box.contains(inspector())).toBe(true);
    // The outline comes first in Tab order.
    expect(
      floatingOutline()?.compareDocumentPosition(screen.getByTestId("canvas"))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("opens the Inspector while a step is selected and closes it when the selection clears", () => {
    setViewportWidth(1280);
    const store = renderLayout();
    expect(inspector()?.dataset.open).toBe("false");
    expect(inspector()?.hasAttribute("inert")).toBe(true);
    expect(store.get(inspectorCoveredWidthAtom)).toBe(0);

    act(() => store.set(selectOnlyNodeAtom, "send"));

    expect(inspector()?.dataset.open).toBe("true");
    expect(inspector()?.hasAttribute("inert")).toBe(false);
    // The camera keeps the selected step clear of the card.
    expect(store.get(revealPlacementRequestAtom)?.nodeIds).toEqual(["send"]);

    act(() => store.set(clearSelectionAtom));
    expect(inspector()?.dataset.open).toBe("false");
  });

  it("keeps the agent's box clear of the open card", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    const composerRight = () =>
      Number.parseFloat(
        document.querySelector<HTMLElement>('[data-slot="agent-composer-box"]')
          ?.style.right ?? ""
      );
    const closedRight = composerRight();

    act(() => store.set(selectOnlyNodeAtom, "send"));

    // The card covers at least its own width, and the box ends past all of it.
    const covered = store.get(inspectorCoveredWidthAtom);
    expect(covered).toBeGreaterThanOrEqual(
      Number.parseFloat(inspector()?.style.width ?? "")
    );
    expect(composerRight()).toBeGreaterThan(covered);
    act(() => store.set(clearSelectionAtom));
    expect(composerRight()).toBe(closedRight);
  });

  it("closes the Inspector while several steps are selected", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    act(() => store.set(selectOnlyNodeAtom, "send"));
    expect(inspector()?.dataset.open).toBe("true");

    act(() =>
      store.set(activeSelectionAtom, {
        nodeIds: ["send", "wait"],
        edgeIds: [],
      })
    );
    expect(inspector()?.dataset.open).toBe("false");
  });

  it("closes the Inspector without clearing the selection until a press or the next subject opens it", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    act(() => store.set(selectOnlyNodeAtom, "send"));
    expect(inspector()?.dataset.open).toBe("true");

    act(() => store.set(dismissInspectorAtom));
    expect(inspector()?.dataset.open).toBe("false");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["send"]);

    // A press on the same step opens the card again and places the step.
    const before = store.get(revealPlacementRequestAtom)?.sequence ?? 0;
    act(() =>
      store.set(openInspectorAtom, store.get(activeWorkspaceAddressAtom))
    );
    expect(inspector()?.dataset.open).toBe("true");
    expect(store.get(revealPlacementRequestAtom)?.sequence).toBe(before + 1);

    // Another subject opens it whatever the card was.
    act(() => store.set(dismissInspectorAtom));
    act(() => store.set(selectOnlyNodeAtom, "wait"));
    expect(inspector()?.dataset.open).toBe("true");

    // The same subject selected again after a change opens it too.
    act(() => store.set(dismissInspectorAtom));
    act(() => store.set(clearSelectionAtom));
    act(() => store.set(selectOnlyNodeAtom, "wait"));
    expect(inspector()?.dataset.open).toBe("true");
  });

  it("opens the card and places its step when a phone widens with a step selected", () => {
    setViewportWidth(500);
    const store = renderLayout();
    act(() => store.set(selectOnlyNodeAtom, "send"));
    expect(inspector()).toBeNull();
    const before = store.get(revealPlacementRequestAtom)?.sequence ?? 0;

    act(() => setViewportWidth(1280));

    expect(inspector()?.dataset.open).toBe("true");
    expect(store.get(inspectorOpenAtom)).toBe(true);
    expect(store.get(revealPlacementRequestAtom)).toMatchObject({
      nodeIds: ["send"],
      sequence: before + 1,
    });
  });

  it("hides and shows the outline with [ outside text fields", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    expect(outlineShown()).toBe(true);

    pressKey("[");
    expect(outlineShown()).toBe(false);
    expect(store.get(outlineHiddenAtom)).toBe(true);
    pressKey("]");
    expect(outlineShown()).toBe(false);
    pressKey("[");
    expect(outlineShown()).toBe(true);

    // A text field keeps its keys.
    const field = screen.getByRole("searchbox", { name: "Filter steps" });
    pressKey("[", field);
    expect(outlineShown()).toBe(true);
  });

  it("keeps the hidden outline mounted, out of sight and inert", () => {
    setViewportWidth(1440);
    renderLayout();
    const field = screen.getByRole("searchbox", { name: "Filter steps" });
    fireEvent.change(field, { target: { value: "Send" } });

    pressKey("[");

    expect(floatingOutline()?.hidden).toBe(true);
    expect(floatingOutline()?.inert).toBe(true);
    // The same field, with its text, is still there to come back to.
    expect(floatingOutline()?.contains(field)).toBe(true);
    pressKey("[");
    expect(
      screen.getByRole<HTMLInputElement>("searchbox", { name: "Filter steps" })
        .value
    ).toBe("Send");
  });

  it("shows the outline in another workflow after [ hid it in one", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    pressKey("[");
    expect(outlineShown()).toBe(false);

    act(() => store.set(currentWorkflowIdAtom, "wf_2"));
    expect(outlineShown()).toBe(true);
    // Back in the first workflow it is as it was left.
    act(() => store.set(currentWorkflowIdAtom, "wf_1"));
    expect(outlineShown()).toBe(false);
  });

  it("shows the outline in Runs after [ hid it in Draft", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    pressKey("[");

    act(() =>
      showWorkspaceRoute(store, { view: "runs", executionId: "run_1" })
    );

    expect(store.get(outlineHiddenAtom)).toBe(false);
    expect(outlineShown()).toBe(true);
  });

  it("shows the outline again once the editor leaves the page", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    pressKey("[");

    act(() => store.set(endWorkflowEditorLifetimeAtom));

    expect(store.get(outlineHiddenAtom)).toBe(false);
  });

  it("always shows the run list and opens no Inspector for it", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    act(() => store.set(outlineHiddenAtom, true));
    expect(outlineShown()).toBe(false);

    act(() => showWorkspaceRoute(store, { view: "runs" }));

    expect(outlineShown()).toBe(true);
    pressKey("[");
    expect(outlineShown()).toBe(true);
    expect(inspector()?.dataset.open).toBe("false");
  });

  it("shows the outline as a phone's main view, and the canvas once Map is pressed", () => {
    setViewportWidth(500);
    const store = renderLayout();

    expect(screen.getByText("Outline body")).toBeTruthy();
    expect(screen.queryByText("Details body")).toBeNull();
    expect(screen.getByTestId("phone-sheets")).toBeTruthy();
    expect(screen.getByTestId("canvas").closest("[inert]")).not.toBeNull();

    act(() => {
      store.set(phoneShowsMapAtom, true);
    });
    expect(screen.queryByText("Outline body")).toBeNull();
    expect(screen.getByTestId("canvas").closest("[inert]")).toBeNull();
    expect(screen.getByTestId("phone-sheets")).toBeTruthy();
  });

  it("puts a phone's prompt line below the outline and the map, never over them", () => {
    setViewportWidth(500);
    const store = renderLayout();
    const box = canvasBox();
    const composer = screen.getByTestId("composer");

    // The line follows the main view rather than sitting inside it, so the
    // outline's scroll and the map end above it.
    expect(box.contains(composer)).toBe(false);
    expect(
      box.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    act(() => {
      store.set(phoneShowsMapAtom, true);
    });
    expect(box.contains(screen.getByTestId("composer"))).toBe(false);
  });

  describe("Find a step", () => {
    const pressFind = () => {
      act(() => {
        fireEvent.keyDown(document.body, { key: "f", metaKey: true });
      });
    };

    it("shows a hidden outline on Cmd+F and asks it for its filter", () => {
      setViewportWidth(1440);
      const store = renderLayout();
      pressKey("[");
      expect(outlineShown()).toBe(false);

      pressFind();

      expect(outlineShown()).toBe(true);
      expect(store.get(outlineHiddenAtom)).toBe(false);
      expect(store.get(outlineFilterFocusRequestAtom)).toBe(true);
    });

    it("leaves a phone's map for the outline", () => {
      setViewportWidth(500);
      const store = renderLayout();
      act(() => {
        store.set(phoneShowsMapAtom, true);
      });

      pressFind();

      expect(store.get(phoneShowsMapAtom)).toBe(false);
      expect(store.get(outlineFilterFocusRequestAtom)).toBe(true);
    });

    it("leaves no request waiting while the run list is the outline", () => {
      setViewportWidth(1440);
      const store = renderLayout();
      act(() => showWorkspaceRoute(store, { view: "runs" }));
      let controls: ReturnType<typeof useOutlineControls> | null = null;
      function Probe() {
        controls = useOutlineControls();
        return null;
      }
      render(
        <JotaiProvider store={store}>
          <Probe />
        </JotaiProvider>
      );

      act(() => controls?.findStep());

      expect(store.get(outlineFilterFocusRequestAtom)).toBe(false);
    });

    it("leaves Cmd+F to the browser on the run list", () => {
      setViewportWidth(1440);
      const store = renderLayout();
      act(() => showWorkspaceRoute(store, { view: "runs" }));
      const event = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });

      act(() => {
        document.body.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(false);
      expect(store.get(outlineFilterFocusRequestAtom)).toBe(false);
    });
  });
});
