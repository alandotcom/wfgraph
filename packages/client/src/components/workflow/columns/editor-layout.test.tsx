import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSelectionAtom,
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { revealPlacementRequestAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import { EditorLayout } from "./editor-layout";
import {
  detailsFloatOpenAtom,
  outlineFilterFocusRequestAtom,
  outlineHiddenAtom,
  phoneShowsMapAtom,
} from "./editor-columns-store";

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
  return document.querySelector<HTMLElement>('[data-slot="details-float"]');
}

function floatingOutline(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="floating-outline"]');
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
    const composerBox = document.querySelector<HTMLElement>(
      '[data-slot="agent-composer-box"]'
    );
    expect(composerBox?.style.right).toBe("12px");

    act(() => store.set(selectOnlyNodeAtom, "send"));

    expect(inspector()?.dataset.open).toBe("true");
    expect(inspector()?.hasAttribute("inert")).toBe(false);
    expect(inspector()?.style.width).toBe("340px");
    expect(inspector()?.dataset.coversWidth).toBe("348");
    // The camera keeps the selected step clear of the card.
    expect(store.get(revealPlacementRequestAtom)?.nodeIds).toEqual(["send"]);
    // The composer's right edge clears the open card.
    expect(composerBox?.style.right).toBe("360px");

    act(() => store.set(clearSelectionAtom));
    expect(inspector()?.dataset.open).toBe("false");
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

  it("closes the Inspector without clearing the selection, and opens it for the next subject", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    act(() => store.set(selectOnlyNodeAtom, "send"));
    expect(inspector()?.dataset.open).toBe("true");

    act(() => store.set(detailsFloatOpenAtom, false));
    expect(inspector()?.dataset.open).toBe("false");

    act(() => store.set(clearSelectionAtom));
    act(() => store.set(selectOnlyNodeAtom, "send"));
    expect(inspector()?.dataset.open).toBe("true");
  });

  it("hides and shows the outline with [ outside text fields", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    expect(floatingOutline()).not.toBeNull();

    pressKey("[");
    expect(floatingOutline()).toBeNull();
    expect(store.get(outlineHiddenAtom)).toBe(true);
    pressKey("]");
    expect(floatingOutline()).toBeNull();
    pressKey("[");
    expect(floatingOutline()).not.toBeNull();

    // A text field keeps its keys.
    const field = screen.getByRole("searchbox", { name: "Filter steps" });
    pressKey("[", field);
    expect(floatingOutline()).not.toBeNull();
  });

  it("always shows the run list and opens no Inspector for it", () => {
    setViewportWidth(1440);
    const store = renderLayout();
    act(() => store.set(outlineHiddenAtom, true));
    expect(floatingOutline()).toBeNull();

    act(() => showWorkspaceRoute(store, { view: "runs" }));

    expect(floatingOutline()).not.toBeNull();
    pressKey("[");
    expect(floatingOutline()).not.toBeNull();
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
      expect(floatingOutline()).toBeNull();

      pressFind();

      expect(floatingOutline()).not.toBeNull();
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

    it("leaves Cmd+F to the outline while it is on screen", () => {
      setViewportWidth(1440);
      renderLayout();
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
    });
  });
});
