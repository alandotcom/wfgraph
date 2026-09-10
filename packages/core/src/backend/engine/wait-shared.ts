/**
 * The vocabulary the Wait node's driver and its two modes share.
 *
 * A Wait is driven as a series of attempts. Each attempt resolves what to park
 * with, writes that park onto the run's one wait row, suspends, and reads why it
 * woke; a `version-migrate` wake sends the Wait around again against the
 * Workflow Version the execution row now names. The step ids for an attempt's
 * prepare, park and resume carry the attempt index, so a park that replaces an
 * earlier one is fresh work rather than a replay of it. The row the Wait opens
 * is memoized under `wait-start-log-<nodeId>`, which carries no index because
 * one row covers every attempt.
 */

import { Effect } from "effect";
import type { WaitConfig } from "@wfgraph/shared/lifecycle/wait-subscription";
import {
  isWaitSignalType,
  type WaitSignalType,
} from "@wfgraph/shared/lifecycle/wait-signal";
import { celStringLiteral } from "@wfgraph/shared/conditions/cel-string-literal";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import type { ExecutionResult } from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { NodeContext } from "#src/backend/engine/step-log";
import type {
  WorkflowStepLogHandle,
  WorkflowStore,
} from "#src/backend/engine/store";
import type { ResolveTemplates } from "#src/backend/engine/wait-match";
import {
  type EngineFailure,
  engineFailure,
  failureFromCause,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import { closeStepLog } from "#src/backend/engine/step-log";
import type { DatabaseError } from "#src/backend/lib/effect/database";

export type WaitActionInput = {
  config: Record<string, unknown>;
  context: NodeContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  workflowId: string;
  /** The Workflow Version the running body loaded. See `WaitBranchContext`. */
  workflowVersionId: string;
  workflowRunId?: string | undefined;
  /** See `WaitBranchContext.resolveTemplates`. */
  resolveTemplates: ResolveTemplates;
};

/**
 * Wait context shared by the delay and event modes.
 */
export type WaitBranchContext = {
  config: WaitConfig;
  context: NodeContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  workflowId: string;
  /**
   * The Workflow Version whose graph this body is walking. A Migration moves the
   * execution row's pointer while the run is parked, and every durable step of
   * this node compares the two, so an attempt never carries on under a graph the
   * run has been moved off.
   */
  workflowVersionId: string;
  runId: string;
  /**
   * Resolves the `{{@nodeId:Label.field}}` references inside a match, which the
   * config-wide template pass does not reach: it walks the config's own string
   * values, and a match sits one level down inside `waitFor`.
   */
  resolveTemplates: ResolveTemplates;
  /** Memoized "step started" log row reused by every attempt below. */
  startLog: WorkflowStepLogHandle;
};

/**
 * What the Wait node leaves behind: its own outcome, and whether the run should
 * stop below it.
 *
 * The two are separate because they travel different distances. The outcome is
 * the node's, and it is stored and read back. Halting is the scheduler's, read
 * a few lines from where this is returned and never persisted.
 */
export type WaitOutcome = {
  result: ExecutionResult;
  haltBranch: boolean;
  /**
   * How this Wait changes the Arriving Event. Absent means leave it. `null`
   * means the run names none below this node (a timeout that continues). A
   * named Event replaces the one the run was on.
   */
  arrivingEvent?: { eventName: string; payload: JsonObject } | null | undefined;
};

export function fromStore<A>(
  effect: Effect.Effect<A, DatabaseError>
): Effect.Effect<A, EngineFailure> {
  return Effect.mapError(effect, failureFromUnknown);
}

/**
 * Moves the run back to `running` under the Workflow Version this body loaded,
 * failing the step when no row moved.
 *
 * The guarded write is the resume's version fence, and it is the first thing a
 * resume does. A Migration that lands between the wake and this write leaves the
 * execution row pinned to another version, so nothing moves and the step fails;
 * Inngest retries the body, which reloads the graph from the new pointer and
 * prepares the Wait again. Running it first leaves the wait row untouched for
 * that retry to re-park.
 */
export function markRunningUnderLoadedVersion(
  branch: WaitBranchContext
): Effect.Effect<void, EngineFailure> {
  return Effect.flatMap(
    fromStore(
      branch.store.markExecutionRunning({
        executionId: branch.context.executionId,
        workflowVersionId: branch.workflowVersionId,
      })
    ),
    (moved) =>
      moved
        ? Effect.void
        : Effect.fail(
            engineFailure(
              "failure",
              `This run has been moved off workflow version ${branch.workflowVersionId} since its graph was loaded.`
            )
          )
  );
}

export function readWaitGateMode(
  config: WaitConfig
): "require_actual_wait" | "off" {
  return config.waitGateMode === "require_actual_wait"
    ? "require_actual_wait"
    : "off";
}

/**
 * The CEL that admits a wait signal addressed to this parked node.
 *
 * Both modes park on one envelope, so the match is what separates their runs
 * from each other: the execution, the node, the reasons the mode answers to,
 * and for an event wait the token that names this park. A delay wait has no
 * token, because the execution and the node already address it and a token on
 * its row would offer the runs panel a manual resume the delay cannot honour.
 */
export function waitSignalMatch(input: {
  nodeId: string;
  resumeToken?: string | undefined;
  signalTypes: readonly WaitSignalType[];
}): string {
  const clauses = [
    "async.data.executionId == event.data.executionId",
    `async.data.nodeId == ${celStringLiteral(input.nodeId)}`,
  ];

  if (input.resumeToken !== undefined) {
    clauses.push(`async.data.token == ${celStringLiteral(input.resumeToken)}`);
  }

  const reasons = input.signalTypes
    .map(
      (signalType) => `async.data.signalType == ${celStringLiteral(signalType)}`
    )
    .join(" || ");
  clauses.push(`(${reasons})`);

  return clauses.join(" && ");
}

/**
 * Why a park ended.
 *
 * `timeout` is the park running out of the time it was given. The other three
 * are the reasons a `workflow/wait.signal` carries: an Event or a manual resume,
 * a Cancel Event claiming the run, and a Migration telling the Wait to prepare
 * itself again. A signal envelope naming no reason this build knows reads as a
 * resume, because a resume is what a wake with a payload and no verdict is.
 */
export type WaitWake =
  | { kind: "timeout" }
  | { kind: "migrate" }
  | { kind: "cancel" }
  | { kind: "resume"; eventName: string | null; payload: JsonObject };

/**
 * Why a park ended, as a resume sees it.
 *
 * A `migrate` wake never reaches a resume: the driver reads it as the
 * instruction to prepare the Wait again against the version the run was moved
 * to, and starts the next attempt instead of resuming.
 */
export type WaitResumeWake = Exclude<WaitWake, { kind: "migrate" }>;

/**
 * Reads why a park ended out of the Inngest event that ended it.
 *
 * `waitForEvent` resolves to the whole event object, and Workflow Graph's own
 * envelope is the `data` inside it. Reading it once here is what keeps that
 * envelope out of everything below: a builder addresses the Event's payload,
 * not the transport it travelled in. A timeout resolves to null.
 */
export function readWaitWake(resumeEvent: unknown): WaitWake {
  if (resumeEvent === null) {
    return { kind: "timeout" };
  }

  const signal = readJsonObject(readJsonObject(resumeEvent)?.data);
  const signalType = signal?.signalType;
  if (isWaitSignalType(signalType)) {
    if (signalType === "version-migrate") {
      return { kind: "migrate" };
    }
    if (signalType === "lifecycle-cancel") {
      return { kind: "cancel" };
    }
  }

  const eventName = signal?.eventType;
  return {
    kind: "resume",
    eventName: typeof eventName === "string" ? eventName : null,
    payload: readJsonObject(signal?.payload) ?? {},
  };
}

/**
 * Suspends the run, closing the Wait's step-log row if the run unwinds instead
 * of waking.
 *
 * A failure at a suspension means the run is being torn down (cancellation
 * surfaces this way), so the closing row is written directly rather than as a
 * durable step, which the unwinding run would never reach.
 */
export function parkUntil<A>(
  branch: WaitBranchContext,
  suspension: Effect.Effect<A, EngineFailure>
): Effect.Effect<A, EngineFailure> {
  return Effect.catchCause(suspension, (cause) =>
    Effect.gen(function* () {
      yield* closeStepLog(branch.store, branch.startLog, {
        status: "error",
        error: failureFromCause(cause).message,
      });
      return yield* Effect.failCause(cause);
    })
  );
}

/**
 * What one attempt of a Wait node parks with: the row it writes and the
 * suspension it registers, which are two readings of the same decision.
 */
export type WaitPark = {
  waitType: "delay" | "event";
  /** Target timestamp as ISO 8601: a delay's end, or an event wait's timeout. */
  waitUntilIso: string | null;
  /** The Event names a delivery finds this row by. Empty for a delay wait. */
  subscribedEvents: string[];
  /** The token addressing this park, and null for a delay wait, which has none. */
  resumeToken: string | null;
  metadata: JsonObject;
  /** Milliseconds left until the target. Zero or less parks nothing. */
  timeoutMs: number;
  /** Which signals this park answers to. */
  signalTypes: readonly WaitSignalType[];
};

/** The attempt a mode is resolving, and what the attempts before it settled. */
export type WaitAttempt = {
  index: number;
  /**
   * The instant the first attempt resolved against, absent on that attempt. A
   * later attempt measures from it, so a Migration changes a Wait's target
   * without restarting its clock.
   */
  anchorAt?: Date | undefined;
  /** The token the row already carries, absent until an attempt mints one. */
  resumeToken?: string | undefined;
};

/**
 * What a mode's resolution answers. It crosses a memoized step boundary, so
 * every field is JSON-safe.
 */
export type WaitPreparation<Prepared> =
  | { status: "error"; error: string }
  | { status: "skipped"; output: Record<string, unknown> }
  | {
      status: "ready";
      /** The instant this attempt resolved against, as an ISO string. */
      anchorAtIso: string;
      park: WaitPark;
      /** What this mode's resume reads back. */
      prepared: Prepared;
    };

/** What a mode's resume step writes and hands to its outcome. */
export type WaitResumeInput<Prepared> = {
  branch: WaitBranchContext;
  prepared: Prepared;
  waitStateId: string;
  wake: WaitResumeWake;
  /** How many times this Wait parked, which is the node's `hops` output. */
  hops: number;
};

/**
 * One mode of the Wait node, as the driver in `wait.ts` uses it.
 *
 * The driver owns the loop, the wait row and the suspension. A mode owns what
 * its config resolves to, what its resume writes, and the shape of its output.
 */
export type WaitMode<Prepared, Resumed> = {
  readonly mode: "delay" | "event";
  prepare: (
    branch: WaitBranchContext,
    attempt: WaitAttempt
  ) => Effect.Effect<WaitPreparation<Prepared>, EngineFailure>;
  /** The body of the resume step. Its answer crosses a step boundary as JSON. */
  resume: (
    input: WaitResumeInput<Prepared>
  ) => Effect.Effect<Resumed, EngineFailure>;
  /** What the node leaves behind, read off the memoized resume and the wake. */
  outcome: (input: { resumed: Resumed; wake: WaitWake }) => WaitOutcome;
};

/**
 * The step ids one attempt of a Wait node memoizes its own work under.
 *
 * The ids name the node and the attempt and nothing else. A Migration may give
 * the node the other mode, and the body that reloads the new Workflow Version
 * has to replay the attempts already on the run: an id carrying the mode would
 * miss every one of them, so the driver would start attempt 0 again with an
 * empty carry and open a second wait row beside the one still parked. The mode
 * appears in the step *name* instead, which the Inngest UI shows and no replay
 * reads.
 */
export function waitStepIds(input: { nodeId: string; attempt: number }): {
  prepare: string;
  park: string;
  resume: string;
} {
  const suffix = `${input.nodeId}-${input.attempt}`;
  return {
    prepare: `wait-prepare-${suffix}`,
    park: `wait-park-${suffix}`,
    resume: `wait-resume-${suffix}`,
  };
}

/** How an attempt's step is labelled in a durable runtime's trace. */
export function waitStepName(input: {
  nodeName: string;
  attempt: number;
  stage: string;
}): string {
  const attempt = input.attempt > 0 ? ` attempt ${input.attempt}` : "";
  return `${input.nodeName} (${input.stage}${attempt})`;
}

export function readAllowedHoursConfig(config: WaitConfig) {
  return {
    waitAllowedHoursMode: config.waitAllowedHoursMode,
    waitAllowedStartTime: config.waitAllowedStartTime,
    waitAllowedEndTime: config.waitAllowedEndTime,
  };
}
