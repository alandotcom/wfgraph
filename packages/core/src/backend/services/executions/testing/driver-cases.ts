/**
 * The database `ExecutionDriver` on one persistence backend: what each method
 * writes, and which loops it wakes. A runner per backend calls
 * `describeExecutionDriverCases`, so every backend answers the same assertions;
 * a backend whose `wakes` broadcast across processes also runs the cases that
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
    /** Whether the backend's `wakes` reach loops in other processes. */
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
  /** Publishes `graph` as a new workflow and starts one run with no schedule row. */
  startRun: (graph: SerializedWorkflowGraph) => Promise<StartedRun>;
  /** Starts a loop on this connection that `worker` wakes. */
  loop: (options?: { onClaim?: (executionIds: string[]) => void }) => {
    stop: () => Promise<void>;
  };
  /** Resolves once the run is no longer in flight, answering its status. */
  ended: (executionId: string) => Promise<string | undefined>;
};

type StartedRun = {
  executionId: string;
  workflowId: string;
  versionId: string;
  entityValue: string;
};

function appOn(connection: ConformanceConnection): App {
  marks = new Map();
  const worker = countedWake();
  const driver = makeExecutionDriverLayer({
    worker: worker.wake,
    persistence: connection.wakes,
  });
  const findStatus = (executionId: string) =>
    connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.findSummaryById(executionId)
      )
    );

  return {
    connection,
    worker,
    drive: (effect) => connection.run(effect.pipe(Effect.provide(driver))),
    startRun: async (graph) => {
      workflows += 1;
      const workflowId = `wf_driver_${workflows}`;
      const versionId = `ver_driver_${workflows}`;
      const entityValue = `entity_${workflows}`;
      const executionId = await connection.run(
        Effect.gen(function* () {
          yield* publishWorkflow({
            workflowId,
            versionId,
            graph,
            catalogFingerprint: actions.catalogFingerprint(),
          });
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId,
              workflowVersionId: versionId,
              startSource: "event",
              startEventName: START_EVENT,
              runMode: "live",
              entityValue,
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started") throw new Error("Start refused");
          return started.execution.id;
        })
      );
      return { executionId, workflowId, versionId, entityValue };
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
            actions,
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
  it("schedules a run once, due now, and wakes the loop only for the call that scheduled it", async () => {
    const app = appOn(await openConnection());
    const { executionId } = await app.startRun(markGraph);

    const result = await app.drive(
      Effect.gen(function* () {
        const driver = yield* ExecutionDriver;
        const executions = yield* ExecutionRepo;
        yield* driver.enqueueRun({ executionId });
        const queued = yield* executions.findSchedule(executionId);
        const [claimed] = yield* claimAll;
        yield* driver.enqueueRun({ executionId });
        return {
          queued,
          claimed,
          again: yield* executions.findSchedule(executionId),
        };
      })
    );

    expect(result.queued).toMatchObject({ kind: "run", state: "queued" });
    expect(result.queued?.wakeAt.getTime()).toBeLessThanOrEqual(Date.now());
    // The second call left the leased row as the claim wrote it.
    expect(result.again).toMatchObject({
      state: "leased",
      ownerToken: result.claimed?.ownerToken,
    });
    expect(app.worker.calls()).toBe(1);
  });

  it("re-queues a waiting run when its park's wake lands and wakes an in-process loop well before its poll", async () => {
    const app = appOn(await openConnection());
    const run = await app.startRun(cancelableWaitGraph);
    await app.drive(
      Effect.flatMap(ExecutionDriver, (driver) =>
        driver.enqueueRun({ executionId: run.executionId })
      )
    );
    const loop = app.loop();
    await waitUntil(
      async () =>
        (
          await app.connection.run(
            Effect.flatMap(ExecutionRepo, (executions) =>
              executions.findSchedule(run.executionId)
            )
          )
        )?.state === "waiting",
      "The run did not park"
    );
    // The release that parked the run made the loop claim once more. Once that
    // claim has ended, the loop sleeps until its next poll, 30 s away.
    await sleep(100);
    const wakesBefore = app.worker.calls();

    const { waitStateId, resolution, wokenAt } = await app.drive(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const driver = yield* ExecutionDriver;
        yield* executions.requestCancelForEntity({
          workflowId: run.workflowId,
          runMode: "live",
          entityValue: run.entityValue,
          eventName: CANCEL_EVENT,
          payload: {},
        });
        const [wait] = yield* executions.listActiveWaitStates(run.executionId);
        if (wait === undefined) throw new Error("The run holds no park");
        const resolved = yield* driver.resolvePark({
          executionId: run.executionId,
          waitStateId: wait.id,
          wake: { kind: "cancel" },
        });
        return {
          waitStateId: wait.id,
          resolution: resolved,
          wokenAt: Date.now(),
        };
      })
    );

    expect(await app.ended(run.executionId)).toBe("canceled");
    await loop.stop();
    expect(resolution).toEqual({ resolved: true, requeued: true });
    expect(app.worker.calls()).toBe(wakesBefore + 1);
    // Well inside the poll, with a second of slack for a loaded machine.
    expect((marks.get("outlet") ?? Number.NaN) - wokenAt).toBeLessThan(1_000);

    // The park took its one wake, so a second resolution neither lands nor
    // wakes anyone.
    const again = await app.drive(
      Effect.flatMap(ExecutionDriver, (driver) =>
        driver.resolvePark({
          executionId: run.executionId,
          waitStateId,
          wake: { kind: "cancel" },
        })
      )
    );
    expect(again).toEqual({ resolved: false, requeued: false });
    expect(app.worker.calls()).toBe(wakesBefore + 1);
  }, 30_000);

  it("leaves a leased run's row to its pass's release and wakes no loop when a park's wake lands", async () => {
    const app = appOn(await openConnection());
    const run = await app.startRun(markGraph);

    const result = await app.drive(
      Effect.gen(function* () {
        const driver = yield* ExecutionDriver;
        const executions = yield* ExecutionRepo;
        yield* driver.enqueueRun({ executionId: run.executionId });
        yield* claimAll;
        const wait = yield* executions.startWait({
          side: "started",
          executionId: run.executionId,
          workflowId: run.workflowId,
          runId: "run_1",
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
          executionId: run.executionId,
          waitStateId: wait.waitStateId,
          wake: { kind: "cancel" },
        });
        return {
          resolution,
          wakes: app.worker.calls() - wakesBefore,
          schedule: yield* executions.findSchedule(run.executionId),
        };
      })
    );

    expect(result.resolution).toEqual({ resolved: true, requeued: false });
    expect(result.wakes).toBe(0);
    expect(result.schedule?.state).toBe("leased");
  });

  it("stops a run by clearing its lease, so the pass holding it is refused its next write, and wakes the loop", async () => {
    const app = appOn(await openConnection());
    const run = await app.startRun(markGraph);
    const unscheduled = await app.startRun(markGraph);

    const result = await app.drive(
      Effect.gen(function* () {
        const driver = yield* ExecutionDriver;
        const executions = yield* ExecutionRepo;
        yield* driver.enqueueRun({ executionId: run.executionId });
        const [claimed] = yield* claimAll;
        if (claimed === undefined) throw new Error("The run was not claimed");
        yield* driver.stopRun({ executionId: run.executionId });
        const wakesAfterStop = app.worker.calls();
        // A run with no schedule row has nothing to stop.
        yield* driver.stopRun({ executionId: unscheduled.executionId });
        const refused = yield* Effect.flip(
          executions
            .fenced({
              scheduleId: claimed.scheduleId,
              executionId: run.executionId,
              ownerToken: claimed.ownerToken,
            })
            .writeStepMemo({
              stepId: "step_1",
              value: "stale",
              leaseExpiresAt: new Date(Date.now() + 60_000),
            })
        );
        return {
          refused: refused._tag,
          wakesAfterStop,
          wakes: app.worker.calls(),
          schedule: yield* executions.findSchedule(run.executionId),
        };
      })
    );

    expect(result.refused).toBe("LeaseLost");
    expect(result.schedule).toMatchObject({
      state: "queued",
      ownerToken: null,
      leaseExpiresAt: null,
    });
    // One wake for the enqueue, one for the stop, none for the run with no row.
    expect(result.wakesAfterStop).toBe(2);
    expect(result.wakes).toBe(2);
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
    const { wakes } = consumer.connection;
    if (wakes.kind !== "notify") {
      throw new Error("The backend broadcasts no wakes across processes");
    }
    return { producer, consumer, broadcast: wakes.broadcast };
  }

  it("wakes a loop in another process within about 200 ms of a run made due, with a 30 s poll", async () => {
    const { producer, consumer, broadcast } = await twoApps();
    const run = await producer.startRun(markGraph);

    let claims = 0;
    let claimedAt = Number.NaN;
    const listening = await broadcast.listen(() => consumer.worker.wake.wake());
    const loop = consumer.loop({
      onClaim: (executionIds) => {
        claims += 1;
        if (executionIds.includes(run.executionId)) claimedAt = Date.now();
      },
    });
    // The loop's first claim finds nothing due, and the loop then sleeps for
    // its poll.
    await waitUntil(() => claims > 0, "The loop never claimed");
    await sleep(100);

    await producer.drive(
      Effect.flatMap(ExecutionDriver, (driver) =>
        driver.enqueueRun({ executionId: run.executionId })
      )
    );
    const enqueuedAt = Date.now();

    expect(await consumer.ended(run.executionId)).toBe("completed");
    await loop.stop();
    await listening.stop();
    // A 50 ms flush, the notification, and the claim, with slack for a loaded
    // machine running other files against the same server.
    expect(claimedAt - enqueuedAt).toBeLessThan(250);
  }, 30_000);

  it("sends a bounded number of notifications for a burst of 100 runs made due", async () => {
    const { producer, broadcast } = await twoApps();
    const runs = await Promise.all(
      Array.from({ length: 100 }, () => producer.startRun(markGraph))
    );

    let notifications = 0;
    const listening = await broadcast.listen(() => {
      notifications += 1;
    });
    const startedAt = Date.now();
    // One at a time, so the burst outlasts more than one flush.
    await producer.drive(
      Effect.forEach(runs, (run) =>
        Effect.flatMap(ExecutionDriver, (driver) =>
          driver.enqueueRun({ executionId: run.executionId })
        )
      )
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
