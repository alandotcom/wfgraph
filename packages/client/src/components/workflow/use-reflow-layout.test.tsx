import { act, renderHook } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  currentWorkflowIdAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { workflowGraphUpdateAtom } from "#src/lib/workflow-ui-store";
import { setViewportWidth } from "#src/lib/viewport-test-support";
import { useReflowLayout } from "./use-reflow-layout";

function step(id: string, x: number, y: number): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y },
    data: { label: id, type: "action" },
  };
}

beforeEach(() => {
  setViewportWidth(1440);
});

describe("useReflowLayout", () => {
  it("asks the canvas to place the camera after Tidy layout, as it places a workflow it opens", () => {
    const store = createStore();
    // Tidy layout saves the moved steps at once.
    store.set(workflowApiAtom, {
      update: vi.fn(async () => savedWorkflow("wf_1")),
    } as never);
    store.set(currentWorkflowIdAtom, "wf_1");
    store.set(loadWorkflowGraphAtom, {
      nodes: [step("a", 0, 0), step("b", 900, 900)],
      edges: [{ id: "a-b", source: "a", target: "b" }],
    });
    const before = store.get(workflowGraphUpdateAtom)?.revision ?? 0;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ExtensionCatalogProvider
        value={{ entities: [], events: [], integrations: [], actions: [] }}
      >
        <JotaiProvider store={store}>{children}</JotaiProvider>
      </ExtensionCatalogProvider>
    );
    const { result } = renderHook(() => useReflowLayout(), { wrapper });
    expect(result.current.canReflow).toBe(true);

    act(() => {
      result.current.reflow();
    });

    expect(store.get(workflowGraphUpdateAtom)).toEqual({
      workflowId: "wf_1",
      revision: before + 1,
    });
  });
});
