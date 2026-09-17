import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import type {
  ExecutionEvent,
  WorkflowExecution,
} from "#src/lib/execution-logs";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { serializeConditionModel } from "@wfgraph/shared/conditions/conditions";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { WorkflowRunDetail } from "./workflow-run-detail";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";

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
    events?: ExecutionEvent[];
    exit?: Parameters<typeof WorkflowRunDetail>[0]["exit"];
    catalog?: ExtensionCatalog;
    nodes?: WorkflowNode[];
    executionNodes?: WorkflowNode[];
    onSelectLog?: (log: WorkflowRunDetailLogs[number]) => void;
    focusLogId?: string;
    onFocusRestored?: () => void;
  }
) {
  const store = createStore();
  if (extras?.nodes) {
    store.set(loadWorkflowGraphAtom, { nodes: extras.nodes, edges: [] });
  }
  if (extras?.executionNodes) {
    showWorkspaceRoute(store, { view: "runs" });
    store.set(executionOverlayGraphAtom, {
      nodes: extras.executionNodes,
      edges: [],
    });
  }
  return {
    store,
    ...render(
      <JotaiProvider store={store}>
        <ExtensionCatalogProvider
          value={extras?.catalog ?? emptyExtensionCatalog}
        >
          <IntegrationUiProvider value={{}}>
            <WorkflowRunDetail
              events={extras?.events ?? []}
              execution={execution}
              exit={extras?.exit ?? null}
              focusLogId={extras?.focusLogId}
              onFocusRestored={extras?.onFocusRestored}
              onSelectLog={extras?.onSelectLog ?? vi.fn()}
              isCanceling={false}
              isResuming={false}
              logs={extras?.logs ?? []}
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

  it("explains an Entity Eligibility exit from the pinned graph without exposing Entity State", () => {
    const view = renderDetail(
      {
        ...BASE_EXECUTION,
        status: "exited",
        completedAt: new Date("2026-10-19T15:00:00.000Z"),
      },
      {
        catalog: {
          ...emptyExtensionCatalog,
          entities: [
            {
              type: "patient",
              label: "Patient",
              stateFields: [
                { path: "appointmentRemindersEnabled", type: "boolean" },
              ],
              stateSchemaDigest: "state-v1",
            },
          ],
        },
        nodes: [
          {
            id: "send-reminder",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "Draft-only label",
              type: "action",
              config: { actionType: "mail/send" },
            },
          },
        ],
        executionNodes: [
          {
            id: "lifecycle",
            type: "lifecycle",
            position: { x: 0, y: 0 },
            data: {
              label: "Lifecycle",
              type: "lifecycle",
              config: {
                lifecycleRules: {
                  startEvents: ["appointment.updated"],
                  cancelEvents: [],
                  concurrency: "unlimited",
                  trackedEntity: {
                    type: "patient",
                    bindings: { "appointment.updated": "patient" },
                  },
                  entityEligibility: {
                    checkpoints: ["before-node"],
                    condition: serializeConditionModel({
                      version: 2,
                      groupLogic: "and",
                      groups: [
                        {
                          id: "eligibility",
                          logic: "and",
                          conditions: [
                            {
                              id: "reminders-enabled",
                              field: "appointmentRemindersEnabled",
                              fieldType: "boolean",
                              operator: "is_true",
                            },
                          ],
                        },
                      ],
                    }),
                  },
                },
              },
            },
          },
          {
            id: "send-reminder",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "Send reminder",
              type: "action",
              config: { actionType: "mail/send" },
            },
          },
        ],
        exit: {
          reason: "entity_condition_not_met",
          entityType: "patient",
          nodeId: "send-reminder",
          checkedAt: new Date("2026-10-19T15:00:00.000Z"),
        },
        events: [
          {
            id: "audit_exit",
            eventType: "run_exited",
            message: "Run exited because the Entity was ineligible",
            metadata: {
              reason: "entity_condition_not_met",
              entityType: "patient",
              conditionId: "condition_digest",
              nodeId: "send-reminder",
              checkedAt: "2026-10-19T15:00:00.000Z",
              entityId: "appt_secret",
              entityState: "active=true",
            },
            createdAt: new Date("2026-10-19T15:00:00.000Z"),
          },
        ],
      }
    );

    expect(
      view.getByText(
        "Exited before “Send reminder” because the Patient was no longer eligible."
      )
    ).toBeTruthy();
    expect(view.getByText("Eligible when")).toBeTruthy();
    expect(view.getByText("appointmentRemindersEnabled")).toBeTruthy();
    expect(view.getByText("is true")).toBeTruthy();
    expect(view.getByText("Eligibility rule did not match")).toBeTruthy();
    expect(view.getByText("Prevented Send reminder")).toBeTruthy();
    expect(view.queryByText("Draft-only label")).toBeNull();
    expect(view.queryByText("condition_digest")).toBeNull();
    expect(view.queryByText(/appt_secret|active=true/)).toBeNull();
  });

  it("hands a chosen journey entry to its frame and focuses a requested entry", () => {
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
    const onSelectLog = vi.fn();
    const onFocusRestored = vi.fn();
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "completed" },
      { logs, onSelectLog, focusLogId: "log_wait", onFocusRestored }
    );

    const entry = view.getByRole("button", { name: "Wait, Success" });
    expect(document.activeElement).toBe(entry);
    expect(onFocusRestored).toHaveBeenCalledOnce();
    fireEvent.click(entry);
    expect(onSelectLog).toHaveBeenCalledWith(logs[0]);
    expect(view.queryByText(/invoiceId/)).toBeNull();
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

  it.each(["pending", "running", "waiting"] as const)(
    "shows parked waits while the run is %s",
    (status) => {
      const view = renderDetail(
        { ...BASE_EXECUTION, status },
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

      expect(
        view.getByRole("heading", { name: "Waiting at Wait" })
      ).toBeTruthy();
      expect(
        view.getByText(/Waiting for resend\/email.delivered/)
      ).toBeTruthy();
      expect(view.getByRole("button", { name: "Resume now" })).toBeTruthy();
    }
  );
});
