import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { ColumnHeader, EditorColumns } from "./editor-columns";
import {
  clearSelectionAtom,
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { revealPlacementRequestAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import {
  columnPreferencesAtom,
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

function renderColumns() {
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
    ],
    edges: [],
  });
  render(
    <JotaiProvider store={store}>
      <EditorColumns
        canvas={<div data-testid="canvas" />}
        details={
          <ColumnHeader side="details">
            <span>Details body</span>
          </ColumnHeader>
        }
        outline={
          <>
            <ColumnHeader side="outline">
              <span>Outline body</span>
            </ColumnHeader>
            <input aria-label="Filter steps" type="search" />
          </>
        }
        composer={<div data-testid="composer" />}
        phone={<div data-testid="phone-sheets" />}
      />
    </JotaiProvider>
  );
  return store;
}

/** A docked column, or null while it is a rail. */
function dockedColumn(side: "outline" | "details"): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-slot="editor-column"][data-column="${side}"]`
  );
}

/** Details floating over the canvas, or null while details is docked. */
function floatingDetails(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="details-float"]');
}

/** Each element of the row under the toolbar, with its width. */
function columnRow(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="editor-columns"] > *'
    ),
  ].map((element) => `${element.dataset.slot}:${element.style.width}`);
}

function pressKey(key: string, target: Element = document.body) {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
}

describe("EditorColumns", () => {
  afterEach(() => {
    setViewportWidth(1024);
  });

  it("docks the outline, the canvas and details in that order at wide widths", () => {
    setViewportWidth(1512);
    renderColumns();

    const outline = screen.getByRole("region", { name: "Outline" });
    const details = screen.getByRole("region", { name: "Details" });
    expect(outline.style.width).toBe("340px");
    expect(details.style.width).toBe("400px");
    const canvas = screen.getByTestId("canvas");
    expect(
      outline.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      canvas.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("collapses each column to a rail and brings it back", () => {
    setViewportWidth(1512);
    const store = renderColumns();

    fireEvent.click(screen.getByRole("button", { name: "Collapse details" }));
    expect(dockedColumn("details")).toBeNull();
    expect(floatingDetails()?.dataset.open).toBe("false");
    expect(store.get(columnPreferencesAtom).details.collapsed).toBe(true);

    const rail = document.querySelector<HTMLElement>(
      '[data-slot="column-rail"][data-column="details"]'
    );
    fireEvent.click(
      within(rail as HTMLElement).getByRole("button", { name: "Show details" })
    );
    expect(dockedColumn("details")).not.toBeNull();
    expect(floatingDetails()).toBeNull();
  });

  it("toggles the outline with [ and details with ] outside text fields", () => {
    setViewportWidth(1512);
    renderColumns();

    pressKey("[");
    expect(dockedColumn("outline")).toBeNull();
    pressKey("]");
    expect(dockedColumn("details")).toBeNull();
    pressKey("[");
    pressKey("]");
    expect(dockedColumn("outline")).not.toBeNull();
    expect(dockedColumn("details")).not.toBeNull();

    const field = document.createElement("input");
    document.body.append(field);
    pressKey("[", field);
    expect(dockedColumn("outline")).not.toBeNull();
    field.remove();
  });

  it("docks the outline at medium widths and floats details in on a selection", () => {
    setViewportWidth(1280);
    const store = renderColumns();
    expect(dockedColumn("outline")).not.toBeNull();
    expect(dockedColumn("details")).toBeNull();
    expect(floatingDetails()?.dataset.open).toBe("false");
    expect(floatingDetails()?.hasAttribute("inert")).toBe(true);
    const row = columnRow();

    act(() => {
      store.set(selectOnlyNodeAtom, "send");
    });
    // Details floats over the canvas box, which keeps its size, and the
    // camera is asked to show the step beside it.
    expect(floatingDetails()?.dataset.open).toBe("true");
    expect(floatingDetails()?.dataset.coversWidth).toBe("408");
    expect(floatingDetails()?.parentElement?.dataset.slot).toBe("canvas-box");
    expect(columnRow()).toEqual(row);
    expect(store.get(revealPlacementRequestAtom)?.nodeIds).toEqual(["send"]);

    act(() => {
      store.set(clearSelectionAtom);
    });
    expect(floatingDetails()?.dataset.open).toBe("false");
    expect(columnRow()).toEqual(row);
  });

  it("closes floating details from its control and ] and reopens it with ]", () => {
    setViewportWidth(1280);
    const store = renderColumns();
    act(() => {
      store.set(selectOnlyNodeAtom, "send");
    });

    fireEvent.click(
      within(floatingDetails() as HTMLElement).getByRole("button", {
        name: "Close details",
      })
    );
    expect(floatingDetails()?.dataset.open).toBe("false");
    pressKey("]");
    expect(floatingDetails()?.dataset.open).toBe("true");
    pressKey("]");
    expect(floatingDetails()?.dataset.open).toBe("false");

    // With nothing selected, ] still opens the workflow's own details.
    act(() => {
      store.set(clearSelectionAtom);
    });
    pressKey("]");
    expect(floatingDetails()?.dataset.open).toBe("true");
  });

  it("floats details on a selection at wide widths once the person collapsed it", () => {
    setViewportWidth(1512);
    const store = renderColumns();
    pressKey("]");
    act(() => {
      store.set(selectOnlyNodeAtom, "send");
    });
    expect(floatingDetails()?.dataset.open).toBe("true");

    pressKey("]");
    expect(dockedColumn("details")).not.toBeNull();
    expect(floatingDetails()).toBeNull();
  });

  it("keeps every docked column and the canvas box as they are on a selection", () => {
    setViewportWidth(1512);
    const store = renderColumns();
    const row = columnRow();

    act(() => {
      store.set(selectOnlyNodeAtom, "send");
    });
    expect(columnRow()).toEqual(row);
    expect(floatingDetails()).toBeNull();
    // Docked details covers nothing, so the selection asks for no placement.
    expect(store.get(revealPlacementRequestAtom)).toBeNull();
    act(() => {
      store.set(clearSelectionAtom);
    });
    expect(columnRow()).toEqual(row);
  });

  it("resizes a column with the arrow keys inside its range", () => {
    setViewportWidth(1512);
    renderColumns();

    const handle = screen.getByRole("separator", { name: "Resize details" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(screen.getByRole("region", { name: "Details" }).style.width).toBe(
      "416px"
    );
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("560");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
  });

  it("shows the outline as a phone's main view, and the canvas once Map is pressed", () => {
    setViewportWidth(500);
    const store = renderColumns();

    expect(screen.getByText("Outline body")).toBeTruthy();
    expect(screen.queryByText("Details body")).toBeNull();
    expect(screen.getByTestId("phone-sheets")).toBeTruthy();
    // No column collapses on a phone, and the canvas under the outline takes
    // no focus.
    expect(screen.queryByRole("button", { name: /outline/i })).toBeNull();
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
    const store = renderColumns();
    const box = document.querySelector('[data-slot="canvas-box"]');
    if (box === null) {
      throw new Error("the phone's main view did not render");
    }
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
    const filterField = () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Filter steps"]'
      );
    const pressFind = () => {
      act(() => {
        fireEvent.keyDown(document.body, { key: "f", metaKey: true });
      });
    };

    it("docks a collapsed outline on Cmd+F and puts the cursor in its filter", () => {
      setViewportWidth(1512);
      const store = renderColumns();
      pressKey("[");
      expect(dockedColumn("outline")).toBeNull();

      pressFind();

      expect(dockedColumn("outline")).not.toBeNull();
      expect(store.get(columnPreferencesAtom).outline.collapsed).toBe(false);
      expect(document.activeElement).toBe(filterField());
    });

    it("docks a collapsed outline at medium widths and focuses its filter", () => {
      setViewportWidth(1024);
      renderColumns();
      pressKey("[");
      expect(dockedColumn("outline")).toBeNull();

      pressFind();

      expect(dockedColumn("outline")).not.toBeNull();
      expect(document.activeElement).toBe(filterField());
    });

    it("leaves a phone's map for the outline", () => {
      setViewportWidth(500);
      const store = renderColumns();
      act(() => {
        store.set(phoneShowsMapAtom, true);
      });

      pressFind();

      expect(store.get(phoneShowsMapAtom)).toBe(false);
      expect(document.activeElement).toBe(filterField());
    });

    it("leaves Cmd+F to the outline while it is on screen", () => {
      setViewportWidth(1512);
      renderColumns();
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
