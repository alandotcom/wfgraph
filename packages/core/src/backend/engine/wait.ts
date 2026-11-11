/**
 * The Wait node: the one action the engine runs itself and never wraps in a
 * step, because a park is a durable step of its own and steps do not nest.
 * This module memoizes its own persistence segments around the park, and
 * `executeWaitAction` is the whole of what the traversal calls. The loop below
 * drives both Wait modes, re-reading the mode from the config on every attempt.
 */

import { Effect } from "effect";
import { readWaitConfig } from "@wfgraph/shared/lifecycle/wait-subscription";
import { claimKindAdmits } from "@wfgraph/shared/lifecycle/execution-contracts";
import { WAIT_ANCHOR_METADATA_KEY } from "@wfgraph/shared/lifecycle/wait-signal";
import type { JsonObjectDraft } from "@wfgraph/shared/types/json";
import { decodeIsoTimestampOrThrow } from "@wfgraph/shared/types/timestamp";
import { closeStepLog, openStepLog } from "#src/backend/engine/step-log";
import {
  fromUnknownPromise,
  runDurable,
  runIdempotentDurable,
} from "#src/backend/engine/durable";
import {
  engineFailure,
  type EngineFailure,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import type { WaitAnswer, WaitWake } from "#src/backend/engine/runtime";
import { delayWaitMode } from "#src/backend/engine/wait-delay";
import { eventWaitMode } from "#src/backend/engine/wait-event";
import {
  fromStore,
  isClaimWake,
  parkUntil,
  readAllowedHoursConfig,
  readWaitGateMode,
  type WaitActionInput,
  type WaitBranchContext,
  type WaitMode,
  type WaitOutcome,
  type WaitPark,
  type WaitPreparation,
  type WaitResumeWake,
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
 * An attempt is one pass of the driver, with resolution, prepare, park and
 * resume steps. A past-due recompute and a re-prepare behind the version fence
 * both consume one without parking. The
 * step count is what the cap protects, so it counts attempts. Each Migration of
 * a parked run costs an attempt, and a run parked for a week can be migrated
 * many times, so the cap is high. What it is there for is a `version-migrate`
 * wake that keeps arriving without the target ever moving, which would
 * otherwise re-queue the run forever.
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
    status: "settled",
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
      side,
      resolveTemplates,
    } = input;

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
          nodeId: context.nodeId,
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

    // The open runs on every pass and stores no memo row. Every pass reaches
    // the same row, whose id derives from the run and the node, and the store
    // answers a row an earlier pass opened with that row's own opening time,
    // so a close on a later pass measures the whole park.
    const startLog = yield* runIdempotentDurable(
      runtime,
      {
        id: `node:${context.nodeId}:log-open`,
        nodeId: context.nodeId,
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
          waitMaxLateness: config.waitMaxLateness,
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
      side,
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
 * re-parks the same row from the same anchor. Each event park gets a fresh
 * token, so a saved candidate cannot address a later attempt.
 */
type WaitCarry = {
  waitStateId: string;
  /** The instant the first attempt resolved against, as an ISO string. */
  anchorAtIso: string;
};

/** The loop's own state, which outlives one attempt but not the node. */
type WaitDriveState = {
  attempt: number;
  /** How many times this Wait parked, which is the node's `hops` output. */
  hops: number;
  carry: WaitCarry | undefined;
};

/**
 * Runs the Wait until it resumes, times out, is skipped, or fails, or until the
 * runtime answers that its park has not resolved.
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

/**
 * Either this pass of the Wait is done, settled or still parked, or this
 * attempt has to be prepared again.
 */
type WaitAttemptResult =
  | { status: "finished"; outcome: WaitOutcome }
  | { status: "reprepare" };

/**
 * What the prepare step of one attempt settled.
 *
 * `woken` is a re-park refused between a Migration's wake and this park. Either
 * a resume claim wrote its wake on the row, and this attempt takes that wake
 * instead of parking on a signal that has already been sent, or a Cancel or
 * Exit claim on the run refused the park, and the claim is the wake.
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

    const anchorAtIso =
      carry?.anchorAtIso ??
      (yield* runDurable(
        runtime,
        {
          id: `wait-anchor-${context.nodeId}`,
          nodeId: context.nodeId,
          name: `${context.nodeName} (anchor)`,
        },
        Effect.sync(() => new Date().toISOString())
      ));
    const anchorAt = yield* Effect.try({
      try: () => decodeIsoTimestampOrThrow(anchorAtIso),
      catch: failureFromUnknown,
    });
    // Persist the decision before its database write. A lost write response must
    // retry with the same token and deadline; a new version resolves a new park.
    const resolution = yield* runDurable(
      runtime,
      {
        id: `wait-resolve-${context.nodeId}-${attempt}-${branch.workflowVersionId}`,
        nodeId: context.nodeId,
        name: waitStepName({
          nodeName: context.nodeName,
          attempt,
          stage: `resolve ${mode.mode}`,
        }),
      },
      Effect.sync(() => mode.prepare(branch, { index: attempt, anchorAt }))
    );
    const prepared = yield* runDurable(
      runtime,
      {
        id: stepIds.prepare,
        nodeId: context.nodeId,
        name: waitStepName({
          nodeName: context.nodeName,
          attempt,
          stage: `prepare ${mode.mode}`,
        }),
      },
      prepareWaitAttempt(branch, resolution, {
        attempt,
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
          status: "settled",
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
        const answer = yield* parkOnSignal(branch, {
          stepId: stepIds.park,
          attempt,
          park: prepared.park,
          waitStateId: prepared.carry.waitStateId,
        });
        // The wait row stays `waiting` and the step-log row stays open. The
        // next pass replays this attempt's memoized steps back to the park.
        if (answer.kind === "parked") {
          return { status: "finished", outcome: { status: "parked" } };
        }
        wake = answer.wake;
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

    // The step memoizes the wake it acted on beside the mode's output. A claim
    // found behind the version fence replaces the wake that arrived, and the
    // outcome has to read that same wake on every replay.
    const settled = yield* runDurable(
      runtime,
      {
        id: stepIds.resume,
        nodeId: context.nodeId,
        name: waitStepName({
          nodeName: context.nodeName,
          attempt,
          stage: `resume ${mode.mode}`,
        }),
      },
      // The step opens with the writes every resume makes, the version fence
      // among them, and each mode then writes its own output.
      Effect.gen(function* () {
        const woke = yield* openResume(branch, {
          mode: mode.mode,
          waitStateId: prepared.carry.waitStateId,
          wake,
          hops: state.hops,
        });
        const resumed = yield* mode.resume({
          branch,
          prepared: prepared.prepared,
          wake: woke,
          hops: state.hops,
        });
        return { wake: woke, resumed };
      })
    );

    return {
      status: "finished",
      outcome: mode.outcome({ resumed: settled.resumed, wake: settled.wake }),
    };
  });
}

/**
 * Acts on a memoized resolution: closes the log row for an error or a skip and
 * records the skip, or writes the park, preserving the row identity across
 * retries.
 */
function prepareWaitAttempt<Prepared>(
  branch: WaitBranchContext,
  preparation: WaitPreparation<Prepared>,
  input: {
    attempt: number;
    waitStateId: string | undefined;
  }
): Effect.Effect<WaitAttemptPreparation<Prepared>, EngineFailure> {
  return Effect.gen(function* () {
    const { context, store, workflowId } = branch;

    if (preparation.status === "error") {
      return yield* failPreparation<Prepared>(branch, preparation.error);
    }

    if (preparation.status === "skipped") {
      yield* fromStore(
        store.recordAuditEvent({
          workflowId,
          executionId: context.executionId,
          eventType: "run_skipped",
          message: preparation.audit.message,
          metadata: preparation.audit.metadata,
        })
      );
      yield* closeStepLog(store, branch.startLog, {
        status: "success",
        output: preparation.output,
      });
      return { status: "skipped", output: preparation.output };
    }
    const { park, prepared, anchorAtIso } = preparation;
    const metadata = {
      ...park.metadata,
      [WAIT_ANCHOR_METADATA_KEY]: anchorAtIso,
    };
    // A first park learns its row id from the row it just created, and a
    // re-park already holds one. The rest of the preparation is the same
    // either way.
    const parked = (
      waitStateId: string
    ): Effect.Effect<WaitAttemptPreparation<Prepared>, EngineFailure> =>
      Effect.gen(function* () {
        const carry = {
          waitStateId,
          anchorAtIso,
        };
        // A producer can resolve the row between its write and this park. A
        // wake already on the row is durable input for this attempt.
        const missed = yield* readMissedWake(branch, waitStateId);
        if (missed !== null) {
          return {
            status: "woken",
            workflowVersionId: branch.workflowVersionId,
            carry,
            prepared,
            wake: missed,
          };
        }
        return {
          status: "parked",
          workflowVersionId: branch.workflowVersionId,
          carry,
          park,
          prepared,
        };
      });

    if (input.waitStateId === undefined) {
      const created = yield* fromStore(
        store.createWaitState({
          executionId: context.executionId,
          workflowId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          workflowVersionId: branch.workflowVersionId,
          side: branch.side,
          waitType: park.waitType,
          resumeToken: park.resumeToken ?? undefined,
          waitUntilIso: park.waitUntilIso ?? undefined,
          subscribedEvents: park.subscribedEvents,
          metadata,
        })
      );

      if (!created) {
        // The write is fenced on the pinned version, on the run still being in
        // flight, and on a claim that admits this Wait's side. A claim that
        // refuses it means the run's work on that side has ended, so the Wait
        // halts its branch without parking, and nothing is added to the
        // timeline because nothing parked. This also covers a branch admitted
        // before the claim that reaches its park after the claim's parked-Wait
        // read. A Canceled-side Wait reads its own run's Cancel claim as no
        // halt, so a park it refused was refused by the version fence or a
        // terminal status, and the step fails instead of halting.
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
        // step. A run's terminal write deletes the schedule row this write is
        // fenced on, so a policy cancel ends the pass before it reaches here.
        // The pass ends, and the next one reloads the graph from the pointer
        // the row now names.
        return yield* Effect.fail(
          versionRefused(
            `This run would not accept a park under workflow version ${branch.workflowVersionId}: it has ended, or it has been moved to another version.`
          )
        );
      }

      yield* recordWaiting(branch, { attempt: input.attempt, park });
      return yield* parked(created.waitStateId);
    }

    const reparked = yield* fromStore(
      store.reparkWaitState({
        waitStateId: input.waitStateId,
        workflowVersionId: branch.workflowVersionId,
        side: branch.side,
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
          versionRefused(
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
        },
        prepared,
        wake: missed,
      };
      return woken;
    }

    yield* recordWaiting(branch, { attempt: input.attempt, park });
    return yield* parked(input.waitStateId);
  });
}

/**
 * The failure a Wait raises when a version fence refused one of its writes,
 * because a Migration moved the run off the Workflow Version this body loaded.
 * The executor ends the pass and re-queues the run without counting an
 * attempt, since nothing failed, and the next pass reloads the graph from the
 * version the row now names.
 */
function versionRefused(message: string): EngineFailure {
  return engineFailure("version_refused", message);
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
 * answering false when no row moved.
 *
 * The guarded write is the resume's version fence, and it is the first thing a
 * resume does. It refuses a run pinned to another version, and it also refuses
 * a run that holds a Cancel or Exit claim. `openResume` reads which of the two
 * refused it.
 */
function markRunningUnderLoadedVersion(
  branch: WaitBranchContext
): Effect.Effect<boolean, EngineFailure> {
  return fromStore(
    branch.store.markExecutionRunning({
      executionId: branch.context.executionId,
      workflowVersionId: branch.workflowVersionId,
      side: branch.side,
    })
  );
}

/**
 * The writes every resume opens with, whichever mode is resuming: the version
 * fence, the wait row, and the run's one timeline entry for this wake. It
 * answers the wake the resume acts on.
 *
 * Only this pass knows it consumed the wake, so it owns the Execution's
 * running status, that entry, and the row it woke from, whichever producer
 * wrote the wake. A row the run has consumed leaves `resuming`, so no later
 * wake can claim a park this node has left.
 *
 * A claim wake (a Cancel or an Exit) skips the version fence, because the
 * running write refuses a claimed run. A claimed run cannot be migrated either,
 * because the Migration's repin write refuses a claimed run too, so the version
 * this body loaded is still the pinned one.
 *
 * Any other wake can arrive after a claim: a resume producer can take the row
 * before a claim and the pass can read that wake first. When the fence
 * refuses such a wake, the run's claim is read, and a Cancel or Exit claim
 * replaces the wake, so the Wait halts as that claim wake would. A refusal with
 * no claim is a Migration that moved the version between the wake and this
 * write, and the pass ends; the next pass reloads the graph from the new
 * pointer and prepares the Wait again. The fence runs first, so the wait row
 * is untouched for that pass to re-park.
 */
function openResume(
  branch: WaitBranchContext,
  input: {
    mode: "delay" | "event";
    waitStateId: string;
    wake: WaitResumeWake;
    hops: number;
  }
): Effect.Effect<WaitResumeWake, EngineFailure> {
  return Effect.gen(function* () {
    const { context, store, workflowId } = branch;
    const { mode, hops } = input;

    let wake = input.wake;
    if (!isClaimWake(wake) && !(yield* markRunningUnderLoadedVersion(branch))) {
      const claim = yield* readClaimWake(branch);
      if (claim === null) {
        return yield* Effect.fail(
          versionRefused(
            `This run has been moved off workflow version ${branch.workflowVersionId} since its graph was loaded.`
          )
        );
      }
      wake = claim;
    }

    if (wake.kind === "timeout" && mode === "event") {
      // Checking only before parking leaves a read-to-registration window.
      // Atomically resolve the timeout against any stored arrival so a sender
      // cannot claim the row between the last read and a timeout write.
      const arrival = yield* fromStore(
        store.settleWaitTimeout(input.waitStateId)
      );
      if (arrival !== null) {
        wake = {
          kind: "resume",
          eventName: arrival.eventName,
          payload: arrival.payload,
        };
      }
    } else {
      // A delay ends on its clock; only an event Wait can time out.
      yield* fromStore(
        store.markWaitStateStatus({
          waitStateId: input.waitStateId,
          status: isClaimWake(wake) ? "cancelled" : "resumed",
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

    return wake;
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
        message: "Run resumed from the Runs view",
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
 * The wake that resolved the row before this park, or null when the row
 * records none. This also covers the first preparation before registration.
 *
 * Between a Migration's repin and the next park the row can still be
 * `waiting`, so a resume can resolve it while nothing is parked on it. The
 * producer writes its wake into the row's `wake` column, and an Event or claim
 * wake there is answered whatever version the row was parked from: the TLA+
 * Migration model resumes a Wait from an Event taken before the re-park, under
 * the version the run then pins. A Cancel or Exit claim leaves the status and
 * writes its wake. A row read here as cancelled was settled by the run's
 * terminal write, which refuses this pass at its next write.
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
      if (
        waitState.status !== "waiting" &&
        waitState.status !== "resumed" &&
        waitState.status !== "resuming"
      ) {
        return null;
      }
      // A re-park writes over a `migrate` or `timeout` wake (`reparkWait`), so
      // an Event or a claim is the only wake this Wait still has to act on. A
      // `migrate` wake that lands after this read is found by the park step.
      const wake = waitState.wake;
      if (wake === null || wake.kind === "migrate" || wake.kind === "timeout") {
        return null;
      }
      return wake;
    }
  );
}

/**
 * The execution-wide claim that ended this run's work, as a wake, or null when
 * the run holds none this Wait has to stop for.
 *
 * Read after the store refused a park, since a claim is one of the reasons it
 * refuses. A claim this Wait's side admits answers null, because that claim is
 * the run's current work rather than a reason to halt, and so does a terminal
 * status carrying no claim at all.
 */
function readClaimWake(
  branch: WaitBranchContext
): Effect.Effect<{ kind: "cancel" } | { kind: "exit" } | null, EngineFailure> {
  return Effect.map(
    fromStore(branch.store.readTerminationState(branch.context.executionId)),
    (state) => {
      const kind = state?.claim?.kind ?? null;
      return kind === null || claimKindAdmits(kind, branch.side)
        ? null
        : { kind };
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
 * Parks on this Wait's row and answers the wake that ended the park, or
 * `parked` while the row holds no wake, which ends this branch for the pass.
 * A producer resolves the park by writing its wake onto the row.
 */
function parkOnSignal(
  branch: WaitBranchContext,
  input: {
    stepId: string;
    attempt: number;
    park: WaitPark;
    waitStateId: string;
  }
): Effect.Effect<WaitAnswer, EngineFailure> {
  const { context, runtime } = branch;
  const { park } = input;

  return parkUntil(
    branch,
    fromUnknownPromise(() =>
      runtime.waitForEvent(
        {
          id: input.stepId,
          nodeId: context.nodeId,
          name: waitStepName({
            nodeName: context.nodeName,
            attempt: input.attempt,
            stage: park.waitType === "delay" ? "delay" : "wait for event",
          }),
        },
        { waitStateId: input.waitStateId }
      )
    )
  );
}
