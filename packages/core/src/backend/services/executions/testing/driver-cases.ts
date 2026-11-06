/**
 * The database `ExecutionDriver` on one persistence backend: what each method
 * writes, and which loops it wakes. A runner per backend calls
 * `describeExecutionDriverCases`, so every backend answers the same assertions;
 * a backend whose broadcast carries wakes across processes also runs the cases that
 * stand two apps on one database.
 *
 * Loops run on the wall clock with a 30 s poll, so a run they act on within a
 * second was reached by a wake.
 */

import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import { defineAction } from "#src/backend/extensions/define-action";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import {
  actionNode,
  CANCEL_EVENT,
  CANCELABLE,
  delay,
  edge,
  lifecycleNode,
  publishWorkflow,
  START_EVENT,
  waitNode,
} from "#src/backend/executor/testing/run-fixtures";
import { runWorkerLoop } from "#src/backend/executor/worker-loop";
import {
  createWorkerWake,
  type WorkerWake,
} from "#src/backend/executor/worker-wake";
import {
  type ConformanceConnection,
  usePersistenceRegistry,
} from "#src/backend/persistence/conformance/support";
import type { PersistenceConformanceHarness } from "#src/backend/persistence/persistence-conformance-test-support";
import {
  ExecutionDriver,
  makeExecutionDriverLayer,
} from "#src/backend/services/executions/driver";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

/** When each `test/mark` node ran, by node id. */
let marks = new Map<string, number>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const actions = createWorkflowActions(
  assembleExtensions({
    actions: [
      defineAction({
        id: "test/mark",
        label: "Mark",
        description: "Records when it ran",
        input: Schema.Struct({}),
        handler: async ({ step, nodeId }) => {
          await step.run("mark", () => {
            if (!marks.has(nodeId)) marks.set(nodeId, Date.now());
            return Promise.resolve(null);
          });
          return {};
        },
      }),
    ],
  }),
  stubWfGraphRuntime()
);

/** Entry, then a node that records when the run got there. */
const markGraph = createSerializedWorkflowGraph({
  nodes: [lifecycleNode(), actionNode("after", "test/mark")],
  edges: [edge("entry", "after", "started")],
});

/** Entry, a 60 s delay, and a Canceled outlet that records when it ran. */
const cancelableWaitGraph = createSerializedWorkflowGraph({
  nodes: [
    lifecycleNode(CANCELABLE),
    waitNode("wait", delay("60s")),
    actionNode("outlet", "test/mark"),
  ],
  edges: [
    edge("entry", "wait", "started"),
    edge("entry", "outlet", "canceled"),
  ],
});

/** A poll no case outlasts, so a loop that acted was woken. */
const LONG_POLL_MS = 30_000;

/** How long a case waits for a state before it fails. */
const REACHED_WITHIN_MS = 10_000;

