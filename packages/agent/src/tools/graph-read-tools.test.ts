import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const catalog = fixtureCatalog;

const lifecycle: WorkflowNode = {
  id: "entry",
  position: { x: 0, y: 0 },
  type: "lifecycle",
  data: {
    label: "Lifecycle",
    type: "lifecycle",
    config: {
      lifecycleRules: {
        ...emptyLifecycleRules,
        startEvents: ["applicant.created"],
      },
    },
  },
};

const slackNode: WorkflowNode = {
  id: "notify",
  position: { x: 0, y: 160 },
  type: "action",
  data: {
    label: "Notify the team",
    description: "Tell #hiring about the applicant.",
    type: "action",
    enabled: true,
    config: {
      actionType: "slack/send-message",
      integrationId: "conn-1",
      channel: "#hiring",
      text: "New applicant",
    },
  },
};

const entryToSlack: WorkflowEdge = {
  id: "entry->notify",
  source: "entry",
  target: "notify",
  sourceHandle: "started",
};

describe("read_workflow", () => {
  it.effect("answers compact topology without positions or config", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [entryToSlack],
        catalog,
      });
      const result = yield* tools.read_workflow({});

      expect(result.nodes).toEqual([
        {
          id: "entry",
          label: "Lifecycle",
          type: "lifecycle",
        },
        {
          id: "notify",
          label: "Notify the team",
          type: "action",
          actionType: "slack/send-message",
          description: "Tell #hiring about the applicant.",
        },
      ]);
      expect(result.edges).toEqual([
        {
          id: "entry->notify",
          source: "entry",
          target: "notify",
          sourceHandle: "started",
        },
      ]);
    })
  );

  it.effect("pages large graph topology", () =>
    Effect.gen(function* () {
      const nodes = Array.from({ length: 25 }, (_, index): WorkflowNode => ({
        ...slackNode,
        id: `node-${index}`,
        data: { ...slackNode.data, label: `Node ${index}` },
      }));
      const { tools } = yield* agentToolsFor({
        nodes,
        edges: [],
        catalog,
      });
      const defaultPage = yield* tools.read_workflow({});
      const result = yield* tools.read_workflow({ nodeOffset: 3, limit: 2 });

      expect(defaultPage.nodes).toHaveLength(20);
      expect(defaultPage.nextNodeOffset).toBe(20);
      expect(result.nodes.map((node) => node.id)).toEqual(["node-3", "node-4"]);
      expect(result.totalNodes).toBe(25);
      expect(result.nextNodeOffset).toBe(5);
    })
  );

  it.effect("leaves sourceHandle off an edge that names none", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [{ id: "plain", source: "entry", target: "notify" }],
        catalog,
      });
      const result = yield* tools.read_workflow({});

      expect(result.edges[0]).toEqual({
        id: "plain",
        source: "entry",
        target: "notify",
      });
    })
  );

  it.effect("answers an empty graph rather than refusing", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* tools.read_workflow({});

      expect(result).toEqual({
        nodes: [],
        edges: [],
        totalNodes: 0,
        totalEdges: 0,
      });
    })
  );
});

describe("read_nodes", () => {
  it.effect("returns full config for selected nodes", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [entryToSlack],
        catalog,
      });

      const result = yield* tools.read_nodes({ nodeIds: ["notify"] });

      expect(result.nodes).toEqual([
        {
          id: "notify",
          label: "Notify the team",
          type: "action",
          actionType: "slack/send-message",
          description: "Tell #hiring about the applicant.",
          config: {
            actionType: "slack/send-message",
            integrationId: "conn-1",
            channel: "#hiring",
            text: "New applicant",
          },
        },
      ]);
    })
  );

  it.effect("refuses an unknown requested node", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [lifecycle], catalog });

      const failure = yield* Effect.flip(
        tools.read_nodes({ nodeIds: ["missing"] })
      );

      expect(failure.reason).toContain("missing");
    })
  );
});

describe("validate_workflow", () => {
  it.effect("requires an explicit draft validation stub", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const result = yield* Effect.exit(tools.validate_workflow());

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = result.cause.reasons[0];
        expect(failure?._tag).toBe("Die");
        if (failure?._tag === "Die") {
          expect(failure.defect).toBeInstanceOf(Error);
          if (failure.defect instanceof Error) {
            expect(failure.defect.message).toBe(
              "agentToolsFor requires an explicit validateDraft stub for validate_workflow"
            );
          }
        }
      }
    })
  );

  it.effect("forwards the injected full draft validation unchanged", () =>
    Effect.gen(function* () {
      const validation = {
        draftValid: false,
        structuralIssues: ["Graph contains duplicate edge IDs"],
        publishBlockers: [
          {
            kind: "missing_integration",
            message: "Connect Slack before publication.",
          },
        ],
        warnings: [
          {
            kind: "broken_reference",
            message: "A template refers to a deleted node.",
          },
        ],
      } as const;
      const { tools } = yield* agentToolsFor({
        catalog,
        validateDraft: () => validation,
      });

      expect(yield* tools.validate_workflow()).toBe(validation);
    })
  );
});
