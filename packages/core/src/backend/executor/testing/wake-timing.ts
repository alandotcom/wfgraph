/**
 * The database executor's wake timings by wall clock. Three runs go through the
 * real worker loop one after another: sibling delay Waits, a Cancel Event that
 * arrives while both siblings are parked, and a Wait behind a Wait. Each
 * measurement pairs when a node should have acted with when it did.
 * `scripts/executor-timing.ts` runs them at full length on each backend, and
 * `worker-loop-cases.ts` runs them shortened.
 *
 * A Wait's target is the deadline on its wait row, which the Wait computed from
 * the wall clock when it parked. A Cancel's target is the moment its claim was
 * written. A node's action time is stamped inside the step of a `timing/mark`
 * action placed after it.
 */

import { Effect, ManagedRuntime, References, Schema } from "effect";
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
  delay,
  edge,
  lifecycleNode,
  publishWorkflow,
  startScheduledRun,
  waitNode,
} from "#src/backend/executor/testing/run-fixtures";
import { runWorkerLoop } from "#src/backend/executor/worker-loop";
import {
  createWorkerWake,
  type WorkerWake,
} from "#src/backend/executor/worker-wake";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import type { WfGraphPersistenceInstance } from "#src/backend/persistence/types";

/** Runs one repository Effect against the database being measured. */
export type RunOnRepositories = <A, E>(
  effect: Effect.Effect<A, E, ExecutionRepo | WorkflowRepo>
) => Promise<A>;

export type WakeTimingDurations = {
  /** The sibling Waits, run alone and again under the Cancel. */
  shortMs: number;
  longMs: number;
  /** How long after both siblings parked the Cancel Event arrives. */
  cancelAfterMs: number;
  /** The Wait behind a Wait: the first, then the second. */
  firstMs: number;
  secondMs: number;
};

/** The lengths the phase 1 exit criteria name. */
export const FULL_WAKE_TIMINGS: WakeTimingDurations = {
  shortMs: 2_000,
  longMs: 9_000,
  cancelAfterMs: 1_000,
  firstMs: 2_000,
  secondMs: 3_000,
};

/**
 * One measured moment.
 *
 * - `acted`: a node that should act at `targetAt`, and when it did, or null
 *   when it never did.
 * - `skipped`: a node that must not act at all, such as a Started-side branch
 *   behind a Cancel, and when it did act, or null.
 */
export type WakeMeasurement =
  | {
      kind: "acted";
      scenario: string;
      what: string;
      targetAt: number;
      actedAt: number | null;
    }
  | { kind: "skipped"; scenario: string; what: string; actedAt: number | null };

/** How often the measurement reads the run's wait rows and status. */
const READ_EVERY_MS = 20;

/** How long a run may outlast its longest Wait before it counts as stuck. */
const STUCK_AFTER_MS = 10_000;

const MARK_ACTION = "timing/mark";

/** One scenario: the graph it runs and what it measures once the run ends. */
type Scenario = {
  name: string;
  graph: SerializedWorkflowGraph;
  /** The longest the run should take, past which it is stuck. */
  expectedMs: number;
  /**
   * Fires the Cancel `cancelAfterMs` after every one of these Wait nodes has
   * parked.
   */
  cancelOnceParked?: readonly string[] | undefined;
  measure: (observed: Observed) => WakeMeasurement[];
};

/** What one run left behind for its measurements. */
type Observed = {
  /** Each Wait node's deadline, as its wait row held it when first read. */
  deadlines: ReadonlyMap<string, number>;
  /** Each mark node's first action time, by node id. */
  marks: ReadonlyMap<string, number>;
  /** When the Cancel claim was written, for a scenario that sends one. */
  cancelAt: number | undefined;
};

function markNode(id: string) {
  return actionNode(id, MARK_ACTION);
}

/**
 * An `acted` measurement. A target the run never recorded reads as NaN, which
 * no lateness bound accepts.
 */
function acted(
  scenario: string,
  what: string,
  targetAt: number | undefined,
  actedAt: number | undefined
): WakeMeasurement {
  return {
    kind: "acted",
    scenario,
    what,
    targetAt: targetAt ?? Number.NaN,
    actedAt: actedAt ?? null,
  };
}

