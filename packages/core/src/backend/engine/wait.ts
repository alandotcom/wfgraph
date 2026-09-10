/**
 * The Wait node: the one action the engine runs itself and the one node it never
 * wraps in a step.
 *
 * Inngest forbids a sleep or an event wait inside a step, so this module
 * memoizes its own persistence segments around those boundaries instead: the
 * config read and the row that opens, the preparation that parks the run, and
 * the resume that closes the row. `executeWaitAction` is the whole of what the
 * traversal calls.
 *
 * The loop below is one driver for both Wait modes. It re-reads the mode from
 * the config on every attempt, so a Migration that turns a delay Wait into an
 * event Wait re-parks as the mode the new Workflow Version says. Each mode
 * supplies only what its config resolves to, what its resume writes, and the
 * shape of its output; `wait-delay.ts` and `wait-event.ts` hold those.
 */

import { Effect } from "effect";
import { readWaitConfig } from "@wfgraph/shared/lifecycle/wait-subscription";
import {
  WAIT_ANCHOR_METADATA_KEY,
  WAIT_SIGNAL_EVENT,
} from "@wfgraph/shared/lifecycle/wait-signal";
import type { JsonObjectDraft } from "@wfgraph/shared/types/json";
import { decodeIsoTimestampOrThrow } from "@wfgraph/shared/types/timestamp";
import { closeStepLog, openStepLog } from "#src/backend/engine/step-log";
import { fromUnknownPromise, runDurable } from "#src/backend/engine/durable";
import {
  engineFailure,
  type EngineFailure,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import { delayWaitMode } from "#src/backend/engine/wait-delay";
import { eventWaitMode } from "#src/backend/engine/wait-event";
import {
  fromStore,
  isClaimWake,
  parkUntil,
  readAllowedHoursConfig,
  readWaitGateMode,
  readWaitWake,
  type WaitActionInput,
  type WaitAttempt,
  type WaitBranchContext,
  type WaitMode,
  type WaitOutcome,
  type WaitPark,
  type WaitResumeWake,
  type WaitWake,
  waitSignalMatch,
  waitStepIds,
  waitStepName,
} from "#src/backend/engine/wait-shared";

export type {
  WaitActionInput,
  WaitOutcome,
} from "#src/backend/engine/wait-shared";

/**
 * How many attempts one Wait may make before the node fails.
 *
 * An attempt is one pass of the driver, and it costs the prepare, park and
 * resume steps whether or not it reaches a park: a past-due recompute and a
 * re-prepare behind the version fence both consume one without parking. The
 * step count is what the cap protects, so it counts attempts. Each Migration of
 * a parked run costs an attempt, and a run parked for a week can be migrated
 * many times, so the cap is high. What it is there for is a `version-migrate`
 * wake that keeps arriving without the target ever moving, which would
 * otherwise spin the body against Inngest forever.
 */
const WAIT_ATTEMPT_LIMIT = 50;

export function executeWaitAction(
  input: WaitActionInput
): Effect.Effect<WaitOutcome, EngineFailure> {
  const waitType = input.config.waitMode === "event" ? "event" : "delay";
  const execute = executeWaitActionInner(input);

  return execute.pipe(
    Effect.withSpan("wfgraph.workflow.wait", {
      attributes: {
        "wfgraph.wait.type": waitType,
        "wfgraph.node.id": input.context.nodeId,
        "wfgraph.node.name": input.context.nodeName,
      },
    })
  );
}

function failedWait(message: string): WaitOutcome {
  return {
    result: {
      success: false,
      error: { kind: "failure", message },
    },
    haltBranch: false,
  };
}

function executeWaitActionInner(
  input: WaitActionInput
): Effect.Effect<WaitOutcome, EngineFailure> {
  return Effect.gen(function* () {
    const {
      context,
      runtime,
      store,
      workflowId,
      workflowVersionId,
      workflowRunId,
      resolveTemplates,
    } = input;

    const runId = workflowRunId || runtime.runId || context.executionId;

    // The first schema this node has ever had, so a config written against the
    // retired shape (or an already-enqueued run that still carries it) stops
    // here rather than parking on a wait nothing can reach. Autosave refuses
    // `waitMode: "hook"` at the graph boundary; this is the park-time gate.
    const read = readWaitConfig(input.config);
    if (!read.valid) {
      const errorMessage = `Wait node configuration is invalid: ${read.error}`;
      yield* runDurable(
        runtime,
        {
          id: `wait-invalid-config-${context.nodeId}`,
          name: `${context.nodeName} (invalid config)`,
        },
        Effect.gen(function* () {
          const earlyLog = yield* openStepLog({
            store,
            context,
            input: {},
          });
          yield* closeStepLog(store, earlyLog, {
            status: "error",
            error: errorMessage,
          });
          return { logged: true };
        })
      );

      return failedWait(errorMessage);
    }

    const config = read.config;

    // The "step started" row is written once and its id is replayed from the
    // memoized step return, so every attempt below closes the same row.
    const startLog = yield* runDurable(
      runtime,
      {
        id: `wait-start-log-${context.nodeId}`,
        name: `${context.nodeName} (open)`,
      },
      openStepLog({
        store,
        context,
        input: {
          waitMode: read.waitMode,
          waitDuration: config.waitDuration,
          waitUntil: config.waitUntil,
          waitOffset: config.waitOffset,
          waitTimezone: config.waitTimezone,
          waitGateMode: readWaitGateMode(config),
          ...readAllowedHoursConfig(config),
          waitFor: config.waitFor?.map((subscription) => subscription.event),
          waitTimeout: config.waitTimeout,
        },
      })
    );

    const branch: WaitBranchContext = {
      config,
      context,
      runtime,
      store,
      workflowId,
      workflowVersionId,
      runId,
      resolveTemplates,
      startLog,
    };

    return yield* driveWait(branch, read.waitMode);
  });
}

/**
 * What one attempt settled, and every later attempt reuses.
 *
 * It crosses the prepare step's memo boundary, so every field is JSON-safe, and
 * it says nothing about which mode wrote it: a later attempt in the other mode
 * re-parks the same row from the same anchor. A delay park carries no resume
 * token, so `resumeToken` is null after one and the event mode mints a fresh
 * token when it takes the row over.
 */
type WaitCarry = {
  waitStateId: string;
  /** The instant the first attempt resolved against, as an ISO string. */
  anchorAtIso: string;
  resumeToken: string | null;
};

/** The loop's own state, which outlives one attempt but not the node. */
type WaitDriveState = {
  attempt: number;
  /** How many times this Wait parked, which is the node's `hops` output. */
  hops: number;
  carry: WaitCarry | undefined;
};

/**
 * Runs the Wait until it resumes, times out, is skipped, or fails.
 *
 * The mode is chosen per attempt from the config this body loaded, which is the
 * config of the Workflow Version the execution row names. A Migration therefore
 * re-parks a Wait as whichever mode the new version gives it.
 */
function driveWait(
  branch: WaitBranchContext,
  waitMode: "delay" | "event"
): Effect.Effect<WaitOutcome, EngineFailure> {
  return Effect.gen(function* () {
    const state: WaitDriveState = { attempt: 0, hops: 0, carry: undefined };

    for (;;) {
      if (state.attempt >= WAIT_ATTEMPT_LIMIT) {
        return yield* abandonWait(branch, state);
      }

      const attempted =
        waitMode === "delay"
          ? yield* runWaitAttempt(branch, delayWaitMode, state)
          : yield* runWaitAttempt(branch, eventWaitMode, state);

      if (attempted.status === "finished") {
        return attempted.outcome;
      }

      state.attempt += 1;
    }
  });
}

/** Either the Wait is done, or this attempt has to be prepared again. */
type WaitAttemptResult =
  | { status: "finished"; outcome: WaitOutcome }
  | { status: "reprepare" };

/**
 * What the prepare step of one attempt settled.
 *
 * `woken` is a re-park refused between a Migration's wake and this park. Either
 * a resume claim recorded its arrival on the row, and this attempt takes that
 * arrival instead of parking on a signal that has already been sent, or a Cancel
 * or Exit claim on the run refused the park, and the claim is the wake.
 *
 * `workflowVersionId` is the version that wrote the preparation. A replay
 * returns the earlier body's memoized value, so the driver starts a new attempt
 * before the current version resumes work prepared from another graph.
 */
type WaitAttemptPreparation<Prepared> =
  | { status: "error"; error: string }
  | { status: "skipped"; output: Record<string, unknown> }
  | {
      status: "parked";
      workflowVersionId: string;
      carry: WaitCarry;
      park: WaitPark;
      prepared: Prepared;
    }
  | {
      status: "woken";
      workflowVersionId: string;
      carry: WaitCarry;
      prepared: Prepared;
      wake: WaitWake;
    };

function runWaitAttempt<Prepared, Resumed>(
  branch: WaitBranchContext,
  mode: WaitMode<Prepared, Resumed>,
  state: WaitDriveState
): Effect.Effect<WaitAttemptResult, EngineFailure> {
  return Effect.gen(function* () {
    const { context, runtime } = branch;
    const { attempt, carry } = state;
    const stepIds = waitStepIds({ nodeId: context.nodeId, attempt });

    const anchorAt = carry
      ? yield* Effect.try({
          try: () => decodeIsoTimestampOrThrow(carry.anchorAtIso),
          catch: failureFromUnknown,
        })
      : undefined;

    // Everything before the park is one durable step per attempt: a replay must
    // not resolve a fresh target time or write the wait row a second time.
    const prepared = yield* runDurable(
      runtime,
      {
        id: stepIds.prepare,
        name: waitStepName({
          nodeName: context.nodeName,
          attempt,
          stage: `prepare ${mode.mode}`,
        }),
      },
      prepareWaitAttempt(branch, mode, {
        attempt: {
          index: attempt,
          anchorAt,
          resumeToken: carry?.resumeToken ?? undefined,
        },
        waitStateId: carry?.waitStateId,
      })
    );

    if (prepared.status === "error") {
      return { status: "finished", outcome: failedWait(prepared.error) };
    }

    if (prepared.status === "skipped") {
      return {
        status: "finished",
        outcome: {
          result: { success: true, data: prepared.output },
          haltBranch: true,
        },
      };
    }

    // The row and the anchor are the attempt's, whichever mode wrote them, so
    // the next attempt reuses both even when the mode has changed underneath.
    state.carry = prepared.carry;

    let wake: WaitWake;
    if (prepared.status === "parked") {
      // A target the clock has already reached is not parked on. There is
      // nothing left to wait for, and a park with no time on it would hold the
      // run for the minimum a durable runtime can express.
      if (prepared.park.timeoutMs > 0) {
        wake = readWaitWake(
          yield* parkOnSignal(branch, {
            stepId: stepIds.park,
            attempt,
            park: prepared.park,
          })
        );
        state.hops += 1;
      } else {
        wake = { kind: "timeout" };
      }
    } else {
      wake = prepared.wake;
    }

    // The run has been moved to a later Workflow Version. The next attempt is
    // prepared from the config this body loaded, which came from that version.
    if (wake.kind === "migrate") {
      return { status: "reprepare" };
    }

    // A replay can return a preparation computed before the execution moved.
    // The next attempt prepares the same row from the current version, and a
    // wake that has already arrived is read from the row by `readMissedWake`.
    if (prepared.workflowVersionId !== branch.workflowVersionId) {
      return { status: "reprepare" };
    }

    const resumed = yield* runDurable(
      runtime,
      {
        id: stepIds.resume,
        name: waitStepName({
          nodeName: context.nodeName,
          attempt,
          stage: `resume ${mode.mode}`,
        }),
      },
      // The step opens with the writes every resume makes, the version fence
      // among them, and each mode then writes its own output.
      Effect.gen(function* () {
        yield* openResume(branch, {
          mode: mode.mode,
          waitStateId: prepared.carry.waitStateId,
          wake,
          hops: state.hops,
        });
        return yield* mode.resume({
          branch,
          prepared: prepared.prepared,
          wake,
          hops: state.hops,
        });
      })
    );

    return { status: "finished", outcome: mode.outcome({ resumed, wake }) };
  });
}

/**
 * Resolves one attempt and writes its park onto the run's wait row.
 *
 * All of it is one durable step. The row write has to be memoized with the
 * resolution that produced it, or a replay would open a second row or park
 * against a target it resolved again.
 */
function prepareWaitAttempt<Prepared, Resumed>(
  branch: WaitBranchContext,
  mode: WaitMode<Prepared, Resumed>,
  input: {
    attempt: WaitAttempt;
    waitStateId: string | undefined;
  }
): Effect.Effect<WaitAttemptPreparation<Prepared>, EngineFailure> {
  return Effect.gen(function* () {
    const { context, store, workflowId, runId } = branch;

    const preparation = yield* mode.prepare(branch, input.attempt);
    if (preparation.status !== "ready") {
      return preparation;
    }
    const { park, prepared, anchorAtIso } = preparation;
    const metadata = {
      ...park.metadata,
      [WAIT_ANCHOR_METADATA_KEY]: anchorAtIso,
    };
    // A first park learns its row id from the row it just created, and a
    // re-park already holds one. The rest of the preparation is the same
    // either way.
    const parked = (waitStateId: string): WaitAttemptPreparation<Prepared> => ({
      status: "parked",
      workflowVersionId: branch.workflowVersionId,
      carry: {
        waitStateId,
        anchorAtIso,
        resumeToken: park.resumeToken,
      },
      park,
      prepared,
    });

    if (input.waitStateId === undefined) {
      const created = yield* fromStore(
        store.createWaitState({
          executionId: context.executionId,
          workflowId,
          runId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          workflowVersionId: branch.workflowVersionId,
          waitType: park.waitType,
          resumeToken: park.resumeToken ?? undefined,
          waitUntilIso: park.waitUntilIso ?? undefined,
          subscribedEvents: park.subscribedEvents,
          metadata,
        })
      );

      if (!created) {
        // The write is fenced on the pinned version, on the run still being in
        // flight, and on no Cancel or Exit claim. A claim means another branch
        // has already ended this run's work, so the Wait halts its branch
        // without parking, and nothing is added to the timeline because nothing
        // parked. This also covers a branch admitted before the claim that
        // reaches its park after the claim's parked-Wait read.
        const claim = yield* readClaimWake(branch);
        if (claim !== null) {
          const output = { waitType: park.waitType, haltedBy: claim.kind };
          yield* closeStepLog(store, branch.startLog, {
            status: "success",
            output,
          });
          const halted: WaitAttemptPreparation<Prepared> = {
            status: "skipped",
            output,
          };
          return halted;
        }

        // With no claim, the refusal is a Migration that landed inside this
        // step or a policy cancel that ended the run. Failing the step covers
        // both: Inngest retries the body, which reloads the graph from the
        // pointer the row now names, and a run Inngest is already killing never
        // reaches that retry.
        return yield* Effect.fail(
          engineFailure(
            "failure",
            `This run would not accept a park under workflow version ${branch.workflowVersionId}: it has ended, or it has been moved to another version.`
          )
        );
      }

      yield* recordWaiting(branch, { attempt: input.attempt.index, park });
      return parked(created.waitStateId);
    }

    const reparked = yield* fromStore(
      store.reparkWaitState({
        waitStateId: input.waitStateId,
        workflowVersionId: branch.workflowVersionId,
        waitType: park.waitType,
        waitUntilIso: park.waitUntilIso,
        subscribedEvents: park.subscribedEvents,
        resumeToken: park.resumeToken,
        metadata,
      })
    );

    if (!reparked.ok) {
      if (reparked.reason === "version_moved") {
        // A Migration landed inside this step, so the park this attempt
        // resolved came from a graph the run has left. Failing the step sends
        // the body around again against the pointer the row now names, and the
        // row is left waiting for that retry to re-park.
        return yield* Effect.fail(
          engineFailure(
            "failure",
            `This run has been moved off workflow version ${branch.workflowVersionId} since its graph was loaded.`
          )
        );
      }

      // The row can also still be waiting, when a Cancel or Exit claim is what
      // refused the re-park. That claim is then the wake.
      const missed =
        (yield* readMissedWake(branch, input.waitStateId)) ??
        (yield* readClaimWake(branch));
      if (missed === null) {
        return yield* failPreparation<Prepared>(
          branch,
          "The wait row left waiting before this park could be written, and it records no wake to resume from"
        );
      }
      const woken: WaitAttemptPreparation<Prepared> = {
        status: "woken",
        workflowVersionId: branch.workflowVersionId,
        carry: {
          waitStateId: input.waitStateId,
          anchorAtIso,
          resumeToken: park.resumeToken,
        },
        prepared,
        wake: missed,
      };
      return woken;
    }

    yield* recordWaiting(branch, { attempt: input.attempt.index, park });
    return parked(input.waitStateId);
  });
}

/**
 * Ends a Wait that has used its whole attempt allowance without resuming.
 *
 * The node fails, and the two rows the Wait opened are closed with it: the
 * step-log row the first attempt wrote, and the wait row, which is settled as
 * cancelled so no delivery and no manual resume can address a park nothing is
 * listening for. A Wait that failed before its first park holds no wait row.
 */
function abandonWait(
  branch: WaitBranchContext,
  state: WaitDriveState
): Effect.Effect<WaitOutcome, EngineFailure> {
  const message = `Wait node made ${WAIT_ATTEMPT_LIMIT} attempts without resuming, which is the limit on one Wait's attempts.`;

  return Effect.gen(function* () {
    const waitStateId = state.carry?.waitStateId;
    if (waitStateId !== undefined) {
      yield* fromStore(
        branch.store.markWaitStateStatus({ waitStateId, status: "cancelled" })
      );
    }
    yield* closeStepLog(branch.store, branch.startLog, {
      status: "error",
      error: message,
    });
    return failedWait(message);
  });
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
function markRunningUnderLoadedVersion(
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

/**
 * The writes every resume opens with, whichever mode is resuming: the version
 * fence, the wait row settled for the wakes that have no producer, and the run's
 * one timeline entry for this wake.
 *
 * Only this engine invocation knows it consumed the wake, so it owns the
 * Execution's running status and that entry. The wait row is settled here only
 * for a timeout and a claim wake; an ordinary resume was settled by the producer
 * that sent the signal, through its own claim fence.
 *
 * A claim wake (a Cancel or an Exit) skips the version fence. The running write
 * refuses a claimed run, so the fence would fail every claim wake. A claimed run
 * cannot be migrated either, because the Migration's repin write refuses a
 * claimed run too, so the version this body loaded is still the pinned one.
 */
function openResume(
  branch: WaitBranchContext,
  input: {
    mode: "delay" | "event";
    waitStateId: string;
    wake: WaitResumeWake;
    hops: number;
  }
): Effect.Effect<void, EngineFailure> {
  return Effect.gen(function* () {
    const { context, store, workflowId } = branch;
    const { mode, wake, hops } = input;

    const claimed = isClaimWake(wake);
    if (!claimed) {
      yield* markRunningUnderLoadedVersion(branch);
    }

    if (wake.kind === "timeout" || claimed) {
      yield* fromStore(
        store.markWaitStateStatus({
          waitStateId: input.waitStateId,
          status: claimed
            ? "cancelled"
            : mode === "event"
              ? "timed_out"
              : "resumed",
        })
      );
    }

    yield* fromStore(
      store.recordAuditEvent({
        workflowId,
        executionId: context.executionId,
        ...resumeAuditEntry({
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          mode,
          waitStateId: input.waitStateId,
          wake,
          hops,
        }),
      })
    );
  });
}

/**
 * The timeline entry for one wake: its type, its sentence, and the fields a
 * reader of the run history wants beside it.
 *
 * A delay wait reaching its target has resumed, so only an event wait records a
 * timeout as one. Every arm carries the node and the hop count, which is how a
 * reader tells a Wait that parked once from one a Migration re-parked.
 */
function resumeAuditEntry(input: {
  nodeId: string;
  nodeName: string;
  mode: "delay" | "event";
  waitStateId: string;
  wake: WaitResumeWake;
  hops: number;
}): {
  eventType: "run_resumed" | "run_timed_out";
  message: string;
  metadata: JsonObjectDraft;
} {
  const { nodeId, nodeName, mode, wake, hops } = input;
  const where = { nodeId, hops };

  if (wake.kind === "timeout") {
    return mode === "event"
      ? {
          eventType: "run_timed_out",
          message: `Run timed out in event wait node '${nodeName}'`,
          metadata: where,
        }
      : {
          eventType: "run_resumed",
          message: `Run resumed after delay in node '${nodeName}'`,
          metadata: where,
        };
  }

  if (wake.kind === "cancel") {
    return {
      eventType: "run_resumed",
      message: `Run woken by a cancel request in node '${nodeName}'`,
      metadata: where,
    };
  }

  if (wake.kind === "exit") {
    return {
      eventType: "run_resumed",
      message: `Run woken by an Exit in node '${nodeName}'`,
      metadata: where,
    };
  }

  return wake.eventName === null
    ? {
        eventType: "run_resumed",
        message: "Run resumed from the runs panel",
        metadata: { ...where, waitStateId: input.waitStateId },
      }
    : {
        eventType: "run_resumed",
        message: `Run resumed from wait on ${wake.eventName}`,
        metadata: { ...where, eventType: wake.eventName },
      };
}

/** Closes the Wait's log row and answers the failure the driver reports. */
function failPreparation<Prepared>(
  branch: WaitBranchContext,
  error: string
): Effect.Effect<WaitAttemptPreparation<Prepared>, EngineFailure> {
  return Effect.as(
    closeStepLog(branch.store, branch.startLog, { status: "error", error }),
    { status: "error" as const, error }
  );
}

/**
 * Why the row this attempt meant to re-park has left `waiting`, or null when it
 * does not say.
 *
 * Between a Migration's wake and the next park the row is still `waiting`, so a
 * resume claim can take it and send a signal nothing is parked on. The claim
 * writes what it was about onto the row, which is what this reads back. A
 * cancelled row is the Cancel Event having claimed the run in the same window.
 */
function readMissedWake(
  branch: WaitBranchContext,
  waitStateId: string
): Effect.Effect<WaitWake | null, EngineFailure> {
  return Effect.map(
    fromStore(branch.store.readWaitState(waitStateId)),
    (waitState) => {
      if (!waitState) {
        return null;
      }
      if (waitState.status === "cancelled") {
        return { kind: "cancel" };
      }
      const arrival = waitState.arrival;
      if (
        arrival === null ||
        (waitState.status !== "resumed" && waitState.status !== "resuming")
      ) {
        return null;
      }
      return {
        kind: "resume",
        eventName: arrival.eventName,
        payload: arrival.payload,
      };
    }
  );
}

/**
 * The execution-wide claim that ended this run's work, as a wake, or null when
 * the run holds no Cancel or Exit claim.
 *
 * Read after the store refused a park, since a claim is one of the reasons it
 * refuses. A terminal status with no claim answers null.
 */
function readClaimWake(
  branch: WaitBranchContext
): Effect.Effect<{ kind: "cancel" } | { kind: "exit" } | null, EngineFailure> {
  return Effect.map(
    fromStore(branch.store.readTerminationState(branch.context.executionId)),
    (state) => {
      const kind = state?.claim?.kind;
      return kind === undefined ? null : { kind };
    }
  );
}

/** The run's timeline entry for one park. */
function recordWaiting(
  branch: WaitBranchContext,
  input: { attempt: number; park: WaitPark }
): Effect.Effect<void, EngineFailure> {
  const { context, store, workflowId } = branch;
  const { park } = input;

  return fromStore(
    store.recordAuditEvent({
      workflowId,
      executionId: context.executionId,
      eventType: "run_waiting",
      message: `Run waiting in ${park.waitType} node '${context.nodeName}'`,
      metadata: {
        nodeId: context.nodeId,
        waitType: park.waitType,
        waitUntil: park.waitUntilIso,
        subscribedEvents: park.subscribedEvents,
        resumeToken: park.resumeToken,
        attempt: input.attempt,
      },
    })
  );
}

/**
 * Suspends until a signal addressed to this park arrives, answering null for the
 * timeout.
 *
 * Inngest waits on Workflow Graph's own signal envelope rather than on the
 * business Event: Workflow Graph decides which runs an arrival concerns first.
 */
function parkOnSignal(
  branch: WaitBranchContext,
  input: { stepId: string; attempt: number; park: WaitPark }
): Effect.Effect<unknown, EngineFailure> {
  const { context, runtime } = branch;
  const { park } = input;

  return parkUntil(
    branch,
    fromUnknownPromise(() =>
      runtime.waitForEvent(
        {
          id: input.stepId,
          name: waitStepName({
            nodeName: context.nodeName,
            attempt: input.attempt,
            stage: park.waitType === "delay" ? "delay" : "wait for event",
          }),
        },
        {
          event: WAIT_SIGNAL_EVENT,
          timeoutMs: park.timeoutMs,
          ifExpression: waitSignalMatch({
            nodeId: context.nodeId,
            resumeToken: park.resumeToken ?? undefined,
            signalTypes: park.signalTypes,
          }),
        }
      )
    )
  );
}
