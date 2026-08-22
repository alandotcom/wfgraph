import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import {
  commandPaletteAtom,
  commandPaletteRefusalAtom,
  openCommandPaletteAtom,
} from "#src/lib/command-palette-store";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  isGeneratingAtom,
  propertiesPanelActiveTabAtom,
} from "#src/lib/workflow-ui-store";

/** A store with a workflow open and nothing holding the canvas. */
function editorStore(workflowId: string | null = "workflow_1") {
  const store = createStore();
  store.set(currentWorkflowIdAtom, workflowId);
  return store;
}

/**
 * The overlay is only on the canvas while the Runs tab is, so both halves of
 * that state go in together.
 */
function pinRunToCanvas(store: ReturnType<typeof editorStore>) {
  store.set(propertiesPanelActiveTabAtom, "runs");
  store.set(executionOverlayGraphAtom, { nodes: [], edges: [] });
}

describe("opening the command palette", () => {
  it("opens on the page it was asked for", () => {
    const store = editorStore();

    expect(
      store.set(openCommandPaletteAtom, {
        id: "add-step",
        at: { x: 5, y: 6 },
      })
    ).toBe(true);
    expect(store.get(commandPaletteAtom)?.pages).toEqual([
      { id: "add-step", at: { x: 5, y: 6 } },
    ]);
  });

  // The palette writes to a draft the overlay is hiding, so a step added under
  // it would appear only once the run was dismissed.
  it("refuses while a past run is pinned to the canvas, and says so", () => {
    const store = editorStore();
    pinRunToCanvas(store);

    expect(store.set(openCommandPaletteAtom, { id: "root" })).toBe(false);
    expect(store.get(commandPaletteAtom)).toBeNull();
    expect(store.get(commandPaletteRefusalAtom)).toMatch(/run on the canvas/);
  });

  // Generation used to fall between the two locks: it opened a palette in which
  // every single item was disabled, including the "Add step" the Actions menu
  // refuses outright in that state.
  it("refuses while generation is rewriting the graph, and says so", () => {
    const store = editorStore();
    store.set(isGeneratingAtom, true);

    expect(store.set(openCommandPaletteAtom, { id: "root" })).toBe(false);
    expect(store.get(commandPaletteAtom)).toBeNull();
    expect(store.get(commandPaletteRefusalAtom)).toMatch(/generating/);
  });

  it("has nothing to say when it will open", () => {
    expect(editorStore().get(commandPaletteRefusalAtom)).toBeNull();
  });

  // A page stack holds a canvas position, and a position pointed at in one
  // workflow means nothing on the next one's graph.
  it("belongs to the workflow it was opened over, not to the next one", () => {
    const store = editorStore("workflow_1");
    store.set(openCommandPaletteAtom, { id: "add-step", at: { x: 5, y: 6 } });

    store.set(currentWorkflowIdAtom, "workflow_2");

    expect(store.get(commandPaletteAtom)).toBeNull();
  });

  /**
   * Keying the held state to an id that is about to change would make a first
   * save look like a navigation somewhere else, and every canvas the editor can
   * draw has an id by then. So the palette waits for one rather than trying to
   * follow a draft through being created.
   */
  it("waits for a workflow that has been saved", () => {
    const store = editorStore(null);

    expect(store.set(openCommandPaletteAtom, { id: "root" })).toBe(false);
    expect(store.get(commandPaletteAtom)).toBeNull();
  });
});
