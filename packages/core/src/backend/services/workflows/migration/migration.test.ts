// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  InngestError,
  type InngestClient,
} from "#src/backend/lib/effect/inngest-client";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type { PublishedWorkflowVersion } from "#src/backend/lib/db/schema";
import type {
  ExecutionRepo,
  InFlightExecutionRow,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import { migrateExecutions } from "#src/backend/services/workflows/migration/migrate";
import { previewMigration } from "#src/backend/services/workflows/migration/preview";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type { JsonValue } from "@wfgraph/shared/types/json";

const WORKFLOW_ID = "wf_1";
const TARGET_VERSION_ID = "ver_2";
const OLD_VERSION_ID = "ver_1";

/** A park that happened a minute ago, so no timeout of any length has run out. */
const PARKED_AT = new Date(Date.now() - 60_000);

/**
 * `before_1` feeds the Wait, and `after_1` sits below it holding a template that
 * names `before_1`. So a run parked on `wait_1` can only take the target graph
 * over when it recorded an output for `before_1`.
 */
function targetGraph(
  options: {
    withWaitNode?: boolean;
    waitEnabled?: boolean;
    waitConfig?: Record<string, unknown>;
    withAddedNodeAboveWait?: boolean;
  } = {}
): SerializedWorkflowGraph {
  const withWaitNode = options.withWaitNode ?? true;
  const waitNode = {
    id: "wait_1",
    position: { x: 0, y: 100 },
    data: {
      label: "Wait for approval",
      type: "action" as const,
      enabled: options.waitEnabled ?? true,
      config: {
        actionType: BUILT_IN_ACTION_IDS.wait,
        waitMode: "delay",
        ...options.waitConfig,
      },
    },
  };

  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "before_1",
        position: { x: 0, y: 0 },
        data: {
          label: "Before",
          type: "action" as const,
          config: { actionType: "http.request" },
        },
      },
      ...(options.withAddedNodeAboveWait
        ? [
            {
              id: "added_1",
              position: { x: 0, y: 50 },
              data: {
                label: "Added",
                type: "action" as const,
                config: { actionType: "http.request" },
              },
            },
          ]
        : []),
      ...(withWaitNode ? [waitNode] : []),
      {
        id: "after_1",
        position: { x: 0, y: 200 },
        data: {
          label: "After",
          type: "action" as const,
          config: {
            actionType: "http.request",
            subject: "{{@before_1:Before.value}}",
          },
        },
      },
    ],
    edges: withWaitNode
      ? [
          ...(options.withAddedNodeAboveWait
            ? [
                { id: "e0", source: "before_1", target: "added_1" },
                { id: "e1", source: "added_1", target: "wait_1" },
              ]
            : [{ id: "e1", source: "before_1", target: "wait_1" }]),
          { id: "e2", source: "wait_1", target: "after_1" },
        ]
      : [{ id: "e2", source: "before_1", target: "after_1" }],
  });
}

/**
 * Two Waits in sequence, each with a node below it. The node below the second
 * Wait references the node between them, which the run reaches only after the
 * first Wait releases.
 */
function graphWithReference(input: {
  nodeIds: string[];
  waitNodeIds: string[];
  consumerId: string;
  referencedNodeId: string;
  edges: Array<{ id: string; source: string; target: string }>;
}): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: input.nodeIds.map((id) => ({
      id,
      position: { x: 0, y: 0 },
      data: {
        label: id,
        type: "action" as const,
        config: {
          actionType: input.waitNodeIds.includes(id)
            ? BUILT_IN_ACTION_IDS.wait
            : "http.request",
          ...(input.waitNodeIds.includes(id) ? { waitMode: "delay" } : {}),
          ...(id === input.consumerId
            ? { subject: `{{@${input.referencedNodeId}:Source.value}}` }
            : {}),
        },
      },
    })),
    edges: input.edges,
  });
}

