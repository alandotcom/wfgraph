import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const catalog = fixtureCatalog;

function lifecycleNode(startEvents: string[]): WorkflowNode {
  return {
    id: "entry",
    position: { x: 0, y: 0 },
    type: "lifecycle",
    data: {
      label: "",
      type: "lifecycle",
      // Built from the real default so the fixture cannot drift out of the
      // shape `readLifecycleRules` decodes.
      config: { lifecycleRules: { ...emptyLifecycleRules, startEvents } },
    },
  };
}

const scoreNode: WorkflowNode = {
  id: "score",
  position: { x: 0, y: 160 },
  type: "action",
  data: {
    label: "Score applicant",
    type: "action",
    config: { actionType: "score-applicant" },
  },
};

const slackNode: WorkflowNode = {
  id: "notify",
  position: { x: 0, y: 320 },
  type: "action",
  data: {
    label: "Notify the team",
    type: "action",
    config: { actionType: "slack/send-message", integrationId: "conn-1" },
  },
};

const entryToScore: WorkflowEdge = {
  id: "e1",
  source: "entry",
  target: "score",
  sourceHandle: LIFECYCLE_STARTED_HANDLE,
};
const scoreToSlack: WorkflowEdge = {
  id: "e2",
  source: "score",
  target: "notify",
};

describe("list_references", () => {
  it.effect("hands back finished tokens rather than the parts", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycleNode(["applicant.created"]), scoreNode, slackNode],
        edges: [entryToScore, scoreToSlack],
        catalog,
      });
      const result = yield* tools.list_references({ nodeId: "notify" });

      expect(result.references).toContainEqual(
        expect.objectContaining({
          token: "{{@score:Score applicant.score}}",
          sourceNodeId: "score",
          path: "score",
          type: "number",
        })
      );
    })
  );

  it.effect("filters and limits reference results", () =>
    Effect.gen(function* () {
      const manyFields = Array.from({ length: 12 }, (_, index) => ({
        path: `field${index}`,
        type: "string" as const,
        description: `Generated field ${index}`,
      }));
      const largeCatalog: ExtensionCatalog = {
        ...catalog,
        events: [
          {
            name: "large.started",
            label: "Large started",
            payloadFields: manyFields,
          },
        ],
      };
      const largeLifecycle: WorkflowNode = {
        ...lifecycleNode([]),
        data: {
          ...lifecycleNode([]).data,
          config: {
            lifecycleRules: {
              startEvents: ["large.started"],
              cancelEvents: [],
              concurrency: "unlimited",
              allowManualStart: false,
            },
          },
        },
      };
      const largeEntryToNotify: WorkflowEdge = {
        id: "large-notify",
        source: "entry",
        target: "notify",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
      };
      const { tools } = yield* agentToolsFor({
        nodes: [largeLifecycle, slackNode],
        edges: [largeEntryToNotify],
        catalog: largeCatalog,
      });

      const result = yield* tools.list_references({
        nodeId: "notify",
        query: "field",
        limit: 3,
      });

      expect(result.references).toHaveLength(3);
      expect(result.totalMatches).toBe(12);
      expect(result.truncated).toBe(true);
    })
  );

  it.effect("identifies open-record fields and their value type", () =>
    Effect.gen(function* () {
      const catalogWithOpenRecord = {
        ...catalog,
        actions: catalog.actions.map((action) =>
          action.id === "score-applicant"
            ? {
                ...action,
                outputFields: [
                  ...action.outputFields,
                  {
                    path: "metadata",
                    type: "object" as const,
                    valueType: "string" as const,
                  },
                ],
              }
            : action
        ),
      };
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycleNode(["applicant.created"]), scoreNode, slackNode],
        edges: [entryToScore, scoreToSlack],
        catalog: catalogWithOpenRecord,
      });

      const result = yield* tools.list_references({ nodeId: "notify" });

      expect(result.references).toContainEqual(
        expect.objectContaining({
          path: "metadata",
          conditionFieldType: "string",
          openRecord: true,
        })
      );
    })
  );

  it.effect("offers the payload of the Events that could start the run", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycleNode(["applicant.created"]), scoreNode],
        edges: [entryToScore],
        catalog,
      });
      const result = yield* tools.list_references({ nodeId: "score" });

      // The Lifecycle Node carries no label of its own, so the token uses the
      // name the editor shows.
      expect(result.references.map((reference) => reference.token)).toEqual([
        "{{@entry:Lifecycle.applicantId}}",
        "{{@entry:Lifecycle.email}}",
        "{{@entry:Lifecycle.score}}",
      ]);
      expect(
        result.references.find((reference) => reference.path === "email")
          ?.description
      ).toBe("Contact address.");
    })
  );

  it.effect("marks a path only some starting Events declare as nullable", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [
          lifecycleNode(["applicant.created", "applicant.withdrawn"]),
          scoreNode,
        ],
        edges: [entryToScore],
        catalog,
      });
      const result = yield* tools.list_references({ nodeId: "score" });

      const applicantId = result.references.find(
        (reference) => reference.path === "applicantId"
      );
      const email = result.references.find(
        (reference) => reference.path === "email"
      );
      // Every starting Event declares applicantId; only one declares email.
      expect(applicantId?.nullable).toBeUndefined();
      expect(email?.nullable).toBe(true);
    })
  );

  it.effect("offers nothing from a node that is not upstream", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        // The Slack node sits below, so its output cannot be read here.
        nodes: [lifecycleNode(["applicant.created"]), scoreNode, slackNode],
        edges: [entryToScore, scoreToSlack],
        catalog,
      });
      const result = yield* tools.list_references({ nodeId: "score" });

      expect(
        result.references.some(
          (reference) => reference.sourceNodeId === "notify"
        )
      ).toBe(false);
    })
  );

  it.effect("offers nothing at all to a node nothing reaches", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycleNode(["applicant.created"]), scoreNode],
        catalog,
      });
      const result = yield* tools.list_references({ nodeId: "score" });

      expect(result.references).toEqual([]);
    })
  );

  it.effect("refuses a node id the graph does not hold", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [scoreNode], catalog });
      const failure = yield* Effect.flip(
        tools.list_references({ nodeId: "ghost" })
      );

      expect(failure.reason).toContain("ghost");
    })
  );
});

