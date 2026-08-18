import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";

const catalog = fixtureCatalog;

const entry: WorkflowNode = {
  id: "entry",
  position: { x: 0, y: 0 },
  type: "lifecycle",
  data: { label: "Lifecycle", type: "lifecycle", config: {} },
};

const condition: WorkflowNode = {
  id: "branch",
  position: { x: 0, y: 0 },
  type: "action",
  data: {
    label: "Score high enough",
    type: "action",
    config: { actionType: "Condition" },
  },
};

describe("set_lifecycle_rules", () => {
  it.effect("creates the Lifecycle Node when the workflow has none", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      const result = yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        concurrency: "newest-wins",
        correlationPaths: [{ event: "applicant.created", path: "applicantId" }],
      });

      const document = yield* draft.current;
      const [node] = document.nodes;
      expect(node?.data.type).toBe("lifecycle");
      // The tool takes a list, because a record cannot survive a strict
      // function schema; the rules store the record the rest of the repo reads.
      expect(readLifecycleRules(node?.data.config)).toEqual({
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        concurrency: "newest-wins",
        correlationPaths: { "applicant.created": "applicantId" },
      });
      expect(result.summary).toContain("Created");
    })
  );

  it.effect("writes onto the entry node the workflow already has", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [entry],
        catalog,
      });
      yield* tools.set_lifecycle_rules({
        startEvents: ["applicant.created"],
      });

      const document = yield* draft.current;
      expect(document.nodes).toHaveLength(1);
      expect(document.nodes[0]?.id).toBe("entry");
      expect(readLifecycleRules(document.nodes[0]?.data.config)).toMatchObject({
        startEvents: ["applicant.created"],
        concurrency: "unlimited",
      });
    })
  );

  it.effect("refuses an Event the host never registered", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.set_lifecycle_rules({ startEvents: ["invoice.paid"] })
      );

      expect(failure.reason).toContain("invoice.paid");
      expect((yield* draft.current).nodes).toEqual([]);
    })
  );

  it.effect("refuses rules that leave a workflow with no way to start", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ catalog });
      const failure = yield* Effect.flip(
        tools.set_lifecycle_rules({ startEvents: [] })
      );

      expect(failure.reason).toContain("needs a way to start");
    })
  );

  it.effect("allows no Start Event when manual start is on", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({ catalog });
      yield* tools.set_lifecycle_rules({
        startEvents: [],
        allowManualStart: true,
      });

      expect(
        readLifecycleRules((yield* draft.current).nodes[0]?.data.config)
      ).toMatchObject({ startEvents: [], allowManualStart: true });
    })
  );
});

describe("set_condition", () => {
  it.effect("writes the model and the CEL it compiles to together", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [condition],
        catalog,
      });
      yield* tools.set_condition({
        nodeId: "branch",
        groups: [
          {
            rules: [
              {
                field: "score",
                fieldType: "number",
                operator: "greater_or_equal",
                value: "80",
              },
            ],
          },
        ],
      });

      const config = (yield* draft.current).nodes[0]?.data.config;
      const expression = readConfigString(config, "condition");
      const serialized = readConfigString(config, "conditionModel") ?? "";

      expect(expression).toContain(">=");
      expect(expression).toContain("80");

      const parsed = parseConditionModel(serialized);
      expect(parsed.valid).toBe(true);
    })
  );

  it.effect("joins groups and rules by the logic it is given", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [condition],
        catalog,
      });
      yield* tools.set_condition({
        nodeId: "branch",
        groupLogic: "or",
        groups: [
          {
            logic: "and",
            rules: [
              {
                field: "score",
                fieldType: "number",
                operator: "greater_than",
                value: "50",
              },
              { field: "email", fieldType: "string", operator: "is_set" },
            ],
          },
          {
            rules: [
              {
                field: "email",
                fieldType: "string",
                operator: "contains",
                value: "@example.com",
              },
            ],
          },
        ],
      });

      const expression =
        readConfigString(
          (yield* draft.current).nodes[0]?.data.config,
          "condition"
        ) ?? "";
      expect(expression).toContain("||");
      expect(expression).toContain("&&");
    })
  );

  it.effect("escapes a value that would otherwise break the expression", () =>
    Effect.gen(function* () {
      const { tools, draft } = yield* agentToolsFor({
        nodes: [condition],
        catalog,
      });
      yield* tools.set_condition({
        nodeId: "branch",
        groups: [
          {
            rules: [
              {
                field: "email",
                fieldType: "string",
                operator: "equals",
                value: 'a"b\nc',
              },
            ],
          },
        ],
      });

      const expression =
        readConfigString(
          (yield* draft.current).nodes[0]?.data.config,
          "condition"
        ) ?? "";
      // The raw newline and quote never reach the expression; a hand-rolled
      // escape here is how a run silently never triggers.
      expect(expression).not.toContain("\n");
      expect(expression).toContain('\\"');
    })
  );

  it.effect("refuses a step that is not a Condition", () =>
    Effect.gen(function* () {
      const notACondition: WorkflowNode = {
        ...condition,
        data: { ...condition.data, config: { actionType: "score-applicant" } },
      };

      const { tools } = yield* agentToolsFor({
        nodes: [notACondition],
        catalog,
      });
      const failure = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                { field: "score", fieldType: "boolean", operator: "is_true" },
              ],
            },
          ],
        })
      );

      expect(failure.reason).toContain("not a Condition step");
    })
  );

  it.effect("names the operator and the field when a rule cannot be read", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [condition], catalog });

      const wrongOperator = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                { field: "score", fieldType: "number", operator: "contains" },
              ],
            },
          ],
        })
      );
      expect(wrongOperator.reason).toContain("not a number operator");

      const missingValue = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                { field: "score", fieldType: "number", operator: "equals" },
              ],
            },
          ],
        })
      );
      expect(missingValue.reason).toContain("numeric value");

      const missingAmount = yield* Effect.flip(
        tools.set_condition({
          nodeId: "branch",
          groups: [
            {
              rules: [
                {
                  field: "createdAt",
                  fieldType: "timestamp",
                  operator: "within_next",
                },
              ],
            },
          ],
        })
      );
      expect(missingAmount.reason).toContain("amount and unit");
    })
  );

  it.effect("refuses an empty condition rather than writing a blank test", () =>
    Effect.gen(function* () {
      const { tools } = yield* agentToolsFor({ nodes: [condition], catalog });

      const noGroups = yield* Effect.flip(
        tools.set_condition({ nodeId: "branch", groups: [] })
      );
      expect(noGroups.reason).toContain("at least one group");

      const noRules = yield* Effect.flip(
        tools.set_condition({ nodeId: "branch", groups: [{ rules: [] }] })
      );
      expect(noRules.reason).toContain("at least one rule");
    })
  );
});
