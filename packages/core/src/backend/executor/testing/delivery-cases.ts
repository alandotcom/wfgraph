/**
 * Event deliveries on the database executor, on one persistence backend: an
 * inbox row delivered by the worker loop, a duplicate send, a host send
 * through `sendEvent`, webhook intake through two Connections, a row a host
 * inserted itself, a webhook source told apart by its `source.when` filter, a
 * refused payload, a lifecycle step that spends its retries, and a crash
 * between a step and its memo row, alone and under a Cancel claim. A runner per
 * backend calls `describeDeliveryCases`, so every backend answers the same
 * assertions.
 *
 * The loop cases run on the wall clock and wait for the database to reach a
 * state. The crash cases drive passes with `claimDue` and `leasedPass` on a
 * clock the case moves past a lease, as `pass-cases.ts` does.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { defineAction } from "#src/backend/extensions/define-action";
import { defineEvent } from "#src/backend/extensions/define-event";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { defaultDeliverPorts } from "#src/backend/lib/inngest/event-listener-function";
import {
  createWfGraphRuntime,
  type WfGraphRuntime,
} from "#src/backend/runtime";
import {
  deliveryBody,
  type DeliverySettings,
} from "#src/backend/executor/delivery-body";
import {
  leasedPass,
  type PassBodies,
  type PassResult,
} from "#src/backend/executor/pass";
import { runBody } from "#src/backend/executor/run-body";
import {
  actionNode,
  CANCEL_EVENT,
  edge,
  lifecycleNode,
  onEvent,
  publishWorkflow,
  START_EVENT,
  waitNode,
} from "#src/backend/executor/testing/run-fixtures";
import { runWorkerLoop } from "#src/backend/executor/worker-loop";
import {
  type CaseDatabase,
  type ConformanceConnection,
  usePersistenceRegistry,
} from "#src/backend/persistence/conformance/support";
import type { PersistenceConformanceHarness } from "#src/backend/persistence/persistence-conformance-test-support";
import {
  ExecutionRepo,
  type InboxEvent,
} from "#src/backend/services/executions/repo";
import { ownershipLost } from "#src/backend/services/executions/repo/fencing";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { sendEvent } from "#src/backend/services/executions/send-event";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { receiveWebhook } from "#src/backend/services/integrations/webhook-intake";

const LEASE_MS = 60_000;
const WEBHOOK_SOURCE = "vendor/webhook";
const VENDOR_BOOKED = "vendor/booked";
const ACME_WEBHOOK = "acme/webhook";
const ACME_BOOKED = "acme/booked";
/** The header the `acme` webhook reads the vendor's message id from. */
const ACME_MESSAGE_ID = "x-acme-message-id";

/** The `test/mark` nodes that ran, by node id, in the order they ran. */
let marks: string[] = [];

const appointment = Schema.Struct({ appointmentId: Schema.String });

