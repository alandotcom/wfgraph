import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Position, ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { ActionNode } from "#src/components/workflow/nodes/action-node";
import { nodesStateAtom, edgesStateAtom } from "#src/lib/workflow-graph-cells";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";

// Required NodeProps fields the card never reads.
const requiredNodeProps = {
  dragging: false,
  zIndex: 0,
  selectable: true,
  deletable: true,
  draggable: true,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  selected: false,
  type: "action",
} as const;

const catalog: ExtensionCatalog = {
  ...emptyExtensionCatalog,
  events: [
    { name: "app/signed-up", label: "Signed up", payloadFields: [] },
    { name: "app/churned", label: "Churned", payloadFields: [] },
  ],
};

const conditionData: WorkflowNodeData = {
  label: "Is VIP",
  type: "action",
  config: { actionType: BUILT_IN_ACTION_IDS.condition },
  status: "idle",
};

const splitData: WorkflowNodeData = {
  label: "By event",
  type: "action",
  config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
  status: "idle",
};

/** A graph where both catalog Events start the run and reach the split. */
function storeWithSplit() {
  const store = createStore();
  const nodes: WorkflowNode[] = [
    {
      id: "entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: ["app/signed-up", "app/churned"],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        },
      },
    },
    {
      id: "split",
      type: "action",
      position: { x: 0, y: 200 },
      data: splitData,
    },
  ];
  const edges: WorkflowEdge[] = [
    {
      id: "entry-split",
      source: "entry",
      sourceHandle: LIFECYCLE_STARTED_HANDLE,
      target: "split",
    },
  ];
  store.set(nodesStateAtom, nodes);
  store.set(edgesStateAtom, edges);
  return store;
}

function renderCard(input: {
  id: string;
  data: WorkflowNodeData;
  sides?: { sourcePosition: Position; targetPosition: Position };
  store?: ReturnType<typeof createStore>;
  /** The edges React Flow holds, which decide which outlets are connected. */
  edges?: WorkflowEdge[];
}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={input.store ?? createStore()}>
        <ExtensionCatalogProvider value={catalog}>
          <IntegrationUiProvider value={{}}>
            <ReactFlowProvider initialEdges={input.edges ?? []}>
              <ActionNode
                data={input.data}
                id={input.id}
                {...requiredNodeProps}
                {...input.sides}
              />
            </ReactFlowProvider>
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
      </Provider>
    </QueryClientProvider>
  );
}

const LEFT_TO_RIGHT = {
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
};

function element(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`missing ${selector}`);
  }
  return found;
}

function label(view: ReturnType<typeof render>, text: string): HTMLElement {
  return view.getByText(text, { selector: "div" });
}

describe("ActionNode outlets", () => {
  it("draws Condition outlets and labels along the bottom on the overview", () => {
    const view = renderCard({ id: "condition", data: conditionData });

    const trueHandle = element(view.container, '[aria-label="True outlet"]');
    expect(trueHandle.className).toContain("react-flow__handle-bottom");
    expect(trueHandle.style.left).toBe("38%");
    expect(
      element(view.container, '[aria-label="Input handle"]').className
    ).toContain("react-flow__handle-top");

    const trueLabel = label(view, "True");
    expect(trueLabel.className).toContain("-bottom-8");
    expect(trueLabel.style.left).toBe("38%");
    expect(label(view, "False").style.left).toBe("62%");
  });

  it("names only the unconnected branch on a Condition card", () => {
    const view = renderCard({
      id: "gate",
      data: conditionData,
      edges: [
        {
          id: "gate-route",
          source: "gate",
          target: "route",
          sourceHandle: "true",
        },
      ],
    });

    expect(
      [...view.container.querySelectorAll("[data-slot=outlet-label]")].map(
        (caption) => caption.textContent
      )
    ).toEqual(["False"]);
  });

  it("draws Condition outlets on the right in a Left to right Group, with each label beside its handle", () => {
    const view = renderCard({
      id: "condition",
      data: conditionData,
      sides: LEFT_TO_RIGHT,
    });

    const trueHandle = element(view.container, '[aria-label="True outlet"]');
    const falseHandle = element(view.container, '[aria-label="False outlet"]');
    expect(trueHandle.className).toContain("react-flow__handle-right");
    expect(trueHandle.style.top).toBe("38%");
    expect(falseHandle.style.top).toBe("62%");
    expect(
      element(view.container, '[aria-label="Input handle"]').className
    ).toContain("react-flow__handle-left");

    const trueLabel = label(view, "True");
    const falseLabel = label(view, "False");
    expect(trueLabel.className).toContain("left-full");
    expect(trueLabel.className).not.toContain("-bottom-8");
    expect(trueLabel.style.top).toBe("38%");
    expect(falseLabel.style.top).toBe("62%");
  });

  it("draws a plain step's handles on the sides it is given", () => {
    const view = renderCard({
      id: "step",
      data: {
        label: "Send",
        type: "action",
        config: { actionType: "demo/send" },
        status: "idle",
      },
      sides: LEFT_TO_RIGHT,
    });

    expect(
      element(view.container, '[aria-label="Output handle"]').className
    ).toContain("react-flow__handle-right");
    expect(
      element(view.container, '[aria-label="Input handle"]').className
    ).toContain("react-flow__handle-left");
  });

  it("spreads Event Split outlets and labels down the right side in a Left to right Group", () => {
    const view = renderCard({
      id: "split",
      data: splitData,
      sides: LEFT_TO_RIGHT,
      store: storeWithSplit(),
    });

    const first = element(view.container, '[aria-label="Signed up outlet"]');
    const second = element(view.container, '[aria-label="Churned outlet"]');
    expect(first.className).toContain("react-flow__handle-right");
    expect(first.style.top).toBe("25%");
    expect(second.style.top).toBe("75%");

    const firstLabel = label(view, "Signed up");
    expect(firstLabel.className).toContain("left-full");
    expect(firstLabel.style.top).toBe("25%");
    expect(label(view, "Churned").style.top).toBe("75%");
  });
});
