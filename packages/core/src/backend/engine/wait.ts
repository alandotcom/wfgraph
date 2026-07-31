/**
 * The Wait node: the one action the engine runs itself and the one node it never
 * wraps in a step.
 *
 * Inngest forbids a sleep or an event wait inside a step, so this module
 * memoizes its own persistence segments around those boundaries instead: the
 * config read and the row that opens, the preparation that parks the run, and
 * the resume that closes the row. `executeWaitAction` is the whole of what the
 * traversal calls.
 */

import { randomUUID } from "node:crypto";
import { withSpan } from "#src/backend/lib/telemetry";
import { type JsonObject, readJsonObject } from "@rova/shared/types/json";
import { encodeIsoTimestamp } from "@rova/shared/types/timestamp";
import { getErrorMessage } from "@rova/shared/utils";
import { resolveWaitUntil } from "@rova/shared/utils/wait-time";
import { celStringLiteral } from "@rova/shared/conditions/cel-string-literal";
import {
  DEFAULT_WAIT_TIMEOUT,
  readWaitConfig,
  type WaitConfig,
} from "@rova/shared/lifecycle/wait-subscription";
import type { ExecutionResult } from "./contracts";
import type { WorkflowExecutionRuntime } from "./runtime";
import { closeStepLog, type NodeContext, openStepLog } from "./step-log";
import type { WorkflowStepLogHandle, WorkflowStore } from "./store";
import { compileWaitSubscriptions, type ResolveTemplates } from "./wait-match";

export type WaitActionInput = {
  config: Record<string, unknown>;
  context: NodeContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  workflowId: string;
  workflowRunId?: string;
  /** See `WaitBranchContext.resolveTemplates`. */
  resolveTemplates: ResolveTemplates;
};

/**
 * Wait context shared by the delay and event branches.
 */
type WaitBranchContext = {
  config: WaitConfig;
  context: NodeContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  workflowId: string;
  runId: string;
  /**
   * Resolves the `{{@nodeId:Label.field}}` references inside a match, which the
   * config-wide template pass does not reach: it walks the config's own string
   * values, and a match sits one level down inside `waitFor`.
   */
  resolveTemplates: ResolveTemplates;
  /** Memoized "step started" log row reused by every branch below. */
  startLog: WorkflowStepLogHandle;
};

/** The token addresses a parked run, so it comes from a cryptographic source. */
function generateWaitToken(): string {
  return randomUUID();
}

/**
 * The `workflow/wait.signal` body out of the Inngest event that carried it.
 *
 * `waitForEvent` resolves to the whole event object, and the signal is Rova's
 * own envelope inside it. Reading it once here is what keeps that envelope out
 * of everything below: a builder addresses the Event's payload, not the
 * transport it travelled in.
 */
function readWaitSignal(resumeEvent: unknown) {
  return readJsonObject(readJsonObject(resumeEvent)?.data);
}

function readWaitGateMode(config: WaitConfig): "require_actual_wait" | "off" {
  return config.waitGateMode === "require_actual_wait"
    ? "require_actual_wait"
    : "off";
}

function readAllowedHoursConfig(config: WaitConfig) {
  return {
    waitAllowedHoursMode: config.waitAllowedHoursMode,
    waitAllowedStartTime: config.waitAllowedStartTime,
    waitAllowedEndTime: config.waitAllowedEndTime,
  };
}

export function executeWaitAction(
  input: WaitActionInput
): Promise<ExecutionResult> {
  const waitType = input.config.waitMode === "event" ? "event" : "delay";

  return withSpan(
    "rova.workflow.wait",
    {
      "rova.wait.type": waitType,
      "rova.node.id": input.context.nodeId,
      "rova.node.name": input.context.nodeName,
    },
    () => executeWaitActionInner(input)
  );
}

