/**
 * What the delivery cases share: a catalog of host and integration Events, the
 * graphs the cases publish, and a harness over one case's database whose
 * passes and loops run on an app runtime built on it. `delivery-loop-cases.ts`
 * drives deliveries through the worker loop on the wall clock, and
 * `delivery-crash-cases.ts` drives passes one at a time on a clock the case
 * moves past a lease.
 */

import { afterEach } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { ExecutionScheduleKind } from "@wfgraph/shared/lifecycle/execution-schedule";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { defineAction } from "#src/backend/extensions/define-action";
import { defineEvent } from "#src/backend/extensions/define-event";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import {
  createWfGraphRuntime,
  type WfGraphRuntime,
} from "#src/backend/runtime";
import { deliveryBody } from "#src/backend/executor/delivery-body";
import { leasedPass, type PassResult } from "#src/backend/executor/pass";
import { runBody } from "#src/backend/executor/run-body";
import {
  actionNode,
  CANCEL_EVENT,
  edge,
  lifecycleNode,
  LOOP_SETTINGS,
  onEvent,
  publishWorkflow,
  START_EVENT,
  waitNode,
} from "#src/backend/executor/testing/run-fixtures";
import { waitUntil } from "#src/backend/executor/testing/waiting";
import { runWorkerLoop } from "#src/backend/executor/worker-loop";
import type {
  CaseDatabase,
  ConformanceConnection,
} from "#src/backend/persistence/conformance/support";
import {
  ExecutionRepo,
  type InboxEvent,
} from "#src/backend/services/executions/repo";
import { ownershipLost } from "#src/backend/services/executions/repo/fencing";
import { sendEvent } from "#src/backend/services/executions/send-event";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { receiveWebhook } from "#src/backend/services/integrations/webhook-intake";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

export const LEASE_MS = 60_000;

export const WEBHOOK_SOURCE = "vendor/webhook";
export const VENDOR_BOOKED = "vendor/booked";
export const ACME_WEBHOOK = "acme/webhook";
export const ACME_BOOKED = "acme/booked";
/** The header the `acme` webhook reads the vendor's message id from. */
const ACME_MESSAGE_ID = "x-acme-message-id";

/** The `test/mark` nodes that ran, by node id, in the order they ran. */
let marks: string[] = [];

const appointment = Schema.Struct({ appointmentId: Schema.String });

export const extensions = assembleExtensions({
  events: [
    defineEvent({
      name: START_EVENT,
      schema: appointment,
      correlationPath: "appointmentId",
    }),
    defineEvent({
      name: CANCEL_EVENT,
      schema: appointment,
      correlationPath: "appointmentId",
    }),
    // Two Events on one webhook source, told apart by `type`.
    defineEvent({
      name: VENDOR_BOOKED,
      schema: Schema.Struct({
        type: Schema.String,
        appointmentId: Schema.String,
      }),
      correlationPath: "appointmentId",
      source: {
        event: WEBHOOK_SOURCE,
        when: { path: "type", equals: "booked" },
      },
    }),
    defineEvent({
      name: "vendor/cancelled",
      schema: Schema.Struct({
        type: Schema.String,
        appointmentId: Schema.String,
      }),
      correlationPath: "appointmentId",
      source: {
        event: WEBHOOK_SOURCE,
        when: { path: "type", equals: "cancelled" },
      },
    }),
  ],
  // An integration whose webhook accepts every signature and records each
  // message under the vendor's id.
  integrations: [
    defineIntegration({
      type: "acme",
      label: "Acme",
      description: "Books appointments",
      credentials: {},
      actions: {},
      events: [
        defineEvent({
          name: ACME_BOOKED,
          schema: appointment,
          correlationPath: "appointmentId",
          source: { event: ACME_WEBHOOK },
        }),
      ],
      webhook: {
        source: ACME_WEBHOOK,
        verify: () => Effect.void,
        receive: (body, headers) => ({
          data: body,
          id: headers.get(ACME_MESSAGE_ID) ?? undefined,
        }),
      },
    }),
  ],
  actions: [
    defineAction({
      id: "test/send",
      label: "Send",
      description: "Runs one durable step",
      input: Schema.Struct({}),
      handler: async ({ step }) => {
        await step.run("dispatch", () => Promise.resolve(null));
        return { sent: true };
      },
    }),
    defineAction({
      id: "test/mark",
      label: "Mark",
      description: "Records that it ran",
      input: Schema.Struct({}),
      handler: async ({ step, nodeId }) => {
        await step.run("mark", () => {
          marks.push(nodeId);
          return Promise.resolve(null);
        });
        return {};
      },
    }),
  ],
});

