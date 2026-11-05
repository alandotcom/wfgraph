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

let heldStep = createGate();
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
  harness: PersistenceConformanceHarness
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
    describeCases(openConnection);
  });
}

/**
 * How long a case waits for the database to reach a state before it fails.
 * Every wait ends as soon as the state is reached, so the bound only has to
 * outlast a loaded machine.
 */
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

function describeCases(
  openConnection: () => Promise<ConformanceConnection>
): void {
  type Loop = {
    /** Aborts the loop's signal and resolves once the loop has returned. */
    stop: () => Promise<void>;
  };

  type Harness = {
    connection: ConformanceConnection;
    /** Starts an Execution of `graph`, due now, and answers its id. */
    start: (graph: SerializedWorkflowGraph) => Promise<string>;
    /** Starts a loop on this connection, polling every 20 ms unless told. */
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
              actions,
              signal: controller.signal,
              pollMs: 20,
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
      ended: async (executionId, ms = REACHED_WITHIN_MS) => {
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
        const giveUpAt = Date.now() + REACHED_WITHIN_MS;
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

  it("interrupts a pass still running once its drain deadline passes, leaving its row leased and its step unrecorded", async () => {
    const harness = await open();
    const executionId = await harness.start(oneActionThenMark("test/held"));
    const loop = harness.loop({ drainMs: 100, workerId: "worker_draining" });
    await heldStep.entered;

    // The loop returns with the step body still held, because its pass was
    // interrupted at the deadline.
    await loop.stop();
    heldStep.release();
    // The step body returns after its pass ended. Its memo write runs on a
    // fiber the interrupted pass closed, so it never reaches the database.
    await sleep(200);

    expect(await harness.schedule(executionId)).toMatchObject({
      state: "leased",
      workerId: "worker_draining",
    });
    const memo = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listStepMemo(executionId)
      )
    );
    expect(memo.filter((entry) => entry.stepId.includes("dispatch"))).toEqual(
      []
    );
    expect(marks.has("after")).toBe(false);
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
      run: { execution: failing },
      pass: { attempt: 0 },
    });
  });

  it("keeps a step body's lease through heartbeats while the body outlasts the lease", async () => {
    const harness = await open();
    const executionId = await harness.start(oneActionThenMark("test/held"));
    const leaseMs = 800;
    const options = { pollMs: 20, leaseMs, heartbeatMs: 50 };
    const first = harness.loop({ ...options, workerId: "worker_a" });
    await heldStep.entered;

    // A second loop polls the same row while the first loop's pass holds the
    // step body open. Without the heartbeat it would claim the run once the
    // lease ran out, and the step body would run twice. A beat every 50 ms
    // leaves the lease 750 ms of slack against a loaded event loop.
    let secondClaims = 0;
    const second = harness.loop({
      ...options,
      workerId: "worker_b",
      wrap: (repo) => ({
        ...repo,
        claimDue: (input) =>
          repo.claimDue(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                secondClaims += 1;
              })
            )
          ),
      }),
    });

    // The body is held for two leases, and then until the second loop has
    // claimed ten more times, so its claims run well past the moment an
    // unrenewed lease would have expired.
    await sleep(2 * leaseMs);
    const claimsBefore = secondClaims;
    await waitUntil(
      () => secondClaims >= claimsBefore + 10,
      "The second loop did not claim ten times"
    );
    heldStep.release();

    expect(await harness.ended(executionId)).toBe("completed");
    await Promise.all([first.stop(), second.stop()]);
    expect(heldStep.calls()).toBe(1);
  }, 30_000);

  it("recovers a run whose worker died mid-pass within one lease and one poll", async () => {
    const harness = await open();
    const leaseMs = 300;
    const pollMs = 100;
    const executionId = await harness.start(oneActionThenMark("test/held"));

    // The dying worker claims the run and stops inside the step body. Its
    // heartbeat is far longer than the case, and its loop is told to stop at
    // once, so it neither renews nor claims again, as a killed process would
    // not. Its pass stays stuck until the case lets the step go.
    let leaseExpiresAt = Number.NaN;
    const dying = harness.loop({
      pollMs: 20,
      leaseMs,
      heartbeatMs: 60_000,
      workerId: "worker_killed",
      wrap: (repo) => ({
        ...repo,
        claimDue: (input) =>
          repo.claimDue(input).pipe(
            Effect.tap((claimed) =>
              Effect.sync(() => {
                const own = claimed.find(
                  (row) => row.executionId === executionId
                );
                if (own) leaseExpiresAt = own.leaseExpiresAt.getTime();
              })
            )
          ),
      }),
    });
    await heldStep.entered;
    const dyingStopped = dying.stop();

    const recovering = harness.loop({ pollMs, workerId: "worker_live" });
    expect(await harness.ended(executionId)).toBe("completed");
    const recoveredAt = marks.get("after") ?? Number.NaN;

    // The step body runs again on the live worker: a step is at least once.
    expect(heldStep.calls()).toBe(2);
    // The live worker's claim came after the dead worker's lease ran out,
    // and within about one poll of it. The upper bound leaves a loaded
    // machine a second of slack.
    expect(recoveredAt).toBeGreaterThanOrEqual(leaseExpiresAt);
    expect(recoveredAt - leaseExpiresAt).toBeLessThan(pollMs + 1_000);

    heldStep.release();
    await dyingStopped;
    await recovering.stop();
  }, 30_000);

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
    const loop = harness.loop({ pollMs: 30_000, wake });

    await harness.scheduleState(executionId, "waiting");
    // The release that parked the run made the loop claim once more. Once that
    // claim has ended, the loop sleeps until its next poll, 30 s away.
    await sleep(100);
    await harness.cancel(executionId);
    const wokenAt = Date.now();
    wake.wake();

    await harness.ended(executionId);
    await loop.stop();
    // Well inside the poll, with a second of slack for a loaded machine.
    expect((marks.get("outlet") ?? Number.NaN) - wokenAt).toBeLessThan(1_000);
  }, 30_000);

  it("claims once more right after a claim that a wake arrived during", async () => {
    const harness = await open();
    const wake = createWorkerWake();
    const claimHeld = createGate();
    const claimStartedAt: number[] = [];
    // The loop's first claim reads the schedule and is then held open, so the
    // run the case starts next is due only after that claim has looked.
    const loop = harness.loop({
      pollMs: 30_000,
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
    // Well inside the poll, with a second of slack for a loaded machine.
    expect((claimStartedAt[1] ?? Number.NaN) - wokenAt).toBeLessThan(1_000);
  }, 30_000);

  // The strict bound, a second, is `pnpm run executor:timing`'s, at full
  // length on an idle machine. This shortened run checks that every node acts
  // and that none acts early, with slack for a loaded machine.
  it("resumes sibling Waits, a Cancel, and a Wait behind a Wait soon after their targets", async () => {
    const harness = await open();
    const measurements = await measureWakeTimings({
      run: harness.connection.run,
      pollMs: 50,
      // The Cancel lands 800 ms before the short sibling's deadline, so a
      // measurement that notices the parks late still cancels both of them.
      durations: {
        shortMs: 1_000,
        longMs: 2_000,
        cancelAfterMs: 200,
        firstMs: 500,
        secondMs: 500,
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
      return lateMs >= 0 && lateMs < 3_000
        ? []
        : [`${measured.what}: ${lateMs} ms after its target`];
    });
    expect(missed).toEqual([]);
    expect(measurements).toHaveLength(7);
  }, 60_000);
}
