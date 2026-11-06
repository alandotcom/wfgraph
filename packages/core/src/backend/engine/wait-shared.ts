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
import type { ExecutionSide } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { ExecutionResult } from "#src/backend/engine/contracts";
import type {
  WaitWake,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";
import type { NodeContext } from "#src/backend/engine/step-log";
import type {
  StoreFailure,
  WorkflowStepLogHandle,
  WorkflowStore,
} from "#src/backend/engine/store";
import type { ResolveTemplates } from "#src/backend/engine/wait-match";
import {
  type EngineFailure,
  failureFromCause,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import { closeStepLog } from "#src/backend/engine/step-log";

export type WaitActionInput = {
  config: Record<string, unknown>;
  context: NodeContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  workflowId: string;
  /** The Workflow Version the running body loaded. See `WaitBranchContext`. */
  workflowVersionId: string;
  /** Which side of the Lifecycle Node this Wait sits on. */
  side: ExecutionSide;
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
   * execution row's pointer while the run is parked, and each of this node's
   * three writes against that row requires it to still pin this version, so an
   * attempt never carries on under a graph the run has been moved off.
   */
  workflowVersionId: string;
  /**
   * Which side of the Lifecycle Node this Wait sits on. Every write this node
   * makes against the execution row carries it, because a Cancel claim admits
   * the Canceled side and refuses the Started one.
   */
  side: ExecutionSide;
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
 * What the Wait node leaves behind: settled, or still parked.
 *
 * A parked Wait has no outcome yet. Its branch halts with the node unfinished,
 * and the node is entered again on the next pass of the body, once the runtime
 * has resolved the park.
 */
export type WaitOutcome = SettledWaitOutcome | { status: "parked" };

/**
 * A Wait that finished: its own outcome, and whether the run should stop below
 * it.
 *
 * The two are separate because they travel different distances. The outcome is
 * the node's, and it is stored and read back. Halting is the scheduler's, read
 * a few lines from where this is returned and never persisted.
 */
export type SettledWaitOutcome = {
  status: "settled";
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
  effect: Effect.Effect<A, StoreFailure>
): Effect.Effect<A, EngineFailure> {
  return Effect.mapError(effect, failureFromUnknown);
}

export type WaitGateMode = "off" | "require_actual_wait" | "max_lateness";

export function readWaitGateMode(config: WaitConfig): WaitGateMode {
  return config.waitGateMode === "require_actual_wait" ||
    config.waitGateMode === "max_lateness"
    ? config.waitGateMode
    : "off";
}

/**
 * Whether a wake comes from an execution-wide claim, a Cancel or an Exit.
 *
 * A claim wake halts the branch where it stands and closes the wait row as
 * cancelled. The claim already refuses every later node, so nothing below the
 * Wait is work the run still wants.
 */
export function isClaimWake(
  wake: WaitWake
): wake is { kind: "cancel" } | { kind: "exit" } {
  return wake.kind === "cancel" || wake.kind === "exit";
}

/**
 * Why a park ended, as a resume sees it.
 *
 * A `migrate` wake never reaches a resume: the driver reads it as the
 * instruction to prepare the Wait again against the version the run was moved
 * to, and starts the next attempt instead of resuming.
 */
export type WaitResumeWake = Exclude<WaitWake, { kind: "migrate" }>;

/**
 * Runs the park, closing the Wait's step-log row if the park fails instead of
 * answering. A park that fails ends the pass, so the closing row is written
 * directly rather than as a durable step. The next pass that resumes the Wait
 * closes the row again with its own verdict.
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

/** What one attempt of a Wait node parks with: the row it writes and its deadline. */
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
};

/** The attempt a mode is resolving, and what the attempts before it settled. */
export type WaitAttempt = {
  index: number;
  /**
   * The memoized instant the first attempt resolved against. Every later
   * attempt measures from it, so a Migration changes a Wait's target
   * without restarting its clock.
   */
  anchorAt?: Date | undefined;
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

/**
 * What a mode's resume step writes and hands to its outcome.
 *
 * The driver has already run the resume's prologue by the time a mode sees
 * this: the version fence, the wait row's settlement, and the timeline entry.
 * What is left to a mode is its own output and, for the event mode, what the
 * configured timeout behaviour does to the branch.
 */
export type WaitResumeInput<Prepared> = {
  branch: WaitBranchContext;
  prepared: Prepared;
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
  outcome: (input: {
    resumed: Resumed;
    wake: WaitResumeWake;
  }) => SettledWaitOutcome;
};

/**
 * The step ids one attempt of a Wait node memoizes its own work under.
 *
 * The ids name the node and the attempt and nothing else. A Migration may give
 * the node the other mode, and the body that reloads the new Workflow Version
 * has to replay the attempts already on the run: an id carrying the mode would
 * miss every one of them, so the driver would start attempt 0 again with an
 * empty carry and open a second wait row beside the one still parked. The mode
 * appears in the step *name* instead, which a trace shows and no replay
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
