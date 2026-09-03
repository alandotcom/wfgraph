import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { LifecycleNode } from "#src/components/workflow/nodes/lifecycle-node";
import { getStartSummary } from "#src/components/workflow/nodes/lifecycle-node-summary";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import {
  COMPARISON_NODE_ANNOTATION,
  type WorkflowNodeData,
} from "#src/lib/workflow-graph-types";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";

const labeledCatalog: ExtensionCatalog = {
  ...emptyExtensionCatalog,
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      payloadFields: [],
    },
    {
      name: "resend/email.sent",
      label: "Email sent",
      payloadFields: [],
    },
    {
      name: "resend/email.delivered",
      label: "Email delivered",
      payloadFields: [],
    },
  ],
};

describe("getStartSummary", () => {
  // A workflow the panel has never touched is one the Run button starts, so the
  // canvas has to say so rather than contradict the button beside it.
  it("says manual runs for a node carrying no rules at all", () => {
    expect(getStartSummary(undefined, emptyExtensionCatalog)).toBe(
      "Manual runs only"
    );
    expect(getStartSummary({}, emptyExtensionCatalog)).toBe("Manual runs only");
  });

  it("names the Start Event by its catalog label", () => {
    expect(
      getStartSummary(
        {
          lifecycleRules: {
            startEvents: ["resend/email.sent", "resend/email.delivered"],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        },
        labeledCatalog
      )
    ).toBe("On Email sent, Email delivered");
  });

  it("falls back to the event name when the catalog has no label", () => {
    expect(
      getStartSummary(
        {
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        },
        emptyExtensionCatalog
      )
    ).toBe("On app/appointment.created");
  });

  // Rules that exist and leave every start source out are a decision, and the
  // canvas is where a builder finds out they made it.
  it("says nothing starts a workflow whose rules allow nothing", () => {
    expect(
      getStartSummary(
        {
          lifecycleRules: {
            startEvents: [],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
          },
        },
        emptyExtensionCatalog
      )
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

  function renderLifecycleNode(
    data: WorkflowNodeData,
    selected = false,
    catalog: ExtensionCatalog = emptyExtensionCatalog
  ) {
    return render(
      <ExtensionCatalogProvider value={catalog}>
        <ReactFlowProvider>
          <LifecycleNode
            data={data}
            id="entry"
            selected={selected}
            type="lifecycle"
            {...requiredNodeProps}
          />
        </ReactFlowProvider>
      </ExtensionCatalogProvider>
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
    expect(
      view.container
        .querySelector(`[data-handleid="${LIFECYCLE_STARTED_HANDLE}"]`)
        ?.getAttribute("aria-label")
    ).toBe("Started outlet");
    expect(
      view.container
        .querySelector(`[data-handleid="${LIFECYCLE_STARTED_HANDLE}"]`)
        ?.getAttribute("role")
    ).toBe("img");
    expect(
      view.container
        .querySelector(`[data-handleid="${LIFECYCLE_CANCELED_HANDLE}"]`)
        ?.getAttribute("aria-label")
    ).toBe("Canceled outlet");
  });

  it("marks the shared node surface when selected", () => {
    const view = renderLifecycleNode(
      {
        label: "Lifecycle",
        description: "",
        type: "lifecycle",
        config: {},
        status: "idle",
      },
      true
    );

    expect(view.container.querySelector("[data-selected='true']")).toBeTruthy();
  });

  it("wraps a long title and keeps the node icon compact", () => {
    const label = "New Donation Appointment";
    const view = renderLifecycleNode({
      label,
      description: "",
      type: "lifecycle",
      config: {},
      status: "idle",
    });

    const title = view.getByText(label);
    expect(title.className).toContain("line-clamp-2");
    expect(title.className).toContain("text-sm");
    expect(title.className).not.toContain("truncate");
    expect(title.getAttribute("title")).toBe(label);
    expect(
      view.container
        .querySelector("svg[class*='text-node-lifecycle']")
        ?.getAttribute("class")
    ).toContain("size-4");
  });

  it("hides the visual comparison marker from the accessibility tree", () => {
    const view = renderLifecycleNode({
      label: "Lifecycle",
      description: "",
      type: "lifecycle",
      config: {},
      [COMPARISON_NODE_ANNOTATION]: { kind: "modified" },
    });

    expect(
      view.getByTitle("Modified in comparison").getAttribute("aria-hidden")
    ).toBe("true");
    expect(view.getByText("M")).toBeTruthy();
  });

  it("uses the start summary as the subtitle on a compact card", () => {
    const view = renderLifecycleNode({
      label: "Lifecycle",
      description: "",
      type: "lifecycle",
      config: {},
      status: "idle",
    });

    expect(view.getByText("Manual runs only")).toBeTruthy();
  });

  it("prints Start Event labels on the card, not the stored event names", () => {
    const view = renderLifecycleNode(
      {
        label: "Lifecycle",
        description: "",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: ["resend/email.sent", "resend/email.delivered"],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        },
        status: "idle",
      },
      false,
      labeledCatalog
    );

    expect(view.getByText("On Email sent, Email delivered")).toBeTruthy();
    expect(view.queryByText(/resend\/email\.sent/)).toBeNull();
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
