import { act, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { EditorLayout } from "./editor-layout";
import { EditorShell } from "./editor-shell";

function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

/**
 * The Tailwind classes that make an element a scroll container. A focus move
 * or `scrollIntoView` scrolls every scroll container above its target, so
 * none of these may sit between an Inspector field's own scrolling body and the
 * page. `overflow-clip` clips without making a scroll container.
 */
const SCROLL_CONTAINER_CLASS =
  /(^|\s|:)overflow(-[xy])?-(auto|scroll|hidden)(\s|$)/u;

/** Every element above `element`, nearest first, up to `<html>`. */
function ancestorsOf(element: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (
    let parent = element.parentElement;
    parent !== null;
    parent = parent.parentElement
  ) {
    found.push(parent);
  }
  return found;
}

function renderEditor() {
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
      <EditorShell>
        <EditorLayout
          canvas={<div data-testid="canvas" />}
          details={
            // The Inspector's body is the one place a field may scroll.
            <div className="overflow-y-auto" data-testid="details-body">
              <input aria-label="Appointment ID" />
            </div>
          }
          outline={<div />}
        />
      </EditorShell>
    </JotaiProvider>
  );
  act(() => store.set(selectOnlyNodeAtom, "send"));
}

/**
 * Focusing a field scrolls the nearest scroll container that holds it, and
 * every one above that. The Inspector body is meant to scroll; anything above
 * it scrolling is the editor shifting under the pointer, as it would when a
 * newly added step's first field takes focus.
 */
function expectOnlyTheInspectorBodyScrolls(): void {
  const body = screen.getByTestId("details-body");
  const scrolling = ancestorsOf(body).filter((element) =>
    SCROLL_CONTAINER_CLASS.test(element.className)
  );
  expect(
    scrolling.map((element) => element.dataset.slot ?? element.tagName)
  ).toEqual([]);
  // `html` and `body` are `overflow: hidden` in the global styles, so a
  // scroll can still reach the document. The page is fixed to the viewport,
  // where the document's scroll position cannot move it.
  const page = document.querySelector<HTMLElement>('[data-slot="editor-page"]');
  expect(page?.className.split(" ")).toContain("fixed");
  expect(ancestorsOf(body)).toContain(page);
}

describe("EditorShell", () => {
  afterEach(() => {
    setViewportWidth(1024);
  });

  it("lets nothing above the Inspector's body scroll when a field in it takes focus", () => {
    setViewportWidth(1440);
    renderEditor();
    expect(
      document
        .querySelector('[data-slot="inspector-card"]')
        ?.contains(screen.getByTestId("details-body"))
    ).toBe(true);
    expectOnlyTheInspectorBodyScrolls();
  });
});
