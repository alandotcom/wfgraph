import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
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
import { type RunExecutorHold, WorkflowRunDetail } from "./workflow-run-detail";
import type { ExecutorSchedule } from "#src/lib/run-executor-activity";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { formatExactTime } from "@wfgraph/shared/utils/time";

const BASE_EXECUTION: WorkflowExecution = {
  cancelledAt: null,
  completedAt: null,
  entityValue: null,
  entity: null,
  duration: null,
  error: null,
  id: "exec_1",
  runMode: "test",
  versionKind: "published",
  versionNumber: 4,
  startedAt: new Date("2026-02-22T10:00:00Z"),
  scheduledFor: null,
  scheduleDescription: null,
  status: "running",
  startEventName: "appointment.updated",
  startSource: "event",
  waitingAt: null,
  workflowId: "wf_1",
  activity: null,
};

/** The props every case shares, so a case only names what it varies. */
function renderDetail(
  execution: WorkflowExecution,
  extras?: {
    logs?: WorkflowRunDetailLogs;
    waits?: Parameters<typeof WorkflowRunDetail>[0]["waits"];
    events?: ExecutionEvent[];
    exit?: Parameters<typeof WorkflowRunDetail>[0]["exit"];
    executor?: RunExecutorHold;
    catalog?: ExtensionCatalog;
    nodes?: WorkflowNode[];
    executionNodes?: WorkflowNode[];
    onSelectLog?: (log: WorkflowRunDetailLogs[number]) => void;
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
      // The failure summary reads the Connection list and can open a
      // Connection's dialog, so the detail renders inside both providers.
      <QueryClientProvider client={new QueryClient()}>
        <JotaiProvider store={store}>
          <OverlayProvider>
            <ExtensionCatalogProvider
              value={extras?.catalog ?? emptyExtensionCatalog}
            >
              <IntegrationUiProvider value={{}}>
                <WorkflowRunDetail
                  events={extras?.events ?? []}
                  execution={execution}
                  exit={extras?.exit ?? null}
                  executor={extras?.executor ?? null}
                  onSelectLog={extras?.onSelectLog ?? vi.fn()}
                  isCanceling={false}
                  isResuming={false}
                  logs={extras?.logs ?? []}
                  onCancel={vi.fn(() => undefined)}
                  onResume={vi.fn(() => undefined)}
                  waits={extras?.waits ?? []}
                />
              </IntegrationUiProvider>
            </ExtensionCatalogProvider>
          </OverlayProvider>
        </JotaiProvider>
      </QueryClientProvider>
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

  it("still shows the cancel button for a waiting execution", () => {
    const view = renderDetail({ ...BASE_EXECUTION, status: "waiting" });

    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  describe("executor section", () => {
    const schedule: ExecutorSchedule = {
      observedAt: "2026-02-22T10:05:00.000Z",
      overdueAfterMs: 60_000,
      activity: null,
      state: "queued",
      wakeAt: "2026-02-22T10:06:00.000Z",
      attempt: 0,
      retryLimit: 4,
      runningStepId: null,
      leaseExpiresAt: null,
      workerId: null,
      failingSteps: [],
    };

    // The executor names a node it has no log row for by id, and the pinned
    // graph's label takes its place.
    it("states what the executor is doing, with its schedule behind a disclosure", () => {
      const view = renderDetail(BASE_EXECUTION, {
        executionNodes: [
          {
            id: "send",
            type: "action",
            position: { x: 0, y: 0 },
            data: { label: "Send reminder", type: "action", config: {} },
          },
        ],
        executor: {
          receivedAtMs: Date.now(),
          schedule: {
            ...schedule,
            activity: {
              kind: "retrying",
              nodeId: "send",
              nodeName: null,
              nextTryAt: "2026-02-22T10:06:00.000Z",
              failures: 1,
              retryLimit: 4,
              error: "Twilio answered 503",
            },
          },
        },
      });

      const section = view.getByRole("region", { name: "Executor" });
      expect(section.textContent).toContain("Retrying “Send reminder” at");
      expect(section.textContent).toContain("try 2 of 5");
      expect(section.textContent).toContain("Twilio answered 503");
      expect(section.textContent).not.toContain("Run tries");

      fireEvent.click(view.getByRole("button", { name: "Executor details" }));
      expect(section.textContent).toContain("Run tries");
      expect(section.textContent).toContain("1 of 5");
    });

    it("says nothing new for a run asleep on its parks, or for a run that ended", () => {
      const asleep = renderDetail(BASE_EXECUTION, {
        executor: {
          receivedAtMs: Date.now(),
          schedule: {
            ...schedule,
            state: "waiting",
            activity: { kind: "waiting" },
          },
        },
      });
      expect(asleep.queryByRole("region", { name: "Executor" })).toBeNull();
      asleep.unmount();

      const ended = renderDetail(
        { ...BASE_EXECUTION, status: "completed" },
        {
          executor: {
            receivedAtMs: Date.now(),
            schedule: {
              ...schedule,
              activity: { kind: "unclaimed", dueSince: schedule.wakeAt },
            },
          },
        }
      );
      expect(ended.queryByRole("region", { name: "Executor" })).toBeNull();
    });
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
    expect(view.getByText("Appointment reminders enabled")).toBeTruthy();
    expect(view.queryByText("appointmentRemindersEnabled")).toBeNull();
    expect(view.getByText("is true")).toBeTruthy();
    expect(view.getByText("Eligibility rule did not match")).toBeTruthy();
    expect(view.queryByText("Draft-only label")).toBeNull();
    expect(view.queryByText("condition_digest")).toBeNull();
    expect(view.queryByText(/appt_secret|active=true/)).toBeNull();
  });

  // A step that failed closes its node's log as `error` before the executor
  // tries it again, so the header reads the node as retrying, as the canvas
  // chip does, while the schedule lists the step as failing.
  it("reads a node with a failing step as retrying in the header", () => {
    const logs: WorkflowRunDetailLogs = [
      {
        id: "log_send",
        nodeId: "send",
        nodeName: "Send reminder",
        nodeType: "action",
        status: "error",
        startedAt: new Date("2026-02-22T10:00:00Z"),
        completedAt: new Date("2026-02-22T10:00:01Z"),
        duration: "1000",
        error: "Twilio answered 503",
        retries: 0,
        retryLimit: 4,
      },
    ];
    const view = renderDetail(BASE_EXECUTION, {
      logs,
      executor: {
        receivedAtMs: Date.now(),
        schedule: {
          observedAt: "2026-02-22T10:05:00.000Z",
          overdueAfterMs: 60_000,
          activity: null,
          state: "leased",
          wakeAt: "2026-02-22T10:05:00.000Z",
          attempt: 0,
          retryLimit: 4,
          runningStepId: null,
          leaseExpiresAt: "2026-02-22T10:06:00.000Z",
          workerId: "worker-a1",
          failingSteps: [
            {
              nodeId: "send",
              failures: 1,
              error: "Twilio answered 503",
              nextTryAt: null,
            },
          ],
        },
      },
    });

    expect(view.getByText("Retrying Send reminder")).toBeTruthy();
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

  it.each(["running", "waiting"] as const)(
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

  describe("a failed run's summary", () => {
    const step = (
      id: string,
      status: "success" | "error",
      minute: number
    ): WorkflowRunDetailLogs[number] => ({
      id,
      nodeId: `node_${id}`,
      nodeName: `Step ${id}`,
      nodeType: "action",
      status,
      startedAt: new Date(`2026-02-22T10:0${minute}:00Z`),
      completedAt: new Date(`2026-02-22T10:0${minute}:01Z`),
      duration: "12",
      error: status === "error" ? "Request failed" : null,
      retries: 0,
      retryLimit: 4,
    });
    const logs = [
      step("a", "success", 0),
      step("b", "success", 1),
      step("c", "success", 2),
      step("d", "error", 3),
    ];
    const failed = { ...BASE_EXECUTION, status: "failed" as const };

    it("opens the failed step's evidence from the failure summary", () => {
      const onSelectLog = vi.fn();
      const view = renderDetail(failed, { logs, onSelectLog });

      fireEvent.click(view.getByRole("button", { name: "Failed at Step d" }));
      expect(onSelectLog).toHaveBeenCalledWith(logs[3]);
    });

    it("states the failure once, in the band", () => {
      const view = renderDetail(failed, { logs });

      expect(view.getAllByText("Request failed")).toHaveLength(1);
    });

    it("words an Entity the app did not find and keeps the stored error", () => {
      const view = renderDetail(
        {
          ...failed,
          error: 'Entity "patient" was not found for node data',
        },
        {
          catalog: {
            ...emptyExtensionCatalog,
            entities: [
              {
                type: "patient",
                label: "Patient",
                stateFields: [],
                stateSchemaDigest: "",
              },
            ],
          },
        }
      );

      expect(
        view.getByText(
          "The app found no Patient for this run. Check that the Patient exists in the app."
        )
      ).toBeTruthy();
      expect(
        view.getByText('Entity "patient" was not found for node data')
      ).toBeTruthy();
    });

    it("names the Event and binding that supplied the missing Entity's ID", () => {
      const view = renderDetail(
        {
          ...failed,
          startEventName: "appointment.created",
          error: 'Entity "patient" was not found for node data',
        },
        {
          catalog: {
            ...emptyExtensionCatalog,
            events: [
              {
                name: "appointment.created",
                label: "Appointment created",
                payloadFields: [],
              },
            ],
            entities: [
              {
                type: "patient",
                label: "Patient",
                stateFields: [],
                stateSchemaDigest: "",
              },
            ],
          },
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
                    startEvents: ["appointment.created"],
                    cancelEvents: [],
                    concurrency: "unlimited",
                    trackedEntity: {
                      type: "patient",
                      bindings: { "appointment.created": "patient" },
                    },
                  },
                },
              },
            },
          ],
        }
      );

      expect(
        view.getByText(
          "The app found no Patient for this run. Appointment created provides the Patient ID through its patient binding. Check that the Patient exists in the app."
        )
      ).toBeTruthy();
    });
  });

  it("words a run's activity, with its clock time and stored type", () => {
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "failed" },
      {
        catalog: {
          ...emptyExtensionCatalog,
          events: [
            {
              name: "appointment.updated",
              label: "Appointment updated",
              payloadFields: [],
            },
          ],
        },
        events: [
          {
            id: "event_1",
            eventType: "run_started",
            message:
              "Event-triggered run of v4 started for appointment.updated, to test recipients",
            metadata: null,
            createdAt: new Date("2026-02-22T10:00:00Z"),
          },
          {
            id: "event_2",
            eventType: "run_failed",
            message: "Run completed with errors",
            metadata: null,
            createdAt: new Date("2026-02-22T10:01:00Z"),
          },
        ],
      }
    );

    fireEvent.click(view.getByRole("button", { name: /Activity · 2/ }));
    expect(view.getByText("Started by Appointment updated")).toBeTruthy();
    expect(view.getByText("Run failed")).toBeTruthy();
    expect(view.queryByText("Run completed with errors")).toBeNull();
    expect(view.getByText("run_failed")).toBeTruthy();
    expect(
      view.getByText(formatExactTime(new Date("2026-02-22T10:01:00Z")))
    ).toBeTruthy();
  });

  it("names the Events a wait is for by their labels", () => {
    const view = renderDetail(
      { ...BASE_EXECUTION, status: "waiting" },
      {
        catalog: {
          ...emptyExtensionCatalog,
          events: [
            {
              name: "billing/payment.settled",
              label: "Payment settled",
              payloadFields: [],
            },
          ],
        },
        waits: [
          {
            id: "wait_1",
            nodeId: "wait_1",
            nodeName: "Wait for payment",
            resumeToken: null,
            subscribedEvents: ["billing/payment.settled", "app/unknown"],
            waitUntil: null,
          },
        ],
      }
    );

    expect(
      view.getByText("Waiting for Payment settled, app/unknown")
    ).toBeTruthy();
  });
});
