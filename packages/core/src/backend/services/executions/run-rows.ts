import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { EffectLogger } from "#src/backend/lib/effect/app-logger";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import type { RunScopedAuditEventType } from "@wfgraph/shared/lifecycle/audit-event-types";
import {
  ExecutionRepo,
  type NewExecution,
} from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import type { JsonObject, JsonObjectDraft } from "@wfgraph/shared/types/json";
import type {
  EntityEligibilityReason,
  WorkflowExecutionIgnoredReason,
  WorkflowExecutionStartSource,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  SerializedWorkflowGraph,
  WorkflowMode,
} from "@wfgraph/shared/graph/types";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { WorkflowVersionKind } from "@wfgraph/shared/graph/version-kinds";

/**
 * Which graph a run pinned: the Draft the canvas held, or a published version
 * identified by its number.
 */
export type PinnedRunVersion = {
  kind: WorkflowVersionKind;
  /** The published version's number. Null on a draft snapshot. */
  number: number | null;
};

/**
 * Identity of the workflow plus the version the run will execute.
 *
 * The version is named by id alone. How the timeline words it is read from the
 * `workflow_versions` row as the run is opened (`runStartedEntry`), so a start
 * path cannot label a run with a version other than the one its row pins.
 */
export type WorkflowRunTarget = {
  id: string;
  name: string;
  graph: SerializedWorkflowGraph;
  versionId: string;
  catalogFingerprint: string;
};

/** Build the run target every start path hands to `startWithConcurrency`. */
export function toWorkflowRunTarget(input: {
  workflow: { id: string; name: string };
  versionId: string;
  catalogFingerprint: string;
  graph: SerializedWorkflowGraph;
}): WorkflowRunTarget {
  return {
    id: input.workflow.id,
    name: input.workflow.name,
    graph: input.graph,
    versionId: input.versionId,
    catalogFingerprint: input.catalogFingerprint,
  };
}

/**
 * Where the run came from, and which entity it is about.
 *
 * `entityValue` is the string the Lifecycle Rules read out of the payload at the
 * Event's Correlation Path, or the workflow's own id for a start that carries no
 * payload. Runs sharing one are about the same entity.
 */
export type WorkflowRunStart = {
  source: WorkflowExecutionStartSource;
  eventName?: string | undefined;
  /**
   * The arrival this start answers, which for an Event is the id the bus carried
   * it under. It goes on the audit row so one arrival can be traced across every
   * workflow it started or was refused by.
   */
  deliveryId?: string | undefined;
} & (
  | {
      /** Stable identity selected from an Event binding for a guarded workflow. */
      entityType: string;
      entityId: string;
      entityValue?: never;
    }
  | {
      /** Legacy untyped Correlation Path identity. */
      entityValue?: string | undefined;
      entityType?: never;
      entityId?: never;
    }
);

function workflowRunIdentity(start: WorkflowRunStart) {
  return start.entityType === undefined
    ? { entityValue: start.entityValue }
    : { entityType: start.entityType, entityId: start.entityId };
}

export type RecordTerminalWorkflowRunInput = {
  workflowId: string;
  /** The published version this terminal row still pins. */
  workflowVersionId: string;
  start: WorkflowRunStart;
  runMode: WorkflowMode;
  payload: JsonObject;
  status: "completed" | "failed" | "canceled";
  error?: string | undefined;
  output?: JsonObject | undefined;
  audit: {
    // Run-scoped only: this path always inserts the terminal Execution the row
    // hangs off, and a refusal opens no run to hang one off at all.
    eventType: Extract<
      RunScopedAuditEventType,
      "run_cancelled" | "run_ignored" | "run_completed"
    >;
    message: string;
    metadata?: JsonObjectDraft | undefined;
  };
};

/** How each start source names itself in a "run started" timeline entry. */
const RUN_STARTED_LABELS: Record<WorkflowExecutionStartSource, string> = {
  manual: "Manual",
  schedule: "Scheduled",
  event: "Event-triggered",
};

/**
 * How each start source names the thing it declined to run, phrased so it reads
 * as a noun inside "Ignored <subject> because ...".
 */
const IGNORED_SUBJECTS: Record<WorkflowExecutionStartSource, string> = {
  manual: "manual run",
  schedule: "scheduled run",
  event: "event",
};

/**
 * The opening words of a "run started" row: who started the run, and which graph
 * it ran.
 *
 * `runMode` cannot supply the graph. A Draft run always reaches test recipients
 * whatever Published mode the workflow is in, so a row worded from the mode
 * alone would read the same for a Draft run and for a test run of the published
 * version.
 */
function runStartedSubject(
  startSource: WorkflowExecutionStartSource,
  version: PinnedRunVersion | undefined
): string {
  const label = `${RUN_STARTED_LABELS[startSource]} `;

  if (version?.kind === "draft_snapshot") {
    return `${label}Draft run started`;
  }
  if (version?.number != null) {
    return `${label}run of v${version.number} started`;
  }
  return `${label}run started`;
}