function publishedVersion(
  graph: SerializedWorkflowGraph
): PublishedWorkflowVersion {
  return {
    id: TARGET_VERSION_ID,
    workflowId: WORKFLOW_ID,
    version: 2,
    kind: "published",
    graph,
    catalogFingerprint: "catalog",
    graphDigest: "digest",
    publishedAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

function inFlightRow(
  overrides: Partial<InFlightExecutionRow> & { id: string }
): InFlightExecutionRow {
  return {
    status: "waiting",
    workflowVersionId: OLD_VERSION_ID,
    versionKind: "published",
    versionNumber: 1,
    ...overrides,
  };
}

function waitRow(
  overrides: Partial<WorkflowWaitState> & { id: string; executionId: string }
): WorkflowWaitState {
  return {
    workflowId: WORKFLOW_ID,
    runId: "run_1",
    nodeId: "wait_1",
    nodeName: "Wait for approval",
    waitType: "delay",
    status: "waiting",
    resumeToken: null,
    waitUntil: new Date(Date.now() + 86_400_000),
    subscribedEvents: [],
    metadata: null,
    createdAt: PARKED_AT,
    resumedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

/** The repositories both operations read, each answering from fixed rows. */
function makeMigrationSeams(input: {
  graph?: SerializedWorkflowGraph | undefined;
  executions?: InFlightExecutionRow[] | undefined;
  waitStates?: WorkflowWaitState[] | undefined;
  nodeOutputs?: Record<string, JsonValue> | undefined;
  nodeLogNodeIds?: string[] | undefined;
  repinned?: boolean | undefined;
  sendWaitSignal?: InngestClient["Service"]["sendWaitSignal"] | undefined;
  recordAuditEvent?: ExecutionRepo["Service"]["recordAuditEvent"] | undefined;
  /** The workflow each run outside the in-flight list belongs to, by run id. */
  workflowIdByExecution?: Record<string, string | null> | undefined;
}) {
  const version = publishedVersion(input.graph ?? targetGraph());
  const waitStates = input.waitStates ?? [];
  const calls = {
    order: [] as string[],
    waitLookups: [] as string[][],
    outputReads: [] as string[],
    nodeStatusReads: [] as string[],
    workflowIdReads: [] as string[],
    repins: [] as Parameters<ExecutionRepo["Service"]["repinVersion"]>[0][],
    auditEvents: [] as Parameters<
      ExecutionRepo["Service"]["recordAuditEvent"]
    >[0][],
    signals: [] as Parameters<InngestClient["Service"]["sendWaitSignal"]>[0][],
  };

  return {
    version,
    calls,
    layer: Layer.mergeAll(
      stubWorkflowRepo({
        findByIdWithPublishedVersionForRun: () =>
          Effect.succeed({
            workflow: {
              id: WORKFLOW_ID,
              name: "Appointments",
              mode: "live",
              isPaused: false,
            },
            publishedVersion: version,
          }),
        findVersionById: () => Effect.succeed(version),
      }),
      stubExecutionRepo({
        listInFlightByWorkflow: () => Effect.succeed(input.executions ?? []),
        listWaitingStatesForExecutions: (executionIds) =>
          Effect.sync(() => {
            calls.waitLookups.push(executionIds);
            const byExecution = new Map<string, WorkflowWaitState[]>();
            for (const row of waitStates) {
              if (!executionIds.includes(row.executionId)) {
                continue;
              }
              const existing = byExecution.get(row.executionId);
              if (existing) {
                existing.push(row);
              } else {
                byExecution.set(row.executionId, [row]);
              }
            }
            return byExecution;
          }),
        readNodeOutputs: (executionId) =>
          Effect.sync(() => {
            calls.outputReads.push(executionId);
            return input.nodeOutputs ?? {};
          }),
        listNodeStatuses: (executionId) =>
          Effect.sync(() => {
            calls.nodeStatusReads.push(executionId);
            return (input.nodeLogNodeIds ?? ["before_1"]).map((nodeId) => ({
              nodeId,
              status: "success" as const,
            }));
          }),
        repinVersion: (repin) =>
          Effect.sync(() => {
            calls.order.push("repin");
            calls.repins.push(repin);
            return input.repinned ?? true;
          }),
        recordAuditEvent: (event) =>
          Effect.suspend(() => {
            calls.order.push("audit");
            calls.auditEvents.push(event);
            return input.recordAuditEvent
              ? input.recordAuditEvent(event)
              : Effect.void;
          }),
        findWorkflowIdById: (executionId) =>
          Effect.sync(() => {
            calls.workflowIdReads.push(executionId);
            return input.workflowIdByExecution?.[executionId] ?? null;
          }),
      }),
      stubInngestClient({
        sendWaitSignal: (signal) =>
          Effect.suspend(() => {
            calls.order.push("signal");
            calls.signals.push(signal);
            return input.sendWaitSignal
              ? input.sendWaitSignal(signal)
              : Effect.void;
          }),
      })
    ),
  };
}

describe("previewMigration", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("reports a parked run the target version can take over", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: { before_1: { value: "ok" } },
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report, {
          targetVersionId: TARGET_VERSION_ID,
          targetVersionNumber: 2,
          eligible: [
            {
              executionId: "exec_1",
              fromVersionNumber: 1,
              parkedNodeIds: ["wait_1"],
            },
          ],
          refused: [],
          alreadyCurrentCount: 0,
        });
      })
    );

    it.effect("counts a run already pinned to the target version", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [
            inFlightRow({
              id: "exec_1",
              workflowVersionId: TARGET_VERSION_ID,
              versionNumber: 2,
            }),
          ],
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.strictEqual(report.alreadyCurrentCount, 1);
        assert.deepStrictEqual(report.eligible, []);
      })
    );

    it.effect("refuses a run that pins a draft snapshot", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [
            inFlightRow({
              id: "exec_1",
              versionKind: "draft_snapshot",
              versionNumber: null,
            }),
          ],
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          {
            executionId: "exec_1",
            fromVersionNumber: null,
            reason: "draft_run",
          },
        ]);
      })
    );

    it.effect("refuses a run that is not parked on a wait", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1", status: "running" })],
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          { executionId: "exec_1", fromVersionNumber: 1, reason: "executing" },
        ]);
      })
    );

    it.effect("refuses a run parked on a node the target graph lost", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: targetGraph({ withWaitNode: false }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          {
            executionId: "exec_1",
            fromVersionNumber: 1,
            reason: "wait_node_missing",
            detail: "wait_1",
          },
        ]);
      })
    );

    it.effect("refuses an enabled node added above the parked Wait", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: targetGraph({ withAddedNodeAboveWait: true }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeLogNodeIds: ["before_1"],
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          {
            executionId: "exec_1",
            fromVersionNumber: 1,
            reason: "node_added_above_wait",
            detail: "added_1",
          },
        ]);
      })
    );

    it.effect("accepts an added node with a node log row", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: targetGraph({ withAddedNodeAboveWait: true }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeLogNodeIds: ["before_1", "added_1"],
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, []);
        assert.strictEqual(report.eligible.length, 1);
      })
    );

    it.effect("refuses a template the run recorded no output for", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: graphWithReference({
            nodeIds: ["before_1", "wait_1", "after_1"],
            waitNodeIds: ["wait_1"],
            consumerId: "after_1",
            referencedNodeId: "before_1",
            edges: [{ id: "e1", source: "wait_1", target: "after_1" }],
          }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: {},
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          {
            executionId: "exec_1",
            fromVersionNumber: 1,
            reason: "unresolved_reference",
            detail: "after_1.subject",
          },
        ]);
      })
    );

    it.effect(
      "refuses a template written into the parked Wait's own config",
      () =>
        Effect.gen(function* () {
          const seams = makeMigrationSeams({
            graph: targetGraph({
              waitConfig: {
                waitMode: "event",
                waitFor: [
                  {
                    event: "approval/granted",
                    match: "{{@missing_1:Missing.id}} == 1",
                  },
                ],
              },
            }),
            executions: [inFlightRow({ id: "exec_1" })],
            waitStates: [
              waitRow({
                id: "wait_row_1",
                executionId: "exec_1",
                waitType: "event",
              }),
            ],
            nodeOutputs: { before_1: { value: "ok" } },
          });

          const report = yield* previewMigration({
            workflowId: WORKFLOW_ID,
          }).pipe(Effect.provide(seams.layer));

          assert.deepStrictEqual(report.refused, [
            {
              executionId: "exec_1",
              fromVersionNumber: 1,
              reason: "unresolved_reference",
              detail: "wait_1.waitFor.0.match",
            },
          ]);
        })
    );

    it.effect("refuses a field the recorded output does not hold", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: graphWithReference({
            nodeIds: ["before_1", "wait_1", "after_1"],
            waitNodeIds: ["wait_1"],
            consumerId: "after_1",
            referencedNodeId: "before_1",
            edges: [{ id: "e1", source: "wait_1", target: "after_1" }],
          }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          // `before_1` ran, but it left no `value`, so the template below the
          // Wait would render as empty text.
          nodeOutputs: { before_1: { other: "x" } },
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          {
            executionId: "exec_1",
            fromVersionNumber: 1,
            reason: "unresolved_reference",
            detail: "after_1.subject",
          },
        ]);
      })
    );

    it.effect("accepts a recorded field holding null", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: { before_1: { value: null } },
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, []);
        assert.strictEqual(report.eligible.length, 1);
      })
    );

    it.effect(
      "refuses a delay park landing on an Event Wait whose timeout passed",
      () =>
        Effect.gen(function* () {
          const seams = makeMigrationSeams({
            graph: targetGraph({
              waitConfig: { waitMode: "event", waitTimeout: "30s" },
            }),
            executions: [inFlightRow({ id: "exec_1" })],
            waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
            nodeOutputs: { before_1: { value: "ok" } },
          });

          const report = yield* previewMigration({
            workflowId: WORKFLOW_ID,
          }).pipe(Effect.provide(seams.layer));

          assert.deepStrictEqual(report.refused, [
            {
              executionId: "exec_1",
              fromVersionNumber: 1,
              reason: "wait_timeout_elapsed",
              detail: "wait_1",
            },
          ]);
        })
    );

    it.effect("keeps an event park landing on a delay Wait", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: targetGraph({
            waitConfig: { waitMode: "delay", waitTimeout: "30s" },
          }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [
            waitRow({
              id: "wait_row_1",
              executionId: "exec_1",
              waitType: "event",
            }),
          ],
          nodeOutputs: { before_1: { value: "ok" } },
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, []);
        assert.strictEqual(report.eligible.length, 1);
      })
    );

    it.effect("refuses a reference across two parked branches", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: graphWithReference({
            nodeIds: ["wait_1", "branch_1", "wait_2", "branch_2"],
            waitNodeIds: ["wait_1", "wait_2"],
            consumerId: "branch_1",
            referencedNodeId: "branch_2",
            edges: [
              { id: "e1", source: "wait_1", target: "branch_1" },
              { id: "e2", source: "wait_2", target: "branch_2" },
            ],
          }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [
            waitRow({ id: "wait_row_1", executionId: "exec_1" }),
            waitRow({
              id: "wait_row_2",
              executionId: "exec_1",
              nodeId: "wait_2",
            }),
          ],
          nodeOutputs: {},
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          {
            executionId: "exec_1",
            fromVersionNumber: 1,
            reason: "unresolved_reference",
            detail: "branch_1.subject",
          },
        ]);
      })
    );

    it.effect(
      "accepts a reference to an upstream node below the same Wait",
      () =>
        Effect.gen(function* () {
          const seams = makeMigrationSeams({
            graph: graphWithReference({
              nodeIds: ["wait_1", "source_1", "consumer_1"],
              waitNodeIds: ["wait_1"],
              consumerId: "consumer_1",
              referencedNodeId: "source_1",
              edges: [
                { id: "e1", source: "wait_1", target: "source_1" },
                { id: "e2", source: "source_1", target: "consumer_1" },
              ],
            }),
            executions: [inFlightRow({ id: "exec_1" })],
            waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
            nodeOutputs: {},
          });

          const report = yield* previewMigration({
            workflowId: WORKFLOW_ID,
          }).pipe(Effect.provide(seams.layer));

          assert.deepStrictEqual(report.refused, []);
          assert.strictEqual(report.eligible.length, 1);
          assert.deepStrictEqual(seams.calls.outputReads, []);
        })
    );

    it.effect("accepts a reference through a join of two parked branches", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: graphWithReference({
            nodeIds: ["wait_1", "branch_1", "wait_2", "branch_2", "join_1"],
            waitNodeIds: ["wait_1", "wait_2"],
            consumerId: "join_1",
            referencedNodeId: "branch_2",
            edges: [
              { id: "e1", source: "wait_1", target: "branch_1" },
              { id: "e2", source: "wait_2", target: "branch_2" },
              { id: "e3", source: "branch_1", target: "join_1" },
              { id: "e4", source: "branch_2", target: "join_1" },
            ],
          }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [
            waitRow({ id: "wait_row_1", executionId: "exec_1" }),
            waitRow({
              id: "wait_row_2",
              executionId: "exec_1",
              nodeId: "wait_2",
            }),
          ],
          nodeOutputs: {},
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, []);
        assert.strictEqual(report.eligible.length, 1);
        assert.deepStrictEqual(seams.calls.outputReads, []);
      })
    );

    it.effect("refuses a Wait that references itself", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: graphWithReference({
            nodeIds: ["wait_1"],
            waitNodeIds: ["wait_1"],
            consumerId: "wait_1",
            referencedNodeId: "wait_1",
            edges: [],
          }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: {},
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          {
            executionId: "exec_1",
            fromVersionNumber: 1,
            reason: "unresolved_reference",
            detail: "wait_1.subject",
          },
        ]);
      })
    );

    it.effect("refuses an event park whose target timeout already passed", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: targetGraph({
            waitConfig: { waitMode: "event", waitTimeout: "30s" },
          }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [
            waitRow({
              id: "wait_row_1",
              executionId: "exec_1",
              waitType: "event",
            }),
          ],
          nodeOutputs: { before_1: { value: "ok" } },
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, [
          {
            executionId: "exec_1",
            fromVersionNumber: 1,
            reason: "wait_timeout_elapsed",
            detail: "wait_1",
          },
        ]);
      })
    );

    it.effect("keeps a delay park whose target date is in the past", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          graph: targetGraph({
            waitConfig: { waitMode: "delay", waitTimeout: "30s" },
          }),
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: { before_1: { value: "ok" } },
        });

        const report = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(report.refused, []);
        assert.strictEqual(report.eligible.length, 1);
      })
    );

    it.effect("reads the parked waits of at most 500 runs at a time", () =>
      Effect.gen(function* () {
        const executions = Array.from({ length: 501 }, (_, index) =>
          inFlightRow({ id: `exec_${index}` })
        );
        const seams = makeMigrationSeams({ executions });

        yield* previewMigration({ workflowId: WORKFLOW_ID }).pipe(
          Effect.provide(seams.layer)
        );

        assert.deepStrictEqual(
          seams.calls.waitLookups.map((ids) => ids.length),
          [500, 1]
        );
      })
    );

    it.effect("reports a missing workflow as not found", () =>
      Effect.gen(function* () {
        const failure = yield* previewMigration({
          workflowId: WORKFLOW_ID,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubWorkflowRepo({
                findByIdWithPublishedVersionForRun: () => Effect.succeed(null),
              }),
              stubExecutionRepo(),
              stubInngestClient()
            )
          ),
          Effect.flip
        );

        assert.strictEqual(failure._tag, "NotFound");
      })
    );

    it.effect("refuses a target version belonging to another workflow", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({});
        const failure = yield* previewMigration({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stubWorkflowRepo({
                findByIdWithPublishedVersionForRun: () =>
                  Effect.succeed({
                    workflow: {
                      id: WORKFLOW_ID,
                      name: "Appointments",
                      mode: "live",
                      isPaused: false,
                    },
                    publishedVersion: seams.version,
                  }),
                findVersionById: () =>
                  Effect.succeed({
                    ...seams.version,
                    workflowId: "wf_other",
                  }),
              }),
              stubExecutionRepo(),
              stubInngestClient()
            )
          ),
          Effect.flip
        );

        assert.strictEqual(failure._tag, "InvalidInput");
      })
    );
  });
});

