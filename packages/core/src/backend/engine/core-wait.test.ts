/** Event-mode Wait coverage through the engine's runtime and store ports. */

import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOutputPath } from "@wfgraph/shared/graph/node-references";
import { executionError } from "#src/backend/engine/contracts";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import {
  claimedRun,
  expectHaltedByClaim,
  runWait,
  waitOutput,
  waitResumeSignal,
  waitStepLogs,
} from "#src/backend/engine/testing/wait-fixtures";

/**
 * A match comparing one payload field against a value, as the editor stores it:
 * the serialized `ConditionModel` the Condition node builds.
 */
function matchOn(field: string, value: string): string {
  return JSON.stringify({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          { id: "rule", field, fieldType: "string", operator: "equals", value },
        ],
      },
    ],
  });
}

describe("wait node - event mode", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it.each([
    { elapsedMs: 30_000, remainingMs: 270_000 },
    { elapsedMs: 360_000, remainingMs: 1 },
  ])(
    "preserves preparation after a lost response and $elapsedMs ms retry",
    async ({ elapsedMs, remainingMs }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const startedAt = new Date("2026-09-22T12:00:00Z");
      vi.setSystemTime(startedAt);
      try {
        const memo = new Map<string, unknown>();
        const config = {
          waitMode: "event",
          waitFor: [{ event: "billing/payment.settled" }],
          waitTimeout: "5m",
        };
        const originalCreate = store.createWaitState.bind(store);
        store.createWaitState = (input) =>
          originalCreate(input).pipe(
            Effect.flatMap(() => Effect.die("lost preparation response"))
          );
        expect(
          (await runWait({ store, config, memo }).execution).results.wait_1
        ).toMatchObject({
          success: false,
          error: { message: "lost preparation response" },
        });
        const first = store.callsOf("createWaitState")[0];
        vi.setSystemTime(startedAt.getTime() + elapsedMs);
        store.createWaitState = originalCreate;
        const { runtime, execution } = runWait({ store, config, memo });
        await execution;
        expect(store.callsOf("createWaitState")).toEqual([first, first]);
        expect(runtime.waits[0]?.options.timeoutMs).toBe(remainingMs);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each(["waiting", "resuming", "resumed"] as const)(
    "consumes a persisted arrival from a %s row before registration",
    async (status) => {
      store.waitState = {
        status,
        arrival: {
          signalType: "wait-resume",
          eventName: "billing/payment.settled",
          payload: { approved: true },
        },
      };
      const { runtime, execution } = runWait({
        store,
        config: {
          waitMode: "event",
          waitFor: [{ event: "billing/payment.settled" }],
          waitTimeout: "7d",
        },
      });
      const result = await execution;
      expect(runtime.waits).toHaveLength(0);
      expect(waitOutput(result)).toMatchObject({
        timedOut: false,
        hops: 0,
        payload: { approved: true },
      });
      expect(result.results.after_wait?.success).toBe(true);
    }
  );

  it("uses the atomic timeout result when the signal was lost after preparation", async () => {
    const arrival = {
      signalType: "wait-resume" as const,
      eventName: "billing/payment.settled",
      payload: { approved: true },
    };
    const recovering = {
      ...store,
      settleWaitTimeout: () => Effect.succeed(arrival),
    };
    const memo = new Map<string, unknown>();
    const config = {
      waitMode: "event",
      waitFor: [{ event: "billing/payment.settled" }],
      waitTimeout: "7d",
    };
    const { runtime, execution } = runWait({ store: recovering, config, memo });
    const result = await execution;
    expect(runtime.waits).toHaveLength(1);
    expect(waitOutput(result)).toMatchObject({
      timedOut: false,
      hops: 1,
      payload: { approved: true },
    });
    expect(result.results.after_wait?.success).toBe(true);
    expect(
      store
        .callsOf("recordAuditEvent")
        .some((event) => event.eventType === "run_timed_out")
    ).toBe(false);
    const replay = await runWait({
      store: {
        ...store,
        settleWaitTimeout: () =>
          Effect.die("memoized timeout resolution must not repeat"),
      },
      config,
      memo,
    }).execution;
    expect(waitOutput(replay)).toEqual(waitOutput(result));
  });

  it("waits on the signal event scoped to this run, node, and token", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: waitResumeSignal({ approved: true }),
    });
    const result = await execution;

    expect(result.success).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      waitType: "event",
      timedOut: false,
      event: "billing/payment.settled",
      payload: { approved: true },
    });
    // An ordinary resume carries the run on, which is what makes the halting
    // assertions elsewhere in this file mean something.
    expect(result.results.after_wait).toBeDefined();
    expect(result.results.after_wait?.success).toBe(true);

    const resumeToken = store.callsOf("createWaitState")[0]?.resumeToken;
    expect(typeof resumeToken).toBe("string");
    expect(resumeToken).not.toBe("");

    const wait = runtime.waits.at(0);
    expect(wait?.stepId).toBe("wait-park-wait_1-0");
    expect(wait?.options.event).toBe("workflow/wait.signal");
    expect(wait?.options.ifExpression).toContain(`"${resumeToken}"`);
    expect(wait?.options.ifExpression).toContain(
      'async.data.nodeId == "wait_1"'
    );
    expect(wait?.options.timeoutMs).toBeGreaterThan(0);

    expect(store.callsOf("createWaitState")[0]).toMatchObject({
      waitType: "event",
    });
    expect(store.callsOf("markExecutionRunning")).toEqual([
      {
        executionId: "exec_wait",
        workflowVersionId: "ver_test",
        side: "started",
      },
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

  // The run is the consumer of the wake, so it closes the row whichever producer
  // sent the signal. A producer whose own settle write failed leaves a
  // `resuming` row that a later wake could otherwise reclaim once its lease
  // expires and signal a park this node has long left.
  it("settles the wait row as resumed when an Event wakes it", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: waitResumeSignal({ approved: true }),
    });
    await execution;

    expect(store.callsOf("markWaitStateStatus")).toEqual([
      { waitStateId: "wait_state_1", status: "resumed" },
    ]);
  });

  it("records a manual resume as coming from the Runs view", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: waitResumeSignal({ approved: true }, null),
    });
    await execution;

    expect(
      store
        .callsOf("recordAuditEvent")
        .filter((event) => event.eventType === "run_resumed")
    ).toEqual([
      expect.objectContaining({
        message: "Run resumed from the Runs view",
        metadata: { nodeId: "wait_1", hops: 1, waitStateId: "wait_state_1" },
      }),
    ]);
  });

  // The node output is the arriving Event's payload and nothing of the signal
  // envelope that carried it, which is what makes `payload.<field>` the path the
  // catalog's field list promises rather than `payload.data.payload.<field>`.
  it("outputs the arriving Event's payload without the signal envelope", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: waitResumeSignal({ orderId: "ord_7" }),
    });
    const result = await execution;

    expect(waitOutput(result).payload).toEqual({ orderId: "ord_7" });

    // The path the catalog offers for this node, walked the way a template and
    // the condition builder walk it.
    const nodeOutput = result.outputs.wait_1?.data ?? null;
    expect(resolveOutputPath(nodeOutput, "payload.orderId")).toBe("ord_7");
    expect(resolveOutputPath(nodeOutput, "waitType")).toBe("event");
  });

  // A wait holds a race between the Events it subscribes to, and the payloads of
  // two Events can be shaped alike. Naming the winner is the only thing that
  // lets a Condition below the wait tell them apart.
  it("names which of several subscribed Events resumed the run", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          { event: "billing/payment.settled" },
          { event: "billing/payment.failed" },
        ],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: waitResumeSignal({ id: "pay_1" }, "billing/payment.failed"),
    });
    const result = await execution;

    expect(waitOutput(result).event).toBe("billing/payment.failed");

    // The path the catalog offers, walked the way the condition builder walks it.
    const nodeOutput = result.outputs.wait_1?.data ?? null;
    expect(resolveOutputPath(nodeOutput, "event")).toBe(
      "billing/payment.failed"
    );
  });

  // A resume that carried no payload still answers an object, so a template
  // reaching into it resolves to nothing rather than failing the node.
  it("outputs an empty payload when the signal carried none", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: { data: { signalType: "wait-resume" } },
    });
    const result = await execution;

    expect(waitOutput(result).payload).toEqual({});
  });

  // A Cancel Event wakes a parked run through the same envelope. The wake closes
  // the wait as cancelled, hands back no resume payload, and stops the branch
  // where it stands: the run's verdict is the flag on its execution row, and a
  // branch run reads no flag of its own (ADR-0011), so anything below this node
  // would be work done for a run already ending.
  it("closes the wait as cancelled when a lifecycle cancel wakes it", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: {
        data: { signalType: "lifecycle-cancel", payload: { reason: "gone" } },
      },
    });
    const result = await execution;

    expect(result.success).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      waitType: "event",
      timedOut: false,
    });
    expect(waitOutput(result)).not.toHaveProperty("payload");
    // A cancel wake is not one of the Events the builder subscribed to, so the
    // node names none.
    expect(waitOutput(result)).not.toHaveProperty("event");
    expect(store.callsOf("markWaitStateStatus")[0]?.status).toBe("cancelled");
    expect(runtime.waits.at(0)?.options.ifExpression).toContain(
      'async.data.signalType == "lifecycle-cancel"'
    );
    // Nothing below the wait ran: the entry node and the wait are the whole of
    // what opened a row.
    expect(store.callsOf("startStepLog").map((open) => open.nodeId)).toEqual([
      "lifecycle_1",
      "wait_1",
    ]);
  });

  // An Exit claimed by another branch of the run wakes an event wait through the
  // same envelope, and the wake halts the branch as a cancel wake does.
  it("closes the wait as cancelled when an Exit wakes it", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: { data: { signalType: "lifecycle-exit" } },
    });
    const result = await execution;

    expect(result.success).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      waitType: "event",
      timedOut: false,
    });
    expect(waitOutput(result)).not.toHaveProperty("payload");
    expect(waitOutput(result)).not.toHaveProperty("event");
    expect(runtime.waits.at(0)?.options.ifExpression).toContain(
      'async.data.signalType == "lifecycle-exit"'
    );
    expect(store.callsOf("markWaitStateStatus")).toEqual([
      { waitStateId: "wait_state_1", status: "cancelled" },
    ]);
    expect(store.callsOf("markExecutionRunning")).toEqual([]);
    expect(
      store
        .callsOf("recordAuditEvent")
        .filter((event) => event.eventType === "run_resumed")
    ).toEqual([
      expect.objectContaining({
        message: "Run woken by an Exit in node 'Wait'",
        metadata: { nodeId: "wait_1", hops: 1 },
      }),
    ]);
    expect(store.callsOf("startStepLog").map((open) => open.nodeId)).toEqual([
      "lifecycle_1",
      "wait_1",
    ]);
  });

  // The running write refuses a run that holds a Cancel or Exit claim. A cancel
  // wake arrives only after that claim, so the resume leaves the write out and
  // still halts the branch rather than failing its step.
  it("halts on a cancel wake without the running write a claimed run refuses", async () => {
    store.markRunningAnswer = false;

    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: { data: { signalType: "lifecycle-cancel" } },
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(true);
    expect(result.results.after_wait).toBeUndefined();
    expect(store.callsOf("markExecutionRunning")).toEqual([]);
    expect(store.callsOf("markWaitStateStatus")).toEqual([
      { waitStateId: "wait_state_1", status: "cancelled" },
    ]);
  });

  // A resume producer can take the row before a claim and have its signal reach
  // the park first. The running write refuses the claimed run, so the resume
  // reads the claim and halts as the claim's own wake would, dropping the
  // arrival. A refusal with no claim is a Migration, and the step still fails:
  // `core-wait-migrate.test.ts` covers that case.
  it.each(["exit", "cancel"] as const)(
    "halts as the %s claim when the running write refuses a resume wake",
    async (kind) => {
      store.markRunningAnswer = false;

      const { execution } = runWait({
        config: {
          waitMode: "event",
          waitFor: [{ event: "billing/payment.settled" }],
          waitTimeout: "7d",
        },
        store,
        resumeEvent: waitResumeSignal({ orderId: "ord_1" }),
        claimOnPark: claimedRun(kind),
      });

      expectHaltedByClaim(store, await execution, kind);
    }
  );

  // The resume step memoizes the claim wake it substituted, so a replay that
  // skips the step body still halts the branch.
  it("halts on replay from the memoized claim wake", async () => {
    store.markRunningAnswer = false;
    const memo = new Map<string, unknown>();
    const config = {
      waitMode: "event",
      waitFor: [{ event: "billing/payment.settled" }],
      waitTimeout: "7d",
    };
    const resumeEvent = waitResumeSignal({ orderId: "ord_1" });
    const claimOnPark = claimedRun("exit");

    await runWait({ config, store, resumeEvent, memo, claimOnPark }).execution;
    const replayed = await runWait({ config, store, resumeEvent, memo })
      .execution;

    expect(replayed.results.after_wait).toBeUndefined();
    expect(waitOutput(replayed)).not.toHaveProperty("payload");
    expect(store.callsOf("markExecutionRunning")).toHaveLength(1);
  });

  // A wait with no end is an immortal run, so the timeout the editor writes is
  // applied here too rather than being left to whatever Inngest would pick.
  it("falls back to the default timeout when the config names none", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
      },
      store,
      resumeEvent: {},
    });
    await execution;

    expect(runtime.waits.at(0)?.options.timeoutMs).toBeGreaterThan(0);
    expect(store.callsOf("createWaitState")[0]?.metadata).toMatchObject({
      waitTimeout: "7d",
      waitTimeoutBehavior: "continue",
    });
  });

  it("records a timeout when the signal never arrives", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "30m",
      },
      store,
      resumeEvent: null,
    });
    const result = await execution;

    expect(waitOutput(result)).toMatchObject({ timedOut: true });
    expect(store.callsOf("settleWaitTimeout")).toEqual([
      { waitStateId: "wait_state_1" },
    ]);
    expect(store.callsOf("recordAuditEvent").map((c) => c.eventType)).toEqual([
      "run_waiting",
      "run_timed_out",
      "run_completed",
    ]);
  });

  it("copies the subscribed Event names onto the wait row", async () => {
    // The delivery fan-out finds parked runs by this column, so the node config
    // and the row have to agree entry for entry.
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          { event: "appointment.confirmed" },
          { event: "appointment.cancelled" },
        ],
        waitTimeout: "1d",
      },
      store,
      resumeEvent: {},
    });
    await execution;

    expect(store.callsOf("createWaitState")[0]?.subscribedEvents).toEqual([
      "appointment.confirmed",
      "appointment.cancelled",
    ]);
  });

  // The whole of the wait bug, pinned: a run started by one Event parks on a
  // different one, and what it compares is the arriving payload against a value
  // only this run knows. The run side is a literal by the time it is stored.
  it("resolves the run side of a match to a literal at park time", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          {
            event: "billing/payment.settled",
            match: matchOn(
              "appointmentId",
              "{{@lifecycle_1:Lifecycle.appointment.id}}"
            ),
          },
        ],
        waitTimeout: "7d",
      },
      store,
      startPayload: { appointment: { id: "appt_8813" } },
      resumeEvent: {},
    });
    await execution;

    expect(store.callsOf("createWaitState")[0]?.metadata).toMatchObject({
      waitFor: [
        {
          event: "billing/payment.settled",
          match: {
            expression:
              '((has(payload.appointmentId) && (payload.appointmentId == "appt_8813")))',
            timestampPaths: [],
          },
        },
      ],
    });
  });

  it("stores no expression for a subscription carrying no match", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: {},
    });
    await execution;

    expect(store.callsOf("createWaitState")[0]?.metadata).toMatchObject({
      waitFor: [{ event: "billing/payment.settled" }],
    });
  });

  // A reference the resolver cannot answer is left as the authored text, so
  // compiling it would park the run on a comparison against the literal
  // `{{...}}` -- a wait nothing can wake, quiet until its timeout runs out.
  it("fails the node when a match still names a node that did not run", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          {
            event: "billing/payment.settled",
            match: matchOn(
              "appointmentId",
              "{{@no_such_node:Gone.appointment.id}}"
            ),
          },
        ],
        waitTimeout: "7d",
      },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(executionError(result.results.wait_1)).toContain(
      "is not available to this run"
    );
    expect(runtime.waits).toHaveLength(0);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
  });

  // Parking without the match would subscribe the run to every occurrence of
  // that Event, which is the opposite of what the builder wrote.
  it("fails the node when a match will not compile", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          { event: "billing/payment.settled", match: matchOn("id", "") },
        ],
        waitTimeout: "7d",
      },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(executionError(result.results.wait_1)).toContain(
      "billing/payment.settled"
    );
    expect(runtime.waits).toHaveLength(0);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
  });

  it("fails the node when the configured timeout cannot be parsed", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "whenever",
      },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(waitStepLogs(store).closed[0]?.status).toBe("error");
  });

  it("parks with no Correlation Path in sight", async () => {
    // The match is the matcher, so a run whose start carried no entity still
    // parks. The failure this replaces refused the wait outright.
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: {},
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(true);
    expect(store.callsOf("createWaitState")).toHaveLength(1);
  });

  it("halts the branch on timeout when configured to skip", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "5m",
        waitTimeoutBehavior: "skip",
      },
      store,
      resumeEvent: null,
    });
    const result = await execution;

    expect(result.results.after_wait).toBeUndefined();
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "timeout_skip",
    });
  });

  // A wait can outlive several edits to the node it parked on. The timeout
  // behaviour comes off the memoized preparation, so the run finishes the way it
  // started rather than reading a config that has moved underneath it.
  //
  // The two passes are the real sequence: a run parks, and the pass that closes
  // the wait out is a separate invocation, replaying the preparation from the
  // memo and reaching the resume step for the first time. Dropping that step's
  // entry is what models the suspend this in-memory runtime does not perform.
  it("keeps the timeout behaviour the run parked with across an edit", async () => {
    const memo = new Map<string, unknown>();
    const parked = {
      waitMode: "event",
      waitFor: [{ event: "billing/payment.settled" }],
      waitTimeout: "5m",
      waitTimeoutBehavior: "skip",
    };

    await runWait({ config: parked, store, memo, resumeEvent: null }).execution;
    memo.delete("wait-resume-wait_1-0");

    const result = await runWait({
      config: { ...parked, waitTimeoutBehavior: "continue" },
      store,
      memo,
      resumeEvent: null,
    }).execution;

    expect(result.results.after_wait).toBeUndefined();
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "timeout_skip",
    });
  });
});
