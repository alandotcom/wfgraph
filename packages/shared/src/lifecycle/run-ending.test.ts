import { describe, expect, it } from "vitest";
import {
  decideRunEnd,
  type RunEndDecision,
  type RunEndRow,
  type RunEnding,
} from "#src/lifecycle/run-ending";

const exitClaim = {
  kind: "exit",
  reason: "entity_condition_not_met",
  nodeId: "send-reminder",
  requestedAt: "2026-10-19T15:00:00.000Z",
} as const;

const exitContext = {
  entityType: "appointment",
  conditionId: "condition_1",
} as const;

const EXIT_FIELDS = {
  reason: "entity_condition_not_met",
  entityType: "appointment",
  conditionId: "condition_1",
  nodeId: "send-reminder",
  checkedAt: "2026-10-19T15:00:00.000Z",
  checkpoint: "before-node",
} as const;

const fatal = {
  kind: "fatal",
  error: "node exploded",
  failureKind: "failure",
} as const;

const unclaimed: RunEndRow = {
  status: "running",
  claim: null,
  runMode: "live",
};
const cancelClaimed: RunEndRow = {
  status: "running",
  claim: { kind: "cancel" },
  runMode: "live",
};
const exitClaimed: RunEndRow = {
  status: "running",
  claim: exitClaim,
  runMode: "live",
};

const CASES: ReadonlyArray<{
  name: string;
  ending: RunEnding;
  row: RunEndRow;
  decision: RunEndDecision;
}> = [
  {
    name: "keeps a fatal verdict's error on the row when the verdict lands",
    ending: { kind: "verdict", status: "failed", reached: fatal },
    row: unclaimed,
    decision: {
      kind: "write",
      status: "failed",
      error: "node exploded",
      entry: {
        eventType: "run_failed",
        message: "Run failed with fatal error",
        metadata: {
          error: "node exploded",
          failureKind: "failure",
          runMode: "live",
        },
      },
    },
  },
  {
    name: "ends exited, with the Exit entry, a completed verdict that meets an Exit claim",
    ending: {
      kind: "verdict",
      status: "completed",
      exitContext,
      reached: { kind: "walked", resultCount: 1 },
    },
    row: exitClaimed,
    decision: {
      kind: "write",
      status: "exited",
      error: undefined,
      entry: {
        eventType: "run_exited",
        message: "Run exited because the Entity was ineligible",
        metadata: { resultCount: 1, runMode: "live", ...EXIT_FIELDS },
      },
    },
  },
  {
    name: "keeps no error on a fatal verdict an Exit claim ended in its place",
    ending: { kind: "verdict", status: "failed", exitContext, reached: fatal },
    row: exitClaimed,
    decision: {
      kind: "write",
      status: "exited",
      error: undefined,
      entry: {
        eventType: "run_exited",
        message: "Run exited because the Entity was ineligible",
        metadata: { runMode: "live", ...EXIT_FIELDS },
      },
    },
  },
  {
    name: "keeps the verdict's fields on an Exit entry with no Entity Eligibility context",
    ending: { kind: "verdict", status: "failed", reached: fatal },
    row: exitClaimed,
    decision: {
      kind: "write",
      status: "exited",
      error: undefined,
      entry: {
        eventType: "run_exited",
        message: "Run exited because the Entity was ineligible",
        metadata: {
          error: "node exploded",
          failureKind: "failure",
          runMode: "live",
        },
      },
    },
  },
  {
    name: "records canceled at the Canceled outlet a run that reached it on its own",
    ending: {
      kind: "verdict",
      status: "canceled",
      reached: { kind: "walked", resultCount: 2 },
    },
    row: cancelClaimed,
    decision: {
      kind: "write",
      status: "canceled",
      error: undefined,
      entry: {
        eventType: "run_cancelled",
        message: "Run canceled at the Canceled outlet",
        metadata: { resultCount: 2, runMode: "live" },
      },
    },
  },
  {
    name: "records a fatal run that had entered the Canceled outlet as canceled there",
    ending: {
      kind: "verdict",
      status: "canceled",
      reached: { ...fatal, canceledOutlet: "entered" },
    },
    row: cancelClaimed,
    decision: {
      kind: "write",
      status: "canceled",
      error: "node exploded",
      entry: {
        eventType: "run_cancelled",
        message:
          "Run canceled at the Canceled outlet, then ended on a fatal error",
        metadata: {
          error: "node exploded",
          failureKind: "failure",
          runMode: "live",
          canceledOutlet: "entered",
        },
      },
    },
  },
  {
    name: "records canceled after a fatal error once the outlet ran for the claim",
    ending: {
      kind: "verdict",
      status: "canceled",
      reached: { ...fatal, canceledOutlet: "ran" },
    },
    row: cancelClaimed,
    decision: {
      kind: "write",
      status: "canceled",
      error: "node exploded",
      entry: {
        eventType: "run_cancelled",
        message: "Run canceled at the Canceled outlet after a fatal error",
        metadata: {
          error: "node exploded",
          failureKind: "failure",
          runMode: "live",
          canceledOutlet: "ran",
        },
      },
    },
  },
  {
    name: "says the Canceled outlet failed after a fatal error",
    ending: {
      kind: "verdict",
      status: "canceled",
      reached: { ...fatal, canceledOutlet: "failed" },
    },
    row: cancelClaimed,
    decision: {
      kind: "write",
      status: "canceled",
      error: "node exploded",
      entry: {
        eventType: "run_cancelled",
        message: "Run canceled after a fatal error; the Canceled outlet failed",
        metadata: {
          error: "node exploded",
          failureKind: "failure",
          runMode: "live",
          canceledOutlet: "failed",
        },
      },
    },
  },
  {
    name: "leaves a completed verdict that meets a Cancel claim",
    ending: {
      kind: "verdict",
      status: "completed",
      reached: { kind: "walked", resultCount: 1 },
    },
    row: cancelClaimed,
    decision: { kind: "leave" },
  },
  {
    name: "names the test recipients of a test run ended outside its graph",
    ending: { kind: "outsideGraph", error: "version gone" },
    row: { status: "waiting", claim: null, runMode: "test" },
    decision: {
      kind: "write",
      status: "failed",
      error: "version gone",
      entry: {
        eventType: "run_failed",
        message: "Run failed with fatal error (test recipients)",
        metadata: {
          error: "version gone",
          failureKind: "failure",
          runMode: "test",
        },
      },
    },
  },
  {
    name: "names the Event that started the newer run in a supersede",
    ending: { kind: "supersede", startEventName: "appointment/rescheduled" },
    row: unclaimed,
    decision: {
      kind: "write",
      status: "superseded",
      error: "Superseded by a newer start from appointment/rescheduled",
      entry: {
        eventType: "run_superseded",
        message: "Superseded by a newer start from appointment/rescheduled",
        metadata: { eventName: "appointment/rescheduled" },
      },
    },
  },
];

describe("decideRunEnd", () => {
  for (const { name, ending, row, decision } of CASES) {
    it(name, () => {
      expect(decideRunEnd(ending, row)).toEqual(decision);
    });
  }
});
