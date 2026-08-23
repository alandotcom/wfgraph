import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
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
  it.effect("answers the graph without positions", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [entryToSlack],
        catalog,
      });
      const result = yield* tools.read_workflow();

      expect(result.nodes).toEqual([
        {
          id: "entry",
          label: "Lifecycle",
          type: "lifecycle",
          config: {
            lifecycleRules: {
              ...emptyLifecycleRules,
              startEvents: ["applicant.created"],
            },
          },
        },
        {
          id: "notify",
          label: "Notify the team",
          type: "action",
          actionType: "slack/send-message",
          description: "Tell #hiring about the applicant.",
          enabled: true,
          config: {
            actionType: "slack/send-message",
            integrationId: "conn-1",
            channel: "#hiring",
            text: "New applicant",
          },
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

  it.effect("drops config keys the operator cleared", () =>
    Effect.gen(function* () {
      const cleared: WorkflowNode = {
        ...slackNode,
        data: {
          ...slackNode.data,
          config: {
            actionType: "slack/send-message",
            integrationId: undefined,
            channel: "#hiring",
          },
        },
      };

      const { tools } = yield* agentToolsFor({
        nodes: [cleared],
        edges: [],
        catalog,
      });
      const result = yield* tools.read_workflow();

      expect(result.nodes[0]?.config).toEqual({
        actionType: "slack/send-message",
        channel: "#hiring",
      });
    })
  );

  it.effect("leaves sourceHandle off an edge that names none", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [{ id: "plain", source: "entry", target: "notify" }],
        catalog,
      });
      const result = yield* tools.read_workflow();

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
      const result = yield* tools.read_workflow();

      expect(result).toEqual({ nodes: [], edges: [] });
    })
  );
});

describe("validate_workflow", () => {
  it.effect("reports nothing for a workflow that is fully configured", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [entryToSlack],
        catalog,
        integrations: [{ id: "conn-1", type: "slack" }],
      });
      const result = yield* tools.validate_workflow();

      expect(result).toEqual({
        draftValid: true,
        structuralIssues: [],
        publishBlockers: [],
        warnings: [],
      });
    })
  );

  it.effect("blocks on an action whose integration is not connected", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, slackNode],
        edges: [entryToSlack],
        catalog,
        integrations: [],
      });
      const result = yield* tools.validate_workflow();

      expect(result.draftValid).toBe(true);
      expect(result.structuralIssues).toEqual([]);
      expect(result.publishBlockers).toContainEqual(
        expect.objectContaining({
          kind: "missing_integration",
          severity: "blocking",
          nodeId: "notify",
        })
      );
    })
  );

  it.effect("blocks on a join across mutually exclusive Condition paths", () =>
    Effect.gen(function* () {
      const condition: WorkflowNode = {
        id: "condition",
        position: { x: 0, y: 0 },
        type: "action",
        data: {
          label: "Is Jerry?",
          type: "action",
          config: { actionType: "Condition" },
        },
      };
      const linear: WorkflowNode = {
        ...slackNode,
        id: "linear",
        data: {
          ...slackNode.data,
          label: "Create Linear ticket",
          config: { actionType: "linear/create-issue" },
        },
      };
      const edges: WorkflowEdge[] = [
        {
          id: "entry-condition",
          source: "entry",
          target: "condition",
          sourceHandle: "started",
        },
        {
          id: "condition-true",
          source: "condition",
          target: "notify",
          sourceHandle: "true",
        },
        {
          id: "condition-false",
          source: "condition",
          target: "linear",
          sourceHandle: "false",
        },
        { id: "notify-linear", source: "notify", target: "linear" },
      ];
      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, condition, slackNode, linear],
        edges,
        catalog,
      });

      const result = yield* tools.validate_workflow();

      expect(result.draftValid).toBe(false);
      expect(result.structuralIssues[0]).toContain(
        "mutually exclusive branches"
      );
    })
  );

  it.effect("blocks on a required field the config leaves empty", () =>
    Effect.gen(function* () {
      const missingText: WorkflowNode = {
        ...slackNode,
        data: {
          ...slackNode.data,
          config: {
            actionType: "slack/send-message",
            integrationId: "conn-1",
            channel: "#hiring",
          },
        },
      };

      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, missingText],
        edges: [entryToSlack],
        catalog,
        integrations: [{ id: "conn-1", type: "slack" }],
      });
      const result = yield* tools.validate_workflow();

      expect(result.draftValid).toBe(true);
      expect(result.publishBlockers).toContainEqual(
        expect.objectContaining({
          kind: "missing_required_field",
          severity: "blocking",
          nodeId: "notify",
        })
      );
    })
  );

  it.effect("warns about a template token naming a node that is gone", () =>
    Effect.gen(function* () {
      const danglingRef: WorkflowNode = {
        ...slackNode,
        data: {
          ...slackNode.data,
          config: {
            actionType: "slack/send-message",
            integrationId: "conn-1",
            channel: "#hiring",
            text: "Score was {{@removed:Score applicant.score}}",
          },
        },
      };

      const { tools } = yield* agentToolsFor({
        nodes: [lifecycle, danglingRef],
        edges: [entryToSlack],
        catalog,
        integrations: [{ id: "conn-1", type: "slack" }],
      });
      const result = yield* tools.validate_workflow();

      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          kind: "broken_reference",
          nodeId: "notify",
        })
      );
      expect(result.draftValid).toBe(true);
      expect(result.publishBlockers).toEqual([]);
    })
  );
});