/**
 * Who a run reached, which is all `runMode` decides. The wording names
 * recipients instead of "test mode", because Published mode is a setting on the
 * workflow while this row records what one run did.
 */
function runRecipientsPhrase(runMode: WorkflowMode): string {
  return runMode === "test" ? "test recipients" : "real recipients";
}

export function buildRunStartedAuditMessage(input: {
  startSource: WorkflowExecutionStartSource;
  runMode: WorkflowMode;
  eventName?: string | undefined;
  /** The version this run pinned, which names the graph that ran. */
  version?: PinnedRunVersion | undefined;
}): string {
  const subject = runStartedSubject(input.startSource, input.version);
  const event = input.eventName ? ` for ${input.eventName}` : "";
  return `${subject}${event}, to ${runRecipientsPhrase(input.runMode)}`;
}

/**
 * The sentence a Refused Start is recorded with, and the one a paused workflow's
 * ignored run gets. Both open with the same three words as the panel's heading, so
 * a builder reading a row knows which list it belongs to.
 */
export function buildIgnoredRunAuditMessage(input: {
  startSource: WorkflowExecutionStartSource;
  reason: WorkflowExecutionIgnoredReason;
  eventName?: string | undefined;
}): string {
  const subject = IGNORED_SUBJECTS[input.startSource];

  if (input.reason === "workflow_paused") {
    return `Ignored ${subject} because workflow is paused`;
  }

  const named = input.eventName ? `${subject} ${input.eventName}` : subject;

  if (input.reason === "concurrency_first_wins") {
    return `Refused a start from ${named}: a run for this entity is already going and Concurrency is first-wins`;
  }

  if (input.reason === "entity_value_missing") {
    return `Refused a start from ${named}: nothing at this workflow's Correlation Path, and Concurrency needs an entity to compare`;
  }

  if (input.reason === "start_event_required") {
    return `Refused a start from ${named}: this workflow splits on the Event a run is on, and this start named none`;
  }

  if (input.reason === "start_filter_not_met") {
    return `Refused a start from ${named}: the payload does not satisfy this workflow's start filter`;
  }

  if (input.reason === "entity_not_found") {
    return `Refused a start from ${named}: the tracked Entity no longer exists`;
  }

  if (input.reason === "entity_condition_not_met") {
    return `Refused a start from ${named}: current Entity State does not satisfy Entity Eligibility`;
  }

  // The filter's own error is not repeated here. It is a message from the CEL
  // library about a payload this row does not carry, and it goes to the log,
  // which is where an operator reads it.
  if (input.reason === "start_filter_unevaluable") {
    return `Refused a start from ${named}: this workflow's start filter could not be read against the payload`;
  }

  return `Refused a start from ${named}: this workflow does not list manual runs as a start source`;
}

/**
 * A refusal, recorded and narrated.
 *
 * Without the row a refusal is invisible, which is the class of problem ADR-0007
 * exists to remove: a builder reading run history should find the start that was
 * declined and why, rather than an absence.
 *
 * Both refusing call sites come through here, so a refusal's sentence, its audit
 * row and its log record are decided in one place whatever declined the start.
 * `extra` is what one reason knows and the others do not: the runs first-wins
 * found already going, or the error a Start Filter could not be read past.
 */
export function startAdmissionDecisionId(
  workflowId: string,
  deliveryId: string
): string {
  return `admission_${createHash("sha256")
    .update(`${workflowId}\0${deliveryId}`)
    .digest("hex")}`;
}

type RecordStartRefusalInput = {
  workflowId: string;
  startSource: WorkflowExecutionStartSource;
  runMode: WorkflowMode;
  logger: EffectLogger;
  eventName?: string | undefined;
  entityValue?: string | undefined;
  entityType?: string | undefined;
  extra?: JsonObject | undefined;
} & (
  | {
      reason: EntityEligibilityReason;
      deliveryId: string;
      /** Coordinates an Event's Entity refusal with a racing start transaction. */
      durableEntityAdmission: true;
    }
  | {
      reason: WorkflowExecutionIgnoredReason;
      deliveryId?: string | undefined;
      durableEntityAdmission?: false | undefined;
    }
);

