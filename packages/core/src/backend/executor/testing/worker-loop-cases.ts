/**
 * The database executor's worker loop on one persistence backend: how it stops,
 * how it outlives a pass that fails, how a heartbeat keeps a long step body's
 * lease, how a second loop recovers a run whose worker died, how a producer's
 * wake makes it claim before its next poll, and a shortened run of the
 * wall-clock wake timings. A runner per backend calls
 * `describeWorkerLoopCases`, so every backend answers the same assertions.
 *
 * Every case runs loops on the wall clock with short leases and polls, and
 * waits for the database to reach a state rather than for a fixed time.
 */

import { describe, expect, it } from "vitest";
import { Effect, Layer, Logger, References, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import { defineAction } from "#src/backend/extensions/define-action";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import {
  actionNode,
  CANCELABLE,
  cancelEntity,
  createGate,
  delay,
  edge,
  lifecycleNode,
  publishWorkflow,
  startScheduledRun,
  waitNode,
} from "#src/backend/executor/testing/run-fixtures";
import { measureWakeTimings } from "#src/backend/executor/testing/wake-timing";
import {
  createWorkerWake,
  runWorkerLoop,
  type WorkerBackend,
  type WorkerLoopOptions,
} from "#src/backend/executor/worker-loop";
import {
  type ConformanceConnection,
  usePersistenceRegistry,
} from "#src/backend/persistence/conformance/support";
import type { PersistenceConformanceHarness } from "#src/backend/persistence/persistence-conformance-test-support";
import {
  ExecutionRepo,
  type ExecutionSchedule,
} from "#src/backend/services/executions/repo";

/** How long the slow step's body runs, several times the case's lease. */
const SLOW_STEP_MS = 600;

let heldStep = createGate();
let slowStepCalls = 0;
/** When each `test/mark` node ran, by node id. */
let marks = new Map<string, number>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
      defineAction({
        id: "test/slow",
        label: "Slow",
        description: "Runs one durable step whose body outlasts the lease",
        input: Schema.Struct({}),
        handler: async ({ step }) => {
          await step.run("dispatch", async () => {
            slowStepCalls += 1;
            await sleep(SLOW_STEP_MS);
            return null;
          });
          return {};
        },
      }),
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

/** Entry, then `actionType`, then a node that records when the run got there. */
function oneActionThenMark(actionType: string): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode(),
      actionNode("work", actionType),
      actionNode("after", "test/mark"),
    ],
    edges: [edge("entry", "work", "started"), edge("work", "after")],
  });
}

