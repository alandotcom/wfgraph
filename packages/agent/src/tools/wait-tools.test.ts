import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { formatTemplateToken } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const lifecycle: WorkflowNode = {
  id: "entry",
  type: "lifecycle",
  position: { x: 0, y: 0 },
  data: { label: "Lifecycle", type: "lifecycle", config: {} },
};

const wait: WorkflowNode = {
  id: "wait",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Wait for reply",
    type: "action",
    config: {
      actionType: BUILT_IN_ACTION_IDS.wait,
      custom: "kept",
    },
  },
};

const documentInput = {
  nodes: [lifecycle, wait],
  edges: [
    {
      id: "entry-wait",
      source: "entry",
      target: "wait",
      sourceHandle: "started",
    },
  ],
  catalog: fixtureCatalog,
};

const timestampCatalog = {
  ...fixtureCatalog,
  events: fixtureCatalog.events.map((event) =>
    event.name === "applicant.created"
      ? {
          ...event,
          payloadFields: [
            ...event.payloadFields,
            { path: "interviewAt", type: "timestamp" as const },
          ],
        }
      : event
  ),
};

const eventLifecycle: WorkflowNode = {
  ...lifecycle,
  data: {
    ...lifecycle.data,
    config: {
      lifecycleRules: {
        startEvents: ["applicant.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: false,
      },
    },
  },
};

describe("set_wait", () => {
  it.effect("writes a canonical delay and clears stale Event settings", () =>
    Effect.gen(function* () {
      const staleWait: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: {
            ...wait.data.config,
            waitMode: "event",
            waitFor: [{ event: "applicant.withdrawn" }],
            waitTimeout: "7d",
            waitTimeoutBehavior: "skip",
          },
        },
      };
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, staleWait],
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: { mode: "duration", duration: "2d" },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
        actionType: BUILT_IN_ACTION_IDS.wait,
        custom: "kept",
        waitMode: "delay",
        waitDuration: "2d",
      });
    })
  );

  it.effect("waits until an upstream timestamp with a relative offset", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
        catalog: timestampCatalog,
      });
      const until = formatTemplateToken({
        nodeId: "entry",
        nodeLabel: "Lifecycle",
        fieldPath: "interviewAt",
      });

      yield* tools.set_wait({
        nodeId: "wait",
        wait: { mode: "until", timestamp: until, offset: "-1d" },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
        actionType: BUILT_IN_ACTION_IDS.wait,
        custom: "kept",
        waitMode: "delay",
        waitDelayTimingMode: "until",
        waitUntil: until,
        waitOffset: "-1d",
      });
    })
  );

  it.effect("refuses a non-timestamp reference for wait-until timing", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
      });
      const applicantId = formatTemplateToken({
        nodeId: "entry",
        nodeLabel: "Lifecycle",
        fieldPath: "applicantId",
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "until",
            timestamp: applicantId,
            offset: "-1d",
          },
        })
      );

      expect(failure.reason).toContain("timestamp");
      expect(failure.reason).toContain("list_references");
    })
  );

  it.effect("refuses an unreachable timestamp reference", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        ...documentInput,
        nodes: [eventLifecycle, wait],
        edges: [],
        catalog: timestampCatalog,
      });
      const interviewAt = formatTemplateToken({
        nodeId: "entry",
        nodeLabel: "Lifecycle",
        fieldPath: "interviewAt",
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "until", timestamp: interviewAt },
        })
      );

      expect(failure.reason).toContain("timestamp token");
      expect(failure.reason).toContain("list_references");
    })
  );

  it.effect("writes Event subscriptions with the safe timeout defaults", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [{ event: "applicant.withdrawn" }],
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toEqual({
        actionType: BUILT_IN_ACTION_IDS.wait,
        custom: "kept",
        waitMode: "event",
        waitFor: [{ event: "applicant.withdrawn" }],
        waitTimeout: "7d",
        waitTimeoutBehavior: "continue",
      });
    })
  );

  it.effect("writes an explicit timeout and timeout behavior", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor(documentInput);

      yield* tools.set_wait({
        nodeId: "wait",
        wait: {
          mode: "event",
          events: [{ event: "applicant.withdrawn" }],
          timeout: "30d",
          timeoutBehavior: "skip",
        },
      });

      expect((yield* draft.current).nodes[1]?.data.config).toMatchObject({
        waitTimeout: "30d",
        waitTimeoutBehavior: "skip",
      });
    })
  );

  it.effect("refuses an empty Event subscription list", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(documentInput);

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "event", events: [] },
        })
      );

      expect(failure.reason).toContain("at least one Event");
    })
  );

  it.effect("refuses an Event absent from the host catalog", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(documentInput);

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "event", events: [{ event: "invoice.paid" }] },
        })
      );

      expect(failure.reason).toContain("list_events");
    })
  );

  it.effect("refuses a node that is not a Wait step", () =>
    Effect.gen(function* () {
      const action: WorkflowNode = {
        ...wait,
        data: {
          ...wait.data,
          config: { actionType: "score-applicant" },
        },
      };
      const { tools } = yield* agentToolsFor({
        ...documentInput,
        nodes: [lifecycle, action],
      });

      const failure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "duration", duration: "2d" },
        })
      );

      expect(failure.reason).toContain("not a Wait step");
    })
  );

  it.effect("refuses malformed delay and timeout durations", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(documentInput);

      const delayFailure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: { mode: "duration", duration: "later" },
        })
      );
      const timeoutFailure = yield* Effect.flip(
        tools.set_wait({
          nodeId: "wait",
          wait: {
            mode: "event",
            events: [{ event: "applicant.withdrawn" }],
            timeout: "eventually",
          },
        })
      );

      expect(delayFailure.reason).toContain("valid duration");
      expect(timeoutFailure.reason).toContain("valid duration");
    })
  );
});