const extensions = assembleExtensions({
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
function startsAndSends(
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
const holdsUntilCanceled = createSerializedWorkflowGraph({
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

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long a loop case waits for the database to reach a state. */
const REACHED_WITHIN_MS = 10_000;

/** Resolves once `reached` answers true, polling every 10 ms, or rejects. */
async function waitUntil(
  reached: () => Promise<boolean>,
  what: string
): Promise<void> {
  const giveUpAt = Date.now() + REACHED_WITHIN_MS;
  // eslint-disable-next-line eslint/no-await-in-loop -- one check per tick until `reached` holds
  while (!(await reached())) {
    if (Date.now() > giveUpAt) {
      throw new Error(`${what} within ${REACHED_WITHIN_MS} ms`);
    }
    // eslint-disable-next-line eslint/no-await-in-loop -- one check per tick until `reached` holds
    await sleep(10);
  }
}

/**
 * A worker whose memo write for the first lifecycle step answers as a lost
 * lease, after the step's own write committed: what a worker that died
 * between the two leaves behind.
 */
function crashBeforeLifecycleMemo(): (
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

export function describeDeliveryCases(
  harness: PersistenceConformanceHarness
): void {
  const title = `database executor deliveries on ${harness.backend}`;
  if (harness.skip !== undefined) {
    describe.skip(`${title} (${harness.skip})`, () => {
      it("runs every delivery case", () => {
        // Skipped: there is no database to run them on.
      });
    });
    return;
  }
  describe(title, () => {
    const registry = usePersistenceRegistry(
      harness.createDatabase,
      harness.teardown
    );
    describeCases(registry.openDatabase);
  });
}

function describeCases(openDatabase: () => Promise<CaseDatabase>): void {
  /** The case's clock: the wall clock, moved forward by what the case adds. */
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);

  // Registered after the registry's own hooks, so each runtime is disposed
  // before the connection under it closes.
  const runtimes: WfGraphRuntime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  });

  type Harness = {
    database: CaseDatabase;
    connection: ConformanceConnection;
    delivery: DeliverySettings;
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
     * in claim order, over `bodies`, until a claim finds none.
     */
    drain: (
      bodies?: PassBodies<ExecutionRepo | WorkflowRepo>
    ) => Promise<PassResult[]>;
    /** Claims one due row and runs one pass over it, or answers null. */
    passOnce: (options?: {
      bodies?: PassBodies<ExecutionRepo | WorkflowRepo> | undefined;
      wrap?:
        | ((repo: ExecutionRepo["Service"]) => ExecutionRepo["Service"])
        | undefined;
    }) => Promise<PassResult | null>;
  };

  async function open(): Promise<Harness> {
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
    const delivery: DeliverySettings = {
      events: extensions.events,
      runtime: app,
    };
    const actions = createWorkflowActions(extensions, app);
    const bodies: PassBodies<ExecutionRepo | WorkflowRepo> = {
      run: runBody({ actions: () => actions }),
      delivery: deliveryBody(delivery),
    };

    const passOnce: Harness["passOnce"] = async (options = {}) =>
      await connection.run(
        Effect.gen(function* () {
          const repo = yield* ExecutionRepo;
          const worker = options.wrap?.(repo) ?? repo;
          const [claimed] = yield* worker.claimDue({
            workerId: "worker_1",
            limit: 1,
            leaseMs: LEASE_MS,
            now: now(),
          });
          if (!claimed) return null;
          return yield* leasedPass(claimed, options.bodies ?? bodies, {
            workerId: "worker_1",
            now,
            leaseMs: LEASE_MS,
            backoffMs: () => 0,
          }).pipe(Effect.provideService(ExecutionRepo, worker));
        })
      );

    return {
      database,
      connection,
      delivery,
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
        const done = connection.run(
          runWorkerLoop({
            actions: () => actions,
            delivery,
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
      drain: async (drainBodies) => {
        const results: PassResult[] = [];
        for (let passes = 0; passes < 50; passes += 1) {
          // eslint-disable-next-line eslint/no-await-in-loop -- one pass at a time, in claim order
          const result = await passOnce({ bodies: drainBodies });
          if (result === null) return results;
          results.push(result);
        }
        throw new Error("The rows were still due after 50 passes");
      },
      passOnce,
    };
  }

  /** Waits until a run of `workflowId` has ended, answering its id. */
  async function endedRun(
    harness: Harness,
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
  async function settled(
    harness: Harness,
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

  it("delivers an inbox row through the worker loop, opening a run that completes", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const sent = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_1" },
    });
    const loop = harness.loop();

    const row = await settled(harness, sent.inboxId);
    const runId = await endedRun(harness, "wf_start");
    await loop.stop();

    expect(row).toMatchObject({ status: "delivered" });
    expect(await harness.runs("wf_start")).toEqual([
      { id: runId, status: "completed" },
    ]);
    expect(await harness.runOf("wf_start", sent.inboxId)).toEqual({
      id: runId,
      status: "completed",
    });
    // The delivery's schedule row and memo went with its settling write.
    const left = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        Effect.all({
          schedule: executions.findSchedule({ inboxId: sent.inboxId }),
          memo: executions.listStepMemo({ inboxId: sent.inboxId }),
        })
      )
    );
    expect(left).toEqual({ schedule: null, memo: [] });
  });

  it("delivers a send repeated with the same idempotency key once", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const arrival = {
      name: START_EVENT,
      data: { appointmentId: "appt_2" },
      idempotencyKey: "booking_2",
    };
    const first = await harness.send(arrival);
    const second = await harness.send(arrival);
    const loop = harness.loop();

    await settled(harness, first.inboxId);
    await endedRun(harness, "wf_start");
    await loop.stop();

    expect(second).toEqual({ duplicate: true, inboxId: first.inboxId });
    expect(await harness.runs("wf_start")).toHaveLength(1);
  });

  it("records a host send through sendEvent, delivers it to a run that completes, and answers a repeated id with the first row", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const send = {
      name: START_EVENT,
      data: { appointmentId: "appt_sent" },
      id: "booking_sent",
    };
    const first = await harness.sendEvent(send);
    const again = await harness.sendEvent(send);
    const loop = harness.loop();

    const row = await settled(harness, first.id);
    const runId = await endedRun(harness, "wf_start");
    await loop.stop();

    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect(row).toMatchObject({
      status: "delivered",
      name: START_EVENT,
      data: { appointmentId: "appt_sent" },
      connectionId: null,
      idempotencyKey: "booking_sent",
    });
    expect(await harness.runs("wf_start")).toEqual([
      { id: runId, status: "completed" },
    ]);
    expect(await harness.runOf("wf_start", first.id)).toMatchObject({
      id: runId,
    });
  });

  it("records one inbox row per vendor id per Connection from webhook intake, and delivers each with its Connection", async () => {
    const harness = await open();
    const bound = await harness.addConnection("Acme bound");
    const other = await harness.addConnection("Acme other");
    // The workflow starts only on bookings that arrive through `bound`.
    await harness.publish(
      "wf_acme",
      startsAndSends(ACME_BOOKED, { [ACME_BOOKED]: bound })
    );
    const envelope = { appointmentId: "appt_hook" };
    const fromBound = await harness.webhook({
      connectionId: bound,
      vendorId: "msg_1",
      data: envelope,
    });
    const retried = await harness.webhook({
      connectionId: bound,
      vendorId: "msg_1",
      data: envelope,
    });
    // The vendor delivered the same message to a second Connection.
    const fromOther = await harness.webhook({
      connectionId: other,
      vendorId: "msg_1",
      data: envelope,
    });
    const loop = harness.loop();

    const boundRow = await settled(harness, fromBound.inboxId);
    const otherRow = await settled(harness, fromOther.inboxId);
    const runId = await endedRun(harness, "wf_acme");
    await loop.stop();

    expect(fromBound.duplicate).toBe(false);
    expect(retried).toEqual({ inboxId: fromBound.inboxId, duplicate: true });
    expect(fromOther.duplicate).toBe(false);
    expect(fromOther.inboxId).not.toBe(fromBound.inboxId);
    // The row keeps the vendor's envelope as sent, and the Connection in its
    // own column.
    expect(boundRow).toMatchObject({
      status: "delivered",
      name: ACME_WEBHOOK,
      data: envelope,
      connectionId: bound,
      idempotencyKey: "msg_1",
    });
    expect(otherRow).toMatchObject({
      status: "delivered",
      connectionId: other,
    });
    expect(await harness.runs("wf_acme")).toEqual([
      { id: runId, status: "completed" },
    ]);
    expect(await harness.runOf("wf_acme", fromBound.inboxId)).toMatchObject({
      id: runId,
    });
    expect(await harness.runOf("wf_acme", fromOther.inboxId)).toBeNull();
    const run = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.findSummaryById(runId)
      )
    );
    expect(run?.startEventName).toBe(ACME_BOOKED);
  });

  it("picks up a row a host inserted in its own transaction on the loop's poll", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    await harness.database.execute(
      `insert into workflow_event_inbox (id, name, data, idempotency_key, connection_id) values ('host_1', '${START_EVENT}', '{"appointmentId":"appt_3"}', null, null)`
    );
    const loop = harness.loop();

    const row = await settled(harness, "host_1");
    await endedRun(harness, "wf_start");
    await loop.stop();

    expect(row).toMatchObject({ status: "delivered" });
    expect(await harness.runs("wf_start")).toHaveLength(1);
    expect(await harness.runOf("wf_start", "host_1")).toMatchObject({
      status: "completed",
    });
  });

  it("delivers a row named after a webhook source as the Event whose source filter its data satisfies, and settles one no Event on the source accepts", async () => {
    const harness = await open();
    await harness.publish("wf_hook", startsAndSends(VENDOR_BOOKED));
    const booked = await harness.send({
      name: WEBHOOK_SOURCE,
      data: { type: "booked", appointmentId: "appt_4" },
    });
    const unknownType = await harness.send({
      name: WEBHOOK_SOURCE,
      data: { type: "rescheduled", appointmentId: "appt_4" },
    });
    const loop = harness.loop();

    await settled(harness, booked.inboxId);
    const unmatched = await settled(harness, unknownType.inboxId);
    const runId = await endedRun(harness, "wf_hook");
    await loop.stop();

    expect(unmatched).toMatchObject({ status: "delivered" });
    expect(await harness.runs("wf_hook")).toEqual([
      { id: runId, status: "completed" },
    ]);
    expect(await harness.runOf("wf_hook", booked.inboxId)).toMatchObject({
      id: runId,
    });
    const run = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.findSummaryById(runId)
      )
    );
    expect(run?.startEventName).toBe(VENDOR_BOOKED);
  });

  it("marks a row whose payload its Event refuses failed with the reason, and never schedules it again", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const refused = await harness.send({
      name: START_EVENT,
      data: { appointment: "appt_5" },
    });
    const unknown = await harness.send({
      name: "app/never.declared",
      data: { appointmentId: "appt_5" },
    });

    const results = await harness.drain();
    const afterwards = await harness.connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return {
          poll: yield* executions.scheduleUnscheduledInbox({
            now: now(),
            limit: 10,
          }),
          claim: yield* executions.claimDue({
            workerId: "worker_2",
            limit: 10,
            leaseMs: LEASE_MS,
            now: now(),
          }),
        };
      })
    );

    expect(results).toEqual([
      {
        kind: "unavailable",
        reason: "payload_refused",
        ending: "written",
        detail: expect.any(String),
      },
      {
        kind: "unavailable",
        reason: "unknown_event",
        ending: "written",
        detail: expect.any(String),
      },
    ]);
    const refusedRow = await harness.inbox(refused.inboxId);
    expect(refusedRow).toMatchObject({ status: "failed" });
    expect(refusedRow?.status === "failed" && refusedRow.error).toMatch(
      new RegExp(`^Payload refused for Event "${START_EVENT}": `)
    );
    // The stored reason names what the schema expects and quotes nothing of
    // what arrived.
    expect(JSON.stringify(refusedRow)).not.toMatch(/appt_5.*appt_5/);
    expect(await harness.inbox(unknown.inboxId)).toMatchObject({
      status: "failed",
    });
    expect(afterwards).toEqual({ poll: [], claim: [] });
    expect(await harness.runs("wf_start")).toEqual([]);
  });

  it("marks a delivery failed once its lifecycle step spends its retries", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const sent = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_6" },
    });
    let attempts = 0;
    const failing: PassBodies<ExecutionRepo | WorkflowRepo> = {
      run: runBody({
        actions: () =>
          createWorkflowActions(extensions, harness.delivery.runtime),
      }),
      delivery: deliveryBody({
        ...harness.delivery,
        deliver: {
          ...defaultDeliverPorts,
          applyLifecycle: () =>
            Effect.suspend(() => {
              attempts += 1;
              return Effect.fail(
                new DatabaseError({ cause: new Error("connection reset") })
              );
            }),
        },
      }),
    };

    const results = await harness.drain(failing);

    expect(results.map((result) => result.kind)).toEqual([
      "retry",
      "retry",
      "retry",
      "retry",
      "retries_spent",
      "run_failed",
    ]);
    expect(attempts).toBe(5);
    const row = await harness.inbox(sent.inboxId);
    expect(row).toMatchObject({ status: "failed" });
    const last = results.at(-1);
    expect(row?.status === "failed" && row.error).toBe(
      last?.kind === "run_failed" ? last.error : undefined
    );
    expect(
      await harness.connection.run(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.findSchedule({ inboxId: sent.inboxId })
        )
      )
    ).toBeNull();
    expect(await harness.runs("wf_start")).toEqual([]);
  });

  it("re-runs a lifecycle step whose memo row a crash lost without opening a second run", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const sent = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_7" },
    });

    const crashed = await harness.passOnce({
      wrap: crashBeforeLifecycleMemo(),
    });
    // The start committed, and the delivery's row stays leased to the worker
    // that died until its lease runs out.
    const afterCrash = await harness.runs("wf_start");
    offsetMs += LEASE_MS + 1;
    await harness.drain();

    expect(crashed).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(afterCrash).toHaveLength(1);
    expect(await harness.runs("wf_start")).toEqual([
      { id: afterCrash[0]?.id, status: "completed" },
    ]);
    expect(await harness.runOf("wf_start", sent.inboxId)).toMatchObject({
      id: afterCrash[0]?.id,
    });
    expect(await harness.inbox(sent.inboxId)).toMatchObject({
      status: "delivered",
    });
  });

  // The Canceled outlet parks a Wait on the very Event that claimed the run.
  // A delivery re-run after a crash between its claim and its memo row still
  // names the run it claimed, so that Wait is left for the next arrival.
  it("cancels a parked run once across a crash between the Cancel claim and its memo row, and leaves its Canceled-side Wait to the next arrival", async () => {
    const harness = await open();
    await harness.publish("wf_cancel", holdsUntilCanceled);
    await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_8" },
    });
    await harness.drain();
    const [parked] = await harness.runs("wf_cancel");
    if (parked === undefined) throw new Error("No run was started");

    const firstCancel = await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_8" },
    });
    const crashed = await harness.passOnce({
      wrap: crashBeforeLifecycleMemo(),
    });
    // The claimed run routes its Canceled outlet and parks on the Cancel
    // Event while the delivery's row is still leased to the worker that died.
    await harness.drain();
    const outletParked = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listWaitingStates(parked.id)
      )
    );
    offsetMs += LEASE_MS + 1;
    await harness.drain();

    const afterRetry = await harness.connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return {
          waiting: yield* executions.listWaitingStates(parked.id),
          events: yield* executions.listEvents(parked.id),
          termination: yield* executions.findTerminationState(parked.id),
        };
      })
    );

    expect(crashed).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(outletParked.map((wait) => wait.nodeId)).toEqual(["canceled_wait"]);
    expect(await harness.inbox(firstCancel.inboxId)).toMatchObject({
      status: "delivered",
    });
    // The re-run delivery found its own claim and woke nothing in the run.
    expect(afterRetry.waiting.map((wait) => wait.nodeId)).toEqual([
      "canceled_wait",
    ]);
    expect(afterRetry.termination?.claim).toMatchObject({
      kind: "cancel",
      eventName: CANCEL_EVENT,
    });
    expect(
      afterRetry.events.filter(
        (event) => event.eventType === "run_cancel_requested"
      )
    ).toHaveLength(1);
    expect(marks).toEqual([]);

    // A second arrival of the Cancel Event claims nothing, and wakes the Wait.
    await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_8" },
    });
    await harness.drain();

    expect(marks).toEqual(["outlet"]);
    expect(await harness.runs("wf_cancel")).toEqual([
      { id: parked.id, status: "canceled" },
    ]);
    const finalEvents = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listEvents(parked.id)
      )
    );
    expect(
      finalEvents.filter((event) => event.eventType === "run_cancel_requested")
    ).toHaveLength(1);
  });
}
