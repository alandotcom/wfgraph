import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import type { WorkflowExecution } from "#src/lib/execution-logs";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { WorkflowRunDetail } from "./workflow-run-detail";

const BASE_EXECUTION: WorkflowExecution = {
  cancelledAt: null,
  completedAt: null,
  entityValue: null,
  duration: null,
  error: null,
  id: "exec_1",
  runMode: "test",
  versionKind: "published",
  versionNumber: 4,
  startedAt: new Date("2026-02-22T10:00:00Z"),
  status: "running",
  startEventName: "appointment.updated",
  startSource: "event",
  waitingAt: null,
  workflowId: "wf_1",
  workflowRunId: "run_1",
};

/** The props every case shares, so a case only names what it varies. */
function renderDetail(
  execution: WorkflowExecution,
  extras?: {
    logs?: WorkflowRunDetailLogs;
    waits?: Parameters<typeof WorkflowRunDetail>[0]["waits"];
    selectedNodeId?: string;
  }
) {
  const store = createStore();
  if (extras?.selectedNodeId) {
    store.set(selectedNodeAtom, extras.selectedNodeId);
  }
  return {
    store,
    ...render(
      <JotaiProvider store={store}>
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <IntegrationUiProvider value={{}}>
            <WorkflowRunDetail
              events={[]}
              execution={execution}
              isCanceling={false}
              isResuming={false}
              logs={extras?.logs ?? []}
              onBack={vi.fn(() => undefined)}
              onCancel={vi.fn(() => undefined)}
              onResume={vi.fn(() => undefined)}
              runNumber={1}
              waits={extras?.waits ?? []}
            />
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
      </JotaiProvider>
    ),
  };
}

type WorkflowRunDetailLogs = Parameters<typeof WorkflowRunDetail>[0]["logs"];

