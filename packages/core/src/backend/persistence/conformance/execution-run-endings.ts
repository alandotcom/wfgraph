/**
 * How each cause ends a run, on both backends: every ending against a run
 * holding no claim, a Cancel claim, an Exit claim, or already ended. Each run
 * starts an hour before it ends, so the stored duration is held to the row's
 * own `started_at`.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type {
  OutsideGraphEnding,
  RunEndAnswer,
  RunVerdict,
} from "@wfgraph/shared/lifecycle/run-ending";
import type { TerminalExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { PersistenceTestRegistry } from "#src/backend/persistence/conformance/support";
import {
  cancelArrival,
  notYetDue,
  seedPublishedWorkflow,
  setTimestamp,
  verdict,
} from "#src/backend/persistence/conformance/support";
import {
  at,
  claimRun,
  LEASE_MS,
  memoWrite,
  park,
  T0,
} from "#src/backend/persistence/conformance/schedule-support";

type TableEnding =
  | RunVerdict
  | OutsideGraphEnding
  | { kind: "cancel" }
  | { kind: "supersede" };

const ENDING_ENTITY = {
  entityType: "appointment",
  entityId: "appointment_1",
} as const;

const CANCEL_REASON = "Canceled from the Runs view";

const EXIT_CLAIM = {
  reason: "entity_condition_not_met",
  nodeId: "node_check",
} as const;

/** How long before its ending each run started. */
const STARTED_BEFORE_MS = 3_600_000;

/** What a run still in flight holds that an ending settles. */
const IN_FLIGHT = {
  completedAt: null,
  schedule: { executionId: expect.any(String) },
  memo: ["node:send:dispatch"],
} as const;

/**
 * Each state a run can meet an ending in: what the run holds just before the
 * ending, and what an ending that leaves the run answers.
 */
const RUN_STATES = {
  unclaimed: {
    before: { status: "waiting", claim: null, wait: "waiting", ...IN_FLIGHT },
    left: { kind: "unclaimed" },
  },
  "cancel-claimed": {
    before: {
      status: "waiting",
      claim: "cancel",
      wait: "resuming",
      ...IN_FLIGHT,
    },
    left: {
      kind: "cancel_claimed",
      cancel: { eventName: "appointment/cancelled", payload: {} },
    },
  },
  "exit-claimed": {
    before: { status: "waiting", claim: "exit", wait: "waiting", ...IN_FLIGHT },
    left: { kind: "exit_claimed" },
  },
  ended: {
    before: {
      status: "completed",
      claim: null,
      wait: "cancelled",
      schedule: null,
      memo: [],
    },
    left: { kind: "already_ended", status: "completed" },
  },
} as const satisfies Record<
  string,
  { before: Record<string, unknown>; left: RunEndAnswer }
>;

type RunBeforeEnding = keyof typeof RUN_STATES;

const ENDING_ENTRY = {
  completed: "run_completed",
  failed: "run_failed",
  canceled: "run_cancelled",
  exited: "run_exited",
  superseded: "run_superseded",
} as const satisfies Record<TerminalExecutionStatus, string>;

const verdictOf = (status: RunVerdict["status"]): RunVerdict => ({
  ...verdict(status),
  exitContext: { entityType: "appointment", conditionId: "condition_1" },
});

const EXITED_MESSAGE = "Run exited because the Entity was ineligible";

const EXIT_ENTRY_METADATA = {
  ...EXIT_CLAIM,
  entityType: "appointment",
  conditionId: "condition_1",
  checkpoint: "before-node",
} as const;

type EndsAs = {
  status: TerminalExecutionStatus;
  message: string;
  metadata?: JsonObject | undefined;
};

const VERDICT_EXITED: EndsAs = {
  status: "exited",
  message: EXITED_MESSAGE,
  metadata: EXIT_ENTRY_METADATA,
};