/** Resolves once `reached` answers true, polling every 10 ms, or rejects. */
async function waitUntil(
  reached: () => boolean | Promise<boolean>,
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

/** A `WorkerWake` that also counts how many times it was called. */
function countedWake(): { wake: WorkerWake; calls: () => number } {
  const wake = createWorkerWake();
  let calls = 0;
  wake.subscribe(() => {
    calls += 1;
  });
  return { wake, calls: () => calls };
}

export function describeExecutionDriverCases(
  harness: PersistenceConformanceHarness & {
    /** Whether the backend's broadcast reaches loops in other processes. */
    crossProcess: boolean;
  }
): void {
  const title = `database execution driver on ${harness.backend}`;
  if (harness.skip !== undefined) {
    describe.skip(`${title} (${harness.skip})`, () => {
      it("runs every execution driver case", () => {
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
    describeCases(registry.openConnection);
    if (harness.crossProcess) {
      describeCrossProcessCases(registry.openDatabase);
    }
  });
}

let workflows = 0;

/** One app's view of the database: its connection and its driver. */
type App = {
  connection: ConformanceConnection;
  /** The in-process wake this app's driver calls, and how often it did. */
  worker: ReturnType<typeof countedWake>;
  /** Runs `effect` with this app's driver. */
  drive: <A, E>(
    effect: Effect.Effect<A, E, ExecutionDriver | ExecutionRepo>
  ) => Promise<A>;
  /** Publishes `graph` as a new workflow, ready for a run to start. */
  publish: (graph: SerializedWorkflowGraph) => Promise<PublishedWorkflow>;
  /** Publishes `graph` and starts one run of it through this app's driver. */
  startRun: (graph: SerializedWorkflowGraph) => Promise<StartedRun>;
  /** Starts a loop on this connection that `worker` wakes. */
  loop: (options?: { onClaim?: (executionIds: string[]) => void }) => {
    stop: () => Promise<void>;
  };
  /** Resolves once the run is no longer in flight, answering its status. */
  ended: (executionId: string) => Promise<string | undefined>;
};

type PublishedWorkflow = {
  workflowId: string;
  versionId: string;
  entityValue: string;
};

type StartedRun = PublishedWorkflow & { executionId: string };

/**
 * Starts one run of `workflow` the way an Event delivery does, through the
 * driver, and answers its id. A start naming the same `deliveryId` again is a
 * retried delivery.
 */
function startOn(workflow: PublishedWorkflow, deliveryId?: string) {
  return Effect.gen(function* () {
    const driver = yield* ExecutionDriver;
    const started = yield* driver.startRun({
      execution: {
        workflowId: workflow.workflowId,
        workflowVersionId: workflow.versionId,
        startSource: "event",
        startEventName: START_EVENT,
        runMode: "live",
        entityValue: workflow.entityValue,
        deliveryId,
        input: {},
      },
      concurrency: "unlimited",
      supersededReason: "newer start",
      startedEntry: { message: "Event-triggered run started", metadata: {} },
    });
    if (started.status !== "started") throw new Error("Start refused");
    return started.execution.id;
  });
}

function appOn(connection: ConformanceConnection): App {
  marks = new Map();
  const worker = countedWake();
  const { broadcast } = connection.capabilities;
  const driver = makeExecutionDriverLayer(
    broadcast === undefined ? [worker.wake] : [worker.wake, broadcast]
  );
  const findStatus = (executionId: string) =>
    connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.findSummaryById(executionId)
      )
    );

  const drive: App["drive"] = (effect) =>
    connection.run(effect.pipe(Effect.provide(driver)));
  const publish = async (
    graph: SerializedWorkflowGraph
  ): Promise<PublishedWorkflow> => {
    workflows += 1;
    const workflow = {
      workflowId: `wf_driver_${workflows}`,
      versionId: `ver_driver_${workflows}`,
      entityValue: `entity_${workflows}`,
    };
    await connection.run(
      publishWorkflow({
        workflowId: workflow.workflowId,
        versionId: workflow.versionId,
        graph,
        catalogFingerprint: actions.catalogFingerprint(),
      })
    );
    return workflow;
  };

  return {
    connection,
    worker,
    drive,
    publish,
    startRun: async (graph) => {
      const workflow = await publish(graph);
      const executionId = await drive(startOn(workflow));
      return { ...workflow, executionId };
    },
    loop: ({ onClaim } = {}) => {
      const controller = new AbortController();
      const done = connection.run(
        Effect.gen(function* () {
          const repo = yield* ExecutionRepo;
          const observed: ExecutionRepo["Service"] = {
            ...repo,
            claimDue: (input) =>
              repo
                .claimDue(input)
                .pipe(
                  Effect.tap((claimed) =>
                    Effect.sync(() =>
                      onClaim?.(claimed.map((row) => row.executionId))
                    )
                  )
                ),
          };
          yield* runWorkerLoop({
            actions: () => actions,
            signal: controller.signal,
            pollMs: LONG_POLL_MS,
            wake: worker.wake,
          }).pipe(Effect.provideService(ExecutionRepo, observed));
        })
      );
      return {
        stop: async () => {
          controller.abort();
          await done;
        },
      };
    },
    ended: async (executionId) => {
      let status: string | undefined;
      await waitUntil(async () => {
        status = (await findStatus(executionId))?.status;
        return !IN_FLIGHT_EXECUTION_STATUSES.some(
          (inFlight) => inFlight === status
        );
      }, `Run ${executionId} did not end`);
      return status;
    },
  };
}

/** Claims every due row for one worker, as a loop's drain step would. */
const claimAll = Effect.flatMap(ExecutionRepo, (executions) =>
  executions.claimDue({
    workerId: "worker_case",
    limit: 10,
    leaseMs: 60_000,
    now: new Date(),
  })
);

function describeCases(
  openConnection: () => Promise<ConformanceConnection>
): void {
  it("opens a run with its schedule row due now, wakes the loop once the start commits, and leaves the row alone on a retried delivery", async () => {
    const app = appOn(await openConnection());
    const workflow = await app.publish(markGraph);

    const result = await app.drive(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const executionId = yield* startOn(workflow, "delivery_1");
        const queued = yield* executions.findSchedule({ executionId });
        const wakesAfterStart = app.worker.calls();
        const [claimed] = yield* claimAll;
        const retried = yield* startOn(workflow, "delivery_1");
        return {
          executionId,
          queued,
          wakesAfterStart,
          claimed,
          retried,
          again: yield* executions.findSchedule({ executionId }),
        };
      })
    );

    expect(result.queued).toMatchObject({ kind: "run", state: "queued" });
    expect(result.queued?.wakeAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(result.wakesAfterStart).toBe(1);
    // The retry answered the same run and left the leased row as the claim
    // wrote it.
    expect(result.retried).toBe(result.executionId);
    expect(result.again).toMatchObject({
      state: "leased",
      ownerToken: result.claimed?.ownerToken,
    });
  });

  it("re-queues a waiting run when a Cancel claim resolves its park and wakes an in-process loop well before its poll", async () => {
    const app = appOn(await openConnection());
    const run = await app.startRun(cancelableWaitGraph);
    const loop = app.loop();
    await waitUntil(
      async () =>
        (
          await app.connection.run(
            Effect.flatMap(ExecutionRepo, (executions) =>
              executions.findSchedule({ executionId: run.executionId })
            )
          )
        )?.state === "waiting",
      "The run did not park"
    );
    // The release that parked the run made the loop claim once more. Once that
    // claim has ended, the loop sleeps until its next poll, 30 s away.
    await sleep(100);
    const wakesBefore = app.worker.calls();

    const cancel = Effect.flatMap(ExecutionDriver, (driver) =>
      driver.requestCanceledOutlet({
        workflowId: run.workflowId,
        runMode: "live",
        entityValue: run.entityValue,
        eventName: CANCEL_EVENT,
        payload: {},
      })
    );
    const claims = await app.drive(cancel);
    const wokenAt = Date.now();

    expect(await app.ended(run.executionId)).toBe("canceled");
    await loop.stop();
    expect(claims).toEqual([
      { executionId: run.executionId, resolvedParks: 1, requeued: true },
    ]);
    expect(app.worker.calls()).toBe(wakesBefore + 1);
    // Well inside the poll, with a second of slack for a loaded machine.
    expect((marks.get("outlet") ?? Number.NaN) - wokenAt).toBeLessThan(1_000);

    // The first Cancel Event owns the run, so a second claims nothing and
    // wakes no one.
    expect(await app.drive(cancel)).toEqual([]);
    expect(app.worker.calls()).toBe(wakesBefore + 1);
  }, 30_000);

  it("leaves a leased run's row to its pass's release and wakes no loop when an Event claims its park", async () => {
    const app = appOn(await openConnection());
    const run = await app.startRun(markGraph);

    const result = await app.drive(
      Effect.gen(function* () {
        const driver = yield* ExecutionDriver;
        const executions = yield* ExecutionRepo;
        yield* claimAll;
        const wait = yield* executions.startWait({
          side: "started",
          executionId: run.executionId,
          workflowId: run.workflowId,
          nodeId: "wait",
          nodeName: "wait",
          workflowVersionId: run.versionId,
          waitType: "event",
          resumeToken: `${run.executionId}-wait`,
          waitUntil: new Date(Date.now() + 60_000),
          subscribedEvents: ["appointment/approved"],
        });
        if (!wait) throw new Error("The park was refused");
        const wakesBefore = app.worker.calls();
        const resolution = yield* driver.resolvePark({
          target: { kind: "resume_token", token: `${run.executionId}-wait` },
          payload: { approved: true },
        });
        return {
          resolution,
          wakes: app.worker.calls() - wakesBefore,
          park: yield* executions.findPark(wait.waitStateId),
          schedule: yield* executions.findSchedule({
            executionId: run.executionId,
          }),
        };
      })
    );

    expect(result.resolution).toMatchObject({
      waitState: { status: "resuming" },
      requeued: false,
    });
    expect(result.wakes).toBe(0);
    expect(result.park).toMatchObject({
      wake: { kind: "resume", eventName: null, payload: { approved: true } },
    });
    expect(result.schedule?.state).toBe("leased");
  });

  // A producer's re-queue pulls a queued row's `wake_at` forward, so a run
  // waiting out a retry backoff acts on a Cancel Event at once rather than
  // when its backoff ends.
  it("makes a run in a retry backoff due at once when a Cancel claim lands, and wakes the loop", async () => {
    const app = appOn(await openConnection());
    const run = await app.startRun(markGraph);

    const result = await app.drive(
      Effect.gen(function* () {
        const driver = yield* ExecutionDriver;
        const executions = yield* ExecutionRepo;
        const claimed = (yield* claimAll).find(
          (row) => row.executionId === run.executionId
        );
        if (claimed === undefined) throw new Error("The run was not claimed");
        yield* executions
          .fenced({
            scheduleId: claimed.scheduleId,
            executionId: run.executionId,
            ownerToken: claimed.ownerToken,
          })
          .releasePass({
            outcome: {
              kind: "step_failed",
              stepId: "step_1",
              error: "vendor timed out",
              backoffMs: 60 * 60 * 1000,
            },
            now: new Date(),
          });
        const backoff = yield* executions.findSchedule({
          executionId: run.executionId,
        });
        const wakesBefore = app.worker.calls();
        const claims = yield* driver.requestCanceledOutlet({
          workflowId: run.workflowId,
          runMode: "live",
          entityValue: run.entityValue,
          eventName: CANCEL_EVENT,
          payload: {},
        });
        return {
          backoff,
          claims,
          wakes: app.worker.calls() - wakesBefore,
          schedule: yield* executions.findSchedule({
            executionId: run.executionId,
          }),
        };
      })
    );

    expect(result.backoff?.state).toBe("queued");
    expect(result.backoff?.wakeAt.getTime()).toBeGreaterThan(
      Date.now() + 30 * 60 * 1000
    );
    expect(result.claims).toEqual([
      { executionId: run.executionId, resolvedParks: 0, requeued: true },
    ]);
    expect(result.wakes).toBe(1);
    expect(result.schedule?.state).toBe("queued");
    expect(result.schedule?.wakeAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
}

/**
 * Two apps on one database, as two processes would be: a producer whose
 * driver announces each run it makes due, and a consumer whose loop listens.
 */
function describeCrossProcessCases(
  openDatabase: () => Promise<{
    open: () => Promise<ConformanceConnection>;
  }>
): void {
  async function twoApps() {
    const database = await openDatabase();
    const producer = appOn(await database.open());
    const consumer = appOn(await database.open());
    const { broadcast } = consumer.connection.capabilities;
    if (broadcast === undefined) {
      throw new Error("The backend broadcasts no wakes across processes");
    }
    return { producer, consumer, broadcast };
  }

  it("wakes a loop in another process within about 200 ms of a run made due, with a 30 s poll", async () => {
    const { producer, consumer, broadcast } = await twoApps();
    const workflow = await producer.publish(markGraph);

    // The run is the only one on this workflow's database the loop can claim,
    // so the first claim that leases anything leases it.
    let claims = 0;
    let claimedAt = Number.NaN;
    const claimedIds: string[] = [];
    const listening = await broadcast.listen(() =>
      consumer.worker.wake.announce()
    );
    const loop = consumer.loop({
      onClaim: (executionIds) => {
        claims += 1;
        if (executionIds.length > 0 && claimedIds.length === 0) {
          claimedAt = Date.now();
        }
        claimedIds.push(...executionIds);
      },
    });
    // The loop's first claim finds nothing due, and the loop then sleeps for
    // its poll.
    await waitUntil(() => claims > 0, "The loop never claimed");
    await sleep(100);

    const executionId = await producer.drive(startOn(workflow));
    const startedAt = Date.now();

    expect(await consumer.ended(executionId)).toBe("completed");
    await loop.stop();
    await listening.stop();
    expect(claimedIds[0]).toBe(executionId);
    // A 50 ms flush, the notification, and the claim, with slack for a loaded
    // machine running other files against the same server.
    expect(claimedAt - startedAt).toBeLessThan(250);
  }, 30_000);

  it("sends a bounded number of notifications for a burst of 100 runs made due", async () => {
    const { producer, broadcast } = await twoApps();
    const published = await Promise.all(
      Array.from({ length: 100 }, () => producer.publish(markGraph))
    );

    let notifications = 0;
    const listening = await broadcast.listen(() => {
      notifications += 1;
    });
    const startedAt = Date.now();
    // One at a time, so the burst outlasts more than one flush.
    await producer.drive(
      Effect.forEach(published, (workflow) => startOn(workflow))
    );
    const burstMs = Date.now() - startedAt;
    // The last flush goes out 50 ms after the last run was made due.
    await sleep(300);
    await listening.stop();

    expect(producer.worker.calls()).toBe(100);
    expect(notifications).toBeGreaterThan(0);
    // At most one notification per 50 ms flush the burst spanned, and one more
    // for the flush still waiting when it ended.
    expect(notifications).toBeLessThanOrEqual(Math.ceil(burstMs / 50) + 1);
    expect(notifications).toBeLessThan(100);
  }, 30_000);
}