const catalogFingerprint = createWorkflowActions(
  extensions,
  stubWfGraphRuntime()
).catalogFingerprint();

/**
 * Lifecycle Rules that start on `startEvent` and cancel on `CANCEL_EVENT`,
 * with the Connection each integration Event must arrive through.
 */
function rules(
  startEvent: string,
  connectionIds?: Record<string, string>
): JsonObject {
  return {
    lifecycleRules: omitUndefined({
      concurrency: "unlimited",
      startEvents: [startEvent],
      cancelEvents: [CANCEL_EVENT],
      allowManualStart: true,
      connectionIds,
    }),
  };
}

/** Entry, then one action that completes the run. */
export function startsAndSends(
  startEvent: string,
  connectionIds?: Record<string, string>
): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode(rules(startEvent, connectionIds)),
      actionNode("send", "test/send"),
    ],
    edges: [edge("entry", "send", "started")],
  });
}

/**
 * Entry; both sides wait on the Cancel Event. A run parked on `hold` is what
 * gives the workflow its wait role when a Cancel Event arrives, so the
 * delivery offers the arrival to the workflow's parked Waits. The Canceled
 * side waits once more before it marks `outlet`.
 */
export const holdsUntilCanceled = createSerializedWorkflowGraph({
  nodes: [
    lifecycleNode(rules(START_EVENT)),
    waitNode("hold", onEvent(CANCEL_EVENT, "1h")),
    waitNode("canceled_wait", onEvent(CANCEL_EVENT, "1h")),
    actionNode("outlet", "test/mark"),
  ],
  edges: [
    edge("entry", "hold", "started"),
    edge("entry", "canceled_wait", "canceled"),
    edge("canceled_wait", "outlet"),
  ],
});

/**
 * A worker whose memo write for the first lifecycle step answers as a lost
 * lease, after the step's own write committed: what a worker that died
 * between the two leaves behind.
 */
export function crashBeforeLifecycleMemo(): (
  repo: ExecutionRepo["Service"]
) => ExecutionRepo["Service"] {
  let crashed = false;
  return (repo) => ({
    ...repo,
    fencedDelivery: (fence) => {
      const writes = repo.fencedDelivery(fence);
      return {
        ...writes,
        writeStepMemo: (input) => {
          if (crashed || !input.stepId.startsWith("lifecycle-")) {
            return writes.writeStepMemo(input);
          }
          crashed = true;
          return Effect.fail(ownershipLost());
        },
      };
    },
  });
}