/** A null outcome is a run the ending leaves alone. */
const RUN_ENDINGS: ReadonlyArray<{
  ending: TableEnding;
  outcomes: Record<RunBeforeEnding, EndsAs | null>;
}> = [
  {
    ending: verdictOf("completed"),
    outcomes: {
      unclaimed: { status: "completed", message: "Run completed successfully" },
      "cancel-claimed": null,
      "exit-claimed": VERDICT_EXITED,
      ended: null,
    },
  },
  {
    ending: verdictOf("failed"),
    outcomes: {
      unclaimed: { status: "failed", message: "Run completed with errors" },
      "cancel-claimed": null,
      "exit-claimed": VERDICT_EXITED,
      ended: null,
    },
  },
  {
    ending: verdictOf("canceled"),
    outcomes: {
      unclaimed: null,
      "cancel-claimed": {
        status: "canceled",
        message: "Run canceled at the Canceled outlet",
      },
      "exit-claimed": VERDICT_EXITED,
      ended: null,
    },
  },
  {
    ending: { kind: "outsideGraph", error: "A step outside any node failed" },
    outcomes: {
      unclaimed: { status: "failed", message: "Run failed with fatal error" },
      "cancel-claimed": {
        status: "canceled",
        message:
          "Run canceled after a fatal error; the Canceled outlet did not run",
      },
      "exit-claimed": { status: "exited", message: EXITED_MESSAGE },
      ended: null,
    },
  },
  {
    ending: { kind: "cancel" },
    outcomes: {
      unclaimed: { status: "canceled", message: CANCEL_REASON },
      "cancel-claimed": null,
      "exit-claimed": null,
      ended: null,
    },
  },
  {
    ending: { kind: "supersede" },
    outcomes: {
      unclaimed: {
        status: "superseded",
        message: "Superseded by a newer start",
      },
      "cancel-claimed": null,
      "exit-claimed": null,
      ended: null,
    },
  },
];

function endingLabel(ending: TableEnding): string {
  if (ending.kind === "verdict") return `a ${ending.status} verdict`;
  if (ending.kind === "outsideGraph") return "an outside-graph ending";
  return ending.kind === "cancel" ? "a cancel" : "a newest-wins supersede";
}

/**
 * What a supersede answers: the newer start names the runs it ended, so the
 * table reads whether this run is one of them.
 */
type SupersedeAnswer = { superseded: boolean };

const STATE_NAMES = [
  "unclaimed",
  "cancel-claimed",
  "exit-claimed",
  "ended",
] as const satisfies readonly RunBeforeEnding[];

/** One case: an ending against a run in one state, and all it should do. */
const CASES = RUN_ENDINGS.flatMap(({ ending, outcomes }) =>
  STATE_NAMES.map((against) => {
    const ends = outcomes[against];
    const state = RUN_STATES[against];
    const answer: RunEndAnswer | SupersedeAnswer =
      ending.kind === "supersede"
        ? { superseded: ends !== null }
        : ends === null
          ? state.left
          : { kind: "ended", status: ends.status };
    return {
      name: `${endingLabel(ending)} against a ${against} run ${ends ? `ends it ${ends.status}` : "leaves it as it was"}`,
      ending,
      against,
      before: state.before,
      answer,
      ends,
    };
  })
);

/**
 * Opens a leased run holding one step memo row and one parked Wait, so an
 * ending that settles those rows is told apart from one that leaves them.
 */
function runBeforeEnding(state: RunBeforeEnding) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const started = yield* executions.startForEntity({
      execution: {
        workflowId: "wf_1",
        workflowVersionId: "ver_1",
        startSource: "event",
        runMode: "live",
        ...ENDING_ENTITY,
        input: {},
      },
      concurrency: "unlimited",
      startedEntry: notYetDue.startedEntry,
      now: T0,
    });
    if (started.status !== "started") throw new Error("Start was refused");
    const executionId = started.execution.id;
    const { fence } = yield* claimRun(executionId, T0);
    yield* executions.fenced(fence).writeStepMemo(
      memoWrite({
        stepId: "node:send:dispatch",
        value: { sent: true },
        leaseExpiresAt: at(LEASE_MS),
      })
    );
    const waitStateId = yield* park(executionId, "wait_1", notYetDue.now);
    if (state === "cancel-claimed") {
      yield* executions.requestCancelForEntity({
        now: T0,
        workflowId: "wf_1",
        ...ENDING_ENTITY,
        eventName: "appointment/cancelled",
        payload: {},
        deliveryId: yield* cancelArrival(),
      });
    }
    if (state === "exit-claimed") {
      yield* executions.requestExit({ executionId, ...EXIT_CLAIM });
    }
    if (state === "ended") {
      yield* executions.endRun({
        executionId,
        ending: verdictOf("completed"),
      });
    }
    return { executionId, waitStateId };
  });
}

