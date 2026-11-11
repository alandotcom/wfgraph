import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { formatTemplateToken } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
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
        startEvents: ["applicant.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: false,
      },
    },
  },
};

describe("apply_edits", () => {
  it.effect(
    "builds a chain whose later steps name earlier new steps by key",
    () =>
      Effect.gen(function* () {
        const { tools, draft } = yield* agentToolsFor({
          nodes: [entry],
          catalog: fixtureCatalog,
        });

        const result = yield* tools.apply_edits({
          operations: [
            {
              tool: "add_node",
              key: "score",
              actionId: "score-applicant",
              label: "Score",
              sourceNodeId: "entry",
              sourceHandle: LIFECYCLE_STARTED_HANDLE,
            },
            {
              tool: "add_node",
              key: "check",
              actionId: "Condition",
              label: "High score",
              sourceNodeId: "$score",
            },
            {
              tool: "add_node",
              actionId: "slack/send-message",
              label: "Notify",
              sourceNodeId: "$check",
              sourceHandle: "true",
              config: [
                {
                  key: "text",
                  value: `Score: {{@$score:Score.score}}`,
                },
              ],
            },
          ],
        });

        const document = yield* draft.current;
        // The batch is one write: the editor and the trajectory see one
        // revision for it, however many operations it held.
        expect((yield* draft.latest).revision).toBe(1);
        const [score, check, notify] = result.results;
        expect(result.results.map((step) => step.tool)).toEqual([
          "add_node",
          "add_node",
          "add_node",
        ]);
        expect(
          document.edges.map((edge) => [edge.source, edge.target])
        ).toEqual([
          ["entry", score?.nodeId],
          [score?.nodeId, check?.nodeId],
          [check?.nodeId, notify?.nodeId],
        ]);
        expect(
          document.nodes.find((node) => node.id === notify?.nodeId)?.data.config
            ?.text
        ).toBe(
          `Score: ${formatTemplateToken({ nodeId: score?.nodeId ?? "", nodeLabel: "Score", fieldPath: "score" })}`
        );
      })
  );

  it.effect("applies nothing when one operation is refused", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry],
        catalog: fixtureCatalog,
      });

      const failure = yield* Effect.flip(
        tools.apply_edits({
          operations: [
            {
              tool: "add_node",
              key: "score",
              actionId: "score-applicant",
              label: "Score",
              sourceNodeId: "entry",
              sourceHandle: LIFECYCLE_STARTED_HANDLE,
            },
            { tool: "connect_nodes", source: "$score", target: "ghost" },
          ],
        })
      );

      expect(failure.reason).toContain("Operation 2 (connect_nodes)");
      expect(failure.reason).toContain("no operation was applied");
      expect(yield* draft.current).toEqual({ nodes: [entry], edges: [] });
      expect((yield* draft.latest).revision).toBe(0);
    })
  );

  it.effect("refuses an empty batch", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({
        nodes: [entry],
        catalog: fixtureCatalog,
      });

      const failure = yield* Effect.flip(tools.apply_edits({ operations: [] }));

      expect(failure.reason).toContain("at least one operation");
    })
  );
});
