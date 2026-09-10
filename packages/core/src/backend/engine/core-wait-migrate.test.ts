/**
 * What a Migration does to a Wait that is already parked.
 *
 * A Migration moves an open Execution to another Workflow Version while the run
 * is parked, so the body Inngest calls next loads a different graph for the same
 * wait row. These cases drive that through `driveWithReplay`, which calls the
 * body again from the top on every wake, and swap the config between calls. The
 * cases about what one park does live in `core-wait.test.ts`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import { executionError } from "#src/backend/engine/contracts";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import { noWorkflowActions } from "#src/backend/engine/actions";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import {
  createWaitGraph,
  waitMigrateSignal,
  waitOutput,
  waitResumeSignal,
} from "#src/backend/engine/testing/wait-fixtures";

/**
 * Drives a Wait whose config changes once the run is parked, which is what a
 * Migration looks like from inside the run: Inngest calls the function body
 * again from the top on every wake, and the body loads the graph from the
 * version the execution row now names. The wait-state row is the switch,
 * because the first park is what writes it.
 */
function runMigratedWait(options: {
  store: RecordingWorkflowStore;
  parked: Record<string, unknown>;
  migrated: Record<string, unknown>;
  events: Record<string, unknown>;
  startEventName?: string | undefined;
  startPayload?: JsonObject | undefined;
}) {
  return driveWithReplay(
    (runtime) => {
      const migrated = options.store.callsOf("createWaitState").length > 0;
      const workflowVersionId = migrated ? "ver_2" : "ver_1";

      return executeWorkflow(
        {
          graph: createWaitGraph(migrated ? options.migrated : options.parked),
          executionId: "exec_wait",
          workflowId: "workflow_wait",
          workflowVersionId,
          startEventName: options.startEventName,
          startPayload: options.startPayload,
        },
        runtime,
        options.store,
        noWorkflowActions
      );
    },
    { events: options.events }
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe("wait node - migration to a later workflow version", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("re-parks a delay wait on the next attempt, measured from the first park's anchor", async () => {
    const run = await runMigratedWait({
      store,
      parked: { waitMode: "delay", waitDuration: "1h" },
      migrated: { waitMode: "delay", waitDuration: "3d" },
      events: { "wait-park-wait_1-0": waitMigrateSignal() },
    });

    // One row, written over rather than joined by a second.
    const created = store.callsOf("createWaitState");
    const reparked = store.callsOf("reparkWaitState");
    expect(created).toHaveLength(1);
    expect(reparked).toHaveLength(1);
    expect(reparked[0]?.waitStateId).toBe("wait_state_1");
    // The whole park is written over, wait type and token included.
    expect(reparked[0]?.waitType).toBe("delay");
    expect(reparked[0]?.resumeToken).toBeNull();
    expect(reparked[0]?.subscribedEvents).toEqual([]);

    // Three days from where the run first parked, not from where it woke. The
    // first park's target is an hour past that anchor.
    const anchorAt = Date.parse(String(created[0]?.waitUntilIso)) - HOUR_MS;
    expect(Date.parse(String(reparked[0]?.waitUntilIso))).toBe(
      anchorAt + 3 * DAY_MS
    );

    // Both parks record that anchor on the row, which is the instant the
    // migration preflight measures a target Wait's elapsed timeout from.
    expect(created[0]?.metadata).toMatchObject({
      anchorAt: new Date(anchorAt).toISOString(),
    });
    expect(reparked[0]?.metadata).toMatchObject({
      anchorAt: new Date(anchorAt).toISOString(),
    });

    const stepIds = run.executed.map((step) => step.stepId);
    expect(stepIds).toContain("wait-prepare-wait_1-1");
    expect(stepIds).toContain("wait-resume-wait_1-1");
    expect(stepIds).not.toContain("wait-resume-wait_1-0");

    expect(waitOutput(run.value)).toMatchObject({
      waitType: "delay",
      hops: 2,
    });
  });

  it("re-prepares after an old version's park times out", async () => {
    const run = await runMigratedWait({
      store,
      parked: { waitMode: "delay", waitDuration: "1h" },
      migrated: { waitMode: "delay", waitDuration: "3h" },
      events: {},
    });

    const created = store.callsOf("createWaitState");
    const reparked = store.callsOf("reparkWaitState");
    expect(created).toHaveLength(1);
    expect(reparked).toHaveLength(1);

    // Attempt 0 times out at one hour. Attempt 1 keeps the original anchor and
    // parks for the two hours remaining under the target version's duration.
    const anchorAt = Date.parse(String(created[0]?.waitUntilIso)) - HOUR_MS;
    expect(Date.parse(String(reparked[0]?.waitUntilIso))).toBe(
      anchorAt + 3 * HOUR_MS
    );
    expect(run.executed.map((step) => step.stepId)).toContain(
      "wait-prepare-wait_1-1"
    );
  });

  // A Migration may give the node the other mode. The attempts already on the
  // run are memoized under ids that name the node and the attempt alone, so the
  // reloaded body replays them, keeps the row and the anchor the delay attempt
  // wrote, and re-parks that row as an event wait.
  it("re-parks the same row in event mode when the migration changed the wait's mode", async () => {
    const run = await runMigratedWait({
      store,
      parked: { waitMode: "delay", waitDuration: "1h" },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      events: {
        "wait-park-wait_1-0": waitMigrateSignal(),
        "wait-park-wait_1-1": waitResumeSignal(
          { id: "pay_1" },
          "billing/payment.settled"
        ),
      },
    });

    const created = store.callsOf("createWaitState");
    const reparked = store.callsOf("reparkWaitState");
    expect(created).toHaveLength(1);
    expect(created[0]?.waitType).toBe("delay");
    expect(reparked).toHaveLength(1);
    expect(reparked[0]?.waitStateId).toBe("wait_state_1");
    expect(reparked[0]?.waitType).toBe("event");
    expect(reparked[0]?.subscribedEvents).toEqual(["billing/payment.settled"]);

    // A delay park carries no token, so the event attempt mints one.
    expect(created[0]?.resumeToken).toBeUndefined();
    expect(reparked[0]?.resumeToken).toEqual(expect.any(String));

    // The event wait's timeout is measured from the instant the delay attempt
    // resolved against, whose target was an hour past it.
    const anchorAt = Date.parse(String(created[0]?.waitUntilIso)) - HOUR_MS;
    expect(Date.parse(String(reparked[0]?.waitUntilIso))).toBe(
      anchorAt + 7 * DAY_MS
    );

    expect(waitOutput(run.value)).toMatchObject({
      waitType: "event",
      timedOut: false,
      event: "billing/payment.settled",
      payload: { id: "pay_1" },
      hops: 2,
    });
  });

  it("recompiles an event wait's subscriptions and timeout on the next attempt", async () => {
    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.failed" }],
        waitTimeout: "7d",
      },
      events: {
        "wait-park-wait_1-0": waitMigrateSignal(),
        "wait-park-wait_1-1": waitResumeSignal(
          { id: "pay_1" },
          "billing/payment.failed"
        ),
      },
    });

    const created = store.callsOf("createWaitState");
    const reparked = store.callsOf("reparkWaitState");
    expect(created[0]?.subscribedEvents).toEqual(["billing/payment.settled"]);
    expect(reparked).toHaveLength(1);
    expect(reparked[0]?.subscribedEvents).toEqual(["billing/payment.failed"]);
    // The token the row already carries addresses the new park too.
    expect(reparked[0]?.resumeToken).toBe(created[0]?.resumeToken);

    // The timeout still runs out where the first park put it.
    expect(reparked[0]?.waitUntilIso).toBe(created[0]?.waitUntilIso);

    expect(waitOutput(run.value)).toMatchObject({
      waitType: "event",
      timedOut: false,
      event: "billing/payment.failed",
      payload: { id: "pay_1" },
      hops: 2,
    });
  });

  it("does not skip a wait that already waited when the recomputed target has passed", async () => {
    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "delay",
        waitDuration: "1h",
        waitGateMode: "require_actual_wait",
      },
      migrated: {
        waitMode: "delay",
        waitDuration: "-1h",
        waitGateMode: "require_actual_wait",
      },
      events: { "wait-park-wait_1-0": waitMigrateSignal() },
    });

    // The gate asks whether this Wait ever waited, and the first attempt waited
    // an hour.
    expect(run.value.results.after_wait).toBeDefined();
    const output = waitOutput(run.value);
    expect(output.skipped).toBeUndefined();
    // The second attempt had nothing left to wait for, so the run parked once
    // in all.
    expect(output.hops).toBe(1);
    expect(run.executed.map((step) => step.stepId)).toContain(
      "wait-resume-wait_1-1"
    );
  });
  // Between a Migration's wake and the next park the row is still `waiting`, so
  // a resume claim can take it and send a signal nothing is parked on. The claim
  // writes its arrival onto the row, and the refused re-park is what sends the
  // Wait to read it.
  it("resumes from the arrival recorded on a row that left waiting", async () => {
    store.reparkAnswer = { ok: false, reason: "not_waiting" };
    store.waitState = {
      status: "resumed",
      arrival: {
        signalType: "wait-resume",
        eventName: "billing/payment.settled",
        payload: { id: "pay_1" },
      },
    };

    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      events: { "wait-park-wait_1-0": waitMigrateSignal() },
    });

    expect(store.callsOf("readWaitState")).toEqual([
      { waitStateId: "wait_state_1" },
    ]);
    expect(waitOutput(run.value)).toMatchObject({
      waitType: "event",
      timedOut: false,
      event: "billing/payment.settled",
      payload: { id: "pay_1" },
      // The second attempt read the arrival instead of parking again.
      hops: 1,
    });
    expect(run.value.results.after_wait).toBeDefined();
  });

  it("keeps a recorded arrival when the target version changes the wait to delay mode", async () => {
    store.reparkAnswer = { ok: false, reason: "not_waiting" };
    store.waitState = {
      status: "resumed",
      arrival: {
        signalType: "wait-resume",
        eventName: "billing/payment.settled",
        payload: { id: "pay_1" },
      },
    };

    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: { waitMode: "delay", waitDuration: "1h" },
      events: {
        "wait-park-wait_1-0": waitResumeSignal({ id: "pay_1" }),
      },
      startEventName: "app/appointment.created",
      startPayload: { id: "appt_1" },
    });

    expect(store.callsOf("reparkWaitState")[0]?.waitType).toBe("delay");
    expect(waitOutput(run.value)).toMatchObject({
      waitType: "delay",
      hops: 1,
    });
    expect(run.value.outputs.lifecycle_1?.data).toEqual({ id: "pay_1" });
    expect(store.callsOf("markWaitStateStatus")).toHaveLength(0);
    expect(store.callsOf("markExecutionRunning")).toEqual([
      { executionId: "exec_wait", workflowVersionId: "ver_2" },
    ]);
    expect(
      store
        .callsOf("recordAuditEvent")
        .filter((event) => event.eventType === "run_resumed")
    ).toEqual([
      expect.objectContaining({
        message: "Run resumed from wait on billing/payment.settled",
      }),
    ]);
  });

  it("takes the cancel path when the row was cancelled between two parks", async () => {
    store.reparkAnswer = { ok: false, reason: "not_waiting" };
    store.waitState = { status: "cancelled", arrival: null };

    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      events: { "wait-park-wait_1-0": waitMigrateSignal() },
    });

    expect(store.callsOf("markWaitStateStatus").at(-1)?.status).toBe(
      "cancelled"
    );
    expect(run.value.results.after_wait).toBeUndefined();
  });

  it("fails the node when the row that left waiting records no wake", async () => {
    store.reparkAnswer = { ok: false, reason: "not_waiting" };
    store.waitState = { status: "timed_out", arrival: null };

    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      events: { "wait-park-wait_1-0": waitMigrateSignal() },
    });

    expect(run.value.results.wait_1?.success).toBe(false);
    expect(executionError(run.value.results.wait_1)).toContain(
      "records no wake"
    );
  });

  // The pointer can move after Inngest has resolved the park and before the
  // resume step runs, which would let the attempt carry on under the graph this
  // body loaded. The resume's own guarded write is that fence: it moves the run
  // back to running only while the row still pins the version this body loaded,
  // so a refused write fails the step and Inngest retries the body against the
  // version the row now names.
  it("fails its step when the run has been moved to another workflow version", async () => {
    store.markRunningAnswer = false;

    const run = driveWithReplay(
      (runtime) =>
        executeWorkflow(
          {
            graph: createWaitGraph({ waitMode: "delay", waitDuration: "1h" }),
            executionId: "exec_wait",
            workflowId: "workflow_wait",
            workflowVersionId: "ver_1",
          },
          runtime,
          store,
          noWorkflowActions
        ),
      { events: {} }
    );

    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining("moved off workflow version ver_1"),
    });
  });

  // The first park carries the same fence in its own write. The repository
  // answers undefined when the execution has left the version this park was
  // resolved from, and the step fails rather than reporting a node error.
  it("fails its step when the first park is refused", async () => {
    store.createWaitStateAnswer = undefined;

    const run = driveWithReplay(
      (runtime) =>
        executeWorkflow(
          {
            graph: createWaitGraph({ waitMode: "delay", waitDuration: "1h" }),
            executionId: "exec_wait",
            workflowId: "workflow_wait",
            workflowVersionId: "ver_1",
          },
          runtime,
          store,
          noWorkflowActions
        ),
      { events: {} }
    );

    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining("would not accept a park"),
    });
  });

  // A re-park the repository refused for the version guard is the same fence one
  // attempt further in. The row stays waiting for the retry to park again, so
  // nothing reads the row back looking for a wake it never recorded.
  it("fails its step when a re-park is refused for the version", async () => {
    store.reparkAnswer = { ok: false, reason: "version_moved" };

    const run = runMigratedWait({
      store,
      parked: { waitMode: "delay", waitDuration: "1h" },
      migrated: { waitMode: "delay", waitDuration: "3d" },
      events: { "wait-park-wait_1-0": waitMigrateSignal() },
    });

    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining("moved off workflow version"),
    });
    expect(store.callsOf("readWaitState")).toHaveLength(0);
  });

  // A `version-migrate` wake that keeps arriving without the target ever moving
  // would spin the body forever. The cap ends the node, and the two rows the
  // Wait opened are closed with it.
  it("fails the node and closes both its rows once the attempt cap is reached", async () => {
    const run = await driveWithReplay(
      (runtime) =>
        executeWorkflow(
          {
            graph: createWaitGraph({ waitMode: "delay", waitDuration: "1h" }),
            executionId: "exec_wait",
            workflowId: "workflow_wait",
            workflowVersionId: "ver_1",
          },
          runtime,
          store,
          noWorkflowActions
        ),
      {
        // Every park is woken by a Migration, so no attempt ever resumes.
        events: Object.fromEntries(
          Array.from({ length: 60 }, (_unused, attempt) => [
            `wait-park-wait_1-${attempt}`,
            waitMigrateSignal(),
          ])
        ),
        maxInvocations: 400,
      }
    );

    expect(run.value.results.wait_1?.success).toBe(false);
    expect(executionError(run.value.results.wait_1)).toContain(
      "which is the limit on one Wait's attempts"
    );
    // The wait row is settled, so no delivery and no manual resume can address
    // a park nothing is listening for.
    expect(store.callsOf("markWaitStateStatus").at(-1)).toEqual({
      waitStateId: "wait_state_1",
      status: "cancelled",
    });
    // The step-log row the first attempt opened is closed with the same reason.
    expect(store.callsOf("completeStepLog").at(-1)).toMatchObject({
      status: "error",
      error: expect.stringContaining("without resuming"),
    });
  });
});