async function executeWaitActionInner(
  input: WaitActionInput
): Promise<ExecutionResult> {
  const {
    context,
    runtime,
    store,
    workflowId,
    workflowRunId,
    resolveTemplates,
  } = input;

  const runId = workflowRunId || runtime.runId || context.executionId;

  // The first schema this node has ever had, so a config written against the
  // retired shape stops the run here rather than parking on a wait nothing can
  // reach. Both log rows are one durable unit, so a replay does not duplicate.
  const read = readWaitConfig(input.config);
  if (!read.valid) {
    const errorMessage = `Wait node configuration is invalid: ${read.error}`;
    await runtime.step(`wait-invalid-config-${context.nodeId}`, async () => {
      const earlyLog = await openStepLog({ store, context, input: {} });
      await closeStepLog(store, earlyLog, {
        status: "error",
        error: errorMessage,
      });
      return { logged: true };
    });

    return { success: false, error: { message: errorMessage } };
  }

  const config = read.config;

  // The "step started" row is written once and its id is replayed from the
  // memoized step return, so the branches below always close the same row.
  const startLog = await runtime.step(`wait-start-log-${context.nodeId}`, () =>
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
    runId,
    resolveTemplates,
    startLog,
  };

  if (read.waitMode === "delay") {
    return await executeDelayWait(branch);
  }
  return await executeEventWait(branch);
}

/**
 * Outcome of the persistence work that happens before a delay wait suspends
 * the run. Crosses a step boundary, so every field is JSON-safe.
 */
type DelayWaitPreparation =
  | { status: "error"; error: string }
  | { status: "skipped"; output: Record<string, unknown> }
  | {
      status: "ready";
      waitStateId: string;
      waitUntilIso: string;
      plannedWaitMs: number;
    };

async function prepareDelayWait(
  branch: WaitBranchContext
): Promise<DelayWaitPreparation> {
  const { config, context, store, workflowId, runId, startLog } = branch;
  const { executionId } = context;

  const waitTimezone = config.waitTimezone;
  const waitGateMode = readWaitGateMode(config);

  const resolved = resolveWaitUntil({
    waitDuration: config.waitDuration,
    waitUntil: config.waitUntil,
    waitOffset: config.waitOffset,
    waitTimezone,
    ...readAllowedHoursConfig(config),
  });

  if (!resolved.waitUntil) {
    const errorMessage =
      resolved.error ||
      "Wait could not determine a target timestamp from waitUntil/waitDuration.";
    await closeStepLog(store, startLog, {
      status: "error",
      error: errorMessage,
    });
    return { status: "error", error: errorMessage };
  }

  const waitUntilIso = encodeIsoTimestamp(resolved.waitUntil);
  const plannedWaitMs = resolved.waitUntil.getTime() - Date.now();
  const didActuallyWait = plannedWaitMs > 0;

  // Gate mode treats an already-passed target as "nothing to wait for" and
  // stops the branch instead of falling through to a zero-length sleep.
  if (waitGateMode === "require_actual_wait" && !didActuallyWait) {
    const output = {
      waitType: "delay",
      waitUntil: waitUntilIso,
      waitGateMode,
      skipped: true,
      skippedReason: "past_due_no_wait",
      plannedWaitMs,
      didActuallyWait,
      resumedAt: encodeIsoTimestamp(new Date()),
    };

    await store.recordAuditEvent({
      workflowId,
      executionId,
      eventType: "run_skipped",
      message: `Skipped delay branch in node '${context.nodeName}' (target already passed)`,
      metadata: {
        nodeId: context.nodeId,
        waitType: "delay",
        waitUntil: waitUntilIso,
        plannedWaitMs,
        reason: "past_due_no_wait",
      },
    });

    await closeStepLog(store, startLog, { status: "success", output });

    return { status: "skipped", output };
  }

  const waitState = await store.createWaitState({
    executionId,
    workflowId,
    runId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    waitType: "delay",
    waitUntilIso,
    metadata: {
      waitGateMode,
      waitTimezone,
    },
  });

  if (!waitState) {
    // A policy cancel flipped the execution terminal between the last step
    // and this park; Inngest is already killing the run.
    const cancelledMessage =
      "Execution was cancelled before the wait was registered";
    await closeStepLog(store, startLog, {
      status: "error",
      error: cancelledMessage,
    });
    return { status: "error", error: cancelledMessage };
  }

  await store.recordAuditEvent({
    workflowId,
    executionId,
    eventType: "run_waiting",
    message: `Run waiting in delay node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      waitType: "delay",
      waitUntil: waitUntilIso,
      waitGateMode,
    },
  });

  return {
    status: "ready",
    waitStateId: waitState.waitStateId,
    waitUntilIso,
    plannedWaitMs,
  };
}

async function executeDelayWait(
  branch: WaitBranchContext
): Promise<ExecutionResult> {
  const { context, runtime, store, workflowId, startLog } = branch;
  const { executionId } = context;

  // Everything before the sleep is one durable step: a replay must not resolve
  // a fresh target time or insert a second wait-state row.
  const prepared = await runtime.step(
    `wait-delay-prepare-${context.nodeId}`,
    () => prepareDelayWait(branch)
  );

  if (prepared.status === "error") {
    return { success: false, error: { message: prepared.error } };
  }

  if (prepared.status === "skipped") {
    return { success: true, data: prepared.output, haltBranch: true };
  }

  try {
    await runtime.sleep(
      `wait-delay-${context.nodeId}`,
      Math.max(prepared.plannedWaitMs, 0)
    );
  } catch (error) {
    // Failure here means the run is unwinding (cancellation surfaces this way),
    // so the closing log row is written directly rather than as a new step.
    await closeStepLog(store, startLog, {
      status: "error",
      error: getErrorMessage(error),
    });
    throw error;
  }

  const output = await runtime.step(
    `wait-delay-resume-${context.nodeId}`,
    async () => {
      await store.markWaitStateStatus({
        waitStateId: prepared.waitStateId,
        status: "resumed",
      });
      await store.markExecutionRunning({ executionId });

      await store.recordAuditEvent({
        workflowId,
        executionId,
        eventType: "run_resumed",
        message: `Run resumed after delay in node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
        },
      });

      const resumeOutput = {
        waitType: "delay",
        waitUntil: prepared.waitUntilIso,
        resumedAt: encodeIsoTimestamp(new Date()),
      };

      await closeStepLog(store, startLog, {
        status: "success",
        output: resumeOutput,
      });

      return resumeOutput;
    }
  );

  return { success: true, data: output };
}