export type DeliveryHarness = {
  database: CaseDatabase;
  connection: ConformanceConnection;
  /** The app's runtime over the case's database, which every pass runs on. */
  app: WfGraphRuntime;
  /** The `test/mark` nodes that ran, by node id, in the order they ran. */
  marks: () => string[];
  /** The case's clock: the wall clock, moved forward by `advance`. */
  now: () => Date;
  /** Moves the case's clock forward. */
  advance: (ms: number) => void;
  /** Publishes `graph` as a workflow subscribed to the Events it names. */
  publish: (
    workflowId: string,
    graph: SerializedWorkflowGraph
  ) => Promise<void>;
  /** Sends an arrival into the inbox, as a source does. */
  send: (input: {
    name: string;
    data: JsonObject;
    idempotencyKey?: string | undefined;
  }) => Promise<{ inboxId: string; duplicate: boolean }>;
  /** Sends an Event as a host does, through `sendEvent` on the app's runtime. */
  sendEvent: (input: {
    name: string;
    data: JsonObject;
    id?: string | undefined;
  }) => Promise<{ id: string; duplicate: boolean }>;
  /** Stores an `acme` Connection, answering its id. */
  addConnection: (name: string) => Promise<string>;
  /** Posts `data` to one `acme` Connection's webhook under a vendor id. */
  webhook: (input: {
    connectionId: string;
    vendorId: string;
    data: JsonObject;
  }) => Promise<{ inboxId: string; duplicate: boolean }>;
  inbox: (inboxId: string) => Promise<InboxEvent | null>;
  /** Every run of one workflow, newest first. */
  runs: (workflowId: string) => Promise<{ id: string; status: string }[]>;
  /** The run one delivery opened in one workflow, or null. */
  runOf: (
    workflowId: string,
    deliveryId: string
  ) => Promise<{ id: string; status: string } | null>;
  /** Runs a worker loop until `stop`, polling every 20 ms. */
  loop: () => { stop: () => Promise<void> };
  /**
   * Claims every row due on the case's clock and runs one pass over each,
   * in claim order, until a claim finds none.
   */
  drain: (options?: PassOptions) => Promise<PassResult[]>;
  /**
   * Claims one due row, a delivery before a run as the loop's lanes order
   * them, and runs one pass over it, or answers null.
   */
  passOnce: (options?: PassOptions) => Promise<PassResult | null>;
};

/** How one worker of a case sees the repositories its passes run on. */
export type PassOptions = {
  wrap?:
    | ((repo: ExecutionRepo["Service"]) => ExecutionRepo["Service"])
    | undefined;
  wrapWorkflows?:
    | ((repo: WorkflowRepo["Service"]) => WorkflowRepo["Service"])
    | undefined;
  /** The loggers the pass writes its records to, in place of the app's. */
  logger?: Layer.Layer<never> | undefined;
};

/**
 * Answers how a case opens its harness on a fresh database. Call it inside
 * the `describe` whose cases use it: it registers the hook that disposes each
 * case's app runtime.
 */