export const recordStartRefusal = Effect.fn("recordStartRefusal")(function* (
  input: RecordStartRefusalInput
) {
  const repo = yield* ExecutionRepo;
  const message = buildIgnoredRunAuditMessage({
    startSource: input.startSource,
    reason: input.reason,
    eventName: input.eventName,
  });
  const metadata = omitUndefined({
    // The refusal's own keys are written last, so what one reason knows and
    // the others do not cannot rename the row it is written on.
    ...input.extra,
    reason: input.reason,
    startSource: input.startSource,
    eventName: input.eventName,
    entityValue: input.entityValue,
    entityType: input.entityType,
    deliveryId: input.deliveryId,
    runMode: input.runMode,
  });

  const admissionDecision =
    input.durableEntityAdmission && input.deliveryId
      ? yield* repo.recordAdmissionRefusal({
          workflowId: input.workflowId,
          deliveryId: input.deliveryId,
          decisionId: startAdmissionDecisionId(
            input.workflowId,
            input.deliveryId
          ),
          reason: input.reason,
          message,
          metadata,
        })
      : undefined;

  if (!admissionDecision) {
    yield* repo.recordAuditEvent({
      workflowId: input.workflowId,
      eventType: "run_refused",
      message,
      metadata,
    });
  }

  if (!admissionDecision || admissionDecision.kind === "refused") {
    yield* input.logger.info(
      "Start refused",
      omitUndefined({
        ...input.extra,
        reason: input.reason,
        entityValue: input.entityValue,
        entityType: input.entityType,
      })
    );
  }
  return admissionDecision;
});

/**
 * The "run started" timeline entry for a run about to be opened, which
 * `ExecutionRepo.startForEntity` writes in the transaction that inserts the
 * row.
 *
 * The version the entry names is read here from the id the row will pin, so
 * no caller can label a run with a version other than the one that run
 * pinned. A run's version row cascades with the run, so a start naming a
 * version that is gone is an invariant break rather than a state a retry can
 * recover from.
 */
export const runStartedEntry = Effect.fn("runStartedEntry")(function* (
  execution: NewExecution
) {
  const workflowRepo = yield* WorkflowRepo;
  const pinned = yield* workflowRepo.findVersionById(
    execution.workflowVersionId
  );
  if (!pinned) {
    return yield* new InternalFailure({
      error: "The run to start pins a workflow version that no longer exists",
    });
  }
  const version: PinnedRunVersion = {
    kind: pinned.kind,
    number: pinned.version,
  };

  return {
    message: buildRunStartedAuditMessage({
      startSource: execution.startSource,
      runMode: execution.runMode,
      eventName: execution.startEventName,
      version,
    }),
    // `entityId` stays off the timeline: it is the host's own record id, and
    // the row that carries it is what an operator reads it from.
    metadata: omitUndefined({
      startSource: execution.startSource,
      runMode: execution.runMode,
      versionKind: version.kind,
      versionNumber: version.number ?? undefined,
      eventName: execution.startEventName,
      entityValue: execution.entityValue,
      entityType: execution.entityType,
      deliveryId: execution.deliveryId,
    }),
  };
});

/**
 * Writes an execution row for a request that reached a verdict without ever
 * running the graph, such as a cancellation or an ignored event. The row starts
 * and completes at the same instant so the run list still shows the decision.
 *
 * A caller owes a row whenever the runs list is the only feedback it gives: the
 * manual execute route answers a screen whose next question is "what happened",
 * and a decision with no row reads there as nothing having happened at all.
 */
export const recordTerminalWorkflowRun = Effect.fn("recordTerminalWorkflowRun")(
  function* (input: RecordTerminalWorkflowRunInput) {
    const repo = yield* ExecutionRepo;

    const execution = yield* repo.insertTerminal({
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      status: input.status,
      startSource: input.start.source,
      runMode: input.runMode,
      startEventName: input.start.eventName,
      ...workflowRunIdentity(input.start),
      input: input.payload,
      output: input.output,
      error: input.error,
    });

    yield* repo.recordAuditEvent({
      workflowId: input.workflowId,
      executionId: execution.id,
      eventType: input.audit.eventType,
      message: input.audit.message,
      metadata: input.audit.metadata,
    });

    return execution;
  }
);

/**
 * The terminal row a paused workflow's request gets.
 *
 * The manual route is the only caller: a paused workflow is filtered out of the
 * subscription join, so an Event never reaches one. The row exists because the
 * runs list is the only
 * feedback the Run button gives, and a decision with no row reads there as nothing
 * having happened.
 */
export const recordPausedRunIgnored = Effect.fn("recordPausedRunIgnored")(
  function* (input: {
    workflowId: string;
    workflowVersionId: string;
    startSource: WorkflowExecutionStartSource;
    runMode: WorkflowMode;
    payload: JsonObject;
    eventName?: string | undefined;
    entityType?: string | undefined;
    entityId?: string | undefined;
  }) {
    const start: WorkflowRunStart =
      input.entityType && input.entityId
        ? {
            source: input.startSource,
            eventName: input.eventName,
            entityType: input.entityType,
            entityId: input.entityId,
          }
        : { source: input.startSource, eventName: input.eventName };

    return yield* recordTerminalWorkflowRun({
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      start,
      runMode: input.runMode,
      payload: input.payload,
      status: "completed",
      output: {
        status: "ignored",
        reason: "workflow_paused",
        runMode: input.runMode,
      },
      audit: {
        eventType: "run_ignored",
        message: buildIgnoredRunAuditMessage({
          startSource: input.startSource,
          reason: "workflow_paused",
        }),
        metadata: {
          reason: "workflow_paused",
          runMode: input.runMode,
        },
      },
    });
  }
);