/**
 * Outcome of the persistence work that happens before an event wait suspends the
 * run. Everything a resumed run needs is here rather than read from the config
 * again: this crosses a memoized step boundary, so it is what the run parked
 * with, and a graph edited while the run was parked cannot reach it.
 */
type EventWaitPreparation =
  | { status: "error"; error: string }
  | {
      status: "ready";
      waitStateId: string;
      resumeToken: string;
      timeoutMs?: number;
      timeoutBehavior: "continue" | "skip";
    };

async function prepareEventWait(
  branch: WaitBranchContext
): Promise<EventWaitPreparation> {
  const {
    config,
    context,
    store,
    workflowId,
    runId,
    resolveTemplates,
    startLog,
  } = branch;
  const { executionId } = context;

  const failWith = async (error: string): Promise<EventWaitPreparation> => {
    await closeStepLog(store, startLog, { status: "error", error });
    return { status: "error", error };
  };

  // The timeout is what keeps a parked run mortal, so a wait that names none is
  // held to the default the editor writes rather than parking forever.
  const timeout = config.waitTimeout?.trim() || DEFAULT_WAIT_TIMEOUT;
  const waitTimeoutResolution = resolveWaitUntil({ waitDuration: timeout });
  if (waitTimeoutResolution.error || !waitTimeoutResolution.waitUntil) {
    return await failWith(
      waitTimeoutResolution.error ??
        "Wait could not determine a timeout from waitTimeout."
    );
  }

  const compiled = compileWaitSubscriptions({
    subscriptions: config.waitFor ?? [],
    resolveTemplates,
  });
  if (!compiled.valid) {
    return await failWith(compiled.error);
  }

  const resumeToken = generateWaitToken();
  const waitUntilIso = encodeIsoTimestamp(waitTimeoutResolution.waitUntil);
  const timeoutBehavior = config.waitTimeoutBehavior ?? "continue";

  const waitState = await store.createWaitState({
    executionId,
    workflowId,
    runId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    waitType: "event",
    resumeToken,
    waitUntilIso,
    subscribedEvents: compiled.subscriptions.map(
      (subscription) => subscription.event
    ),
    // Everything here crosses the JSONB column and Inngest's memoization, so a
    // compiled string and a literal are what the match is reduced to.
    metadata: {
      waitTimeout: timeout,
      waitTimeoutBehavior: timeoutBehavior,
      waitFor: compiled.subscriptions,
    },
  });

  if (!waitState) {
    // A policy cancel flipped the execution terminal between the last step
    // and this park; Inngest is already killing the run.
    return await failWith(
      "Execution was cancelled before the wait was registered"
    );
  }

  await store.recordAuditEvent({
    workflowId,
    executionId,
    eventType: "run_waiting",
    message: `Run waiting on event in node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      resumeToken,
      waitFor: compiled.subscriptions.map((subscription) => subscription.event),
      timeoutAt: waitUntilIso,
    },
  });

  return {
    status: "ready",
    waitStateId: waitState.waitStateId,
    resumeToken,
    timeoutMs: Math.max(
      waitTimeoutResolution.waitUntil.getTime() - Date.now(),
      0
    ),
    timeoutBehavior,
  };
}

async function executeEventWait(
  branch: WaitBranchContext
): Promise<ExecutionResult> {
  const { context, runtime, store, workflowId, startLog } = branch;
  const { executionId } = context;

  const prepared = await runtime.step(
    `wait-event-prepare-${context.nodeId}`,
    () => prepareEventWait(branch)
  );

  if (prepared.status === "error") {
    return { success: false, error: { message: prepared.error } };
  }

  let timedOut = false;
  let signal: JsonObject | null = null;

  try {
    // Inngest waits on Rova's own signal envelope rather than on the business
    // Event: which runs an arrival concerns is decided by resume matching, in
    // Rova code, before this signal is ever sent.
    const resumeEvent = await runtime.waitForEvent(
      `wait-event-${context.nodeId}`,
      {
        event: "workflow/wait.signal",
        timeoutMs: prepared.timeoutMs,
        ifExpression: [
          "async.data.executionId == event.data.executionId",
          `async.data.nodeId == ${celStringLiteral(context.nodeId)}`,
          `async.data.token == ${celStringLiteral(prepared.resumeToken)}`,
          // A Cancel Event wakes a parked run through the same envelope, so this
          // wait admits both signals and the step below tells them apart.
          `(async.data.signalType == ${celStringLiteral("wait-resume")} || async.data.signalType == ${celStringLiteral("lifecycle-cancel")})`,
        ].join(" && "),
      }
    );
    timedOut = resumeEvent === null;
    signal = readWaitSignal(resumeEvent);
  } catch (error) {
    // Same reasoning as the delay branch: the run is unwinding, so no new step.
    await closeStepLog(store, startLog, {
      status: "error",
      error: getErrorMessage(error),
    });
    throw error;
  }

  // Derived outside the step for the same reason `timedOut` is: both come off
  // the memoized `waitForEvent` result, so a replay reads the same verdict.
  const canceled = !timedOut && signal?.signalType === "lifecycle-cancel";

  const resumed = await runtime.step(
    `wait-event-resume-${context.nodeId}`,
    async () => {
      await store.markWaitStateStatus({
        waitStateId: prepared.waitStateId,
        status: canceled ? "cancelled" : timedOut ? "timed_out" : "resumed",
      });
      await store.markExecutionRunning({ executionId });

      await store.recordAuditEvent({
        workflowId,
        executionId,
        eventType: timedOut ? "run_timed_out" : "run_resumed",
        message: timedOut
          ? `Run timed out in event wait node '${context.nodeName}'`
          : canceled
            ? `Run woken by a cancel request in node '${context.nodeName}'`
            : `Run resumed from event in node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
          resumeToken: prepared.resumeToken,
        },
      });

      // A wait configured to skip on timeout stops its branch instead of letting
      // downstream nodes run without the awaited Event. The behaviour comes off
      // the preparation, which is what this run parked with: a wait can outlive
      // several edits to the node it parked on, and none of them may change how
      // this run treats a timeout it is already counting down.
      const skipOnTimeout = timedOut && prepared.timeoutBehavior === "skip";

      // The resume token stays off this object: it is a capability addressing
      // this parked run, node output is template-addressable, and the panel
      // reads the token off the wait row instead.
      const base = {
        waitType: "event",
        timedOut,
        resumedAt: encodeIsoTimestamp(new Date()),
      };
      // A cancel wake carries no resume payload: the signal is a nudge, and what
      // the canceling Event sent is on the execution row, which the engine reads
      // at this node's boundary.
      const carriesPayload = !(timedOut || canceled);
      // What the arriving Event carried, and nothing of the envelope it came in:
      // `payload.orderId` is the path a builder writes, and the catalog's field
      // list for this node promises exactly that.
      const output = skipOnTimeout
        ? { ...base, skipped: true, skippedReason: "timeout_skip" }
        : {
            ...base,
            ...(carriesPayload
              ? { payload: readJsonObject(signal?.payload) ?? {} }
              : {}),
          };

      await closeStepLog(store, startLog, { status: "success", output });

      return { output, skipOnTimeout };
    }
  );

  if (resumed.skipOnTimeout) {
    return { success: true, data: resumed.output, haltBranch: true };
  }

  return { success: true, data: resumed.output };
}