function sendEnding(ending: TableEnding, executionId: string) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    switch (ending.kind) {
      case "supersede": {
        const start = yield* executions.startForEntity({
          execution: {
            workflowId: "wf_1",
            workflowVersionId: "ver_1",
            startSource: "event",
            runMode: "live",
            ...ENDING_ENTITY,
            input: {},
          },
          concurrency: "newest-wins",
          ...notYetDue,
        });
        if (start.status !== "started") throw new Error("Start was refused");
        return {
          superseded: start.supersededExecutionIds.includes(executionId),
        };
      }
      case "cancel":
        return yield* executions.cancelRun({
          executionId,
          reason: CANCEL_REASON,
        });
      default:
        return yield* executions.endRun({ executionId, ending });
    }
  });
}

function observeRun(executionId: string, waitStateId: string) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const rows = yield* executions.listByWorkflow({
      workflowId: "wf_1",
      includeSuperseded: true,
    });
    const row = rows.find((candidate) => candidate.id === executionId);
    const termination = yield* executions.findTerminationState(executionId);
    const events = yield* executions.listEvents(executionId);
    const memo = yield* executions.listStepMemo({ executionId });
    return {
      status: row?.status,
      claim: termination?.claim?.kind ?? null,
      completedAt: row?.completedAt ?? null,
      duration: row?.duration ?? null,
      cancelledAt: row?.cancelledAt ?? null,
      entries: events.map(
        ({ id, workflowId, eventType, message, metadata }) => ({
          id,
          workflowId,
          eventType,
          message,
          metadata,
        })
      ),
      wait: (yield* executions.findWaitStateById(waitStateId))?.status,
      schedule: yield* executions.findSchedule({ executionId }),
      memo: memo.map((entry) => entry.stepId),
    };
  });
}

export function describeExecutionRunEndingConformance({
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("how each run-ending cause ends a run", () => {
    for (const { name, ending, against, before, answer, ends } of CASES) {
      it(name, async () => {
        const database = await openDatabase();
        const connection = await database.open();
        await seedPublishedWorkflow(connection);
        const { executionId, waitStateId } = await connection.run(
          runBeforeEnding(against)
        );
        await setTimestamp(database, {
          table: "workflow_executions",
          column: "started_at",
          where: `id = '${executionId}'`,
          at: new Date(Date.now() - STARTED_BEFORE_MS),
        });

        const observed = await connection.run(
          Effect.gen(function* () {
            return {
              before: yield* observeRun(executionId, waitStateId),
              answer: yield* sendEnding(ending, executionId),
              after: yield* observeRun(executionId, waitStateId),
            };
          })
        );

        // The run holds what the write would settle, so a write that leaves
        // it alone is told apart from a run with nothing to settle.
        expect(observed.before).toMatchObject(before);
        expect(observed.answer).toEqual(answer);
        const added = observed.after.entries.filter(
          (entry) => !observed.before.entries.some(({ id }) => id === entry.id)
        );
        expect(added).toEqual(
          ends === null
            ? []
            : [
                {
                  id: expect.any(String),
                  workflowId: "wf_1",
                  eventType: ENDING_ENTRY[ends.status],
                  message: ends.message,
                  metadata: expect.objectContaining(ends.metadata ?? {}),
                },
              ]
        );
        expect(observed.after).toEqual(
          ends === null
            ? observed.before
            : {
                status: ends.status,
                claim: observed.before.claim,
                completedAt: expect.any(Date),
                duration: expect.stringMatching(/^\d+$/),
                cancelledAt:
                  ends.status === "canceled" ? expect.any(Date) : null,
                entries: expect.arrayContaining(observed.before.entries),
                wait: "cancelled",
                schedule: null,
                memo: [],
              }
        );
        if (ends !== null) {
          expect(Number(observed.after.duration)).toBeGreaterThanOrEqual(
            STARTED_BEFORE_MS
          );
        }
      });
    }
  });
}
