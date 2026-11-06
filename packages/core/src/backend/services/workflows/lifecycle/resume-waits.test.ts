import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLogger } from "#src/backend/lib/effect/app-logger";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExecutionDriver,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  DriverError,
  type ExecutionDriver,
} from "#src/backend/services/executions/driver";
import { getAppLogger } from "#src/backend/lib/logger";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WorkflowWaitState } from "#src/backend/services/executions/repo/contracts";
import { resumeWaitsMatchingEvent } from "#src/backend/services/workflows/lifecycle/resume-waits";
import type { JsonObject } from "@wfgraph/shared/types/json";

const { loggerErrorMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
}));

type Repo = ExecutionRepo["Service"];

const CLAIMED_AT = new Date("2026-03-01T00:01:00.000Z");

/**
 * The resume claim as the driver answers it: the park the target names,
 * claimed and resolved with the arrival, and its run re-queued.
 */
function claimedPark(
  input: Parameters<ExecutionDriver["Service"]["resolvePark"]>[0]
) {
  const id =
    input.target.kind === "wait_state"
      ? input.target.waitStateId
      : input.target.token;
  return Effect.succeed({
    requeued: true,
    waitState: {
      id,
      executionId: `exec_${id}`,
      workflowId: "workflow_1",
      nodeId: `node_${id}`,
      nodeName: `Wait ${id}`,
      waitType: "event" as const,
      status: "resuming" as const,
      resumeToken: `token_${id}`,
      waitUntil: null,
      subscribedEvents: ["event.update"],
      metadata: null,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      resumedAt: CLAIMED_AT,
      cancelledAt: null,
    },
  });
}

const resolveParkMock =
  vi.fn<ExecutionDriver["Service"]["resolvePark"]>(claimedPark);
const findWaitStateByIdMock = vi.fn<Repo["findWaitStateById"]>(() =>
  Effect.succeed(null)
);
const findParkMock = vi.fn<Repo["findPark"]>(() => Effect.succeed(null));

/** The park a reread finds, resolved with a `resume` wake from `deliveryId`. */
function resumedPark(
  id: string,
  executionId: string,
  deliveryId: string | null
) {
  return Effect.succeed({
    waitStateId: id,
    executionId,
    status: "resuming" as const,
    parkStepId: null,
    wake: {
      kind: "resume" as const,
      eventName: "event.update",
      payload: { key: "value" },
      deliveryId,
    },
  });
}

const services = Layer.mergeAll(
  stubExecutionRepo({
    findWaitStateById: findWaitStateByIdMock,
    findPark: findParkMock,
  }),
  stubExecutionDriver({ resolvePark: resolveParkMock })
);

type Subscription = {
  event: string;
  connectionId?: string | undefined;
  match?: { expression: string; timestampPaths: string[] };
};

/**
 * A parked wait, holding the subscriptions it compiled when it parked.
 *
 * The row's own metadata is the matcher, so an edit to the node it parked on
 * cannot change what the run is owed. `subscribedEvents` is what the candidate
 * query narrows by, and it is set here to match so a row reaching this function
 * looks the way the query would have handed it over.
 */
function createWaitState(
  id: string,
  executionId: string,
  options?: {
    resumeToken?: string | null | undefined;
    subscriptions?: Subscription[] | undefined;
  }
) {
  const subscriptions = options?.subscriptions ?? [{ event: "event.update" }];

  return {
    id,
    executionId,
    nodeId: `node_${id}`,
    resumeToken:
      options?.resumeToken === undefined ? `token_${id}` : options.resumeToken,
    subscribedEvents: subscriptions.map((subscription) => subscription.event),
    metadata: { waitFor: subscriptions } as JsonObject,
  };
}