/** Captures every log line a loop writes, with its annotations. */
function recordingLogger() {
  const lines: { message: unknown; annotations: Record<string, unknown> }[] =
    [];
  const logger = Logger.make<unknown, void>(({ fiber, message }) => {
    lines.push({
      message: Array.isArray(message) ? message[0] : message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  return {
    lines,
    layer: Layer.merge(
      Logger.layer([logger]),
      Layer.succeed(References.MinimumLogLevel, "All")
    ),
  };
}

export function describeWorkerLoopCases(
  harness: PersistenceConformanceHarness & { workerBackend: WorkerBackend }
): void {
  const title = `database executor worker loop on ${harness.backend}`;
  if (harness.skip !== undefined) {
    describe.skip(`${title} (${harness.skip})`, () => {
      it("runs every worker loop case", () => {
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
    describeCases(openConnection, harness.workerBackend);
  });
}

function describeCases(
  openConnection: () => Promise<ConformanceConnection>,
  backend: WorkerBackend
): void {
  type Loop = {
    /** Aborts the loop's signal and resolves once the loop has returned. */
    stop: () => Promise<void>;
  };

  type Harness = {
    connection: ConformanceConnection;
    /** Starts an Execution of `graph`, due now, and answers its id. */
    start: (graph: SerializedWorkflowGraph) => Promise<string>;
    /** Starts a loop on this connection. */
    loop: (
      options: Partial<Omit<WorkerLoopOptions, "signal" | "actions">> & {
        wrap?: (repo: ExecutionRepo["Service"]) => ExecutionRepo["Service"];
        logger?: Layer.Layer<never> | undefined;
      }
    ) => Loop;
    /** Resolves once the run is no longer in flight, or rejects after `ms`. */
    ended: (executionId: string, ms?: number) => Promise<string | undefined>;
    schedule: (executionId: string) => Promise<ExecutionSchedule | null>;
    /** Resolves once the run's schedule row is in `state`, or rejects. */
    scheduleState: (
      executionId: string,
      state: ExecutionSchedule["state"]
    ) => Promise<void>;
    /** Sends a Cancel Event for the entity a run of `start` was started for. */
    cancel: (executionId: string) => Promise<void>;
  };

  let runs = 0;

  async function open(): Promise<Harness> {
    heldStep = createGate();
    slowStepCalls = 0;
    marks = new Map();
    const connection = await openConnection();
    // The workflow and entity each run was started for, by Execution id.
    const started = new Map<
      string,
      { workflowId: string; entityValue: string }
    >();
    const schedule = (executionId: string) =>
      connection.run(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.findSchedule(executionId)
        )
      );

    return {
      connection,
      start: async (graph) => {
        runs += 1;
        const workflowId = `wf_loop_${runs}`;
        const versionId = `ver_loop_${runs}`;
        const entityValue = `entity_${runs}`;
        const executionId = await connection.run(
          Effect.gen(function* () {
            yield* publishWorkflow({
              workflowId,
              versionId,
              graph,
              catalogFingerprint: actions.catalogFingerprint(),
            });
            return yield* startScheduledRun({
              workflowId,
              versionId,
              entityValue,
              wakeAt: new Date(),
            });
          })
        );
        started.set(executionId, { workflowId, entityValue });
        return executionId;
      },
      loop: ({ wrap, logger, ...options }) => {
        const controller = new AbortController();
        const done = connection.run(
          Effect.gen(function* () {
            const repo = yield* ExecutionRepo;
            yield* runWorkerLoop({
              backend,
              actions,
              signal: controller.signal,
              ...options,
            }).pipe(
              Effect.provideService(ExecutionRepo, wrap?.(repo) ?? repo),
              Effect.provide(logger ?? Layer.empty)
            );
          })
        );
        return {
          stop: async () => {
            controller.abort();
            await done;
          },
        };
      },
      ended: async (executionId, ms = 3_000) => {
        const giveUpAt = Date.now() + ms;
        for (;;) {
          // eslint-disable-next-line eslint/no-await-in-loop -- a read per tick until the run ends
          const summary = await connection.run(
            Effect.flatMap(ExecutionRepo, (executions) =>
              executions.findSummaryById(executionId)
            )
          );
          const status = summary?.status;
          if (
            !IN_FLIGHT_EXECUTION_STATUSES.some(
              (inFlight) => inFlight === status
            )
          ) {
            return status;
          }
          if (Date.now() > giveUpAt) {
            throw new Error(
              `Run ${executionId} was still ${status} after ${ms} ms`
            );
          }
          // eslint-disable-next-line eslint/no-await-in-loop -- a read per tick until the run ends
          await sleep(10);
        }
      },
      schedule,
      scheduleState: async (executionId, state) => {
        const giveUpAt = Date.now() + 3_000;
        // eslint-disable-next-line eslint/no-await-in-loop -- a read per tick until the row is in `state`
        while ((await schedule(executionId))?.state !== state) {
          if (Date.now() > giveUpAt) {
            throw new Error(`Run ${executionId} never reached ${state}`);
          }
          // eslint-disable-next-line eslint/no-await-in-loop -- a read per tick until the row is in `state`
          await sleep(10);
        }
      },
      cancel: async (executionId) => {
        const run = started.get(executionId);
        if (run === undefined) throw new Error(`No run ${executionId}`);
        await connection.run(cancelEntity({ ...run, now: new Date() }));
      },
    };
  }

  it("stops claiming once the stop signal aborts and returns after the pass in flight has released its run", async () => {
    const harness = await open();
    const held = await harness.start(oneActionThenMark("test/held"));
    const loop = harness.loop({ pollMs: 20 });
    await heldStep.entered;

    const stopping = loop.stop();
    // A run due after the stop signal is never claimed by the stopped loop.
    const late = await harness.start(oneActionThenMark("test/send"));
    const beforeRelease = await Promise.race([
      stopping.then(() => "returned" as const),
      sleep(150).then(() => "waiting" as const),
    ]);
    heldStep.release();
    await stopping;

    expect(beforeRelease).toBe("waiting");
    expect(await harness.ended(held)).toBe("completed");
    expect(marks.has("after")).toBe(true);
    expect(await harness.schedule(held)).toBeNull();
    expect(await harness.schedule(late)).toMatchObject({
      state: "queued",
      workerId: null,
    });
  });

  it("logs a pass that fails, keeps claiming, and runs the failed run again once its lease expires", async () => {
    const harness = await open();
    const failing = await harness.start(oneActionThenMark("test/send"));
    const healthy = await harness.start(oneActionThenMark("test/send"));

    let failures = 0;
    const captured = recordingLogger();
    const loop = harness.loop({
      pollMs: 20,
      leaseMs: 200,
      logger: captured.layer,
      // The first pass over `failing` dies after its claim, as a pass does
      // when the process hits a bug: nothing releases the row.
      wrap: (repo) => ({
        ...repo,
        listStepMemo: (executionId) =>
          executionId === failing && failures === 0
            ? Effect.suspend(() => {
                failures += 1;
                return Effect.die(new Error("The memo could not be decoded"));
              })
            : repo.listStepMemo(executionId),
      }),
    });

    expect(await harness.ended(healthy)).toBe("completed");
    expect(await harness.ended(failing)).toBe("completed");
    await loop.stop();

    expect(failures).toBe(1);
    const errors = captured.lines.filter(
      (line) =>
        line.message ===
        "A pass failed; its run is claimed again once its lease expires"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.annotations).toMatchObject({
      pass: { execution: failing, attempt: 0 },
    });
  });

  it("keeps a step body's lease through heartbeats while the body outlasts the lease", async () => {
    const harness = await open();
    const executionId = await harness.start(oneActionThenMark("test/slow"));

    // Two loops poll the same rows. Without the heartbeat the second claims
    // the run once the first lease runs out, and the step body runs twice.
    const options = { pollMs: 20, leaseMs: 150, heartbeatMs: 40 };
    const first = harness.loop({ ...options, workerId: "worker_a" });
    const second = harness.loop({ ...options, workerId: "worker_b" });

    expect(await harness.ended(executionId)).toBe("completed");
    await Promise.all([first.stop(), second.stop()]);
    expect(slowStepCalls).toBe(1);
  });

  it("recovers a run whose worker died mid-pass within one lease and one poll", async () => {
    const harness = await open();
    const leaseMs = 300;
    const pollMs = 100;
    const executionId = await harness.start(oneActionThenMark("test/held"));

    // The dying worker claims the run and stops inside the step body. Its
    // heartbeat is far longer than the case, and its loop is told to stop at
    // once, so it neither renews nor claims again, as a killed process would
    // not. Its pass stays stuck until the case lets the step go.
    const dying = harness.loop({
      pollMs: 20,
      leaseMs,
      heartbeatMs: 60_000,
      workerId: "worker_killed",
    });
    await heldStep.entered;
    const diedAt = Date.now();
    const dyingStopped = dying.stop();

    const recovering = harness.loop({ pollMs, workerId: "worker_live" });
    expect(await harness.ended(executionId)).toBe("completed");
    const recoveredAt = marks.get("after") ?? Number.NaN;

    // The step body runs again on the live worker: a step is at least once.
    expect(heldStep.calls()).toBe(2);
    // The claim came after the lease ran out, and at most one poll later.
    // The lease started at the claim, a little before the body was entered.
    expect(recoveredAt - diedAt).toBeGreaterThan(leaseMs - 150);
    expect(recoveredAt - diedAt).toBeLessThan(leaseMs + pollMs + 250);

    heldStep.release();
    await dyingStopped;
    await recovering.stop();
  });

  it("claims a run a producer re-queued as soon as the producer wakes the loop, well before its next poll", async () => {
    const harness = await open();
    const executionId = await harness.start(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(CANCELABLE),
          waitNode("wait", delay("60s")),
          actionNode("outlet", "test/mark"),
        ],
        edges: [
          edge("entry", "wait", "started"),
          edge("entry", "outlet", "canceled"),
        ],
      })
    );
    const wake = createWorkerWake();
    const loop = harness.loop({ pollMs: 5_000, wake });

    await harness.scheduleState(executionId, "waiting");
    // The release that parked the run made the loop claim once more. Once that
    // claim has ended, the loop sleeps until its next poll, about 5 s away.
    await sleep(100);
    await harness.cancel(executionId);
    const wokenAt = Date.now();
    wake.wake();

    await harness.ended(executionId);
    await loop.stop();
    expect((marks.get("outlet") ?? Number.NaN) - wokenAt).toBeLessThan(200);
  });

  it("claims once more right after a claim that a wake arrived during", async () => {
    const harness = await open();
    const wake = createWorkerWake();
    const claimHeld = createGate();
    const claimStartedAt: number[] = [];
    // The loop's first claim reads the schedule and is then held open, so the
    // run the case starts next is due only after that claim has looked.
    const loop = harness.loop({
      pollMs: 5_000,
      wake,
      wrap: (repo) => ({
        ...repo,
        claimDue: (input) =>
          Effect.sync(() => claimStartedAt.push(Date.now())).pipe(
            Effect.andThen(repo.claimDue(input)),
            Effect.tap(() => Effect.promise(() => claimHeld.pass()))
          ),
      }),
    });

    await claimHeld.entered;
    const executionId = await harness.start(oneActionThenMark("test/send"));
    const wokenAt = Date.now();
    wake.wake();
    claimHeld.release();

    expect(await harness.ended(executionId)).toBe("completed");
    await loop.stop();
    expect(claimStartedAt).toHaveLength(2);
    expect((claimStartedAt[1] ?? Number.NaN) - wokenAt).toBeLessThan(200);
  });

  it("resumes sibling Waits, a Cancel, and a Wait behind a Wait within a second of their targets", async () => {
    const harness = await open();
    const measurements = await measureWakeTimings({
      run: harness.connection.run,
      backend,
      pollMs: 50,
      durations: {
        shortMs: 300,
        longMs: 1_200,
        cancelAfterMs: 200,
        firstMs: 300,
        secondMs: 300,
      },
    });

    const missed = measurements.flatMap((measured) => {
      if (measured.kind === "skipped") {
        return measured.actedAt === null ? [] : [`${measured.what}: it ran`];
      }
      const lateMs =
        measured.actedAt === null
          ? Number.NaN
          : measured.actedAt - measured.targetAt;
      return lateMs >= 0 && lateMs < 1_000
        ? []
        : [`${measured.what}: ${lateMs} ms after its target`];
    });
    expect(missed).toEqual([]);
    expect(measurements).toHaveLength(7);
  });
}