describe("WorkflowRunDetail", () => {
  // A Lifecycle Rules Cancel Event reaches every in-flight status (ADR-0007),
  // so the manual button reaches the same ground: a run standing on an
  // ordinary node, not just one parked on a Wait.
  it("shows the cancel button for a running execution", () => {
    const view = renderDetail(BASE_EXECUTION);

    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("shows the cancel button for a pending execution", () => {
    const view = renderDetail({ ...BASE_EXECUTION, status: "pending" });

    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("still shows the cancel button for a waiting execution", () => {
    const view = renderDetail({ ...BASE_EXECUTION, status: "waiting" });

    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("hides the cancel button once the run has finished", () => {
    const view = renderDetail({ ...BASE_EXECUTION, status: "completed" });

    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("opens the inspector from an executed-node row and back returns to overview", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_wait",
        nodeId: "wait_1",
        nodeName: "Wait",
        nodeType: "wait",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:09Z"),
        duration: "9030",
        input: { invoiceId: "inv_1" },
        output: {},
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs }
    );

    fireEvent.click(view.getByRole("button", { name: /Wait/ }));
    expect(view.getByRole("heading", { name: "Wait" })).toBe(
      document.activeElement
    );
    expect(view.queryByText("This node was not reached")).toBeNull();
    expect(view.queryByText(/invoiceId/)).toBeNull();
    expect(
      view
        .getByRole("button", { name: "Technical details" })
        .getAttribute("aria-expanded")
    ).toBe("false");

    fireEvent.click(view.getByRole("button", { name: "Technical details" }));
    expect(view.getByRole("tab", { name: "Input" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "Output" })).toBeTruthy();
    fireEvent.click(view.getByRole("tab", { name: "Input" }));
    expect(view.getByText(/invoiceId/)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Back to run overview" }));
    expect(
      view.getByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
    expect(view.getByRole("button", { name: /Wait/ })).toBe(
      document.activeElement
    );
  });

  it("keeps the technical details trigger focused when opened from the keyboard", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_action",
        nodeId: "action_1",
        nodeName: "Create appointment",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        input: { customerId: "cus_1" },
        output: { appointmentId: "appt_1" },
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs, selectedNodeId: "action_1" }
    );
    const trigger = view.getByRole("button", { name: "Technical details" });

    trigger.focus();
    fireEvent.click(trigger);

    expect(view.getByRole("button", { name: "Technical details" })).toBe(
      trigger
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("snaps technical details open without a height transition", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_action",
        nodeId: "action_1",
        nodeName: "Create appointment",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        input: { customerId: "cus_1" },
        output: { appointmentId: "appt_1" },
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs, selectedNodeId: "action_1" }
    );

    const trigger = view.getByRole("button", { name: "Technical details" });
    fireEvent.click(trigger);

    expect(trigger.closest("section")?.className).not.toContain(
      "transition-[height]"
    );
  });

  it("closes technical details and keeps Escape inside the inspector", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_action",
        nodeId: "action_1",
        nodeName: "Create appointment",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        input: { customerId: "cus_1" },
        output: { appointmentId: "appt_1" },
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs, selectedNodeId: "action_1" }
    );
    fireEvent.click(view.getByRole("button", { name: "Technical details" }));
    const drawerEscape = vi.fn();
    document.addEventListener("keydown", drawerEscape);

    try {
      fireEvent.keyDown(view.getByRole("tab", { name: "Output" }), {
        key: "Escape",
      });

      expect(view.queryByRole("tab", { name: "Output" })).toBeNull();
      expect(drawerEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", drawerEscape);
    }
  });

  it("keeps an earlier execution selected when a node runs more than once", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_first",
        nodeId: "loop_1",
        nodeName: "Loop step",
        nodeType: "action",
        status: "error",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        input: { attempt: 1 },
        output: { attempt: 1 },
        error: "The first attempt failed",
      },
      {
        id: "log_second",
        nodeId: "loop_1",
        nodeName: "Loop step",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:02Z"),
        completedAt: new Date("2026-02-22T10:00:03Z"),
        duration: "1000",
        input: { attempt: 2 },
        output: { attempt: 2 },
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs }
    );

    fireEvent.click(view.getByRole("button", { name: "Loop step, Error" }));

    expect(view.getByText("Step failed")).toBeTruthy();
    expect(view.getByText("The first attempt failed")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Back to run overview" }));

    expect(view.getByRole("button", { name: "Loop step, Error" })).toBe(
      document.activeElement
    );
  });

  it("uses the latest attempt when the canvas reopens a node after journey inspection", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_first",
        nodeId: "loop_1",
        nodeName: "Loop step",
        nodeType: "action",
        status: "error",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        input: { attempt: 1 },
        output: "first attempt result",
        error: "The first attempt failed",
      },
      {
        id: "log_second",
        nodeId: "loop_1",
        nodeName: "Loop step",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:02Z"),
        completedAt: new Date("2026-02-22T10:00:03Z"),
        duration: "1000",
        input: { attempt: 2 },
        output: "latest attempt result",
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs }
    );

    fireEvent.click(view.getByRole("button", { name: "Loop step, Error" }));
    expect(view.getByText("The first attempt failed")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Back to run overview" }));
    act(() => {
      view.store.set(selectedNodeAtom, "loop_1");
    });

    expect(view.queryByText("The first attempt failed")).toBeNull();
    expect(view.getByText("latest attempt result")).toBeTruthy();
  });

  it("clears journey selection when the canvas deselects before reopening the same node", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_first",
        nodeId: "loop_1",
        nodeName: "Loop step",
        nodeType: "action",
        status: "error",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        input: { attempt: 1 },
        output: "first attempt result",
        error: "The first attempt failed",
      },
      {
        id: "log_second",
        nodeId: "loop_1",
        nodeName: "Loop step",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:02Z"),
        completedAt: new Date("2026-02-22T10:00:03Z"),
        duration: "1000",
        input: { attempt: 2 },
        output: "latest attempt result",
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs }
    );

    fireEvent.click(view.getByRole("button", { name: "Loop step, Error" }));
    expect(view.getByText("The first attempt failed")).toBeTruthy();

    act(() => {
      view.store.set(selectedNodeAtom, null);
    });
    act(() => {
      view.store.set(selectedNodeAtom, "loop_1");
    });

    expect(view.queryByText("The first attempt failed")).toBeNull();
    expect(view.getByText("latest attempt result")).toBeTruthy();
  });

  it("uses the latest attempt after directly switching between canvas nodes", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_a_first",
        nodeId: "node_a",
        nodeName: "Node A",
        nodeType: "action",
        status: "error",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        input: { attempt: 1 },
        output: "Node A first attempt result",
        error: "Node A first attempt failed",
      },
      {
        id: "log_b",
        nodeId: "node_b",
        nodeName: "Node B",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:02Z"),
        completedAt: new Date("2026-02-22T10:00:03Z"),
        duration: "1000",
        input: { attempt: 1 },
        output: "Node B result",
        error: null,
      },
      {
        id: "log_a_second",
        nodeId: "node_a",
        nodeName: "Node A",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:04Z"),
        completedAt: new Date("2026-02-22T10:00:05Z"),
        duration: "1000",
        input: { attempt: 2 },
        output: "Node A latest attempt result",
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs }
    );

    fireEvent.click(view.getByRole("button", { name: "Node A, Error" }));
    expect(view.getByText("Node A first attempt failed")).toBeTruthy();

    act(() => {
      view.store.set(selectedNodeAtom, "node_b");
    });
    act(() => {
      view.store.set(selectedNodeAtom, "node_a");
    });

    expect(view.queryByText("Node A first attempt failed")).toBeNull();
    expect(view.getByText("Node A latest attempt result")).toBeTruthy();
  });

  it("shows an empty inspector for a canvas node that never ran", () => {
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { selectedNodeId: "action_never" }
    );

    expect(view.getByText("This node was not reached")).toBeTruthy();
    expect(view.queryByText("Input")).toBeNull();
  });

  it("shows friendly output while keeping raw payloads in the console", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_action",
        nodeId: "action_1",
        nodeName: "Create appointment",
        nodeType: "host/create-appointment",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        input: { customerId: "cus_1" },
        output: {
          appointment_url: "https://example.com/appointments/42",
          confirmed: true,
        },
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs, selectedNodeId: "action_1" }
    );

    expect(view.getByText("Appointment URL")).toBeTruthy();
    expect(view.getByText("Yes")).toBeTruthy();
    expect(view.queryByText(/customerId/)).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Technical details" }));
    expect(view.getByRole("tab", { name: "Output" })).toBeTruthy();
    expect(view.queryByText(/customerId/)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(logs[0]!.output, null, 2)
    );

    fireEvent.keyDown(view.getByRole("tab", { name: "Output" }), {
      key: "Escape",
    });
    expect(view.queryByRole("tab", { name: "Output" })).toBeNull();
  });

  it("omits unavailable technical detail tabs", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_action",
        nodeId: "action_1",
        nodeName: "Create appointment",
        nodeType: "action",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        output: { id: "appt_1" },
        error: null,
      },
    ];
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs, selectedNodeId: "action_1" }
    );

    fireEvent.click(view.getByRole("button", { name: "Technical details" }));
    expect(view.queryByRole("tab", { name: "Input" })).toBeNull();
    expect(view.getByRole("tab", { name: "Output" })).toBeTruthy();
  });

  // Cancel paints the list row first and stops the logs poll. The journey and
  // waits can still be the last in-flight snapshot, so they follow the run
  // status rather than those leftover rows.
  it("treats leftover running steps as cancelled once the run is canceled", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_lifecycle",
        nodeId: "lifecycle_1",
        nodeName: "Lifecycle",
        nodeType: "lifecycle",
        status: "success",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        error: null,
      },
      {
        id: "log_wait",
        nodeId: "wait_1",
        nodeName: "Wait",
        nodeType: "action",
        status: "running",
        startedAt: new Date("2026-02-22T10:00:01Z"),
        completedAt: null,
        duration: null,
        error: null,
      },
    ];

    const view = renderDetail(
      { ...BASE_EXECUTION, status: "canceled" },
      { logs }
    );

    expect(view.getByRole("button", { name: "Wait, Cancelled" })).toBeTruthy();
    expect(view.queryByText("In progress")).toBeNull();
    expect(view.queryByText("Running")).toBeNull();
  });

  it("hides parked waits once the run is no longer waiting", () => {
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "canceled" },
      {
        waits: [
          {
            id: "wait_1",
            nodeId: "wait_1",
            nodeName: "Wait",
            resumeToken: "tok_1",
            subscribedEvents: ["resend/email.delivered"],
            waitUntil: null,
          },
        ],
      }
    );

    expect(view.queryByText("Waiting at Wait")).toBeNull();
    expect(view.queryByText(/Waiting for resend\/email.delivered/)).toBeNull();
    expect(view.queryByRole("button", { name: "Resume now" })).toBeNull();
  });
});