function createPersistedWaitState(
  id: string,
  executionId: string,
  options?: {
    resumeToken?: string | null | undefined;
    subscriptions?: Subscription[] | undefined;
    subscribedEvents?: string[] | null | undefined;
    metadata?: JsonObject | null | undefined;
    status?: WorkflowWaitState["status"] | undefined;
  }
): WorkflowWaitState {
  const subscriptions = options?.subscriptions ?? [{ event: "event.update" }];
  return {
    id,
    executionId,
    workflowId: "workflow_1",
    nodeId: `node_${id}`,
    nodeName: `Wait ${id}`,
    waitType: "event",
    status: options?.status ?? "waiting",
    resumeToken:
      options?.resumeToken === undefined
        ? `token_${id}_current`
        : options.resumeToken,
    waitUntil: null,
    subscribedEvents:
      options?.subscribedEvents === undefined
        ? subscriptions.map((subscription) => subscription.event)
        : options.subscribedEvents,
    metadata:
      options?.metadata === undefined
        ? ({ waitFor: subscriptions } as JsonObject)
        : options.metadata,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    resumedAt: null,
    cancelledAt: null,
  };
}

/**
 * The subject on its stub services.
 *
 * Every case claims and reads through the same stubs, so only what varies is
 * written at a call site. The logger defaults to silent; a case that asserts
 * on a log line hands over `makeRecordingLogger().layer` instead.
 */
function resumeWaits(
  input: Parameters<typeof resumeWaitsMatchingEvent>[0],
  loggerLayer: Layer.Layer<AppLogger> = SilentAppLoggerLayer
): Promise<number> {
  return Effect.runPromise(
    resumeWaitsMatchingEvent(input).pipe(
      Effect.provide(Layer.mergeAll(services, loggerLayer))
    )
  );
}

