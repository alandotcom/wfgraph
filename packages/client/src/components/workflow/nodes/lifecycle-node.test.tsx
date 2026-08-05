import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  getStartSummary,
  LifecycleNode,
} from "#src/components/workflow/nodes/lifecycle-node";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@rova/shared/lifecycle/lifecycle-outlets";
import type { WorkflowNodeData } from "#src/lib/workflow-graph-types";

describe("getStartSummary", () => {
  // A workflow the panel has never touched is one the Run button starts, so the
  // canvas has to say so rather than contradict the button beside it.
  it("says manual runs for a node carrying no rules at all", () => {
    expect(getStartSummary(undefined)).toBe("Manual runs only");
    expect(getStartSummary({})).toBe("Manual runs only");
  });

  it("names the Start Event when there is one", () => {
    expect(
      getStartSummary({
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: "unlimited",
        },
      })
    ).toBe("On app/appointment.created");
  });

  // Rules that exist and leave every start source out are a decision, and the
  // canvas is where a builder finds out they made it.
  it("says nothing starts a workflow whose rules allow nothing", () => {
    expect(
      getStartSummary({
        lifecycleRules: {
          startEvents: [],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: false,
        },
      })
    ).toBe("Nothing starts this yet");
  });
});

describe("LifecycleNode handles", () => {
  // Required NodeProps fields the component itself never reads: the node face
  // destructures only `data` and `selected`.
  const requiredNodeProps = {
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as const;

  function renderLifecycleNode(data: WorkflowNodeData) {
    return render(
      <ReactFlowProvider>
        <LifecycleNode
          data={data}
          id="entry"
          selected={false}
          type="lifecycle"
          {...requiredNodeProps}
        />
      </ReactFlowProvider>
    );
  }

  it("renders a source handle for both the Started and Canceled outlets", () => {
    const view = renderLifecycleNode({
      label: "",
      description: "",
      type: "lifecycle",
      config: {},
      status: "idle",
    });

    expect(
      view.container.querySelector(
        `[data-handleid="${LIFECYCLE_STARTED_HANDLE}"]`
      )
    ).toBeTruthy();
    expect(
      view.container.querySelector(
        `[data-handleid="${LIFECYCLE_CANCELED_HANDLE}"]`
      )
    ).toBeTruthy();
    expect(view.getByText("Started")).toBeTruthy();
    expect(view.getByText("Canceled")).toBeTruthy();
  });

  it("softens the Canceled chip when no Cancel Event is declared", () => {
    const view = renderLifecycleNode({
      label: "",
      description: "",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: "unlimited",
        },
      },
      status: "idle",
    });

    expect(view.getByText("Canceled").className).toContain("opacity-50");
  });

  it("keeps the Canceled chip full strength when a Cancel Event is declared", () => {
    const view = renderLifecycleNode({
      label: "",
      description: "",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents: ["app/appointment.canceled"],
          concurrency: "unlimited",
        },
      },
      status: "idle",
    });

    expect(view.getByText("Canceled").className).not.toContain("opacity-50");
  });
});
