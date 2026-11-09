/**
 * The database executor's pass on one persistence backend, through the orders
 * of writes the replay suites cannot reach: a wake that lands during a pass, a
 * step whose retries run out under a Cancel claim, a Migration that lands
 * between loading a version and parking, a worker paused past its lease, a
 * step body held while the database is read and written, and the memo a long
 * run writes. A runner per backend calls `describePassCases` with its
 * database, so every backend answers the same assertions.
 *
 * Every case drives one Execution with `claimDue` and `leasedPass` over the
 * run body, on a clock the case moves. A Wait measures its deadline from the wall clock, so the case's
 * clock is the wall clock plus an offset.
 */

import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { defineAction } from "#src/backend/extensions/define-action";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { leasedPass, type PassResult } from "#src/backend/executor/pass";
import { runBody } from "#src/backend/executor/run-body";
import { deliveryBody } from "#src/backend/executor/delivery-body";
import { cronBody } from "#src/backend/executor/cron-body";
import {
  actionNode,
  CANCEL_EVENT,
  CANCELABLE,
  cancelEntity,
  createGate,
  delay,
  edge,
  lifecycleNode,
  noDeliveryServices,
  onEvent,
  publishWorkflow,
  startScheduledRun,
  waitNode,
} from "#src/backend/executor/testing/run-fixtures";
import {
  type ConformanceConnection,
  cancelArrival,
  usePersistenceRegistry,
} from "#src/backend/persistence/conformance/support";
import type { PersistenceConformanceHarness } from "#src/backend/persistence/persistence-conformance-test-support";
import {
  ExecutionRepo,
  type FencedExecutionWrites,
  type StoreWrites,
} from "#src/backend/services/executions/repo";
import { buildStoreWrites } from "#src/backend/services/executions/repo/fencing";
import { nodeLogId } from "#src/backend/services/executions/repo/node-logs";
import { STEP_RETRY_LIMIT } from "#src/backend/services/executions/repo/release-policy";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

const LEASE_MS = 60_000;
const ENTITY = "appointment_1";

let heldStep = createGate();

/**
 * How many times the `test/flaky` handler has run in the current case. Its
 * first call throws outside any step, which fails its node with no step having
 * thrown; every later call succeeds.
 */
let flakyCalls = 0;
/** How many times the `test/throws-once` step has run in the current case. */
let throwsOnceCalls = 0;
/** How many times the `test/fails-twice` step has run in the current case. */
let failsTwiceCalls = 0;
/** Settles once the `flaky` node's log row is closed. */
let flakyClosed = Promise.withResolvers<void>();

const actions = createWorkflowActions(
  assembleExtensions({
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
        id: "test/fail",
        label: "Fail",
        description: "Runs one durable step that always throws",
        input: Schema.Struct({}),
        handler: async ({ step }) => {
          await step.run("dispatch", () =>
            Promise.reject(new Error("The vendor is down"))
          );
          return {};
        },
      }),
      defineAction({
        id: "test/flaky",
        label: "Flaky",
        description: "Fails its node outside any step on its first call",
        input: Schema.Struct({}),
        handler: async ({ step }) => {
          flakyCalls += 1;
          if (flakyCalls === 1) throw new Error("The vendor answered nonsense");
          await step.run("dispatch", () => Promise.resolve(null));
          return { sent: true };
        },
      }),
      defineAction({
        id: "test/throws-once",
        label: "Throws once",
        description:
          "Runs one durable step that throws on its first call, once the flaky node's log row is closed",
        input: Schema.Struct({}),
        handler: async ({ step }) => {
          await step.run("dispatch", async () => {
            throwsOnceCalls += 1;
            if (throwsOnceCalls === 1) {
              await flakyClosed.promise;
              throw new Error("The vendor is down");
            }
            return null;
          });
          return { sent: true };
        },
      }),
      defineAction({
        id: "test/fails-twice",
        label: "Fails twice",
        description: "Runs one durable step that throws on its first two calls",
        input: Schema.Struct({}),
        handler: async ({ step }) => {
          await step.run("dispatch", () => {
            failsTwiceCalls += 1;
            return failsTwiceCalls <= 2
              ? Promise.reject(new Error("The vendor is down"))
              : Promise.resolve(null);
          });
          return { sent: true };
        },
      }),
      defineAction({
        id: "test/held",
        label: "Held",
        description: "Runs one durable step the case holds open once",
        input: Schema.Struct({}),
        handler: async ({ step }) => {
          await step.run("dispatch", async () => {
            await heldStep.pass();
            return null;
          });
          return { held: true };
        },
      }),
    ],
  }),
  stubWfGraphRuntime()
);

/** One worker's view of the repository, which a case may wrap. */
type RepoWrap = (repo: ExecutionRepo["Service"]) => ExecutionRepo["Service"];

/** Wraps the fenced writes every pass of one worker makes. */
function wrapFenced(
  wrap: (writes: FencedExecutionWrites) => FencedExecutionWrites
): RepoWrap {
  return (repo) => ({ ...repo, fenced: (fence) => wrap(repo.fenced(fence)) });
}

/** Reads every run as canceled, so a pass finds its run no longer in flight. */
const endedRun: RepoWrap = (repo) => ({
  ...repo,
  findSummaryById: (executionId) =>
    repo
      .findSummaryById(executionId)
      .pipe(
        Effect.map((summary) =>
          summary === null ? null : { ...summary, status: "canceled" }
        )
      ),
});

/** Reads every run as pinning a version that does not exist. */
const missingVersion: RepoWrap = (repo) => ({
  ...repo,
  findSummaryById: (executionId) =>
    repo
      .findSummaryById(executionId)
      .pipe(
        Effect.map((summary) =>
          summary === null
            ? null
            : { ...summary, workflowVersionId: "ver_gone" }
        )
      ),
});

/** Fails every read of a run's log rows, which a run pass makes when it opens. */
const refuseLogRead: RepoWrap = (repo) => ({
  ...repo,
  listNodeLogStates: () =>
    Effect.fail(new DatabaseError({ cause: new Error("connection reset") })),
});

/**
 * Settles with `work`, or rejects once `ms` pass first. A case that expects
 * the database to answer at once uses it, so a call stuck behind a held write
 * fails with a message naming the call, not as the test's own timeout.
 */