describe("migrateExecutions", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("moves the pointer, signals, then records the audit row", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [
            waitRow({
              id: "wait_row_1",
              executionId: "exec_1",
              waitType: "event",
              resumeToken: "resume_1",
            }),
          ],
          nodeOutputs: { before_1: { value: "ok" } },
        });

        const result = yield* migrateExecutions({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
          executionIds: ["exec_1"],
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(result.outcomes, [
          { executionId: "exec_1", status: "migrated", signaled: true },
        ]);
        assert.deepStrictEqual(seams.calls.order, ["repin", "signal", "audit"]);
        assert.deepStrictEqual(seams.calls.repins, [
          {
            executionId: "exec_1",
            fromVersionId: OLD_VERSION_ID,
            toVersionId: TARGET_VERSION_ID,
          },
        ]);
        assert.deepStrictEqual(seams.calls.auditEvents, [
          {
            workflowId: WORKFLOW_ID,
            executionId: "exec_1",
            eventType: "run_migrated",
            message: "Run migrated to version 2",
            metadata: {
              fromVersionId: OLD_VERSION_ID,
              fromVersionNumber: 1,
              toVersionId: TARGET_VERSION_ID,
              toVersionNumber: 2,
            },
          },
        ]);
        assert.deepStrictEqual(seams.calls.signals, [
          {
            executionId: "exec_1",
            nodeId: "wait_1",
            token: "resume_1",
            signalType: "version-migrate",
          },
        ]);
      })
    );

    it.effect("sends no token for a delay park", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: { before_1: { value: "ok" } },
        });

        yield* migrateExecutions({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
          executionIds: ["exec_1"],
        }).pipe(Effect.provide(seams.layer));

        assert.strictEqual(seams.calls.signals[0]?.token, null);
      })
    );

    it.effect("reports a refused signal as an unsignaled migration", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: { before_1: { value: "ok" } },
          sendWaitSignal: () =>
            Effect.fail(
              new InngestError({ cause: new Error("temporarily offline") })
            ),
        });

        const result = yield* migrateExecutions({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
          executionIds: ["exec_1"],
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(result.outcomes, [
          { executionId: "exec_1", status: "migrated", signaled: false },
        ]);
        assert.strictEqual(seams.calls.auditEvents.length, 1);
      })
    );

    it.effect("refuses a run whose guarded pointer move changed no row", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: { before_1: { value: "ok" } },
          repinned: false,
        });

        const result = yield* migrateExecutions({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
          executionIds: ["exec_1"],
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(result.outcomes, [
          {
            executionId: "exec_1",
            status: "refused",
            reason: "not_requested_version",
          },
        ]);
        assert.deepStrictEqual(seams.calls.order, ["repin"]);
      })
    );

    it.effect("migrates a run whose audit write was refused", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: { before_1: { value: "ok" } },
          recordAuditEvent: () =>
            Effect.fail(
              new DatabaseError({ cause: new Error("write failed") })
            ),
        });

        const result = yield* migrateExecutions({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
          executionIds: ["exec_1"],
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(result.outcomes, [
          { executionId: "exec_1", status: "migrated", signaled: true },
        ]);
        assert.deepStrictEqual(seams.calls.order, ["repin", "signal", "audit"]);
      })
    );

    it.effect(
      "refuses one run that left the in-flight list since the preview",
      () =>
        Effect.gen(function* () {
          const seams = makeMigrationSeams({
            executions: [inFlightRow({ id: "exec_1" })],
            waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
            nodeOutputs: { before_1: { value: "ok" } },
            workflowIdByExecution: { exec_ended: WORKFLOW_ID },
          });

          const result = yield* migrateExecutions({
            workflowId: WORKFLOW_ID,
            targetVersionId: TARGET_VERSION_ID,
            executionIds: ["exec_1", "exec_ended"],
          }).pipe(Effect.provide(seams.layer));

          assert.deepStrictEqual(result.outcomes, [
            { executionId: "exec_1", status: "migrated", signaled: true },
            {
              executionId: "exec_ended",
              status: "refused",
              reason: "not_requested_version",
            },
          ]);
        })
    );

    it.effect("reports a run already on the target as already current", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [
            inFlightRow({
              id: "exec_1",
              workflowVersionId: TARGET_VERSION_ID,
              versionNumber: 2,
            }),
          ],
        });

        const result = yield* migrateExecutions({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
          executionIds: ["exec_1"],
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(result.outcomes, [
          { executionId: "exec_1", status: "already_current" },
        ]);
        assert.deepStrictEqual(seams.calls.order, []);
      })
    );

    it.effect(
      "reclassifies each named run rather than trusting the preview",
      () =>
        Effect.gen(function* () {
          const seams = makeMigrationSeams({
            executions: [inFlightRow({ id: "exec_1", status: "running" })],
          });

          const result = yield* migrateExecutions({
            workflowId: WORKFLOW_ID,
            targetVersionId: TARGET_VERSION_ID,
            executionIds: ["exec_1"],
          }).pipe(Effect.provide(seams.layer));

          assert.deepStrictEqual(result.outcomes, [
            { executionId: "exec_1", status: "refused", reason: "executing" },
          ]);
          assert.deepStrictEqual(seams.calls.order, []);
        })
    );

    it.effect("refuses the whole call for a run of another workflow", () =>
      Effect.gen(function* () {
        const seams = makeMigrationSeams({
          executions: [inFlightRow({ id: "exec_1" })],
          waitStates: [waitRow({ id: "wait_row_1", executionId: "exec_1" })],
          nodeOutputs: { before_1: { value: "ok" } },
        });

        const failure = yield* migrateExecutions({
          workflowId: WORKFLOW_ID,
          targetVersionId: TARGET_VERSION_ID,
          executionIds: ["exec_1", "exec_elsewhere"],
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.strictEqual(failure._tag, "InvalidInput");
        assert.deepStrictEqual(seams.calls.order, []);
      })
    );
  });
});
