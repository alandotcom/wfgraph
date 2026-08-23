import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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
              waits={[]}
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

    fireEvent.keyDown(document, { key: "Escape" });
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
});