export function useDeliveryHarness(
  openDatabase: () => Promise<CaseDatabase>
): () => Promise<DeliveryHarness> {
  /** The case's clock: the wall clock, moved forward by what the case adds. */
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);

  // Registered after the registry's own hooks, so each runtime is disposed
  // before the connection under it closes.
  const runtimes: WfGraphRuntime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  });

  return async () => {
    offsetMs = 0;
    marks = [];
    const database = await openDatabase();
    const connection = await database.open();
    const app = createWfGraphRuntime({
      extensions,
      appContext: { apiBasePath: "/api" },
      agent: { enabled: false },
      repositories: connection.repositories,
      wakes: [],
    });
    runtimes.push(app);
    const actions = createWorkflowActions(extensions, app);
    const bodies = {
      run: runBody({ actions: () => actions }),
      delivery: deliveryBody(),
    };

    const passOnce: DeliveryHarness["passOnce"] = async (options = {}) =>
      await app.runPromise(
        Effect.gen(function* () {
          const repo = yield* ExecutionRepo;
          const workflows = yield* WorkflowRepo;
          const worker = options.wrap?.(repo) ?? repo;
          const claimOne = (kind: ExecutionScheduleKind) =>
            worker.claimDue({
              lanes: [{ kind, limit: 1 }],
              workerId: "worker_1",
              leaseMs: LEASE_MS,
              now: now(),
            });
          const deliveries = yield* claimOne("delivery");
          const [claimed] =
            deliveries.length > 0 ? deliveries : yield* claimOne("run");
          if (!claimed) return null;
          return yield* leasedPass(claimed, bodies, {
            workerId: "worker_1",
            now,
            leaseMs: LEASE_MS,
            backoffMs: () => 0,
          }).pipe(
            Effect.provideService(ExecutionRepo, worker),
            Effect.provideService(
              WorkflowRepo,
              options.wrapWorkflows?.(workflows) ?? workflows
            ),
            Effect.provide(options.logger ?? Layer.empty)
          );
        })
      );

    return {
      database,
      connection,
      app,
      marks: () => marks,
      now,
      advance: (ms) => {
        offsetMs += ms;
      },
      publish: (workflowId, graph) =>
        connection.run(
          publishWorkflow({
            workflowId,
            versionId: `${workflowId}_v1`,
            graph,
            catalogFingerprint,
            subscribe: true,
          })
        ),
      send: (input) =>
        connection.run(
          Effect.flatMap(ExecutionRepo, (executions) =>
            executions.insertInboxEvent({
              name: input.name,
              data: input.data,
              connectionId: null,
              idempotencyKey: input.idempotencyKey ?? null,
              now: now(),
            })
          )
        ),
      sendEvent: (input) => app.runPromise(sendEvent(input)),
      addConnection: (name) =>
        connection.run(
          Effect.flatMap(IntegrationRepo, (integrations) =>
            integrations
              .insert({ name, type: "acme", config: {} })
              .pipe(Effect.map((stored) => stored.id))
          )
        ),
      webhook: async (input) => {
        const received = await app.runPromise(
          receiveWebhook({
            type: "acme",
            connectionId: input.connectionId,
            rawBody: JSON.stringify(input.data),
            headers: new Headers({ [ACME_MESSAGE_ID]: input.vendorId }),
          })
        );
        if (received.kind !== "received") {
          throw new Error("The acme webhook ignored a message");
        }
        return { inboxId: received.inboxId, duplicate: received.duplicate };
      },
      inbox: (inboxId) =>
        connection.run(
          Effect.flatMap(ExecutionRepo, (executions) =>
            executions.findInboxEvent(inboxId)
          )
        ),
      runs: (workflowId) =>
        connection.run(
          Effect.flatMap(ExecutionRepo, (executions) =>
            executions
              .listPage({ workflowIds: [workflowId], limit: 50 })
              .pipe(
                Effect.map((page) =>
                  page.map((row) => ({ id: row.id, status: row.status }))
                )
              )
          )
        ),
      runOf: (workflowId, deliveryId) =>
        connection.run(
          Effect.flatMap(ExecutionRepo, (executions) =>
            executions
              .findByDelivery({ workflowId, deliveryId })
              .pipe(
                Effect.map((row) =>
                  row === null ? null : { id: row.id, status: row.status }
                )
              )
          )
        ),
      loop: () => {
        const controller = new AbortController();
        const done = app.runPromise(
          runWorkerLoop({
            actions: () => actions,
            ...LOOP_SETTINGS,
            signal: controller.signal,
            pollMs: 20,
          })
        );
        return {
          stop: async () => {
            controller.abort();
            await done;
          },
        };
      },
      drain: async (options) => {
        const results: PassResult[] = [];
        for (let passes = 0; passes < 50; passes += 1) {
          // eslint-disable-next-line eslint/no-await-in-loop -- one pass at a time, in claim order
          const result = await passOnce(options);
          if (result === null) return results;
          results.push(result);
        }
        throw new Error("The rows were still due after 50 passes");
      },
      passOnce,
    };
  };
}

/** Waits until a run of `workflowId` has ended, answering its id. */
export async function endedRun(
  harness: DeliveryHarness,
  workflowId: string
): Promise<string> {
  let ended: string | undefined;
  await waitUntil(async () => {
    const [run] = await harness.runs(workflowId);
    if (
      run === undefined ||
      IN_FLIGHT_EXECUTION_STATUSES.some((status) => status === run.status)
    ) {
      return false;
    }
    ended = run.id;
    return true;
  }, `No run of ${workflowId} ended`);
  if (ended === undefined) throw new Error("Unreachable");
  return ended;
}

/** Waits until the inbox row has settled, answering it. */
export async function settled(
  harness: DeliveryHarness,
  inboxId: string
): Promise<InboxEvent> {
  let row: InboxEvent | null = null;
  await waitUntil(async () => {
    row = await harness.inbox(inboxId);
    return row !== null && row.status !== "pending";
  }, `Inbox row ${inboxId} never settled`);
  if (row === null) throw new Error("Unreachable");
  return row;
}