describe("resumeWaitsMatchingEvent", () => {
  beforeEach(() => {
    loggerErrorMock.mockReset();
    resolveParkMock.mockReset();
    findWaitStateByIdMock.mockReset();
    findParkMock.mockReset();

    // `wait-match` captured the logger at module load, so spy the same category
    // instance's `error` rather than replacing `getAppLogger`. This module's
    // own logging goes through the `AppLogger` service, silenced below.
    const waitMatchLogger = getAppLogger("waits");
    vi.spyOn(waitMatchLogger, "error").mockImplementation(((
      message: string
    ) => {
      loggerErrorMock(message);
    }) as typeof waitMatchLogger.error);

    resolveParkMock.mockImplementation(claimedPark);
    findWaitStateByIdMock.mockImplementation(() => Effect.succeed(null));
    findParkMock.mockImplementation(() => Effect.succeed(null));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 when eventType is undefined", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: undefined,
      payload: { data: "test" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).not.toHaveBeenCalled();
  });

  it("returns 0 when eventType is empty string", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "",
      payload: { data: "test" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).not.toHaveBeenCalled();
  });

  it("returns 0 for empty waitStates array", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { data: "test" },
      waitStates: [],
    });

    expect(result).toBe(0);
  });

  it("leaves a wait parked when the arrival is a different Connection", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { data: "test" },
      connectionId: "conn_other",
      waitStates: [
        createWaitState("1", "exec_1", {
          subscriptions: [{ event: "event.update", connectionId: "conn_1" }],
        }),
      ],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).not.toHaveBeenCalled();
  });

  it("wakes a wait when the arrival is the Connection it named", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { data: "test" },
      connectionId: "conn_1",
      waitStates: [
        createWaitState("1", "exec_1", {
          subscriptions: [{ event: "event.update", connectionId: "conn_1" }],
        }),
      ],
    });

    expect(result).toBe(1);
    expect(resolveParkMock).toHaveBeenCalledTimes(1);
  });

  // A row with no token can never be woken by an Event, so it is a defect in
  // whatever wrote it.
  it("skips wait states without a resume token", async () => {
    const recorder = makeRecordingLogger();

    const result = await resumeWaits(
      {
        workflowId: "workflow_1",
        eventType: "event.update",
        payload: { data: "test" },
        waitStates: [
          createWaitState("1", "exec_1", { resumeToken: null }),
          createWaitState("2", "exec_2", { resumeToken: null }),
        ],
      },
      recorder.layer
    );

    expect(result).toBe(0);
    expect(resolveParkMock).not.toHaveBeenCalled();
    expect(recorder.warnLines).toHaveLength(2);
    expect(recorder.warnLines[0]).toEqual({
      message: "Parked wait carries no resume token",
      properties: expect.objectContaining({
        waitStateId: "1",
        executionId: "exec_1",
      }),
    });
  });

  it("resumes a match-free subscription on the next occurrence", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { key: "value" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(1);
    // One write claims the park and resolves it with the arrival.
    expect(resolveParkMock).toHaveBeenCalledExactlyOnceWith({
      target: {
        kind: "wait_state",
        waitStateId: "1",
        token: "token_1",
        eventName: "event.update",
      },
      payload: { key: "value" },
    });
  });

  it("resumes multiple wait states and returns total count", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1"),
        createWaitState("2", "exec_2"),
        createWaitState("3", "exec_3"),
      ],
    });

    expect(result).toBe(3);
    expect(resolveParkMock).toHaveBeenCalledTimes(3);
  });

  it("wakes nothing for a row whose metadata holds no subscriptions", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        { ...createWaitState("1", "exec_1"), metadata: null },
        { ...createWaitState("2", "exec_2"), metadata: {} },
      ],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).not.toHaveBeenCalled();
  });

  // A candidate row reached the matcher because its own `subscribed_events`
  // named this Event, so a `waitFor` that will not decode is a row this engine
  // wrote and cannot read. Silently, it looks exactly like an ordinary no-match.
  it("says so when a parked row's subscriptions will not decode", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        {
          ...createWaitState("1", "exec_1"),
          metadata: { waitFor: "not a list of subscriptions" },
        },
      ],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Parked wait holds subscriptions that will not decode"
    );
  });

  it("returns 0 for a wait state when the wait row had already moved on", async () => {
    resolveParkMock.mockImplementation(() => Effect.succeed(null));

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads and resumes the same still-matching Wait after its token rotates", async () => {
    resolveParkMock.mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock.mockImplementationOnce(() =>
      Effect.succeed(
        createPersistedWaitState("1", "exec_1", {
          resumeToken: "token_1_v2",
        })
      )
    );

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { key: "value" },
      waitStates: [
        createWaitState("1", "exec_1", { resumeToken: "token_1_v1" }),
      ],
    });

    expect(result).toBe(1);
    expect(findWaitStateByIdMock).toHaveBeenCalledExactlyOnceWith("1");
    expect(
      resolveParkMock.mock.calls.map(([claim]) => claim.target.token)
    ).toEqual(["token_1_v1", "token_1_v2"]);
  });

  it("revalidates the current Event subscription before refreshing a token", async () => {
    resolveParkMock.mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock.mockImplementationOnce(() =>
      Effect.succeed(
        createPersistedWaitState("1", "exec_1", {
          resumeToken: "token_1_v2",
          subscriptions: [{ event: "event.other" }],
        })
      )
    );

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1", { resumeToken: "token_1_v1" }),
      ],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).toHaveBeenCalledTimes(1);
  });

  it("revalidates the current Connection before refreshing a token", async () => {
    resolveParkMock.mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock.mockImplementationOnce(() =>
      Effect.succeed(
        createPersistedWaitState("1", "exec_1", {
          resumeToken: "token_1_v2",
          subscriptions: [
            { event: "event.update", connectionId: "connection_b" },
          ],
        })
      )
    );

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      connectionId: "connection_a",
      waitStates: [
        createWaitState("1", "exec_1", {
          resumeToken: "token_1_v1",
          subscriptions: [
            { event: "event.update", connectionId: "connection_a" },
          ],
        }),
      ],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).toHaveBeenCalledTimes(1);
  });

  it("revalidates the current payload filter before refreshing a token", async () => {
    const oldSubscription = {
      event: "event.update",
      match: { expression: 'payload.account == "old"', timestampPaths: [] },
    };
    resolveParkMock.mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock.mockImplementationOnce(() =>
      Effect.succeed(
        createPersistedWaitState("1", "exec_1", {
          resumeToken: "token_1_v2",
          subscriptions: [
            {
              event: "event.update",
              match: {
                expression: 'payload.account == "new"',
                timestampPaths: [],
              },
            },
          ],
        })
      )
    );

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { account: "old" },
      waitStates: [
        createWaitState("1", "exec_1", {
          resumeToken: "token_1_v1",
          subscriptions: [oldSubscription],
        }),
      ],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying only the same Wait across more than three token rotations", async () => {
    resolveParkMock
      .mockImplementationOnce(() => Effect.succeed(null))
      .mockImplementationOnce(() => Effect.succeed(null))
      .mockImplementationOnce(() => Effect.succeed(null))
      .mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock
      .mockImplementationOnce(() =>
        Effect.succeed(
          createPersistedWaitState("1", "exec_1", {
            resumeToken: "token_1_v2",
          })
        )
      )
      .mockImplementationOnce(() =>
        Effect.succeed(
          createPersistedWaitState("1", "exec_1", {
            resumeToken: "token_1_v3",
          })
        )
      )
      .mockImplementationOnce(() =>
        Effect.succeed(
          createPersistedWaitState("1", "exec_1", {
            resumeToken: "token_1_v4",
          })
        )
      )
      .mockImplementationOnce(() =>
        Effect.succeed(
          createPersistedWaitState("1", "exec_1", {
            resumeToken: "token_1_v5",
          })
        )
      );

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1", { resumeToken: "token_1_v1" }),
      ],
    });

    expect(result).toBe(1);
    expect(findWaitStateByIdMock.mock.calls).toEqual([
      ["1"],
      ["1"],
      ["1"],
      ["1"],
    ]);
    expect(
      resolveParkMock.mock.calls.map(([claim]) => claim.target.token)
    ).toEqual([
      "token_1_v1",
      "token_1_v2",
      "token_1_v3",
      "token_1_v4",
      "token_1_v5",
    ]);
  });

  it("does not refresh a row a resume already woke when the delivery has no id", async () => {
    resolveParkMock.mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock.mockImplementationOnce(() =>
      Effect.succeed(
        createPersistedWaitState("1", "exec_1", {
          resumeToken: "token_1_v2",
          status: "resuming",
        })
      )
    );
    findParkMock.mockImplementationOnce(() => resumedPark("1", "exec_1", null));

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { later: true },
      waitStates: [
        createWaitState("1", "exec_1", { resumeToken: "token_1_v1" }),
      ],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).toHaveBeenCalledTimes(1);
  });

  it("retries its own recorded resume wake after token rotation", async () => {
    const deliveryId = "delivery_1";
    resolveParkMock.mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock.mockImplementationOnce(() =>
      Effect.succeed(
        createPersistedWaitState("1", "exec_1", {
          resumeToken: "token_1_v2",
          status: "resuming",
        })
      )
    );
    findParkMock.mockImplementationOnce(() =>
      resumedPark("1", "exec_1", deliveryId)
    );

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { key: "value" },
      waitStates: [
        createWaitState("1", "exec_1", { resumeToken: "token_1_v1" }),
      ],
      deliveryId,
    });

    expect(result).toBe(1);
    expect(resolveParkMock).toHaveBeenCalledTimes(2);
    expect(resolveParkMock.mock.calls[1]?.[0]).toMatchObject({
      target: {
        waitStateId: "1",
        token: "token_1_v2",
        eventName: "event.update",
        deliveryId,
      },
      payload: { key: "value" },
    });
  });

  it("does not replace a resume wake owned by a different Event delivery", async () => {
    resolveParkMock.mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock.mockImplementationOnce(() =>
      Effect.succeed(
        createPersistedWaitState("1", "exec_1", {
          resumeToken: "token_1_v2",
          status: "resuming",
        })
      )
    );
    findParkMock.mockImplementationOnce(() =>
      resumedPark("1", "exec_1", "delivery_older")
    );

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { key: "value" },
      waitStates: [
        createWaitState("1", "exec_1", { resumeToken: "token_1_v1" }),
      ],
      deliveryId: "delivery_current",
    });

    expect(result).toBe(0);
    expect(resolveParkMock).toHaveBeenCalledTimes(1);
  });

  it("does not bypass a termination claim when the refreshed token is unclaimable", async () => {
    const current = createPersistedWaitState("1", "exec_1", {
      resumeToken: "token_1_v2",
    });
    resolveParkMock
      .mockImplementationOnce(() => Effect.succeed(null))
      .mockImplementationOnce(() => Effect.succeed(null));
    findWaitStateByIdMock
      .mockImplementationOnce(() => Effect.succeed(current))
      .mockImplementationOnce(() => Effect.succeed(current));

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1", { resumeToken: "token_1_v1" }),
      ],
    });

    expect(result).toBe(0);
    expect(resolveParkMock).toHaveBeenCalledTimes(2);
    expect(findWaitStateByIdMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a transient database failure while claiming a wait", async () => {
    resolveParkMock.mockImplementationOnce(() =>
      Effect.fail(new DriverError({ cause: new Error("connection reset") }))
    );

    const failure = await resumeWaits(
      {
        workflowId: "workflow_1",
        eventType: "event.update",
        payload: {},
        waitStates: [createWaitState("1", "exec_1")],
      },
      SilentAppLoggerLayer
    ).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(DriverError);
  });

  it("propagates failed resumes after attempting every candidate", async () => {
    resolveParkMock
      .mockImplementationOnce(claimedPark)
      .mockImplementationOnce(() =>
        Effect.fail(new DriverError({ cause: "claim refused" }))
      )
      .mockImplementationOnce(claimedPark);

    const failure = await Effect.runPromise(
      resumeWaitsMatchingEvent({
        workflowId: "workflow_1",
        eventType: "event.update",
        payload: {},
        waitStates: [
          createWaitState("1", "exec_1"),
          createWaitState("2", "exec_2"),
          createWaitState("3", "exec_3"),
        ],
      }).pipe(Effect.provide(Layer.mergeAll(services, SilentAppLoggerLayer)))
    ).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(DriverError);
    expect(resolveParkMock).toHaveBeenCalledTimes(3);
  });

  describe("the stored match decides", () => {
    // The owner's case: a run started by one Event, parked on a different one,
    // woken by the arrival whose payload names this run's entity and by no other.
    it("wakes the run whose match the payload satisfies, and no other", async () => {
      const parkedOn = (appointmentId: string) => ({
        event: "billing/payment.settled",
        match: {
          expression: `payload.appointmentId == "${appointmentId}"`,
          timestampPaths: [],
        },
      });

      const result = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { appointmentId: "appt_8813", amountCents: 4200 },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [parkedOn("appt_8813")],
          }),
          createWaitState("2", "exec_2", {
            subscriptions: [parkedOn("appt_0001")],
          }),
        ],
      });

      expect(result).toBe(1);
      expect(resolveParkMock).toHaveBeenCalledTimes(1);
      expect(resolveParkMock.mock.calls[0]?.[0].target).toMatchObject({
        waitStateId: "1",
      });
    });

    // A rejection that wrote nothing leaves an operator with a count of zero
    // and no way to tell it from a row the candidate query never returned.
    it("wakes nothing when no arriving payload satisfies the match", async () => {
      const recorder = makeRecordingLogger();

      const result = await resumeWaits(
        {
          workflowId: "workflow_1",
          eventType: "billing/payment.settled",
          payload: { appointmentId: "appt_nobody_waits_for" },
          waitStates: [
            createWaitState("1", "exec_1", {
              subscriptions: [
                {
                  event: "billing/payment.settled",
                  match: {
                    expression: 'payload.appointmentId == "appt_8813"',
                    timestampPaths: [],
                  },
                },
              ],
            }),
          ],
        },
        recorder.layer
      );

      expect(result).toBe(0);
      expect(resolveParkMock).not.toHaveBeenCalled();
      expect(recorder.debugLines).toHaveLength(1);
      expect(recorder.debugLines[0]?.message).toBe(
        "Wait match rejected an arrival"
      );
    });

    // A free-entered Event the catalog never heard of parks and wakes the same
    // way: the name and the match are all resume matching ever reads.
    it("wakes on an undeclared Event name with a match", async () => {
      const result = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "vendor/never.declared",
        payload: { ref: "abc" },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "vendor/never.declared",
                match: {
                  expression: 'payload.ref == "abc"',
                  timestampPaths: [],
                },
              },
            ],
          }),
        ],
      });

      expect(result).toBe(1);
    });

    // A payload delivers a timestamp as an ISO string, and CEL has no overload
    // comparing a string to an instant, so the paths the model marked travel
    // beside the expression and are decoded before it runs.
    it("compares a timestamp field the model marked", async () => {
      const subscriptions = [
        {
          event: "billing/payment.settled",
          match: {
            expression: 'payload.settledAt < date("2026-07-01T00:00:00.000Z")',
            timestampPaths: ["settledAt"],
          },
        },
      ];

      const before = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { settledAt: "2026-06-30T12:00:00.000Z" },
        waitStates: [createWaitState("1", "exec_1", { subscriptions })],
      });
      expect(before).toBe(1);

      vi.clearAllMocks();

      const after = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { settledAt: "2026-07-02T12:00:00.000Z" },
        waitStates: [createWaitState("2", "exec_2", { subscriptions })],
      });
      expect(after).toBe(0);
    });

    // The timestamp decode writes a `Date` into whatever object holds the path,
    // so it runs against a copy. Sharing it would leave the second wait comparing
    // a `Date` where its own match, and every downstream template, expects the
    // ISO string the sender wrote.
    it("leaves the arriving payload as the sender wrote it", async () => {
      const payload = { settledAt: "2026-06-30T12:00:00.000Z" };

      const woken = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload,
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "billing/payment.settled",
                match: {
                  expression:
                    'payload.settledAt < date("2026-07-01T00:00:00.000Z")',
                  timestampPaths: ["settledAt"],
                },
              },
            ],
          }),
          createWaitState("2", "exec_2", {
            subscriptions: [
              {
                event: "billing/payment.settled",
                match: {
                  expression: 'payload.settledAt == "2026-06-30T12:00:00.000Z"',
                  timestampPaths: [],
                },
              },
            ],
          }),
        ],
      });

      expect(woken).toBe(2);
      expect(payload.settledAt).toBe("2026-06-30T12:00:00.000Z");
    });

    // The payload arrived from outside and may carry anything, so a field of the
    // wrong shape is a payload that does not satisfy the match.
    it("does not wake a run when the match fails to evaluate", async () => {
      const result = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { appointmentId: { nested: "object" } },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "billing/payment.settled",
                match: {
                  expression: 'payload.appointmentId.contains("appt")',
                  timestampPaths: [],
                },
              },
            ],
          }),
        ],
      });

      expect(result).toBe(0);
      expect(resolveParkMock).not.toHaveBeenCalled();
    });

    it("reads only the subscriptions naming the arriving Event", async () => {
      const result = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "app/appointment.confirmed",
        payload: { id: "no" },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "app/appointment.confirmed",
                match: {
                  expression: 'payload.id == "yes"',
                  timestampPaths: [],
                },
              },
              // Satisfied by this payload, and irrelevant: a different Event.
              { event: "app/appointment.canceled" },
            ],
          }),
        ],
      });

      expect(result).toBe(0);
    });
  });
});
