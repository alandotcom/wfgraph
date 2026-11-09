import { describe, expect, it } from "vitest";
import { decideRunEnd, type RunVerdict } from "#src/lifecycle/run-ending";

const exitClaim = {
  kind: "exit",
  reason: "entity_condition_not_met",
  nodeId: "check",
  requestedAt: "2026-10-19T15:00:00.000Z",
} as const;

const failedVerdict: RunVerdict = {
  kind: "verdict",
  status: "failed",
  reached: { kind: "fatal", error: "node exploded", failureKind: "failure" },
};

describe("decideRunEnd", () => {
  it("keeps a verdict's error on the row when the verdict lands", () => {
    expect(
      decideRunEnd(failedVerdict, {
        status: "running",
        claim: null,
        runMode: "live",
      })
    ).toMatchObject({
      kind: "write",
      status: "failed",
      error: "node exploded",
    });
  });

  it("keeps no error on a run an Exit claim ended in place of the verdict", () => {
    expect(
      decideRunEnd(failedVerdict, {
        status: "running",
        claim: exitClaim,
        runMode: "live",
      })
    ).toMatchObject({ kind: "write", status: "exited", error: undefined });
  });

  it("names the test recipients of a test run ended outside its graph", () => {
    expect(
      decideRunEnd(
        { kind: "outsideGraph", error: "version gone" },
        { status: "waiting", claim: null, runMode: "test" }
      )
    ).toMatchObject({
      kind: "write",
      status: "failed",
      entry: {
        eventType: "run_failed",
        message: "Run failed with fatal error (test recipients)",
      },
    });
  });

  it("names the Event that started the newer run in a supersede", () => {
    expect(
      decideRunEnd(
        { kind: "supersede", startEventName: "appointment/rescheduled" },
        { status: "running", claim: null, runMode: "live" }
      )
    ).toEqual({
      kind: "write",
      status: "superseded",
      output: undefined,
      error: "Superseded by a newer start from appointment/rescheduled",
      entry: {
        eventType: "run_superseded",
        message: "Superseded by a newer start from appointment/rescheduled",
        metadata: { eventName: "appointment/rescheduled" },
      },
    });
  });
});