function scenarios(durations: WakeTimingDurations): Scenario[] {
  const { shortMs, longMs, firstMs, secondMs } = durations;
  const siblingNodes = [
    waitNode("short_wait", delay(`${shortMs}ms`)),
    markNode("short_after"),
    waitNode("long_wait", delay(`${longMs}ms`)),
    markNode("long_after"),
  ];
  const siblingEdges = [
    edge("entry", "short_wait", "started"),
    edge("short_wait", "short_after"),
    edge("entry", "long_wait", "started"),
    edge("long_wait", "long_after"),
  ];

  return [
    {
      name: "siblings",
      graph: createSerializedWorkflowGraph({
        nodes: [lifecycleNode(), ...siblingNodes],
        edges: siblingEdges,
      }),
      expectedMs: longMs,
      measure: ({ deadlines, marks }) => [
        acted(
          "siblings",
          `short_wait (${shortMs} ms) resumed`,
          deadlines.get("short_wait"),
          marks.get("short_after")
        ),
        acted(
          "siblings",
          `long_wait (${longMs} ms) resumed`,
          deadlines.get("long_wait"),
          marks.get("long_after")
        ),
      ],
    },
    {
      name: "cancel",
      graph: createSerializedWorkflowGraph({
        nodes: [lifecycleNode(CANCELABLE), ...siblingNodes, markNode("outlet")],
        edges: [...siblingEdges, edge("entry", "outlet", "canceled")],
      }),
      expectedMs: durations.cancelAfterMs,
      cancelOnceParked: ["short_wait", "long_wait"],
      measure: ({ marks, cancelAt }) => [
        acted(
          "cancel",
          `Canceled outlet ran (${durations.cancelAfterMs} ms after both parked)`,
          cancelAt,
          marks.get("outlet")
        ),
        {
          kind: "skipped",
          scenario: "cancel",
          what: "short_wait's branch stayed halted",
          actedAt: marks.get("short_after") ?? null,
        },
        {
          kind: "skipped",
          scenario: "cancel",
          what: "long_wait's branch stayed halted",
          actedAt: marks.get("long_after") ?? null,
        },
      ],
    },
    {
      name: "chain",
      graph: createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode(),
          waitNode("first_wait", delay(`${firstMs}ms`)),
          waitNode("second_wait", delay(`${secondMs}ms`)),
          markNode("chain_after"),
        ],
        edges: [
          edge("entry", "first_wait", "started"),
          edge("first_wait", "second_wait"),
          edge("second_wait", "chain_after"),
        ],
      }),
      expectedMs: firstMs + secondMs,
      measure: ({ deadlines, marks }) => {
        const second = deadlines.get("second_wait");
        return [
          // The second Wait computed its deadline the moment the first one
          // resumed into it, so that moment is its deadline less its length.
          acted(
            "chain",
            `first_wait (${firstMs} ms) resumed`,
            deadlines.get("first_wait"),
            second === undefined ? undefined : second - secondMs
          ),
          acted(
            "chain",
            `second_wait (${secondMs} ms) resumed`,
            second,
            marks.get("chain_after")
          ),
        ];
      },
    },
  ];
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `measureWakeTimings` on an open persistence instance. The instance stays
 * open; the caller closes it.
 */
export async function measureWakeTimingsOn(input: {
  instance: WfGraphPersistenceInstance;
  pollMs: number;
  durations: WakeTimingDurations;
}): Promise<WakeMeasurement[]> {
  const runtime = ManagedRuntime.make(input.instance.repositories);
  try {
    return await measureWakeTimings({
      run: (effect) => runtime.runPromise(effect),
      pollMs: input.pollMs,
      durations: input.durations,
    });
  } finally {
    await runtime.dispose();
  }
}

/**
 * Runs every scenario through one worker loop polling every `pollMs` on the
 * database `run` reaches, and answers the measurements in scenario order. The
 * loop is stopped before this returns.
 */