async function answersWithin<A>(
  ms: number,
  label: string,
  work: Promise<A>
): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not answer within ${ms} ms`)),
      ms
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function describePassCases(
  harness: PersistenceConformanceHarness
): void {
  const title = `database executor pass on ${harness.backend}`;
  if (harness.skip !== undefined) {
    describe.skip(`${title} (${harness.skip})`, () => {
      it("runs every pass case", () => {
        // Skipped: there is no database to run them on.
      });
    });
    return;
  }
  describe(title, () => {
    const { openConnection } = usePersistenceRegistry(
      harness.createDatabase,
      harness.teardown
    );
    describeCases(openConnection);
  });
}

/** Every pass case, each on a fresh database from `openConnection`. */
function describeCases(
  openConnection: () => Promise<ConformanceConnection>
): void {
  /** The case's clock: the wall clock, moved forward by what the case adds. */
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);

  type Harness = {
    connection: ConformanceConnection;
    executionId: string;
    /** Claims the run for `workerId` and runs one pass, or answers null. */
    pass: (options?: {
      workerId?: string | undefined;
      wrap?: RepoWrap | undefined;
      heartbeatMs?: number | undefined;
    }) => Promise<PassResult | null>;
    /** Publishes `graph` as the workflow's second version. */
    publishSecondVersion: (graph: SerializedWorkflowGraph) => Promise<void>;
  };

  async function startRun(graph: SerializedWorkflowGraph): Promise<Harness> {
    offsetMs = 0;
    heldStep = createGate();
    flakyCalls = 0;
    throwsOnceCalls = 0;
    failsTwiceCalls = 0;
    flakyClosed = Promise.withResolvers<void>();
    const connection = await openConnection();
    const executionId = await connection.run(
      Effect.gen(function* () {
        yield* publishWorkflow({
          workflowId: "wf_1",
          versionId: "ver_1",
          graph,
          catalogFingerprint: actions.catalogFingerprint(),
        });
        return yield* startScheduledRun({
          workflowId: "wf_1",
          versionId: "ver_1",
          entityValue: ENTITY,
          wakeAt: now(),
        });
      })
    );

    return {
      connection,
      executionId,
      pass: async (options = {}) =>
        await connection.run(
          Effect.gen(function* () {
            const repo = yield* ExecutionRepo;
            const worker = options.wrap?.(repo) ?? repo;
            const [claimed] = yield* worker.claimDue({
              lanes: [{ kind: "run", limit: 1 }],
              workerId: options.workerId ?? "worker_1",
              leaseMs: LEASE_MS,
              now: now(),
            });
            if (!claimed) return null;
            return yield* leasedPass(
              claimed,
              {
                run: runBody({ actions: () => actions }),
                delivery: deliveryBody(),
                cron: cronBody(),
              },
              {
                workerId: options.workerId ?? "worker_1",
                now,
                leaseMs: LEASE_MS,
                heartbeatMs: options.heartbeatMs,
                backoffMs: () => 0,
              }
            ).pipe(
              Effect.provideService(ExecutionRepo, worker),
              Effect.provide(noDeliveryServices)
            );
          })
        ),
      publishSecondVersion: async (secondGraph) =>
        await connection.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            const draft = yield* workflows.findDraftRevisionById("wf_1");
            yield* workflows.insertPublishedVersion({
              workflowId: "wf_1",
              versionId: "ver_2",
              version: 2,
              expectedPublishedVersionId: "ver_1",
              expectedDraftRevision: draft?.draftRevision ?? 1,
              graph: secondGraph,
              draftGraph: secondGraph,
              catalogFingerprint: actions.catalogFingerprint(),
              graphDigest: "digest-2",
              eventSubscriptions: [],
              now: new Date(),
            });
          })
        ),
    };
  }

  /** Every row the run left, which two workers' runs are compared on. */
  function readRun(harness: Harness) {
    return harness.connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const { executionId } = harness;
        const execution = yield* executions.findSummaryById(executionId);
        const logs = yield* executions.listLogs(executionId);
        const events = yield* executions.listEvents(executionId);
        return {
          status: execution?.status,
          output: execution?.output,
          error: execution?.error,
          logs: logs.map((log) => ({
            id: log.id,
            nodeId: log.nodeId,
            status: log.status,
            output: log.output,
            error: log.error,
            retries: log.retries,
          })),
          events: events.map((event) => event.eventType),
          waits: yield* executions.listWaitingStates(executionId),
          schedule: yield* executions.findSchedule({ executionId }),
          memo: yield* executions.listStepMemo({ executionId }),
        };
      })
    );
  }

  function logsOf(harness: Harness, nodeId: string) {
    return readRun(harness).then((run) =>
      run.logs.filter((log) => log.nodeId === nodeId)
    );
  }

  /** The run's timeline after its "run started" entry, newest first. */
  function endingOf(harness: Harness) {
    return harness.connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const events = yield* executions.listEvents(harness.executionId);
        return events
          .filter((event) => event.eventType !== "run_started")
          .map(({ eventType, message, metadata }) => ({
            eventType,
            message,
            metadata,
          }));
      })
    );
  }

  /** The memo row of the step that prepares the Wait `hold` on its first attempt. */
  function prepareMemoOf(harness: Harness) {
    return readRun(harness).then((run) =>
      run.memo.find((entry) => entry.stepId === "wait-prepare-hold-0")
    );
  }

  it("re-queues a run whose Wait was woken after the pass read it as parked, and runs the woken branch next", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          waitNode("long_wait", delay("1h")),
          waitNode("approval", onEvent("app/approved", "1h")),
          actionNode("after_approval", "test/send"),
        ],
        edges: [
          edge("entry", "long_wait", "started"),
          edge("entry", "approval", "started"),
          edge("approval", "after_approval"),
        ],
      })
    );

    // The producer's write lands just after the pass recorded the park, so
    // the pass has already read the Wait as parked when the wake arrives.
    let woken = false;
    const wakeOnPark: RepoWrap = (repo) => ({
      ...repo,
      fenced: (fence) => {
        const writes = repo.fenced(fence);
        return {
          ...writes,
          recordParkStep: (input) =>
            writes.recordParkStep(input).pipe(
              Effect.tap(() => {
                if (input.parkStepId !== "wait-park-approval-0" || woken) {
                  return Effect.void;
                }
                woken = true;
                return repo.wakePark({
                  executionId: harness.executionId,
                  waitStateId: input.waitStateId,
                  wake: {
                    kind: "resume",
                    eventName: "app/approved",
                    payload: { approvedBy: "dana" },
                    deliveryId: null,
                  },
                  now: now(),
                });
              })
            ),
        };
      },
    });

    const first = await harness.pass({ wrap: wakeOnPark });
    expect(woken).toBe(true);
    expect(first).toMatchObject({
      kind: "parked",
      schedule: { state: "queued", attempt: 0 },
    });

    const second = await harness.pass();
    expect(second).toMatchObject({
      kind: "parked",
      schedule: { state: "waiting", attempt: 0 },
    });
    expect(await logsOf(harness, "after_approval")).toMatchObject([
      { status: "success" },
    ]);
    const run = await readRun(harness);
    expect(run.waits.map((wait) => wait.nodeId)).toEqual(["long_wait"]);
  });

  it("runs the Canceled outlet and ends canceled when a Join admitted before the Cancel Event spends its retries", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(CANCELABLE),
          waitNode("first_wait", delay("10s")),
          waitNode("second_wait", delay("10s")),
          actionNode("join", "test/fail"),
          waitNode("outlet_wait", delay("30s")),
          actionNode("outlet", "test/send"),
        ],
        edges: [
          edge("entry", "first_wait", "started"),
          edge("entry", "second_wait", "started"),
          edge("first_wait", "join"),
          edge("second_wait", "join"),
          edge("entry", "outlet_wait", "canceled"),
          edge("outlet_wait", "outlet"),
        ],
      })
    );

    const results: Array<PassResult | null> = [];
    results.push(await harness.pass());

    // Both Waits run out, the Join is admitted, and its step throws.
    offsetMs += 11_000;
    results.push(await harness.pass());

    // The Cancel Event claims the run while the Join is being retried. No
    // Started-side Wait is parked, so it resolves no park.
    await harness.connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        yield* executions.requestCancelForEntity({
          workflowId: "wf_1",
          entityValue: ENTITY,
          eventName: CANCEL_EVENT,
          payload: { reason: "customer left" },
          deliveryId: yield* cancelArrival(),
          now: now(),
        });
      })
    );
    // The Join's step fails three more times within its retries, and the
    // fifth failure spends them.
    for (let failure = 2; failure <= 5; failure += 1) {
      // eslint-disable-next-line eslint/no-await-in-loop -- each pass follows the one before it
      results.push(await harness.pass());
    }
    // The Join's step memo row is now `failed`: the node fails and the run
    // reads the claim and parks on the outlet's Wait.
    results.push(await harness.pass());
    expect((await readRun(harness)).waits.map((wait) => wait.nodeId)).toEqual([
      "outlet_wait",
    ]);

    offsetMs += 31_000;
    results.push(await harness.pass());

    expect(results.map((result) => result?.kind)).toEqual([
      "parked",
      "retry",
      "retry",
      "retry",
      "retry",
      "retries_spent",
      "parked",
      "ended",
    ]);
    expect(results[5]).toMatchObject({
      kind: "retries_spent",
      stepId: "node:join:dispatch",
      schedule: { state: "queued", attempt: 0 },
    });
    const run = await readRun(harness);
    expect(run.status).toBe("canceled");
    expect(await logsOf(harness, "join")).toMatchObject([{ status: "error" }]);
    expect(await logsOf(harness, "outlet")).toMatchObject([
      { status: "success" },
    ]);
    expect(run.schedule).toBeNull();
    expect(run.memo).toEqual([]);
  });

  it("re-queues counting no failure when a Migration lands during a pass, and the next pass runs the new version", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          waitNode("hold", onEvent("app/approved", "1h")),
          actionNode("after_hold", "test/send"),
        ],
        edges: [edge("entry", "hold", "started"), edge("hold", "after_hold")],
      })
    );
    await harness.publishSecondVersion(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          waitNode("hold", delay("2h")),
          actionNode("after_hold", "test/send"),
        ],
        edges: [edge("entry", "hold", "started"), edge("hold", "after_hold")],
      })
    );

    // The first pass parks the Wait's row and then loses the connection
    // before the step that parked it is recorded, so the run is retried with
    // its row parked and nothing woken: the state a Migration may repin.
    let dropped = false;
    const dropPrepareMemo = wrapFenced((writes) => ({
      ...writes,
      writeStepMemo: (input) =>
        input.stepId === "wait-prepare-hold-0" && !dropped
          ? Effect.suspend(() => {
              dropped = true;
              return Effect.fail(
                new DatabaseError({ cause: new Error("connection reset") })
              );
            })
          : writes.writeStepMemo(input),
    }));
    expect(await harness.pass({ wrap: dropPrepareMemo })).toMatchObject({
      kind: "retry",
      schedule: { state: "queued", attempt: 0 },
    });
    expect(await prepareMemoOf(harness)).toMatchObject({
      status: "failing",
      failures: 1,
    });

    // The Migration lands after the second pass loaded version 1 and before
    // it replays: the run moves to version 2 and its parked Wait is woken with
    // a migrate wake while the pass holds the lease.
    let migrated = false;
    const migrateOnLoad: RepoWrap = (repo) => ({
      ...repo,
      listStepMemo: (key) =>
        Effect.gen(function* () {
          const { executionId } = harness;
          const [wait] = yield* repo.listWaitingStates(executionId);
          if (!wait) throw new Error("No parked Wait to migrate");
          const repinned = yield* repo.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
            expectedWaitStates: [
              { id: wait.id, resumeToken: wait.resumeToken },
            ],
            now: now(),
          });
          migrated = repinned.moved;
          return yield* repo.listStepMemo(key);
        }),
    });
    expect(await harness.pass({ wrap: migrateOnLoad })).toMatchObject({
      kind: "fence_refused",
      fence: "version",
      schedule: { state: "queued", attempt: 0 },
    });
    expect(migrated).toBe(true);
    // The refused fence counted nothing against the step either.
    expect(await prepareMemoOf(harness)).toMatchObject({
      status: "failing",
      failures: 1,
    });

    // The next pass loads version 2, reads the migrate wake and parks the
    // same row again as a two-hour delay.
    const third = await harness.pass();
    expect(third).toMatchObject({
      kind: "parked",
      schedule: { state: "waiting", attempt: 0 },
    });
    const run = await readRun(harness);
    expect(run.waits).toHaveLength(1);
    expect(run.waits[0]).toMatchObject({
      nodeId: "hold",
      waitType: "delay",
      status: "waiting",
    });
    expect(run.waits[0]?.waitUntil?.getTime()).toBeGreaterThan(
      now().getTime() + 90 * 60 * 1000
    );
    expect(await logsOf(harness, "after_hold")).toEqual([]);
  });

  // Only a version fence the engine reports refused is the run having moved. A
  // failure of another kind in a pass a Migration lands in still counts a
  // failure, even though the version the run pins has changed by the release.
  it("counts a failure that is not a version refusal when a Migration lands in the same pass", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(),
        waitNode("hold", onEvent("app/approved", "1h")),
        actionNode("after_hold", "test/send"),
      ],
      edges: [edge("entry", "hold", "started"), edge("hold", "after_hold")],
    });
    const harness = await startRun(graph);
    await harness.publishSecondVersion(graph);

    // The first pass parks the Wait's row and its retry leaves the run queued
    // with the row parked, which is the state a Migration may repin.
    const failMemoWrite = (stepId: string) =>
      wrapFenced((writes) => ({
        ...writes,
        writeStepMemo: (input) =>
          input.stepId === stepId
            ? Effect.fail(
                new DatabaseError({ cause: new Error("connection reset") })
              )
            : writes.writeStepMemo(input),
      }));
    expect(
      await harness.pass({ wrap: failMemoWrite("wait-prepare-hold-0") })
    ).toMatchObject({ kind: "retry", schedule: { attempt: 0 } });
    expect(await prepareMemoOf(harness)).toMatchObject({ failures: 1 });

    // The Migration lands as the second pass loads, and the pass then fails
    // to park the Wait again for a reason of its own: the database drops the
    // write before its version fence is read.
    const failPark = wrapFenced((writes) => ({
      ...writes,
      startWait: () =>
        Effect.fail(
          new DatabaseError({ cause: new Error("connection reset") })
        ),
    }));
    let migrated = false;
    const migrateOnLoad: RepoWrap = (repo) => ({
      ...failPark(repo),
      listStepMemo: (key) =>
        Effect.gen(function* () {
          const { executionId } = harness;
          const [wait] = yield* repo.listWaitingStates(executionId);
          if (!wait) throw new Error("No parked Wait to migrate");
          const repinned = yield* repo.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
            expectedWaitStates: [
              { id: wait.id, resumeToken: wait.resumeToken },
            ],
            now: now(),
          });
          migrated = repinned.moved;
          return yield* repo.listStepMemo(key);
        }),
    });
    expect(await harness.pass({ wrap: migrateOnLoad })).toMatchObject({
      kind: "retry",
      schedule: { state: "queued", attempt: 0 },
    });
    expect(migrated).toBe(true);
    expect(await prepareMemoOf(harness)).toMatchObject({
      status: "failing",
      failures: 2,
    });
  });

  // An Event that arrives while a Migration's `migrate` wake is still pending
  // replaces that wake (the TLA+ Migration model's `EventReplacesMigrateWake`).
  // The next pass loads the new version, finds the Wait's first preparation
  // came from the old one and prepares it again. The re-park is refused
  // because the row holds the Event's wake, and the Wait resumes from that
  // wake under the new version, as the model's
  // `ReachEventResumesAcrossAModeChange` state has it.
  it("resumes from an Event wake that replaced a pending migrate wake", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          waitNode("hold", onEvent("app/approved", "1h")),
          actionNode("after_hold", "test/send"),
        ],
        edges: [edge("entry", "hold", "started"), edge("hold", "after_hold")],
      })
    );
    await harness.publishSecondVersion(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          waitNode("hold", onEvent("app/approved", "1h")),
          actionNode("after_migration", "test/send"),
        ],
        edges: [
          edge("entry", "hold", "started"),
          edge("hold", "after_migration"),
        ],
      })
    );

    expect(await harness.pass()).toMatchObject({
      kind: "parked",
      schedule: { state: "waiting" },
    });

    const wake = await harness.connection.run(
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        const executionId = harness.executionId;
        const [wait] = yield* repo.listWaitingStates(executionId);
        if (!wait) throw new Error("No parked Wait to migrate");
        const repinned = yield* repo.repinVersion({
          executionId,
          fromVersionId: "ver_1",
          toVersionId: "ver_2",
          expectedWaitStates: [{ id: wait.id, resumeToken: wait.resumeToken }],
          now: now(),
        });
        const claim = yield* repo.claimWaitingStateById({
          waitStateId: wait.id,
          resumeToken: wait.resumeToken,
          eventName: "app/approved",
          arrival: {
            eventName: "app/approved",
            payload: { approvedBy: "dana" },
          },
          now: now(),
        });
        return {
          migrated: repinned.moved,
          wake: (yield* repo.findPark(wait.id))?.wake,
          // The repin already re-queued the run.
          requeued: claim?.requeued,
        };
      })
    );
    expect(wake).toEqual({
      migrated: true,
      wake: {
        kind: "resume",
        eventName: "app/approved",
        payload: { approvedBy: "dana" },
        deliveryId: null,
      },
      requeued: false,
    });

    expect(await harness.pass()).toEqual({ kind: "ended" });
    const run = await readRun(harness);
    expect(run.status).toBe("completed");
    expect(run.logs.filter((log) => log.nodeId === "hold")).toMatchObject([
      { status: "success", output: { payload: { approvedBy: "dana" } } },
    ]);
    expect(await logsOf(harness, "after_migration")).toMatchObject([
      { status: "success" },
    ]);
    expect(await logsOf(harness, "after_hold")).toEqual([]);
  });

  it("refuses every write of a worker paused past its lease while a second worker completes the run", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          actionNode("held", "test/held"),
          actionNode("after_held", "test/send"),
        ],
        edges: [edge("entry", "held", "started"), edge("held", "after_held")],
      })
    );

    // Every write the paused worker sends to the database once it wakes.
    const lateWrites: Array<{ name: string; outcome: string }> = [];
    let paused = true;
    const recordLateWrites = wrapFenced((writes) =>
      recordWrites(writes, (name, outcome) => {
        if (!paused) lateWrites.push({ name, outcome });
      })
    );

    const stale = harness.pass({
      workerId: "worker_stale",
      wrap: recordLateWrites,
    });
    await heldStep.entered;

    offsetMs += LEASE_MS + 1_000;
    const live = await harness.pass({ workerId: "worker_live" });
    expect(live).toEqual({ kind: "ended" });
    const afterLive = await readRun(harness);
    expect(afterLive.status).toBe("completed");

    paused = false;
    heldStep.release();
    expect(await stale).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(lateWrites).toEqual([
      { name: "writeStepMemo", outcome: "LeaseLost" },
    ]);
    expect(await readRun(harness)).toEqual(afterLive);
  });

  // A node's log close runs on every pass, and the fenced close lets a later
  // `success` correct the `error` an earlier pass wrote.
  it("closes a node's log row as success when it succeeds on a later pass after failing with no step thrown", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          actionNode("flaky", "test/flaky"),
          actionNode("throws_once", "test/throws-once"),
        ],
        edges: [
          edge("entry", "flaky", "started"),
          edge("entry", "throws_once", "started"),
        ],
      })
    );
    const flakyLogId = nodeLogId(harness.executionId, "flaky");
    const signalFlakyClosed = wrapFenced((writes) => ({
      ...writes,
      closeNodeLog: (input) =>
        writes.closeNodeLog(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (input.logId === flakyLogId) flakyClosed.resolve();
            })
          )
        ),
    }));

    // The flaky node fails with no step thrown and closes its row as an error,
    // then the sibling's step throws, which ends the pass and resets the
    // run's failure count.
    expect(await harness.pass({ wrap: signalFlakyClosed })).toMatchObject({
      kind: "retry",
      schedule: { state: "queued", attempt: 0 },
    });
    expect(await logsOf(harness, "flaky")).toMatchObject([{ status: "error" }]);

    expect(await harness.pass()).toEqual({ kind: "ended" });
    expect(flakyCalls).toBe(2);
    expect(await logsOf(harness, "flaky")).toMatchObject([
      { status: "success", output: { sent: true }, error: null },
    ]);
    expect(await logsOf(harness, "throws_once")).toMatchObject([
      { status: "success" },
    ]);
  });

  it("closes a node's log with the retries its step spent, and keeps the count when a later pass replays the node", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          actionNode("retried", "test/fails-twice"),
          waitNode("pause", delay("10s")),
          actionNode("after_pause", "test/send"),
        ],
        edges: [
          edge("entry", "retried", "started"),
          edge("retried", "pause"),
          edge("pause", "after_pause"),
        ],
      })
    );

    // Two passes each count one failure on the step; the third succeeds,
    // closes the node's log, and parks on the delay.
    const results: Array<PassResult | null> = [];
    for (let pass = 1; pass <= 3; pass += 1) {
      // eslint-disable-next-line eslint/no-await-in-loop -- each pass follows the one before it
      results.push(await harness.pass());
    }
    expect(results.map((result) => result?.kind)).toEqual([
      "retry",
      "retry",
      "parked",
    ]);
    const parked = await readRun(harness);
    expect(
      parked.memo.find((entry) => entry.stepId === "node:retried:dispatch")
    ).toEqual({
      stepId: "node:retried:dispatch",
      nodeId: "retried",
      status: "succeeded",
      failures: 2,
      value: null,
    });
    expect(await logsOf(harness, "retried")).toMatchObject([
      { status: "success", retries: 2 },
    ]);

    // The pass after the delay replays the node from its memo, which answers
    // the log close without writing the row again.
    offsetMs += 11_000;
    expect(await harness.pass()).toEqual({ kind: "ended" });
    expect(failsTwiceCalls).toBe(3);
    expect(await logsOf(harness, "retried")).toMatchObject([
      { status: "success", retries: 2 },
    ]);
    expect(await logsOf(harness, "after_pause")).toMatchObject([
      { status: "success", retries: 0 },
    ]);
  });

  it("keeps one log row when the lease is lost right after a log open", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(), actionNode("send", "test/send")],
        edges: [edge("entry", "send", "started")],
      })
    );

    const openGate = createGate();
    const sendLogId = nodeLogId(harness.executionId, "send");
    const holdAfterSendOpen = wrapFenced((writes) => ({
      ...writes,
      openNodeLog: (input) =>
        writes
          .openNodeLog(input)
          .pipe(
            Effect.tap(() =>
              input.nodeId === "send"
                ? Effect.promise(() => openGate.pass())
                : Effect.void
            )
          ),
    }));

    const stale = harness.pass({
      workerId: "worker_stale",
      wrap: holdAfterSendOpen,
    });
    await openGate.entered;
    expect(await logsOf(harness, "send")).toMatchObject([
      { id: sendLogId, status: "running" },
    ]);

    // The live pass finds the row the stale one opened and writes no second.
    offsetMs += LEASE_MS + 1_000;
    expect(await harness.pass({ workerId: "worker_live" })).toEqual({
      kind: "ended",
    });

    openGate.release();
    expect(await stale).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(await logsOf(harness, "send")).toMatchObject([
      { id: sendLogId, status: "success" },
    ]);
  });

  // The log open stores no memo row, so its failure is counted on a memo row
  // the release creates for the open's own step id.
  it("counts a failed log open against its step, retries it, and fails the node once its retries are spent", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(), actionNode("send", "test/send")],
        edges: [edge("entry", "send", "started")],
      })
    );
    const refuseSendOpen = wrapFenced((writes) => ({
      ...writes,
      openNodeLog: (input) =>
        input.nodeId === "send"
          ? Effect.fail(
              new DatabaseError({ cause: new Error("connection reset") })
            )
          : writes.openNodeLog(input),
    }));

    const results: Array<PassResult | null> = [];
    for (let pass = 0; pass <= STEP_RETRY_LIMIT; pass += 1) {
      // eslint-disable-next-line eslint/no-await-in-loop -- each pass follows the one before it
      results.push(await harness.pass({ wrap: refuseSendOpen }));
    }
    expect(results.map((result) => result?.kind)).toEqual([
      ...Array.from({ length: STEP_RETRY_LIMIT }, () => "retry"),
      "retries_spent",
    ]);
    const spent = await readRun(harness);
    expect(
      spent.memo.find((entry) => entry.stepId === "node:send:log-open")
    ).toMatchObject({
      nodeId: "send",
      status: "failed",
      failures: STEP_RETRY_LIMIT + 1,
    });
    expect(spent.logs.filter((log) => log.nodeId === "send")).toEqual([]);

    // The next pass refuses the open before writing it, which fails the node
    // and with it the run.
    expect(await harness.pass({ wrap: refuseSendOpen })).toEqual({
      kind: "ended",
    });
    expect((await readRun(harness)).status).toBe("failed");
  });

  // A log open that failed once and then succeeded marks its memo row
  // `succeeded`, so the Runs view stops reading the node as retrying while
  // the run waits, and the failure count stays on the row for `retries`.
  it("clears a log open's failure from the run's failing nodes once the open succeeds", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          actionNode("send", "test/send"),
          waitNode("pause", delay("10s")),
        ],
        edges: [edge("entry", "send", "started"), edge("send", "pause")],
      })
    );
    let refused = 0;
    const refuseSendOpenOnce = wrapFenced((writes) => ({
      ...writes,
      openNodeLog: (input) =>
        input.nodeId === "send" && refused === 0
          ? Effect.suspend(() => {
              refused += 1;
              return Effect.fail(
                new DatabaseError({ cause: new Error("connection reset") })
              );
            })
          : writes.openNodeLog(input),
    }));

    expect(await harness.pass({ wrap: refuseSendOpenOnce })).toMatchObject({
      kind: "retry",
    });
    expect(await harness.pass({ wrap: refuseSendOpenOnce })).toMatchObject({
      kind: "parked",
    });

    const parked = await readRun(harness);
    // The only log step with a memo row is the open whose failure it counts;
    // the Wait's open, like every other, stores none.
    expect(
      parked.memo
        .map((entry) => entry.stepId)
        .filter((stepId) => stepId.includes("log"))
    ).toEqual(["node:send:log-open"]);
    expect(
      parked.memo.find((entry) => entry.stepId === "node:send:log-open")
    ).toEqual({
      stepId: "node:send:log-open",
      nodeId: "send",
      status: "succeeded",
      failures: 1,
      value: null,
    });
    expect(await logsOf(harness, "send")).toMatchObject([
      { status: "success", retries: 1 },
    ]);
    const failing = await harness.connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return yield* executions.listFailingNodeIds(harness.executionId);
      })
    );
    expect(failing).toEqual([]);
  });

  // A log write takes milliseconds and is never the step the heartbeat
  // records, so a worker that dies just after one leaves no step to blame:
  // the claim that sweeps its lease counts the run's own attempt.
  it("charges no log step when the worker dies right after a log open", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(), actionNode("send", "test/send")],
        edges: [edge("entry", "send", "started")],
      })
    );

    // The step each heartbeat recorded as running.
    const beats: Array<string | null> = [];
    let opened = false;
    const beatAfterOpen = Promise.withResolvers<void>();
    const death = createGate();
    const dieAfterSendOpen = wrapFenced((writes) => ({
      ...writes,
      // Once the worker is dead its heartbeat reaches the database no more.
      renewLease: (input) =>
        death.calls() > 0
          ? Effect.fail(new DatabaseError({ cause: new Error("worker gone") }))
          : writes.renewLease(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  beats.push(input.runningStepId);
                  if (opened) beatAfterOpen.resolve();
                })
              )
            ),
      openNodeLog: (input) =>
        writes.openNodeLog(input).pipe(
          Effect.tap(() =>
            input.nodeId === "send"
              ? Effect.promise(async () => {
                  opened = true;
                  await beatAfterOpen.promise;
                  await death.pass();
                })
              : Effect.void
          )
        ),
    }));

    const stale = harness.pass({
      workerId: "worker_stale",
      wrap: dieAfterSendOpen,
      heartbeatMs: 5,
    });
    await death.entered;

    offsetMs += LEASE_MS + 1_000;
    expect(await harness.pass({ workerId: "worker_live" })).toEqual({
      kind: "ended",
    });
    death.release();
    expect(await stale).toEqual({ kind: "fence_refused", fence: "owner" });

    expect(beats.filter((step) => step?.includes(":log-"))).toEqual([]);
    expect(await logsOf(harness, "send")).toMatchObject([
      { status: "success", retries: 0 },
    ]);
  });

  // The pass reads the run's log rows when it opens, before any step runs,
  // so a failed read is the pass's own failure. Its row is swept once its
  // lease expires, and the next pass that parks resets the run's count.
  it("never spends a finished node's step on log row reads that fail on scattered passes", async () => {
    const pauses = Array.from(
      { length: STEP_RETRY_LIMIT + 1 },
      (_, index) => `pause_${index + 1}`
    );
    const chain = ["send", ...pauses, "after"];
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          actionNode("send", "test/send"),
          ...pauses.map((id) => waitNode(id, delay("10s"))),
          actionNode("after", "test/send"),
        ],
        edges: [
          edge("entry", "send", "started"),
          ...chain.slice(1).map((id, index) => edge(chain[index] ?? "", id)),
        ],
      })
    );

    const failingNodes = () =>
      harness.connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.listFailingNodeIds(harness.executionId);
        })
      );

    expect(await harness.pass()).toMatchObject({ kind: "parked" });
    const blamed: string[][] = [];
    const settled: Array<string | undefined> = [];
    for (let round = 0; round < pauses.length; round += 1) {
      offsetMs += 11_000;
      // eslint-disable-next-line eslint/no-await-in-loop -- each pass follows the one before it
      await harness.pass({ wrap: refuseLogRead }).catch(() => null);
      // eslint-disable-next-line eslint/no-await-in-loop -- each read follows the pass before it
      blamed.push(await failingNodes());
      offsetMs += LEASE_MS + 1_000;
      // eslint-disable-next-line eslint/no-await-in-loop -- each pass follows the one before it
      settled.push((await harness.pass())?.kind);
    }

    expect(blamed).toEqual(pauses.map(() => []));
    expect(settled).toEqual([...pauses.slice(1).map(() => "parked"), "ended"]);
    const ended = await readRun(harness);
    expect(ended.status).toBe("completed");
    expect(
      ended.logs
        .filter((log) => log.status !== "success")
        .map((log) => log.nodeId)
    ).toEqual([]);
  });

  // SQLite has one writer per database: a write transaction holds the
  // connection from `BEGIN IMMEDIATE` to its commit, and every other statement
  // on that connection waits for it. A read and a write answering while the
  // pass's step body is held is what shows the body runs outside any write.
  it("answers a read and a write on the pass's own connection while a step body runs", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          actionNode("held", "test/held"),
          actionNode("after_held", "test/send"),
        ],
        edges: [edge("entry", "held", "started"), edge("held", "after_held")],
      })
    );

    const pass = harness.pass();
    await heldStep.entered;

    // The body is let go whatever the reads answer, so a failed expectation
    // does not leave the pass running into the next case's teardown.
    const during = await answersWithin(
      1_000,
      "The database, while the step body was held,",
      harness.connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const { executionId } = harness;
          const logs = yield* executions.listLogs(executionId);
          const schedule = yield* executions.findSchedule({ executionId });
          // A write transaction of its own: one timeline entry.
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            executionId,
            eventType: "run_started",
            message: "Written while the step body was held",
          });
          return { logs, schedule };
        })
      )
    ).finally(() => heldStep.release());
    expect(await pass).toEqual({ kind: "ended" });

    expect(
      during.logs
        .filter((log) => log.nodeId === "held")
        .map((log) => log.status)
    ).toEqual(["running"]);
    expect(during.schedule).toMatchObject({
      state: "leased",
      workerId: "worker_1",
    });
    expect((await readRun(harness)).status).toBe("completed");
  });

  it("records the running step through the heartbeat, so a lease that expires under it counts against that step", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(), actionNode("held", "test/held")],
        edges: [edge("entry", "held", "started")],
      })
    );
    // The worker's heartbeat goes quiet on cue, as a process that died would.
    let silenced = false;
    const silenceable = wrapFenced((writes) => ({
      ...writes,
      renewLease: (input) =>
        silenced ? Effect.void : writes.renewLease(input),
    }));
    const readSchedule = () =>
      harness.connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          return yield* executions.findSchedule({
            executionId: harness.executionId,
          });
        })
      );

    const stale = harness.pass({
      workerId: "worker_stale",
      wrap: silenceable,
      heartbeatMs: 5,
    });
    await heldStep.entered;
    // A beat sent before an earlier step finished may land after it, so the
    // case waits for a beat sent while the held step runs.
    const recorded = await answersWithin(
      1_000,
      "The heartbeat's running step",
      (async () => {
        for (;;) {
          // eslint-disable-next-line eslint/no-await-in-loop -- polls until the heartbeat lands
          const schedule = await readSchedule();
          if (schedule?.runningStepId === "node:held:dispatch") {
            return {
              stepId: schedule.runningStepId,
              nodeId: schedule.runningNodeId,
            };
          }
          // eslint-disable-next-line eslint/no-await-in-loop -- polls until the heartbeat lands
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })()
    ).finally(() => {
      silenced = true;
    });

    // PostgreSQL's claim skips a row a renewal sent before the silence still
    // holds, so the claim is tried until that renewal has committed.
    offsetMs += LEASE_MS + 1_000;
    const claimOnce = () =>
      harness.connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const [claimed] = yield* executions.claimDue({
            lanes: [{ kind: "run", limit: 1 }],
            workerId: "worker_live",
            leaseMs: LEASE_MS,
            now: now(),
          });
          return claimed;
        })
      );
    const swept = await answersWithin(
      1_000,
      "The claim of the silenced lease",
      (async () => {
        for (;;) {
          // eslint-disable-next-line eslint/no-await-in-loop -- claims until the row is free
          const claimed = await claimOnce();
          if (claimed) {
            // eslint-disable-next-line eslint/no-await-in-loop -- reads once the claim landed
            const memo = await harness.connection.run(
              Effect.gen(function* () {
                const executions = yield* ExecutionRepo;
                return yield* executions.listStepMemo({
                  executionId: harness.executionId,
                });
              })
            );
            return { claimed, memo };
          }
          // eslint-disable-next-line eslint/no-await-in-loop -- claims until the row is free
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })()
    ).finally(() => heldStep.release());
    expect(await stale).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(recorded).toEqual({
      stepId: "node:held:dispatch",
      nodeId: "held",
    });
    expect(swept.claimed?.attempt).toBe(0);
    // The step never wrote a memo row of its own, so the node id on the row
    // the claim created is the one the heartbeat recorded.
    expect(
      swept.memo.find((entry) => entry.stepId === "node:held:dispatch")
    ).toMatchObject({ nodeId: "held", status: "failing", failures: 1 });
  });

  it("fails a Wait whose park step spent its retries rather than reading the step as a wake", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          waitNode("hold", onEvent("app/approved", "1h")),
          actionNode("after_hold", "test/send"),
        ],
        edges: [edge("entry", "hold", "started"), edge("hold", "after_hold")],
      })
    );
    const failPark = wrapFenced((writes) => ({
      ...writes,
      recordParkStep: () =>
        Effect.fail(
          new DatabaseError({ cause: new Error("connection reset") })
        ),
    }));

    const results: Array<PassResult | null> = [];
    for (let failure = 1; failure <= 5; failure += 1) {
      // eslint-disable-next-line eslint/no-await-in-loop -- each pass follows the one before it
      results.push(await harness.pass({ wrap: failPark }));
    }
    results.push(await harness.pass());

    expect(results.map((result) => result?.kind)).toEqual([
      "retry",
      "retry",
      "retry",
      "retry",
      "retries_spent",
      "ended",
    ]);
    const run = await readRun(harness);
    expect(run.status).toBe("failed");
    // Four failures were each followed by another try; the fifth was not.
    expect(await logsOf(harness, "hold")).toMatchObject([
      { status: "error", retries: 4 },
    ]);
    expect(await logsOf(harness, "after_hold")).toEqual([]);
    expect(run.schedule).toBeNull();
  });

  it("ends the run failed, with its timeline entry, once a step outside any node spends its retries", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(), actionNode("send", "test/send")],
        edges: [edge("entry", "send", "started")],
      })
    );
    // The run's completed record is refused every time it is written.
    const refuseCompletion = wrapFenced((writes) => ({
      ...writes,
      endRun: (input) =>
        input.ending.kind === "verdict" && input.ending.status === "completed"
          ? Effect.fail(
              new DatabaseError({ cause: new Error("connection reset") })
            )
          : writes.endRun(input),
    }));

    const results: Array<PassResult | null> = [];
    for (let pass = 1; pass <= 6; pass += 1) {
      // eslint-disable-next-line eslint/no-await-in-loop -- each pass follows the one before it
      results.push(await harness.pass({ wrap: refuseCompletion }));
    }

    expect(results.map((result) => result?.kind)).toEqual([
      "retry",
      "retry",
      "retry",
      "retry",
      "retries_spent",
      "subject_failed",
    ]);
    expect(results[4]).toMatchObject({ stepId: "workflow-run-completed" });
    const run = await readRun(harness);
    expect(run.status).toBe("failed");
    expect(await logsOf(harness, "send")).toMatchObject([
      { status: "success" },
    ]);
    expect(run.schedule).toBeNull();
    expect(run.memo).toEqual([]);
    expect(await endingOf(harness)).toEqual([
      {
        eventType: "run_failed",
        message: "Run failed with fatal error",
        metadata: { error: run.error, failureKind: "failure", runMode: "live" },
      },
    ]);
    expect(await harness.pass()).toBeNull();
  });

  it("ends canceled, with its timeline entry, a run under a Cancel claim once a step outside any node spends its retries", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(CANCELABLE), actionNode("send", "test/send")],
        edges: [edge("entry", "send", "started")],
      })
    );
    // Every terminal record the engine writes is refused.
    const refuseEnding = wrapFenced((writes) => ({
      ...writes,
      endRun: () =>
        Effect.fail(
          new DatabaseError({ cause: new Error("connection reset") })
        ),
    }));

    const results: Array<PassResult | null> = [];
    results.push(await harness.pass({ wrap: refuseEnding }));
    // The Cancel Event claims the run once its node has run.
    await harness.connection.run(
      cancelEntity({ workflowId: "wf_1", entityValue: ENTITY, now: now() })
    );
    for (let pass = 2; pass <= 5; pass += 1) {
      // eslint-disable-next-line eslint/no-await-in-loop -- each pass follows the one before it
      results.push(await harness.pass({ wrap: refuseEnding }));
    }
    results.push(await harness.pass());

    expect(results.map((result) => result?.kind)).toEqual([
      "retry",
      "retry",
      "retry",
      "retry",
      "retries_spent",
      "subject_failed",
    ]);
    const run = await readRun(harness);
    expect(run.status).toBe("canceled");
    expect(run.schedule).toBeNull();
    expect(await endingOf(harness)).toEqual([
      {
        eventType: "run_cancelled",
        message:
          "Run canceled after a fatal error; the Canceled outlet did not run",
        metadata: { error: run.error, failureKind: "failure", runMode: "live" },
      },
      expect.objectContaining({ eventType: "run_cancel_requested" }),
    ]);
  });

  it("ends a run whose version is gone failed, with its timeline entry", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(), actionNode("send", "test/send")],
        edges: [edge("entry", "send", "started")],
      })
    );

    expect(await harness.pass({ wrap: missingVersion })).toEqual({
      kind: "unavailable",
      reason: "missing_version",
      ending: "written",
      severity: "info",
    });
    const run = await readRun(harness);
    expect(run.status).toBe("failed");
    expect(run.schedule).toBeNull();
    expect(await endingOf(harness)).toEqual([
      {
        eventType: "run_failed",
        message: "Run failed with fatal error",
        metadata: {
          error: "The requested workflow version does not exist",
          failureKind: "failure",
          runMode: "live",
        },
      },
    ]);
  });

  it("ends a run whose version is gone canceled, with its timeline entry, when it holds a Cancel claim", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(CANCELABLE), actionNode("send", "test/send")],
        edges: [edge("entry", "send", "started")],
      })
    );
    await harness.connection.run(
      cancelEntity({ workflowId: "wf_1", entityValue: ENTITY, now: now() })
    );

    expect(await harness.pass({ wrap: missingVersion })).toEqual({
      kind: "unavailable",
      reason: "missing_version",
      ending: "written",
      severity: "info",
    });
    const run = await readRun(harness);
    expect(run.status).toBe("canceled");
    expect(run.schedule).toBeNull();
    expect(await endingOf(harness)).toEqual([
      {
        eventType: "run_cancelled",
        message:
          "Run canceled after a fatal error; the Canceled outlet did not run",
        metadata: {
          error: "The requested workflow version does not exist",
          failureKind: "failure",
          runMode: "live",
        },
      },
      expect.objectContaining({ eventType: "run_cancel_requested" }),
    ]);
  });

  it("releases a run it has nothing to run for when deleting its row fails, and deletes the row on the next pass", async () => {
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [lifecycleNode(), actionNode("send", "test/send")],
        edges: [edge("entry", "send", "started")],
      })
    );
    // The run reads as ended, as it would once a policy cancel ended it after
    // the claim, so the pass has nothing to run and deletes its schedule row.
    const refuseDrop: RepoWrap = (repo) =>
      wrapFenced((writes) => ({
        ...writes,
        dropSchedule: () =>
          Effect.fail(
            new DatabaseError({ cause: new Error("connection reset") })
          ),
      }))(endedRun(repo));

    expect(await harness.pass({ wrap: refuseDrop })).toMatchObject({
      kind: "unavailable",
      reason: "not_in_flight",
      ending: "failed",
      schedule: { state: "queued", attempt: 1 },
    });
    expect(await harness.pass({ wrap: endedRun })).toEqual({
      kind: "unavailable",
      reason: "not_in_flight",
      ending: "written",
      severity: "info",
    });
    expect((await readRun(harness)).schedule).toBeNull();
  });

  it("writes one memo row per action node of a 50-node run, and none survive the terminal write", async () => {
    const ids = Array.from(
      { length: 50 },
      (_, index) => `n_${String(index + 1).padStart(2, "0")}`
    );
    const harness = await startRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          ...ids.map((id) => actionNode(id, "test/send")),
          waitNode("last_wait", delay("1h")),
        ],
        edges: [
          edge("entry", "n_01", "started"),
          ...ids.slice(1).map((id, index) => edge(ids[index] ?? "", id)),
          edge("n_50", "last_wait"),
        ],
      })
    );

    expect(await harness.pass()).toMatchObject({ kind: "parked" });
    const parked = await readRun(harness);
    const perNode = Map.groupBy(
      parked.memo.flatMap((entry) => {
        const nodeId = /(?:^|[:-])(n_\d{2})(?=$|[:-])/.exec(entry.stepId)?.[1];
        return nodeId === undefined ? [] : [nodeId];
      }),
      (nodeId) => nodeId
    );
    expect(perNode.size).toBe(50);
    expect(new Set([...perNode.values()].map((steps) => steps.length))).toEqual(
      new Set([1])
    );

    offsetMs += 61 * 60 * 1000;
    expect(await harness.pass()).toEqual({ kind: "ended" });
    const ended = await readRun(harness);
    expect(ended.status).toBe("completed");
    expect(ended.memo).toEqual([]);
    expect(ended.schedule).toBeNull();
  });
}

/**
 * Wraps each fenced write so `record` hears its name and how it ended: `ok`,
 * or the tag of the failure.
 */
function recordWrites(
  writes: FencedExecutionWrites,
  record: (name: string, outcome: string) => void
): FencedExecutionWrites {
  const observe =
    <I, A, E extends { _tag: string }>(
      name: string,
      write: (input: I) => Effect.Effect<A, E>
    ) =>
    (input: I) =>
      write(input).pipe(
        Effect.tap(() => Effect.sync(() => record(name, "ok"))),
        Effect.tapError((failure) =>
          Effect.sync(() => record(name, failure._tag))
        )
      );
  const store: StoreWrites = writes;
  return {
    ...buildStoreWrites((name) => observe(name, store[name])),
    renewLease: observe("renewLease", writes.renewLease),
    writeStepMemo: observe("writeStepMemo", writes.writeStepMemo),
    recordParkStep: observe("recordParkStep", writes.recordParkStep),
    releasePass: observe("releasePass", writes.releasePass),
    dropSchedule: () => observe("dropSchedule", writes.dropSchedule)(undefined),
  };
}
