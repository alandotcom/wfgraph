/**
 * How a run ends. A caller names why (`RunEnding`), and `decideRunEnd` answers
 * from the run's stored status and claim what to write, timeline entry
 * included, or that the run is left alone. Both database backends and the
 * engine's recording store decide with it, and none imports a database.
 */

import type { RunScopedAuditEventType } from "#src/lifecycle/audit-event-types";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type EntityEligibilityReason,
  type TerminalExecutionStatus,
  type WorkflowExecutionStatus,
} from "#src/lifecycle/execution-contracts";
import type { JsonObjectDraft } from "#src/types/json";
import { omitUndefined } from "#src/utils/omit-undefined";

/**
 * What became of the Canceled outlet for a run whose verdict is `canceled`.
 *
 * `entered` is a run that had taken the outlet before a fatal error. `ran` and
 * `failed` cover a Cancel claim that refused the run's first verdict: the
 * engine ran the outlet for that claim, and it either finished or died partway.
 */
export type CanceledOutletOutcome = "entered" | "ran" | "failed";

export type RunExitContext = { entityType: string; conditionId: string };

export type RunExitOutcome = RunExitContext & {
  reason: EntityEligibilityReason;
  nodeId: string;
  checkedAt: string;
};

/** The traversal walked the graph to its end, with `resultCount` nodes run. */
type Walked = { kind: "walked"; resultCount: number };

/** An error escaped the traversal. `error` is the message the row keeps. */
type Fatal = { kind: "fatal"; error: string; failureKind: string };

type VerdictOf<Status, Reached> = {
  kind: "verdict";
  status: Status;
  reached: Reached;
  /** What an Exit claim's entry names, for a run with Entity Eligibility. */
  exitContext?: RunExitContext | undefined;
};

/**
 * The engine walked the graph and reached a verdict. Each status carries only
 * the evidence it can have: a failed run its error, and a canceled run what
 * became of its Canceled outlet. A walked canceled run with no outlet outcome
 * reached the outlet on its own, and its `error` is a node's failure.
 */
export type RunVerdict =
  | VerdictOf<"completed", Walked>
  | VerdictOf<"failed", (Walked & { error: string }) | Fatal>
  | VerdictOf<
      "canceled",
      | (Walked & {
          error?: string | undefined;
          canceledOutlet?: "ran" | "failed" | undefined;
        })
      | (Fatal & { canceledOutlet: CanceledOutletOutcome })
    >;

/**
 * The executor ends a run it could not walk: a step outside any node spent its
 * retries, or the version the run pins is gone.
 */
export type OutsideGraphEnding = { kind: "outsideGraph"; error: string };

/** An operator, a Cancel Event or a Lifecycle Rule stops the run from outside it. */
export type CancelEnding = {
  kind: "cancel";
  reason: string;
  eventName?: string | undefined;
};

/** Newest-wins Concurrency lets a newer start take the run's place. */
export type SupersedeEnding = {
  kind: "supersede";
  /** The Event that started the newer run, absent for a manual or cron start. */
  startEventName?: string | undefined;
};

export type RunEnding =
  | RunVerdict
  | OutsideGraphEnding
  | CancelEnding
  | SupersedeEnding;

/** The part of a run's termination claim an ending reads. */
export type RunEndClaim =
  | { kind: "cancel" }
  | {
      kind: "exit";
      reason: EntityEligibilityReason;
      nodeId: string;
      requestedAt: string;
    };

/** The run an ending reaches, as it is stored when the write decides. */
export type RunEndRow = {
  status: WorkflowExecutionStatus;
  claim: RunEndClaim | null;
  runMode: "live" | "test";
};

const ENTRY_TYPE = {
  completed: "run_completed",
  failed: "run_failed",
  canceled: "run_cancelled",
  exited: "run_exited",
  superseded: "run_superseded",
} as const satisfies Record<TerminalExecutionStatus, RunScopedAuditEventType>;

export type RunEndEntry = {
  eventType: (typeof ENTRY_TYPE)[TerminalExecutionStatus];
  message: string;
  metadata: JsonObjectDraft;
};

export type RunEndDecision =
  | {
      kind: "write";
      status: TerminalExecutionStatus;
      error: string | undefined;
      entry: RunEndEntry;
    }
  | { kind: "leave" };

const LEAVE = { kind: "leave" } as const satisfies RunEndDecision;

/**
 * Decides one ending against one run. An ended run is always left. Otherwise:
 *
 * - A verdict under an Exit claim ends the run `exited`. Under a Cancel claim
 *   only a `canceled` verdict ends it, so the engine runs the Canceled outlet
 *   before it records `canceled`. With no claim, `completed` and `failed` end
 *   it and `canceled` leaves it.
 * - An outside-graph ending writes `failed`, or the status the claim selects.
 * - A cancel or a supersede ends only a run holding no claim, since the run's
 *   own pass finalizes the claim it holds.
 */
