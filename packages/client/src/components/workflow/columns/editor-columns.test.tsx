import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { ColumnHeader, EditorColumns } from "./editor-columns";
import {
  clearSelectionAtom,
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
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
          <ColumnHeader side="outline">
            <span>Outline body</span>
          </ColumnHeader>
        }
        phone={<div data-testid="phone-sheets" />}
      />
    </JotaiProvider>
  );
  return store;
}

/** The outline column itself, docked or over the canvas, rather than its rail. */
function outlineColumn(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-slot="editor-column"][data-column="outline"]'
  );
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
    expect(screen.queryByText("Details body")).toBeNull();
    expect(store.get(columnPreferencesAtom).details.collapsed).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("Details body")).toBeTruthy();
  });

  it("toggles the outline with [ and details with ] outside text fields", () => {
    setViewportWidth(1512);
    renderColumns();

    pressKey("[");
    expect(screen.queryByText("Outline body")).toBeNull();
    pressKey("]");
    expect(screen.queryByText("Details body")).toBeNull();
    pressKey("[");
    pressKey("]");
    expect(screen.getByText("Outline body")).toBeTruthy();
    expect(screen.getByText("Details body")).toBeTruthy();

    const field = document.createElement("input");
    document.body.append(field);
    pressKey("[", field);
    expect(screen.getByText("Outline body")).toBeTruthy();
    field.remove();
  });

  it("opens the outline over the canvas at medium widths while details is docked", () => {
    setViewportWidth(1100);
    renderColumns();

    expect(screen.queryByText("Outline body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show outline" }));
    const overlay = outlineColumn();
    // The outline shows inside the canvas box, over the canvas.
    expect(overlay?.parentElement).toBe(
      screen.getByTestId("canvas").parentElement
    );
    fireEvent.keyDown(overlay as HTMLElement, { key: "Escape" });
    expect(screen.queryByText("Outline body")).toBeNull();

    // Collapsing details leaves room to dock the outline instead.
    fireEvent.click(screen.getByRole("button", { name: "Collapse details" }));
    expect(outlineColumn()?.parentElement?.getAttribute("data-slot")).toBe(
      "editor-columns"
    );
    expect(screen.getByText("Outline body")).toBeTruthy();
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

  it("keeps every column where it is when a step is selected and deselected", () => {
    setViewportWidth(1512);
    const store = renderColumns();
    const layout = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-slot="editor-columns"] > *'
        ),
      ].map((element) => `${element.dataset.slot}:${element.style.width}`);
    const before = layout();

    act(() => {
      store.set(selectOnlyNodeAtom, "send");
    });
    expect(layout()).toEqual(before);
    act(() => {
      store.set(clearSelectionAtom);
    });
    expect(layout()).toEqual(before);
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
});
