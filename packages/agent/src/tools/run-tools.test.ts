import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { WorkflowOperationsService } from "#src/operations";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const entry: WorkflowNode = {
  id: "entry",
  position: { x: 0, y: 0 },
  type: "lifecycle",
  data: {
    label: "Lifecycle",
    type: "lifecycle",
    config: {
      lifecycleRules: {
        startEvents: [],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    },
  },
};

const failedRun = {
  runId: "run_1",
  status: "error",
  runMode: "test",
  startSource: "manual",
  error: "Slack refused the channel",
  startedAt: "2026-11-11T10:00:00.000Z",
};

function operations(
  overrides: Partial<WorkflowOperationsService>
): WorkflowOperationsService {
  const refuse = () => Effect.fail({ reason: "unexpected" });
  return {
    listRuns: refuse,
    readRun: refuse,
    startTestRun: refuse,
    fieldOptions: refuse,
    ...overrides,
  };
}

describe("read_run", () => {
  it.effect("reads the most recent run when no run is named", () =>
    Effect.gen(function* () {
      const read: string[] = [];
      const { tools } = yield* agentToolsFor({
        catalog: fixtureCatalog,
        operations: operations({
          listRuns: () => Effect.succeed({ runs: [failedRun], total: 1 }),
          readRun: ({ runId }) =>
            Effect.sync(() => {
              read.push(runId);
              return { ...failedRun, steps: [], waitingAt: [] };
            }),
        }),
      });

      const run = yield* tools.read_run({});

      expect(read).toEqual(["run_1"]);
      expect(run.error).toBe("Slack refused the channel");
    })
  );

  it.effect("says plainly when the workflow has never run", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        catalog: fixtureCatalog,
        operations: operations({
          listRuns: () => Effect.succeed({ runs: [], total: 0 }),
        }),
      });

      const failure = yield* Effect.flip(tools.read_run({}));

      expect(failure.reason).toContain("never run");
    })
  );
});

describe("start_test_run", () => {
  it.effect("passes the parsed payload and answers the run id", () =>
    Effect.gen(function* () {
      const started: unknown[] = [];
      const { tools } = yield* agentToolsFor({
        catalog: fixtureCatalog,
        operations: operations({
          startTestRun: (input) =>
            Effect.sync(() => {
              started.push(input);
              return { status: "started" as const, runId: "run_2" };
            }),
        }),
      });

      const result = yield* tools.start_test_run({
        payload: '{"applicantId":"a_1"}',
        eventName: "applicant.created",
      });

      expect(result).toEqual({ status: "started", runId: "run_2" });
      expect(started).toEqual([
        { payload: { applicantId: "a_1" }, eventName: "applicant.created" },
      ]);
    })
  );

  it.effect("refuses once the session has edited the unsaved draft", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [entry],
        catalog: fixtureCatalog,
        operations: operations({
          startTestRun: () =>
            Effect.succeed({ status: "started" as const, runId: "run_3" }),
        }),
      });

      yield* tools.add_node({
        actionId: "slack/send-message",
        label: "Notify",
      });
      const failure = yield* Effect.flip(
        tools.start_test_run({ payload: "{}" })
      );

      expect(failure.reason).toContain("later turn");
    })
  );

  it.effect("refuses payload text that is not one JSON object", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog: fixtureCatalog });

      const failure = yield* Effect.flip(
        tools.start_test_run({ payload: "[1, 2]" })
      );

      expect(failure.reason).toContain("JSON object");
    })
  );
});

describe("the run tools without host operations", () => {
  it.effect("refuse with a sentence rather than inventing an answer", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog: fixtureCatalog });

      const failure = yield* Effect.flip(tools.list_runs({}));

      expect(failure.reason).toContain("not available");
    })
  );
});