export function decideRunEnd(
  ending: RunEnding,
  row: RunEndRow
): RunEndDecision {
  if (!isInFlight(row.status)) return LEAVE;
  switch (ending.kind) {
    case "verdict":
      if (row.claim?.kind === "exit") {
        return {
          kind: "write",
          status: "exited",
          // The run ended because its Entity was ineligible, so the verdict's
          // error is not the reason it ended.
          error: undefined,
          entry: exitedEntry(ending, row.claim, row.runMode),
        };
      }
      if ((row.claim?.kind === "cancel") !== (ending.status === "canceled")) {
        return LEAVE;
      }
      return {
        kind: "write",
        status: ending.status,
        error: ending.status === "completed" ? undefined : ending.reached.error,
        entry: verdictEntry(ending, row.runMode),
      };
    case "outsideGraph": {
      const status =
        row.claim === null ? "failed" : CLAIMED_STATUS[row.claim.kind];
      return {
        kind: "write",
        status,
        error: ending.error,
        entry: {
          eventType: ENTRY_TYPE[status],
          message: withRecipients(OUTSIDE_GRAPH_MESSAGE[status], row.runMode),
          metadata: {
            error: ending.error,
            failureKind: "failure",
            runMode: row.runMode,
          },
        },
      };
    }
    default:
      return row.claim === null ? stoppedFromOutside(ending) : LEAVE;
  }
}

function isInFlight(status: WorkflowExecutionStatus): boolean {
  return IN_FLIGHT_EXECUTION_STATUSES.some((candidate) => candidate === status);
}

const CLAIMED_STATUS = {
  cancel: "canceled",
  exit: "exited",
} as const satisfies Record<RunEndClaim["kind"], TerminalExecutionStatus>;

/** A cancel or a supersede, which stops a run from outside it. */
function stoppedFromOutside(
  ending: CancelEnding | SupersedeEnding
): RunEndDecision {
  const { status, reason, eventName } =
    ending.kind === "cancel"
      ? ({
          status: "canceled",
          reason: ending.reason,
          eventName: ending.eventName,
        } as const)
      : ({
          status: "superseded",
          reason: supersededReason(ending.startEventName),
          eventName: ending.startEventName,
        } as const);
  return {
    kind: "write",
    status,
    error: reason,
    entry: {
      eventType: ENTRY_TYPE[status],
      message: reason,
      metadata: { eventName },
    },
  };
}

function supersededReason(eventName: string | undefined): string {
  return eventName
    ? `Superseded by a newer start from ${eventName}`
    : "Superseded by a newer start";
}

function withRecipients(message: string, runMode: "live" | "test"): string {
  return runMode === "test" ? `${message} (test recipients)` : message;
}

const EXITED_MESSAGE = "Run exited because the Entity was ineligible";

const FATAL_MESSAGE = "Run failed with fatal error";

const OUTSIDE_GRAPH_MESSAGE = {
  failed: FATAL_MESSAGE,
  canceled: "Run canceled after a fatal error; the Canceled outlet did not run",
  exited: EXITED_MESSAGE,
} as const;

const WALKED_MESSAGE = {
  completed: "Run completed successfully",
  failed: "Run completed with errors",
  canceled: "Run canceled at the Canceled outlet",
} as const satisfies Record<RunVerdict["status"], string>;

const CANCELED_FATAL_MESSAGE = {
  entered: "Run canceled at the Canceled outlet, then ended on a fatal error",
  ran: "Run canceled at the Canceled outlet after a fatal error",
  failed: "Run canceled after a fatal error; the Canceled outlet failed",
} as const satisfies Record<CanceledOutletOutcome, string>;

function verdictEntry(
  verdict: RunVerdict,
  runMode: "live" | "test"
): RunEndEntry {
  const eventType = ENTRY_TYPE[verdict.status];
  const canceledOutlet =
    verdict.status === "canceled" ? verdict.reached.canceledOutlet : undefined;
  const { reached } = verdict;
  if (reached.kind === "walked") {
    return {
      eventType,
      message: withRecipients(WALKED_MESSAGE[verdict.status], runMode),
      metadata: omitUndefined({
        resultCount: reached.resultCount,
        runMode,
        canceledOutlet,
      }),
    };
  }
  return {
    eventType,
    message: withRecipients(
      canceledOutlet ? CANCELED_FATAL_MESSAGE[canceledOutlet] : FATAL_MESSAGE,
      runMode
    ),
    metadata: omitUndefined({
      error: reached.error,
      failureKind: reached.failureKind,
      runMode,
      canceledOutlet,
    }),
  };
}

/**
 * The entry of a verdict an Exit claim ended. A run with no Entity Eligibility
 * context keeps the verdict's own fields in place of the Exit's.
 */
function exitedEntry(
  verdict: RunVerdict,
  claim: Extract<RunEndClaim, { kind: "exit" }>,
  runMode: "live" | "test"
): RunEndEntry {
  return {
    eventType: "run_exited",
    message: withRecipients(EXITED_MESSAGE, runMode),
    metadata: exitedMetadata(
      verdict.reached,
      exitOutcome(claim, verdict.exitContext),
      runMode
    ),
  };
}

function exitedMetadata(
  reached: RunVerdict["reached"],
  exit: RunExitOutcome | undefined,
  runMode: "live" | "test"
): JsonObjectDraft {
  if (exit) {
    const exitFields = { runMode, ...exit, checkpoint: "before-node" };
    return reached.kind === "walked"
      ? { resultCount: reached.resultCount, ...exitFields }
      : exitFields;
  }
  return reached.kind === "walked"
    ? { resultCount: reached.resultCount, runMode }
    : { error: reached.error, failureKind: reached.failureKind, runMode };
}

export function exitOutcome(
  claim: RunEndClaim | null | undefined,
  context: RunExitContext | undefined
): RunExitOutcome | undefined {
  return claim?.kind === "exit" && context
    ? {
        reason: claim.reason,
        entityType: context.entityType,
        conditionId: context.conditionId,
        nodeId: claim.nodeId,
        checkedAt: claim.requestedAt,
      }
    : undefined;
}
