import { act, render } from "@testing-library/react";
import {
  ReactFlowProvider,
  type ReactFlowState,
  useStoreApi,
} from "@xyflow/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  activeWorkspaceAddressAtom,
  closeMobileSheetAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  expectSteadyCamera,
  recordCameraMotion,
} from "#src/components/workflow/camera-motion-test-support";
import { mobileRevealAtom } from "./canvas-reveal-state";
import { useMobileSheetCamera } from "./use-mobile-sheet-camera";

const CANVAS = { width: 390, height: 800 };
/** Where the summary sheet's top edge sits inside the canvas. */
const SHEET_TOP = 420;

function step(id: string, x: number, y: number): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y },
    width: 200,
    height: 80,
    data: { label: id, type: "action", config: { actionType: "mailer/send" } },
  };
}

type Viewport = { x: number; y: number; zoom: number };

/**
 * The hook inside a real React Flow store, with a sheet element whose top edge
 * sits at `SHEET_TOP`. `panZoom` is a stub that applies each viewport at once.
 */
function renderSheetCamera() {
  const nodes = [step("high", 100, 100), step("low", 100, 600)];
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
  showWorkspaceRoute(store, {});

  let flow: {
    getState: () => ReactFlowState;
    setState: (state: Partial<ReactFlowState>) => void;
  } | null = null;

  function Harness() {
    flow = useStoreApi();
    const sheet = useRef<HTMLDivElement>(null);
    const state = useAtomValue(mobileRevealAtom);
    useMobileSheetCamera({ state, sheet });
    return (
      <div>
        <div
          ref={(element) => {
            sheet.current = element;
            if (element) {
              element.getBoundingClientRect = () =>
                new DOMRect(0, SHEET_TOP, CANVAS.width, 380);
            }
          }}
        />
      </div>
    );
  }

  render(
    <JotaiProvider store={store}>
      <ReactFlowProvider
        initialEdges={[]}
        initialHeight={CANVAS.height}
        initialNodes={nodes}
        initialWidth={CANVAS.width}
      >
        <Harness />
      </ReactFlowProvider>
    </JotaiProvider>
  );

  const flowState = () => {
    if (!flow) {
      throw new Error("the React Flow store did not mount");
    }
    return flow;
  };
  flowState().setState({
    panZoom: {
      setViewport: vi.fn(async (viewport: Viewport) => {
        flowState().setState({
          transform: [viewport.x, viewport.y, viewport.zoom],
        });
        return { k: viewport.zoom, x: viewport.x, y: viewport.y };
      }),
    } as unknown as ReactFlowState["panZoom"],
  });
  const motion = recordCameraMotion(flowState());

  const run = async (write: () => void) => {
    await act(async () => {
      write();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  return { store, motion, run };
}

describe("useMobileSheetCamera", () => {
  it("places a step the summary sheet covers in one straight move, and Back leaves the camera", async () => {
    const camera = renderSheetCamera();
    await camera.run(() => undefined);

    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "low"));
    expect(camera.motion.moves).toHaveLength(1);
    expectSteadyCamera(camera.motion.moves, { x: 0, y: 0, zoom: 1 });

    camera.motion.moves.length = 0;
    await camera.run(() =>
      camera.store.set(
        closeMobileSheetAtom,
        camera.store.get(activeWorkspaceAddressAtom)
      )
    );
    expect(camera.motion.moves).toEqual([]);
  });

  it("leaves a step above the sheet where it is", async () => {
    const camera = renderSheetCamera();
    await camera.run(() => undefined);

    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "high"));
    expect(camera.motion.moves).toEqual([]);
  });
});