export async function measureWakeTimings(input: {
  run: RunOnRepositories;
  pollMs: number;
  durations: WakeTimingDurations;
}): Promise<WakeMeasurement[]> {
  const { run, durations } = input;
  // Each mark node's first action time, by Execution and then by node id.
  const marks = new Map<string, Map<string, number>>();
  const actions = createWorkflowActions(
    assembleExtensions({
      actions: [
        defineAction({
          id: MARK_ACTION,
          label: "Mark",
          description: "Records when it ran",
          input: Schema.Struct({}),
          handler: async ({ step, executionId, nodeId }) => {
            await step.run("mark", () => {
              const ofRun = marks.get(executionId ?? "") ?? new Map();
              if (!ofRun.has(nodeId)) ofRun.set(nodeId, Date.now());
              marks.set(executionId ?? "", ofRun);
              return Promise.resolve(null);
            });
            return {};
          },
        }),
      ],
    }),
    stubWfGraphRuntime()
  );

  const controller = new AbortController();
  const wake = createWorkerWake();
  // The engine logs every node and run at Info. A measurement prints its own
  // lines, so only warnings and errors from the run come through.
  const loop = run(
    runWorkerLoop({
      actions: () => actions,
      signal: controller.signal,
      wake,
      pollMs: input.pollMs,
    }).pipe(Effect.provideService(References.MinimumLogLevel, "Warn"))
  );

  const measurements: WakeMeasurement[] = [];
  try {
    for (const scenario of scenarios(durations)) {
      // eslint-disable-next-line eslint/no-await-in-loop -- one scenario at a time, so none delays another's wake
      const executionId = await run(
        Effect.gen(function* () {
          yield* publishWorkflow({
            workflowId: `wf_${scenario.name}`,
            versionId: `ver_${scenario.name}`,
            graph: scenario.graph,
            catalogFingerprint: actions.catalogFingerprint(),
          });
          return yield* startScheduledRun({
            workflowId: `wf_${scenario.name}`,
            versionId: `ver_${scenario.name}`,
            entityValue: `entity_${scenario.name}`,
            wakeAt: new Date(),
          });
        })
      );
      // eslint-disable-next-line eslint/no-await-in-loop -- one scenario at a time, so none delays another's wake
      const observed = await observeRun({
        run,
        scenario,
        executionId,
        durations,
        wake,
      });
      measurements.push(
        ...scenario.measure({
          ...observed,
          marks: marks.get(executionId) ?? new Map(),
        })
      );
    }
  } finally {
    controller.abort();
    await loop;
  }
  return measurements;
}

/**
 * Reads the run's wait rows and status every `READ_EVERY_MS` until the run
 * ends or is stuck, sending the scenario's Cancel when it is due. The Cancel
 * wakes the loop after its writes, as the in-process Cancel producer does.
 */
async function observeRun(input: {
  run: RunOnRepositories;
  scenario: Scenario;
  executionId: string;
  durations: WakeTimingDurations;
  wake: WorkerWake;
}): Promise<Omit<Observed, "marks">> {
  const { run, scenario, executionId } = input;
  const deadlines = new Map<string, number>();
  const startedAt = Date.now();
  let cancelDueAt: number | undefined;
  let cancelAt: number | undefined;

  for (;;) {
    // eslint-disable-next-line eslint/no-await-in-loop -- a read per tick, by design
    const { status, waits } = await run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const summary = yield* executions.findSummaryById(executionId);
        return {
          status: summary?.status,
          waits: yield* executions.listWaitingStates(executionId),
        };
      })
    );
    for (const wait of waits) {
      if (wait.waitUntil !== null && !deadlines.has(wait.nodeId)) {
        deadlines.set(wait.nodeId, wait.waitUntil.getTime());
      }
    }
    const inFlight = IN_FLIGHT_EXECUTION_STATUSES.some(
      (inFlightStatus) => inFlightStatus === status
    );
    if (!inFlight) break;
    if (Date.now() - startedAt > scenario.expectedMs + STUCK_AFTER_MS) {
      throw new Error(
        `The ${scenario.name} run was still ${status ?? "missing"} ${Date.now() - startedAt} ms after it started`
      );
    }

    const parkedAll = scenario.cancelOnceParked?.every((nodeId) =>
      deadlines.has(nodeId)
    );
    if (parkedAll === true && cancelDueAt === undefined) {
      cancelDueAt = Date.now() + input.durations.cancelAfterMs;
    }
    if (
      cancelDueAt !== undefined &&
      cancelAt === undefined &&
      Date.now() >= cancelDueAt
    ) {
      cancelAt = Date.now();
      // eslint-disable-next-line eslint/no-await-in-loop -- the Cancel is sent once, at its moment
      await run(
        cancelEntity({
          workflowId: `wf_${scenario.name}`,
          entityValue: `entity_${scenario.name}`,
          now: new Date(cancelAt),
        })
      );
      input.wake.announce();
      continue;
    }
    // eslint-disable-next-line eslint/no-await-in-loop -- a read per tick, by design
    await sleep(READ_EVERY_MS);
  }
  return { deadlines, cancelAt };
}
