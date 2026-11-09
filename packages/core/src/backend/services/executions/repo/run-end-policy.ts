/**
 * How a run ends. A caller names why (`RunEnding`), and `decideRunEnd` answers
 * from the run's stored status and claim what to write, timeline entry
 * included, or that the run is left alone. Both database backends and the
 * engine's recording store decide with it, and none imports a database.
 */

import type { RunScopedAuditEventType } from "@wfgraph/shared/lifecycle/audit-event-types";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type EntityEligibilityReason,
  type TerminalExecutionStatus,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObjectDraft, JsonValue } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

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

/** The engine walked the graph and reached `status`. */
export type RunVerdict = {
  kind: "verdict";
  status: "completed" | "failed" | "canceled" | "exited";
  output?: JsonValue | undefined;
  exitContext?: RunExitContext | undefined;
  /**
   * How the traversal reached `status`, which the entry is worded from:
   * `walked` ran the graph to its end, and `fatal` is an error that escaped it.
   * `error` is the message the run's row keeps.
   */
  reached:
    | {
        kind: "walked";
        resultCount: number;
        error?: string | undefined;
        canceledOutlet?: CanceledOutletOutcome | undefined;
      }
    | {
        kind: "fatal";
        error: string;
        failureKind: string;
        canceledOutlet?: CanceledOutletOutcome | undefined;
      };
};

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

export type RunEndEntry<
  Status extends TerminalExecutionStatus = TerminalExecutionStatus,
> = {
  eventType: (typeof ENTRY_TYPE)[Status];
  message: string;
  metadata: JsonObjectDraft;
};

export type RunEndDecision<
  Status extends TerminalExecutionStatus = TerminalExecutionStatus,
> =
  | {
      kind: "write";
      status: Status;
      output: JsonValue | undefined;
      error: string | undefined;
      entry: RunEndEntry<Status>;
    }
  | { kind: "leave" };

const LEAVE = { kind: "leave" } as const satisfies RunEndDecision;

/**
 * Decides one ending against one run. An ended run is always left. Otherwise:
 *
 * - A verdict under an Exit claim ends the run `exited`. Under a Cancel claim
 *   only a `canceled` verdict ends it, so the engine runs the Canceled outlet
 *   before it records `canceled`. With no claim, `completed` and `failed` end
 *   it and the two claimed statuses leave it.
 * - An outside-graph ending writes `failed`, or the status the claim selects.
 * - A cancel or a supersede ends only a run holding no claim, since the run's
 *   own pass finalizes the claim it holds.
 */
export function decideRunEnd(
  ending: RunVerdict,
  row: RunEndRow
): RunEndDecision<RunVerdict["status"]>;
export function decideRunEnd(ending: RunEnding, row: RunEndRow): RunEndDecision;
export function decideRunEnd(
  ending: RunEnding,
  row: RunEndRow
): RunEndDecision {
  if (!isInFlight(row.status)) return LEAVE;
  switch (ending.kind) {
    case "verdict": {
      const status = verdictStatus(ending.status, row.claim);
      if (status === null) return LEAVE;
      return {
        kind: "write",
        status,
        output: ending.output,
        // A verdict an Exit claim overrode keeps no error: the run ended
        // because its Entity was ineligible.
        error: status === ending.status ? ending.reached.error : undefined,
        entry: verdictEntry(ending, status, row),
      };
    }
    case "outsideGraph": {
      const status =
        row.claim === null ? "failed" : CLAIMED_STATUS[row.claim.kind];
      return {
        kind: "write",
        status,
        output: undefined,
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
    case "cancel":
      if (row.claim !== null) return LEAVE;
      return {
        kind: "write",
        status: "canceled",
        output: undefined,
        error: ending.reason,
        entry: {
          eventType: "run_cancelled",
          message: ending.reason,
          metadata: { eventName: ending.eventName },
        },
      };
  }
  if (row.claim !== null) return LEAVE;
  const reason = supersededReason(ending.startEventName);
  return {
    kind: "write",
    status: "superseded",
    output: undefined,
    error: reason,
    entry: {
      eventType: "run_superseded",
      message: reason,
      metadata: { eventName: ending.startEventName },
    },
  };
}

function isInFlight(status: WorkflowExecutionStatus): boolean {
  return IN_FLIGHT_EXECUTION_STATUSES.some((candidate) => candidate === status);
}

type VerdictStatus = RunVerdict["status"];

const CLAIMED_STATUS = {
  cancel: "canceled",
  exit: "exited",
} as const satisfies Record<RunEndClaim["kind"], VerdictStatus>;

function verdictStatus(
  verdict: VerdictStatus,
  claim: RunEndClaim | null
): VerdictStatus | null {
  if (claim?.kind === "exit") return "exited";
  if (claim?.kind === "cancel") return verdict === "canceled" ? verdict : null;
  return verdict === "completed" || verdict === "failed" ? verdict : null;
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

const OUTSIDE_GRAPH_MESSAGE = {
  failed: "Run failed with fatal error",
  canceled: "Run canceled after a fatal error; the Canceled outlet did not run",
  exited: EXITED_MESSAGE,
} as const satisfies Record<Exclude<VerdictStatus, "completed">, string>;

const WALKED_MESSAGE = {
  completed: "Run completed successfully",
  failed: "Run completed with errors",
  canceled: "Run canceled at the Canceled outlet",
  exited: EXITED_MESSAGE,
} as const satisfies Record<VerdictStatus, string>;

const CANCELED_FATAL_MESSAGE = {
  entered: "Run canceled at the Canceled outlet, then ended on a fatal error",
  ran: "Run canceled at the Canceled outlet after a fatal error",
  failed: "Run canceled after a fatal error; the Canceled outlet failed",
} as const satisfies Record<CanceledOutletOutcome, string>;

function verdictEntry(
  verdict: RunVerdict,
  status: VerdictStatus,
  row: RunEndRow
): RunEndEntry<VerdictStatus> {
  const eventType = ENTRY_TYPE[status];
  const exit =
    status === "exited"
      ? exitOutcome(row.claim, verdict.exitContext)
      : undefined;
  const { reached } = verdict;
  if (reached.kind === "walked") {
    return {
      eventType,
      message: withRecipients(WALKED_MESSAGE[status], row.runMode),
      metadata: exit
        ? {
            resultCount: reached.resultCount,
            runMode: row.runMode,
            ...exit,
            checkpoint: "before-node",
          }
        : omitUndefined({
            resultCount: reached.resultCount,
            runMode: row.runMode,
            canceledOutlet:
              status === "canceled" ? reached.canceledOutlet : undefined,
          }),
    };
  }
  const canceledOutlet =
    status === "canceled" ? reached.canceledOutlet : undefined;
  return {
    eventType,
    message: withRecipients(
      canceledOutlet
        ? CANCELED_FATAL_MESSAGE[canceledOutlet]
        : status === "exited"
          ? EXITED_MESSAGE
          : "Run failed with fatal error",
      row.runMode
    ),
    metadata: exit
      ? { ...exit, checkpoint: "before-node", runMode: row.runMode }
      : omitUndefined({
          error: reached.error,
          failureKind: reached.failureKind,
          runMode: row.runMode,
          canceledOutlet,
        }),
  };
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