describe("list_references below an Event wait", () => {
  const eventWait: WorkflowNode = {
    id: "wait",
    position: { x: 0, y: 160 },
    type: "action",
    data: {
      label: "Wait for withdrawal",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitFor: [{ event: "applicant.withdrawn" }],
        waitTimeout: "7d",
        waitTimeoutBehavior: "continue",
      },
    },
  };

  const skippingWait: WorkflowNode = {
    ...eventWait,
    data: {
      ...eventWait.data,
      config: { ...eventWait.data.config, waitTimeoutBehavior: "skip" },
    },
  };

  const entryToWait: WorkflowEdge = {
    id: "e1",
    source: "entry",
    target: "wait",
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
  };
  const waitToSlack: WorkflowEdge = {
    id: "e2",
    source: "wait",
    target: "notify",
  };

  const belowTheWait = (wait: WorkflowNode) => ({
    nodes: [lifecycleNode(["applicant.created"]), wait, slackNode],
    edges: [entryToWait, waitToSlack],
    catalog,
  });

  it.effect("names the Events a Lifecycle Node path came from", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(belowTheWait(eventWait));
      const result = yield* tools.list_references({ nodeId: "notify" });

      expect(result.references).toContainEqual(
        expect.objectContaining({
          sourceNodeId: "entry",
          path: "applicantId",
          declaredBy: ["applicant.withdrawn"],
        })
      );
    })
  );

  it.effect("drops the Start Event payload the wait replaced", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(belowTheWait(eventWait));
      const result = yield* tools.list_references({ nodeId: "notify" });

      // `email` belongs to applicant.created alone, which no longer reaches here.
      expect(
        result.references.filter((reference) => reference.path === "email")
      ).toEqual([]);
    })
  );

  it.effect(
    "marks every Lifecycle field nullable when the wait continues",
    () =>
      Effect.gen(function* () {
        const { tools } = yield* agentToolsFor(belowTheWait(eventWait));
        const result = yield* tools.list_references({ nodeId: "notify" });

        expect(
          result.references.find(
            (reference) =>
              reference.sourceNodeId === "entry" &&
              reference.path === "applicantId"
          )?.nullable
        ).toBe(true);
      })
  );

  it.effect("leaves them as declared when the wait skips on timeout", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(belowTheWait(skippingWait));
      const result = yield* tools.list_references({ nodeId: "notify" });

      expect(
        result.references.find(
          (reference) =>
            reference.sourceNodeId === "entry" &&
            reference.path === "applicantId"
        )?.nullable
      ).toBeUndefined();
    })
  );

  it.effect("names the Start Events above the wait", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor(belowTheWait(eventWait));
      const result = yield* tools.list_references({ nodeId: "wait" });

      expect(result.references).toContainEqual(
        expect.objectContaining({
          path: "email",
          declaredBy: ["applicant.created"],
        })
      );
    })
  );
});
